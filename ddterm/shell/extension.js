/*
    Copyright © 2020, 2021 Aleksandr Mezin

    This file is part of ddterm GNOME Shell extension.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

'use strict';

/* exported init enable disable settings toggle window_manager service */

const { GLib, GObject, Gio, Meta, Shell } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const { dbusapi, subprocess } = Me.imports.ddterm.shell;
const { translations } = Me.imports.ddterm.util;
const { Installer } = Me.imports.ddterm.shell.install;
const { PanelIconProxy } = Me.imports.ddterm.shell.panelicon;
const { Service } = Me.imports.ddterm.shell.service;
const { WindowManager } = Me.imports.ddterm.shell.wm;
const { WindowMatch } = Me.imports.ddterm.shell.windowmatch;

let app_process = null;

var settings = null;
var window_manager = null;
let window_matcher = null;
var service = null;
let app_actions = null;
let dbus_interface = null;
let installer = null;
let panel_icon = null;
let disable_cancellable = null;
let shutdown_handler = null;

var app_enable_heap_dump = false;

let revision = null;

let notification_source = null;
let revision_mismatch_notification = null;

const APP_ID = 'com.github.amezin.ddterm';
const APP_WMCLASS = 'Com.github.amezin.ddterm';
const APP_DBUS_PATH = '/com/github/amezin/ddterm';
const WINDOW_PATH_PREFIX = `${APP_DBUS_PATH}/window/`;

function init() {
    revision = read_revision();
    imports.misc.extensionUtils.initTranslations();
}

function enable() {
    disable_cancellable = Gio.Cancellable.new();

    settings = imports.misc.extensionUtils.getSettings();

    service = new Service({
        bus: Gio.DBus.session,
        bus_name: APP_ID,
        subprocess: app_process,
    });

    service.connect('activate', () => {
        if (revision !== read_revision())
            show_revision_mismatch_notification();

        const argv = [
            Me.dir.get_child('bin').get_child(APP_ID).get_path(),
            '--gapplication-service',
        ];

        if (app_enable_heap_dump)
            argv.push('--allow-heap-dump');

        if (settings.get_boolean('force-x11-gdk-backend'))
            argv.push('--allowed-gdk-backends=x11');

        else if (Meta.is_wayland_compositor())
            return new subprocess.WaylandSubprocess({ journal_identifier: APP_ID, argv });

        return new subprocess.Subprocess({ journal_identifier: APP_ID, argv });
    });

    service.connect('notify::subprocess', () => {
        app_process = service.subprocess;

        /* In case the app terminates while the extension is disabled */
        app_process?.wait().then(() => {
            app_process = null;
        });
    });

    window_manager = new WindowManager({ settings });

    window_manager.connect('hide-request', () => {
        if (service.is_registered)
            app_actions.activate_action('hide', null);
    });

    window_manager.connect('notify::current-window', set_skip_taskbar);

    const window_skip_taskbar_setting_handler =
        settings.connect('changed::window-skip-taskbar', set_skip_taskbar);

    disable_cancellable.connect(() => settings.disconnect(window_skip_taskbar_setting_handler));

    window_matcher = new WindowMatch({
        subprocess: service.subprocess,
        display: global.display,
        gtk_application_id: APP_ID,
        gtk_window_object_path_prefix: WINDOW_PATH_PREFIX,
        wm_class: APP_WMCLASS,
    });

    service.bind_property(
        'subprocess',
        window_matcher,
        'subprocess',
        GObject.BindingFlags.DEFAULT
    );

    window_matcher.connect('notify::current-window', () => {
        if (window_matcher.current_window)
            window_manager.manage_window(window_matcher.current_window);
    });

    app_actions = Gio.DBusActionGroup.get(Gio.DBus.session, APP_ID, APP_DBUS_PATH);

    dbus_interface = new dbusapi.Api({ revision });

    dbus_interface.connect('toggle', toggle);
    dbus_interface.connect('activate', activate);
    dbus_interface.connect('service', ensure_app_on_bus);
    dbus_interface.connect('refresh-target-rect', () => {
        /*
         * Don't want to track mouse pointer continuously, so try to update the
         * index manually in multiple places. Also, Meta.CursorTracker doesn't
         * seem to work properly in X11 session.
         */
        if (!window_manager.current_window)
            window_manager.update_monitor_index();
    });

    window_manager.bind_property(
        'target-rect',
        dbus_interface,
        'target-rect',
        GObject.BindingFlags.SYNC_CREATE
    );

    dbus_interface.dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/ddterm');

    if (window_matcher.current_window)
        window_manager.manage_window(window_matcher.current_window);

    Main.wm.addKeybinding(
        'ddterm-toggle-hotkey',
        settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        () => {
            toggle().catch(e => logError(e, 'Failed to toggle ddterm by keybinding'));
        }
    );

    Main.wm.addKeybinding(
        'ddterm-activate-hotkey',
        settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        () => {
            activate().catch(e => logError(e, 'Failed to activate ddterm by keybinding'));
        }
    );

    panel_icon = new PanelIconProxy();
    settings.bind(
        'panel-icon-type',
        panel_icon,
        'type-name',
        Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY
    );

    panel_icon.connect('toggle', (_, value) => {
        if (value !== (window_manager.current_window !== null))
            toggle();
    });

    panel_icon.connect('open-preferences', () => {
        app_actions.activate_action('preferences', null);
    });

    window_manager.connect('notify::current-window', () => {
        panel_icon.active = window_manager.current_window !== null;
    });

    installer = new Installer();
    installer.install();

    if (GObject.signal_lookup('shutdown', Shell.Global))
        shutdown_handler = global.connect('shutdown', () => installer.uninstall());
}

