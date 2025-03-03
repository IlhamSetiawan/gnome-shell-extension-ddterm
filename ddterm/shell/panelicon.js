/*
    Copyright © 2021 Aleksandr Mezin

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

/* exported PanelIconProxy */

const { GObject, Atk, Clutter, St } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const { translations } = Me.imports.ddterm.util;

const PanelIconBase = GObject.registerClass({
    Properties: {
        'active': GObject.ParamSpec.boolean(
            'active',
            '',
            '',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            false
        ),
    },
    Signals: {
        'toggle': {
            param_types: [GObject.TYPE_BOOLEAN],
        },
        'open-preferences': {},
    },
}, class DDTermPanelIconBase extends PanelMenu.Button {
    _init(dontCreateMenu) {
        super._init(null, 'ddterm', dontCreateMenu);

        this.add_actor(new St.Icon({
            icon_name: 'utilities-terminal',
            style_class: 'system-status-icon',
        }));

        this.add_style_class_name('panel-status-button');
    }
});

const PanelIconPopupMenu = GObject.registerClass({
}, class DDTermPanelIconPopupMenu extends PanelIconBase {
    _init() {
        super._init(false);

        this.toggle_item = new PopupMenu.PopupSwitchMenuItem(
            translations.gettext('Show'),
            false
        );
        this.menu.addMenuItem(this.toggle_item);
        this.toggle_item.connect('toggled', (_, value) => {
            this.emit('toggle', value);
        });
        this.toggle_item.connect('notify::state', () => {
            this.notify('active');
        });

        this.preferences_item = new PopupMenu.PopupMenuItem(
            translations.gettext('Preferences...')
        );
        this.menu.addMenuItem(this.preferences_item);
        this.preferences_item.connect('activate', () => {
            this.emit('open-preferences');
        });
    }

    get active() {
        return this.toggle_item.state;
    }

    set active(value) {
        this.toggle_item.setToggleState(value);
    }

    static type_name() {
        return 'menu-button';
    }
});

const PanelIconToggleButton = GObject.registerClass({
}, class DDTermPanelIconToggleButton extends PanelIconBase {
    _init() {
        super._init(true);

        this.accessible_role = Atk.Role.TOGGLE_BUTTON;
    }

    get active() {
        return this.has_style_pseudo_class('active');
    }

    set active(value) {
        if (value === this.active)
            return;

        if (value) {
            this.add_style_pseudo_class('active');
            this.add_accessible_state(Atk.StateType.CHECKED);
        } else {
            this.remove_style_pseudo_class('active');
            this.remove_accessible_state(Atk.StateType.CHECKED);
        }

        this.notify('active');
    }

    static type_name() {
        return 'toggle-button';
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS ||
            event.type() === Clutter.EventType.TOUCH_BEGIN) {
            this.emit('toggle', !this.active);
            return Clutter.EVENT_PROPAGATE;
        }

        return super.vfunc_event(event);
    }
});

const PanelIconToggleAndMenu = GObject.registerClass({
}, class DDTermPanelIconToggleAndMenu extends PanelIconPopupMenu {
    get active() {
        return super.active;
    }

    set active(value) {
        if (value) {
            this.add_style_pseudo_class('checked');
            this.add_accessible_state(Atk.StateType.CHECKED);
        } else {
            this.remove_style_pseudo_class('checked');
            this.remove_accessible_state(Atk.StateType.CHECKED);
        }

        super.active = value;
    }

    static type_name() {
        return 'toggle-and-menu-button';
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN ||
            event.type() === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() === Clutter.BUTTON_PRIMARY ||
                event.get_button() === Clutter.BUTTON_MIDDLE) {
                this.emit('toggle', !this.active);
                return Clutter.EVENT_PROPAGATE;
            }
        }

        return super.vfunc_event(event);
    }
});

const TYPE_BY_NAME = {
    'none': null,
    ...Object.fromEntries([
        PanelIconPopupMenu,
        PanelIconToggleButton,
        PanelIconToggleAndMenu,
    ].map(t => [t.type_name(), t])),
};

var PanelIconProxy = GObject.registerClass({
    Properties: {
        'active': GObject.ParamSpec.boolean(
            'active',
            '',
            '',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            false
        ),
        'type-name': GObject.ParamSpec.string(
            'type-name',
            '',
            '',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            'none'
        ),
    },
    Signals: {
        'toggle': {
            param_types: [GObject.TYPE_BOOLEAN],
        },
        'open-preferences': {},
    },
}, class DDTermPanelIconProxy extends GObject.Object {
    _init(params) {
        super._init(params);

        this.icon = null;
    }

    get type_name() {
        if (!this.icon)
            return 'none';

        return this.icon.type_name();
    }

    set type_name(value) {
        if (!TYPE_BY_NAME.hasOwnProperty(value))
            throw new Error(`${value} is not a vaild icon type`);

        const type_resolved = TYPE_BY_NAME[value];

        if (type_resolved) {
            if (this.icon instanceof type_resolved)
                return;
        } else if (this.icon === null) {
            return;
        }

        this.freeze_notify();

        try {
            this.remove();

            if (!type_resolved)
                return;

            this.icon = new type_resolved();
            Main.panel.addToStatusArea('ddterm', this.icon);

            this.bind_property(
                'active',
                this.icon,
                'active',
                GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.BIDIRECTIONAL
            );

            this.icon.connect('toggle', (_, v) => {
                this.emit('toggle', v);
            });

            this.icon.connect('open-preferences', () => {
                this.emit('open-preferences');
            });
        } finally {
            this.thaw_notify();
        }
    }

    remove() {
        this.icon?.destroy();
        this.icon = null;
        this.notify('type-name');
    }
});
