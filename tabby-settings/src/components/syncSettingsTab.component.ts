import { Component, HostBinding, OnInit } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService, PlatformService, TranslateService, VaultService } from 'tabby-core'

import { SyncTransport } from '../sync/api'
import { SyncSecretStore } from '../sync/secrets'
import { MIN_SYNC_INTERVAL, OPTIONAL_SYNC_PARTS, SyncService } from '../sync/sync.service'

/** Labels for the parts the user may exclude, keyed by config section. */
const PART_LABELS: Record<string, string> = {
    hotkeys: 'Hotkeys',
    appearance: 'Window & appearance',
    vault: 'Vault',
    profiles: 'Profiles & connections',
}

/** @hidden */
@Component({
    selector: 'sync-settings-tab',
    templateUrl: './syncSettingsTab.component.pug',
})
export class SyncSettingsTabComponent extends BaseComponent implements OnInit {
    /** `null` until a check has run; then the outcome of the last one. */
    validated: boolean|null = null
    validationError: string|null = null
    /** Bound to the secret input; never written back into the config store. */
    secret = ''
    secretDirty = false
    busy = false
    readonly parts = OPTIONAL_SYNC_PARTS
    readonly partLabels = PART_LABELS
    readonly minInterval = MIN_SYNC_INTERVAL

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public sync: SyncService,
        private platform: PlatformService,
        private secrets: SyncSecretStore,
        private vault: VaultService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        await this.loadSecret()
    }

    get transports (): SyncTransport[] {
        return this.sync.getTransports()
    }

    get transport (): SyncTransport|null {
        return this.sync.activeTransport
    }

    get options (): Record<string, string|undefined> {
        const id = this.config.store.sync.transport
        if (!id) {
            return {}
        }
        this.config.store.sync.transports[id] ??= {}
        return this.config.store.sync.transports[id]
    }

    /** True once the vault can hold the secret; otherwise plaintext is the only option. */
    get vaultAvailable (): boolean {
        return this.vault.isEnabled()
    }

    get plaintextSecret (): boolean {
        return !!this.options.secretPlaintext
    }

    get testButtonClass (): string {
        if (this.busy) {
            return 'btn-warning'
        }
        if (this.validated === true) {
            return 'btn-success'
        }
        if (this.validated === false) {
            return 'btn-danger'
        }
        return 'btn-secondary'
    }

    /** ISO string so the `tabbyDate` pipe gets the type it declares. */
    get lastSync (): string|null {
        return this.sync.status.at?.toISOString() ?? null
    }

    /** When the next automatic poll is scheduled. */
    get nextPoll (): Date|null {
        return this.sync.status.nextPoll
    }

    /** True while an explicit sync is in progress. */
    get syncing (): boolean {
        return this.sync.status.syncing
    }

    /** Human-readable status message with context. */
    get statusMessage (): string|null {
        const s = this.sync.status
        if (s.error) {
            return s.error
        }
        if (s.syncing) {
            return this.translate.instant('Uploading config…')
        }
        if (s.busy) {
            return this.translate.instant('Checking for remote changes…')
        }
        if (s.direction !== 'none' && s.at) {
            return this.translate.instant({
                up: '✓ Uploaded at {time}',
                down: '✓ Downloaded at {time}',
                conflict: '⚠ Conflict at {time} — pick a side',
                none: '✓ In sync',
            }[s.direction], { time: s.at.toLocaleTimeString() })
        }
        // No sync yet - show what's missing
        const transport = this.transport
        if (!transport) {
            return this.translate.instant('Select a storage provider to enable sync')
        }
        if (!this.config.store.sync.auto) {
            return this.translate.instant('Auto-sync is off — enable it or click "Sync now"')
        }
        return this.translate.instant('Ready — waiting for changes')
    }

    /** CSS class for status styling. */
    get statusClass (): string {
        const s = this.sync.status
        if (s.error) return 'text-danger'
        if (s.syncing) return 'text-primary'
        if (s.busy) return 'text-warning'
        if (s.direction === 'up' || s.direction === 'down') return 'text-success'
        if (s.direction === 'conflict') return 'text-warning'
        const transport = this.transport
        if (!transport) return 'text-muted'
        if (!this.config.store.sync.auto) return 'text-warning'
        return 'text-warning'
    }

    async selectTransport (id: string|null): Promise<void> {
        if (this.config.store.sync.transport === id) {
            return
        }
        this.config.store.sync.transport = id
        this.validated = null
        this.validationError = null
        await this.sync.resetState()
        await this.loadSecret()
    }

    async saveOptions (): Promise<void> {
        this.validated = null
        await this.config.save()
    }

    async saveInterval (): Promise<void> {
        const value = Number(this.config.store.sync.interval)
        this.config.store.sync.interval = Number.isFinite(value)
            ? Math.max(MIN_SYNC_INTERVAL, Math.round(value))
            : MIN_SYNC_INTERVAL
        await this.config.save()
    }

    async saveSecret (): Promise<void> {
        const { transport } = this
        if (!transport || !this.secretDirty) {
            return
        }
        try {
            if (this.secret) {
                await this.secrets.set(transport.info.id, this.secret)
            } else {
                await this.secrets.clear(transport.info.id)
            }
            this.secretDirty = false
            this.validated = null
        } catch (error) {
            this.report(error)
        }
    }

    async allowPlaintext (): Promise<void> {
        this.config.store.sync.allowPlaintextSecret = true
        await this.config.save()
        this.secretDirty = !!this.secret
        await this.saveSecret()
    }

    async validate (): Promise<void> {
        const { transport } = this
        if (!transport) {
            return
        }
        await this.saveSecret()
        await this.run(async () => {
            try {
                await transport.validate(await this.sync.getContext(transport))
                this.validated = true
                this.validationError = null
                this.notifications.info(this.translate.instant('Connection successful'))
            } catch (error) {
                this.validated = false
                this.validationError = error instanceof Error ? error.message : String(error)
            }
        })
    }

    async syncNow (): Promise<void> {
        await this.saveSecret()
        await this.run(async () => {
            const direction = await this.sync.syncNow(true)
            if (direction === 'conflict') {
                return
            }
            this.notifications.info(this.translate.instant({
                up: 'Uploaded the local config',
                down: 'Applied the remote config',
                none: 'Already in sync',
            }[direction]))
        })
    }

    async forceUpload (): Promise<void> {
        await this.saveSecret()
        await this.run(async () => {
            await this.sync.forceUpload()
            this.notifications.info(this.translate.instant('Uploaded the local config'))
        })
    }

    async forceDownload (): Promise<void> {
        await this.saveSecret()
        await this.run(async () => {
            await this.sync.forceDownload()
            this.notifications.info(this.translate.instant('Applied the remote config'))
        })
    }

    /** Trigger immediate sync when auto is enabled. */
    async onAutoToggle (enabled: boolean): Promise<void> {
        await this.config.save()
        if (enabled) {
            this.syncNow()
        }
    }

    async resetState (): Promise<void> {
        await this.sync.resetState()
        this.notifications.info(this.translate.instant('Sync state cleared'))
    }

    openHelpUrl (): void {
        const url = this.transport?.info.helpUrl
        if (url) {
            this.platform.openExternal(url)
        }
    }

    private async loadSecret (): Promise<void> {
        const { transport } = this
        this.secret = ''
        this.secretDirty = false
        if (!transport?.info.secretLabel) {
            return
        }
        try {
            this.secret = await this.secrets.get(transport.info.id)
        } catch {
            // Vault locked or unavailable; the user re-enters the secret.
        }
    }

    /** Run an action with the busy flag set and errors surfaced as notifications. */
    private async run (action: () => Promise<void>): Promise<void> {
        this.busy = true
        try {
            await action()
        } catch (error) {
            this.report(error)
        } finally {
            this.busy = false
        }
    }

    private report (error: unknown): void {
        this.notifications.error(error instanceof Error ? error.message : String(error))
    }
}