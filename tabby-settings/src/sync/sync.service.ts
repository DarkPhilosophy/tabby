import * as yaml from 'js-yaml'
import { createHash } from 'crypto'
import { Inject, Injectable } from '@angular/core'
import { Observable, Subject, debounceTime } from 'rxjs'
import { ConfigService, HostAppService, Logger, LogService, NotificationsService, Platform, PlatformService, TranslateService } from 'tabby-core'

import { SyncAuthError, SyncConflictError, SyncContext, SyncRemote, SyncTransport } from './api'
import { SyncSecretStore } from './secrets'

/** A parsed `config.yaml` document as exchanged with the remote. */
// eslint-disable-next-line @typescript-eslint/no-type-alias
export type ConfigDocument = Record<string, unknown>

/** Config sections the user may exclude from sync. */
export const OPTIONAL_SYNC_PARTS = ['hotkeys', 'appearance', 'vault', 'profiles']

/** Anything below this and providers start rate-limiting us. */
export const MIN_SYNC_INTERVAL = 60

export type SyncDirection = 'up'|'down'|'none'|'conflict'

export interface SyncStatus {
    /** Last completed action. */
    direction: SyncDirection
    at: Date|null
    error: string|null
    busy: boolean
    /** When the next automatic poll is scheduled. */
    nextPoll: Date|null
    /** True while an explicit upload/download is in progress (not auto-poll). */
    syncing: boolean
}

/** Bookkeeping that lets us tell a local edit apart from a remote one. */
export interface SyncState {
    /** Hash of the local document at the last successful sync. */
    localHash: string|null
    /** Hash of the remote document at the last successful sync. */
    remoteHash: string|null
    /** Provider revision observed at the last successful sync. */
    remoteRevision: string|null
}

/** Arguments for one upload. */
interface PushRequest {
    transport: SyncTransport
    ctx: SyncContext
    local: ConfigDocument
    remote: SyncRemote|null
    /** Overwrite the remote unconditionally, ignoring its revision. */
    force?: boolean
}

function hash (content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex')
}

function parseDocument (content: string|null|undefined): ConfigDocument {
    if (!content) {
        return {}
    }
    const parsed = yaml.load(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
    }
    return parsed as ConfigDocument
}

/**
 * Remote documents round-trip through provider storage, so compare a canonical
 * re-dump rather than raw bytes: line endings, key order and trailing
 * newlines all drift on the way.
 */
function normalizeRemote (content: string): string {
    try {
        return yaml.dump(yaml.load(content))
    } catch {
        return content
    }
}

@Injectable({ providedIn: 'root' })
export class SyncService {
    get status$ (): Observable<SyncStatus> { return this.statusSubject }

    status: SyncStatus = { direction: 'none', at: null, error: null, busy: false, nextPoll: null, syncing: false }

    private logger: Logger
    private statusSubject = new Subject<SyncStatus>()
    private pollTimer: any = null
    /** Set while we are writing the config ourselves, to break feedback loops. */
    private applyingRemote = false

    constructor (
        log: LogService,
        private config: ConfigService,
        private platform: PlatformService,
        private hostApp: HostAppService,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private secrets: SyncSecretStore,
        @Inject(SyncTransport) private transports: SyncTransport[],
    ) {
        this.logger = log.create('sync')

        this.config.ready$.toPromise().then(() => {
            this.config.changed$.pipe(debounceTime(5000)).subscribe(() => {
                if (this.applyingRemote || !this.config.store.sync.auto) {
                    return
                }
                this.syncNow().catch(() => { /* surfaced through status */ })
            })
            this.schedulePoll(10000)
        })
    }

    isAvailable (): boolean {
        return this.hostApp.platform !== Platform.Web
    }

    getTransports (): SyncTransport[] {
        return this.transports.slice().sort((a, b) => a.info.name.localeCompare(b.info.name))
    }

    getTransport (id: string|null): SyncTransport|null {
        return this.transports.find(t => t.info.id === id) ?? null
    }

    get activeTransport (): SyncTransport|null {
        return this.getTransport(this.config.store.sync.transport)
    }

    async getContext (transport: SyncTransport): Promise<SyncContext> {
        const { id } = transport.info
        this.config.store.sync.transports[id] ??= {}
        return {
            options: this.config.store.sync.transports[id],
            secret: transport.info.secretLabel ? await this.secrets.get(id) : '',
        }
    }

