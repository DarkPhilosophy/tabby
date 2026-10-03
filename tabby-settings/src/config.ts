import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class SettingsConfigProvider extends ConfigProvider {
    defaults = {
        sync: {
            /** Transport id, e.g. `github-gist`. `null` disables sync. */
            transport: null,
            auto: false,
            /** Poll interval in seconds; clamped to >= 60 at runtime. */
            interval: 300,
            /**
             * Allow storing the transport credential unencrypted in this file.
             * Off by default: the vault is the supported location.
             */
            allowPlaintextSecret: false,
            parts: {
                hotkeys: true,
                appearance: true,
                vault: true,
                profiles: true,
            },
            /** Per-transport non-secret options, keyed by transport id. */
            transports: {
                __nonStructural: true,
            },
            state: {
                localHash: null,
                remoteHash: null,
                remoteRevision: null,
            },
        },
        hotkeys: {
            'settings-tab': {
                __nonStructural: true,
            },
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                settings: ['⌘-,'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
    }
}
