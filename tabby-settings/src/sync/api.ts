/**
 * Native config sync API.
 *
 * A transport is a dumb, stateless remote document store: it can read the
 * document, write it back with optimistic concurrency, and validate its own
 * credentials. All merge/conflict/serialization policy lives in
 * `SyncService` so every transport behaves identically.
 */

/** A snapshot of the remote document. */
export interface SyncRemote {
    /** Serialized YAML config document. */
    content: string
    /**
     * Opaque provider revision (ETag, gist `updated_at`, S3 version id, ...) or
     * `null` when the provider exposes none.
     */
    revision: string|null
}

export interface SyncTransportField {
    key: string
    label: string
    type: 'text'|'url'
    placeholder?: string
    required?: boolean
    hint?: string
}

export interface SyncTransportInfo {
    id: string
    name: string
    /** Font Awesome icon name shown in the transport picker. */
    icon: string
    /** Non-secret options rendered by the settings UI. */
    fields: SyncTransportField[]
    /** Label for the single secret this transport needs, or null when it needs none. */
    secretLabel: string|null
    /** Placeholder text for the secret password input. */
    secretPlaceholder?: string
    /** Short description shown under the transport name. */
    description: string
    /** Optional link to provider docs (e.g. how to create a token). */
    helpUrl?: string
}

export interface SyncContext {
    /** Non-secret text options, i.e. `config.store.sync.transports[<id>]`. */
    options: Record<string, string|undefined>
    /** Resolved secret (token / password / secret access key). Empty when unused. */
    secret: string
}

/**
 * Raised by a transport when `expectedRevision` no longer matches the remote,
 * i.e. somebody else wrote in between. Never overwrite on this - surface it.
 */
export class SyncConflictError extends Error {
    constructor (message = 'Remote document changed since last read') {
        super(message)
        this.name = 'SyncConflictError'
    }
}

/** Raised for authentication/authorization failures so the UI can be specific. */
export class SyncAuthError extends Error {
    constructor (message = 'Authentication failed') {
        super(message)
        this.name = 'SyncAuthError'
    }
}

export abstract class SyncTransport {
    abstract readonly info: SyncTransportInfo

    /**
     * Fetch the remote document.
     * @returns `null` when the document does not exist yet (first sync).
     * @throws SyncAuthError on 401/403, Error on anything else.
     */
    abstract read (ctx: SyncContext): Promise<SyncRemote|null>

    /**
     * Replace the remote document.
     * @param expectedRevision revision observed by the caller, or `null` to
     *        create/force. Transports that support conditional writes MUST
     *        throw `SyncConflictError` when the remote moved.
     * @returns the new revision, or `null` when the provider exposes none.
     */
    abstract write (ctx: SyncContext, content: string, expectedRevision: string|null): Promise<string|null>

    /** Cheap credential check for the "Test connection" button. */
    abstract validate (ctx: SyncContext): Promise<void>

    /** True when all required options + the secret are present. */
    isConfigured (ctx: SyncContext): boolean {
        if (this.info.secretLabel && !ctx.secret) {
            return false
        }
        return this.info.fields
            .filter(f => f.required)
            .every(f => !!ctx.options[f.key])
    }
}