    async isEnabled (): Promise<boolean> {
        const transport = this.activeTransport
        if (!this.isAvailable() || !transport) {
            return false
        }
        return transport.isConfigured(await this.getContext(transport))
    }

    /**
     * Run one sync cycle: compare local and remote against the last synced
     * state and move data in whichever direction changed. A two-sided change
     * is reported as a conflict and never resolved automatically.
     */
    async syncNow (manual = false): Promise<SyncDirection> {
        if (this.status.busy) {
            return 'none'
        }
        const transport = this.activeTransport
        if (!transport || !this.isAvailable()) {
            return 'none'
        }
        this.setStatus({ busy: true, error: null, syncing: manual })
        try {
            const ctx = await this.getContext(transport)
            if (!transport.isConfigured(ctx)) {
                return this.finish('none')
            }

            const local = await this.readLocalDocument()
            const localHash = hash(yaml.dump(local))
            const remote = await transport.read(ctx)

            if (!remote) {
                await this.push({ transport, ctx, local, remote: null })
                return this.finish('up')
            }

            const remoteHash = hash(normalizeRemote(remote.content))
            const state = this.readState()

            if (localHash === remoteHash) {
                await this.rememberState(localHash, remoteHash, remote.revision)
                return this.finish('none')
            }
            if (!state.localHash && !state.remoteHash) {
                // Never synced against this remote and both sides hold content.
                return this.finish('conflict')
            }

            const localChanged = state.localHash !== localHash
            const remoteChanged = state.remoteHash !== remoteHash
            if (localChanged && remoteChanged) {
                return this.finish('conflict')
            }
            if (localChanged) {
                await this.push({ transport, ctx, local, remote })
                return this.finish('up')
            }
            if (remoteChanged) {
                await this.pull(remote)
                return this.finish('down')
            }
            return this.finish('none')
        } catch (error) {
            this.reportError(error)
            throw error
        } finally {
            this.setStatus({ busy: false, syncing: false })
        }
    }

    /** Explicit user action: local wins. */
    async forceUpload (): Promise<void> {
        const transport = this.requireTransport()
        this.setStatus({ busy: true, error: null, syncing: true })
        try {
            const ctx = await this.getContext(transport)
            const local = await this.readLocalDocument()
            const remote = await transport.read(ctx)
            await this.push({ transport, ctx, local, remote, force: true })
            this.finish('up')
        } catch (error) {
            this.reportError(error)
            throw error
        } finally {
            this.setStatus({ busy: false, syncing: false })
        }
    }

    /** Explicit user action: remote wins. */
    async forceDownload (): Promise<void> {
        const transport = this.requireTransport()
        this.setStatus({ busy: true, error: null, syncing: true })
        try {
            const remote = await transport.read(await this.getContext(transport))
            if (!remote) {
                throw new Error('Nothing stored on the remote yet')
            }
            await this.pull(remote)
            this.finish('down')
        } catch (error) {
            this.reportError(error)
            throw error
        } finally {
            this.setStatus({ busy: false, syncing: false })
        }
    }

    /** Forget the sync bookkeeping so the next cycle starts from scratch. */
    async resetState (): Promise<void> {
        this.writeState({ localHash: null, remoteHash: null, remoteRevision: null })
        await this.config.save()
    }

    // ---- internals ----

    private requireTransport (): SyncTransport {
        const transport = this.activeTransport
        if (!transport) {
            throw new Error('No sync transport selected')
        }
        return transport
    }

    private readState (): SyncState {
        const { state } = this.config.store.sync
        return {
            localHash: state?.localHash ?? null,
            remoteHash: state?.remoteHash ?? null,
            remoteRevision: state?.remoteRevision ?? null,
        }
    }

    /**
     * `config.store.sync.state` is a structural member of the defaults, so the
     * proxy exposes it read-only - assign the leaves, never the object.
     */
    private writeState (state: SyncState): void {
        const target = this.config.store.sync.state
        target.localHash = state.localHash
        target.remoteHash = state.remoteHash
        target.remoteRevision = state.remoteRevision
    }

    /**
     * The document we exchange with the remote: the on-disk config - so an
     * encrypted config stays encrypted end to end - minus our own settings.
     */
    private async readLocalDocument (): Promise<ConfigDocument> {
        const raw = await this.platform.loadConfig()
        const doc = parseDocument(raw)
        delete doc.sync
        return doc
    }