function disable() {
    disable_cancellable?.cancel();

    Main.wm.removeKeybinding('ddterm-toggle-hotkey');
    Main.wm.removeKeybinding('ddterm-activate-hotkey');

    dbus_interface?.dbus.unexport();

    if (!Main.sessionMode.isLocked) {
        // Stop the app only if the extension isn't being disabled because of
        // lock screen. Because when the session switches back to normal mode
        // we want to keep all open terminals.
        if (service?.is_registered && app_actions)
            app_actions.activate_action('quit', null);
        else
            service?.terminate();
    }

    service?.unwatch();
    window_matcher?.disable();
    window_manager?.disable();
    panel_icon?.remove();

    // Don't uninstall desktop/service files because of screen locking
    // GNOME Shell picks up newly installed desktop files with a noticeable delay
    if (!Main.sessionMode.isLocked)
        installer?.uninstall();

    if (shutdown_handler) {
        global.disconnect(shutdown_handler);
        shutdown_handler = null;
    }

    notification_source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    revision_mismatch_notification?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);

    settings = null;
    window_manager = null;
    window_matcher = null;
    service = null;
    app_actions = null;
    dbus_interface = null;
    installer = null;
    panel_icon = null;
    disable_cancellable = null;
}

async function wait_timeout(message, timeout_ms, cancellable = null) {
    await new Promise(resolve => {
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout_ms, () => {
            cancellable?.disconnect(cancel_handler);
            resolve();
            return GLib.SOURCE_REMOVE;
        });

        const cancel_handler = cancellable?.connect(() => {
            GLib.Source.remove(source);
            resolve();
        });
    });

    cancellable?.set_error_if_cancelled();
    throw GLib.Error.new_literal(Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT, message);
}

async function ensure_app_on_bus() {
    if (service.is_registered)
        return;

    const cancellable = Gio.Cancellable.new();
    const disable_handler = disable_cancellable.connect(() => cancellable.cancel());

    try {
        await Promise.race([
            service.start(cancellable),
            wait_timeout('ddterm app failed to start in 10 seconds', 10000, cancellable),
        ]);
    } finally {
        disable_cancellable.disconnect(disable_handler);
        cancellable.cancel();
    }
}

async function wait_app_window_visible(visible) {
    visible = Boolean(visible);

    if (Boolean(window_manager.current_window) === visible)
        return;

    const cancellable = Gio.Cancellable.new();
    const disable_handler = disable_cancellable.connect(() => cancellable.cancel());

    try {
        const wait = new Promise((resolve, reject) => {
            const window_handler = window_manager.connect('notify::current-window', () => {
                if (Boolean(window_manager.current_window) === visible)
                    resolve();
            });

            cancellable.connect(() => window_manager.disconnect(window_handler));

            const dbus_handler = service.connect('notify::bus-name-owner', () => {
                reject(new Error(visible ? 'ddterm failed to show' : 'ddterm failed to hide'));
            });

            cancellable.connect(() => service.disconnect(dbus_handler));
        });

        await Promise.race([
            wait,
            wait_timeout(
                // eslint-disable-next-line max-len
                visible ? 'ddterm failed to show in 10 seconds' : 'ddterm failed to hide in 10 seconds',
                10000,
                cancellable
            ),
        ]);
    } finally {
        disable_cancellable.disconnect(disable_handler);
        cancellable.cancel();
    }
}

async function toggle() {
    if (window_manager.current_window) {
        if (service.is_registered)
            app_actions.activate_action('hide', null);

        await wait_app_window_visible(false);
    } else {
        await activate();
    }
}

async function activate() {
    if (window_manager.current_window) {
        Main.activateWindow(window_manager.current_window);
        return;
    }

    window_manager.update_monitor_index();

    await ensure_app_on_bus();

    app_actions.activate_action('show', null);
    await wait_app_window_visible(true);
}

function set_skip_taskbar() {
    const win = window_manager.current_window;

    if (win?.get_client_type() !== Meta.WindowClientType.WAYLAND)
        return;

    if (settings.get_boolean('window-skip-taskbar'))
        app_process.wayland_client.hide_from_window_list(win);
    else
        app_process.wayland_client.show_in_window_list(win);
}

function read_revision() {
    try {
        const [ok_, data] = Me.dir.get_child('revision.txt').load_contents(null);
        return ByteArray.toString(data).trim();
    } catch (ex) {
        if (ex instanceof GLib.Error &&
            ex.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND))
            return null;

        throw ex;
    }
}

function ensure_notification_source() {
    if (notification_source)
        return notification_source;

    notification_source = new MessageTray.Source(
        translations.gettext('Drop Down Terminal'),
        'utilities-terminal'
    );

    notification_source.connect('destroy', () => {
        notification_source = null;
    });

    Main.messageTray.add(notification_source);
    return notification_source;
}

function ensure_revision_mismatch_notification() {
    if (revision_mismatch_notification)
        return revision_mismatch_notification;

    const title = translations.gettext('Drop Down Terminal');
    const msg = translations.gettext(
        'Warning: ddterm version has changed. ' +
        'Log out, then log in again to load the updated extension.'
    );

    revision_mismatch_notification =
        new MessageTray.Notification(ensure_notification_source(), title, msg);

    revision_mismatch_notification.connect('destroy', () => {
        revision_mismatch_notification = null;
    });

    return revision_mismatch_notification;
}

function show_revision_mismatch_notification() {
    ensure_notification_source().showNotification(ensure_revision_mismatch_notification());
}
