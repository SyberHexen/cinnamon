// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Cinnamon = imports.gi.Cinnamon;
const Meta = imports.gi.Meta;

const XdgAppState = {
    BACKGROUND: 0, // window.is_hidden
    RUNNING: 1, // window visible
    ACTIVE: 2  // window focused
}

const CinnamonPortalIface =
    '<node> \
        <interface name="org.cinnamon.PortalHandlers"> \
            <method name="GetAppStates"> \
                <arg type="a{sv}" direction="out" name="apps" /> \
            </method> \
            <signal name="RunningAppsChanged"/> \
            <method name="GetWindows"> \
                <arg type="a{ta{sv}}" direction="out" name="windows" /> \
            </method> \
            <signal name="WindowsChanged"/> \
            <method name="GetWindowThumbnail"> \
                <arg type="t" direction="in" name="window_id" /> \
                <arg type="i" direction="in" name="max_width" /> \
                <arg type="i" direction="in" name="max_height" /> \
                <arg type="i" direction="out" name="width" /> \
                <arg type="i" direction="out" name="height" /> \
                <arg type="i" direction="out" name="stride" /> \
                <arg type="ay" direction="out" name="pixels" /> \
            </method> \
            <method name="GetMonitorThumbnail"> \
                <arg type="s" direction="in" name="connector" /> \
                <arg type="i" direction="in" name="max_width" /> \
                <arg type="i" direction="in" name="max_height" /> \
                <arg type="i" direction="out" name="width" /> \
                <arg type="i" direction="out" name="height" /> \
                <arg type="i" direction="out" name="stride" /> \
                <arg type="ay" direction="out" name="pixels" /> \
            </method> \
        </interface> \
    </node>';


var CinnamonPortalHandler = class CinnamonPortalHandler {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(CinnamonPortalIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/Cinnamon');

        this.running_apps = {};
        Cinnamon.AppSystem.get_default().connect("app-state-changed", () => this.EmitRunningAppsChanged());
        Cinnamon.WindowTracker.get_default().connect("notify::focus-app", () => this.EmitRunningAppsChanged());

        /* The screen sharing picker updates its window list with this */
        this._windowsChangedId = 0;
        global.display.connect('window-created', (display, window) => {
            this._watchWindow(window);
            this._queueWindowsChanged();
        });
        for (let actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);
    }

    _watchWindow(window) {
        window.connect('unmanaged', () => this._queueWindowsChanged());
        window.connect('notify::title', () => this._queueWindowsChanged());
        window.connect('notify::skip-taskbar', () => this._queueWindowsChanged());
    }

    /* Coalesced: a window opening changes its title a few times */
    _queueWindowsChanged() {
        if (this._windowsChangedId)
            return;
        this._windowsChangedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._windowsChangedId = 0;
            this._dbusImpl.emit_signal('WindowsChanged', null);
            return GLib.SOURCE_REMOVE;
        });
    }

    EmitRunningAppsChanged() {
        this._dbusImpl.emit_signal('RunningAppsChanged', null);
    }

    has_focus(app) {
        const fwin = global.display.get_focus_window();
        if (!fwin) {
            return false;
        }
        return app.get_windows().includes(fwin);
    }

    /* org.freedesktop.impl.portal.Background.GetAppState:
     * A big issue right now is that in X11, CinnamonAppSystem stops caring
     * about an app if its windows are closed or *hidden* to tray, so our list
     * here won't contain any background apps until this behavior is addressed. */
    GetAppStates() {
        const appsys = Cinnamon.AppSystem.get_default();
        const running = appsys.get_running();
        const apps = {}

        for (let app of running) {
            var id = null;

            if (app.get_is_flatpak()) {
                id = app.get_flatpak_app_id();
            }
            else {
                id = app.get_id();
            }
            let state;
            if (app.get_n_windows() === 0) {
                state = XdgAppState.BACKGROUND;
            } else if (this.has_focus(app)) {
                state = XdgAppState.ACTIVE;
            } else {
                state = XdgAppState.RUNNING;
            }
            apps[id] = GLib.Variant.new_uint32(state);
        }

        return new GLib.Variant("(a{sv})", [apps]);
    }

    /* org.freedesktop.impl.portal.ScreenCast: the windows that can be shared,
     * by the ID org.cinnamon.Muffin.ScreenCast RecordWindow takes (the same
     * as org.gnome.Shell.Introspect.GetWindows) */
    GetWindows() {
        const tracker = Cinnamon.WindowTracker.get_default();
        const focus = global.display.get_focus_window();
        const windows = {};

        for (let actor of global.get_window_actors()) {
            const window = actor.meta_window;
            const type = window.get_window_type();

            if (window.is_skip_taskbar() ||
                (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG))
                continue;

            const app = tracker.get_window_app(window);
            const rect = window.get_frame_rect();
            windows[window.get_id()] = {
                'title': GLib.Variant.new_string(window.get_title() || ''),
                'app-id': GLib.Variant.new_string(app ? app.get_id() : ''),
                'wm-class': GLib.Variant.new_string(window.get_wm_class() || ''),
                'client-type': GLib.Variant.new_uint32(window.get_client_type()),
                'is-hidden': GLib.Variant.new_boolean(window.minimized),
                'has-focus': GLib.Variant.new_boolean(window === focus),
                'width': GLib.Variant.new_uint32(rect.width),
                'height': GLib.Variant.new_uint32(rect.height),
            };
        }

        return new GLib.Variant("(a{ta{sv}})", [windows]);
    }

    /* Small Cairo ARGB32 previews for the screen sharing picker; an empty
     * result (0 x 0) when the window or monitor is gone */
    _thumbnailVariant(result) {
        let [bytes, width, height, stride] = result || [null, 0, 0, 0];

        if (!bytes) {
            bytes = new GLib.Bytes(new Uint8Array(0));
            width = height = stride = 0;
        }
        return GLib.Variant.new_tuple([
            GLib.Variant.new_int32(width),
            GLib.Variant.new_int32(height),
            GLib.Variant.new_int32(stride),
            GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), bytes, true),
        ]);
    }

    GetWindowThumbnailAsync(params, invocation) {
        const [windowId, maxWidth, maxHeight] = params;
        const actor = global.get_window_actors().find(
            a => String(a.meta_window.get_id()) === String(windowId));
        const result = actor ? actor.get_thumbnail(maxWidth, maxHeight) : null;

        invocation.return_value(this._thumbnailVariant(result));
    }

    GetMonitorThumbnailAsync(params, invocation) {
        const [connector, maxWidth, maxHeight] = params;
        const index = Meta.MonitorManager.get().get_monitor_for_connector(connector);
        const result = index >= 0 ?
            global.display.get_monitor_thumbnail(index, maxWidth, maxHeight) : null;

        invocation.return_value(this._thumbnailVariant(result));
    }
}