    private async push ({ transport, ctx, local, remote, force = false }: PushRequest): Promise<void> {
        const payload: ConfigDocument = { ...local }
        const remoteDoc = remote ? parseDocument(remote.content) : null

        // Keep the remote's copy of the parts the user excluded from sync.
        if (remoteDoc && !payload.encrypted && !remoteDoc.encrypted) {
            this.applyExcludedParts(payload, remoteDoc)
        }

        const content = yaml.dump(payload)
        const revision = await transport.write(ctx, content, force ? null : remote?.revision ?? null)
        await this.rememberState(hash(yaml.dump(local)), hash(normalizeRemote(content)), revision)
        this.logger.info(`Uploaded config via ${transport.info.id}`)
    }

    private async pull (remote: SyncRemote): Promise<void> {
        const incoming = parseDocument(remote.content)
        if (!Object.keys(incoming).length) {
            throw new Error('Remote config is empty or not a valid YAML document')
        }
        const localDoc = parseDocument(await this.platform.loadConfig())

        const merged: ConfigDocument = { ...incoming }
        // Sync settings are machine-local and never come from the remote. Assign
        // only when present: `undefined` would dump as an explicit `sync: null`.
        delete merged.sync
        if (localDoc.sync !== undefined) {
            merged.sync = localDoc.sync
        }
        if (!incoming.encrypted) {
            this.applyExcludedParts(merged, localDoc)
        }

        this.applyingRemote = true
        try {
            await this.platform.saveConfig(yaml.dump(merged))
            await this.config.load()
            const local = await this.readLocalDocument()
            await this.rememberState(hash(yaml.dump(local)), hash(normalizeRemote(remote.content)), remote.revision)
        } finally {
            this.applyingRemote = false
        }
        this.logger.info('Applied remote config')
    }

    /** Replace every deselected part of `target` with the copy from `source`. */
    private applyExcludedParts (target: ConfigDocument, source: ConfigDocument): void {
        for (const part of OPTIONAL_SYNC_PARTS) {
            if (this.config.store.sync.parts[part]) {
                continue
            }
            if (part in source) {
                target[part] = source[part]
            } else {
                Reflect.deleteProperty(target, part)
            }
        }
    }

    private async rememberState (localHash: string, remoteHash: string, revision: string|null): Promise<void> {
        const current = this.readState()
        if (current.localHash === localHash && current.remoteHash === remoteHash && current.remoteRevision === revision) {
            return
        }
        this.writeState({ localHash, remoteHash, remoteRevision: revision })
        const wasApplying = this.applyingRemote
        this.applyingRemote = true
        try {
            await this.config.save()
        } finally {
            this.applyingRemote = wasApplying
        }
    }

    private schedulePoll (delay: number): void {
        clearTimeout(this.pollTimer)
        const nextPoll = new Date(Date.now() + delay)
        this.setStatus({ nextPoll })
        this.pollTimer = setTimeout(() => {
            void this.poll()
        }, delay)
    }

    private async poll (): Promise<void> {
        try {
            if (this.config.store.sync.auto && await this.isEnabled()) {
                await this.syncNow()
            }
        } catch (error) {
            this.logger.debug('Poll cycle failed', error)
        }
        const interval = Math.max(MIN_SYNC_INTERVAL, this.config.store.sync.interval ?? 300)
        this.schedulePoll(interval * 1000)
    }

    private finish (direction: SyncDirection): SyncDirection {
        this.setStatus({ direction, at: new Date(), error: null, nextPoll: null, syncing: false })
        if (direction === 'conflict') {
            this.notifications.error(this.translate.instant('Config sync conflict: local and remote both changed'))
        }
        return direction
    }

    private reportError (error: unknown): void {
        const message = this.describeError(error)
        this.logger.error('Sync failed:', error)
        this.setStatus({ error: message, at: new Date() })
    }

    private describeError (error: unknown): string {
        if (error instanceof SyncConflictError) {
            return this.translate.instant('Remote config changed while syncing, retrying next cycle')
        }
        if (error instanceof SyncAuthError) {
            return this.translate.instant('Sync credentials rejected by the provider')
        }
        return error instanceof Error ? error.message : String(error)
    }

    private setStatus (patch: Partial<SyncStatus>): void {
        this.status = { ...this.status, ...patch }
        this.statusSubject.next(this.status)
    }
}
