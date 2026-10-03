import { Injectable } from '@angular/core'

import { SyncConflictError, SyncContext, SyncRemote, SyncTransport, SyncTransportInfo } from '../api'
import { SyncResponse, expectOK, syncRequest } from './http'

const API = 'https://api.github.com'
const FILENAME = 'tabby-config.yaml'
const DESCRIPTION = 'Tabby config sync'
const USER_AGENT = 'Tabby-config-sync'

interface GistFile {
    content?: string
    truncated?: boolean
    raw_url?: string
}

interface Gist {
    id: string
    updated_at: string
    files: Record<string, GistFile|null>
    history?: { version: string }[]
}

/** One call against the Gist API, relative to `API`. */
interface GistRequest {
    method: string
    path: string
    body?: string
}

function parse<T> (response: SyncResponse): T {
    try {
        return JSON.parse(response.body) as T
    } catch {
        throw new Error(`GitHub returned a malformed response: ${response.body.slice(0, 200)}`)
    }
}

/**
 * The commit SHA is the only strictly monotonic revision the Gist API exposes;
 * `updated_at` has one-second granularity and is the documented fallback.
 */
function revisionOf (gist: Gist): string {
    return gist.history?.[0]?.version ?? gist.updated_at
}

/**
 * Stores the config document as a single file inside a secret GitHub Gist.
 *
 * The Gist API has no conditional-write header, so concurrency is enforced by
 * re-reading the gist immediately before writing and comparing revisions. That
 * leaves a small race window, but the loser only ever sees a conflict on its
 * next cycle - it never silently overwrites a revision it has not seen.
 */
@Injectable()
export class GithubGistSyncTransport extends SyncTransport {
    readonly info: SyncTransportInfo = {
        id: 'github-gist',
        name: 'GitHub Gist',
        icon: 'fab fa-github',
        description: 'Keeps the config in a private Gist. Created automatically on the first upload.',
        secretLabel: 'Personal access token',
        secretPlaceholder: 'ghp_... or github_pat_...',
        helpUrl: 'https://github.com/settings/tokens/new?scopes=gist&description=Tabby%20config%20sync',
        fields: [
            {
                key: 'gistId',
                label: 'Gist ID',
                type: 'text',
                placeholder: 'created automatically',
                hint: 'Leave empty to create a new private Gist. Copy it here to reuse an existing one.',
            },
        ],
    }

    async read (ctx: SyncContext): Promise<SyncRemote|null> {
        const gist = await this.fetchGist(ctx)
        if (!gist) {
            return null
        }
        const file = gist.files[FILENAME]
        if (!file) {
            return null
        }
        return {
            content: await this.readFile(file),
            revision: revisionOf(gist),
        }
    }

    async write (ctx: SyncContext, content: string, expectedRevision: string|null): Promise<string|null> {
        const files = { [FILENAME]: { content } }

        if (!ctx.options.gistId) {
            const created = await this.send<Gist>(
                ctx,
                { method: 'POST', path: '/gists', body: JSON.stringify({ description: DESCRIPTION, 'public': false, files }) },
                'Creating the Gist',
            )
            // Persisted by SyncService when it saves the sync state.
            ctx.options.gistId = created.id
            return revisionOf(created)
        }

        if (expectedRevision) {
            const current = await this.fetchGist(ctx)
            if (current && revisionOf(current) !== expectedRevision) {
                throw new SyncConflictError()
            }
        }

        const updated = await this.send<Gist>(
            ctx,
            {
                method: 'PATCH',
                path: `/gists/${ctx.options.gistId}`,
                body: JSON.stringify({ description: DESCRIPTION, files }),
            },
            'Updating the Gist',
        )
        return revisionOf(updated)
    }

    async validate (ctx: SyncContext): Promise<void> {
        expectOK(await this.request(ctx, { method: 'GET', path: '/user' }), 'Checking the GitHub token')
        if (ctx.options.gistId && !await this.fetchGist(ctx)) {
            throw new Error(`Gist ${ctx.options.gistId} not found, or the token cannot see it`)
        }
    }

    private async fetchGist (ctx: SyncContext): Promise<Gist|null> {
        if (!ctx.options.gistId) {
            return null
        }
        const response = await this.request(ctx, { method: 'GET', path: `/gists/${ctx.options.gistId}` })
        if (response.status === 404) {
            return null
        }
        return parse<Gist>(expectOK(response, 'Reading the Gist'))
    }

    /**
     * Gists over ~1 MB come back truncated with a pointer to the raw blob. The
     * raw host is unauthenticated (the URL carries the commit SHA and is
     * unguessable for a secret gist), so the token is deliberately not sent.
     */
    private async readFile (file: GistFile): Promise<string> {
        if (!file.truncated) {
            return file.content ?? ''
        }
        if (!file.raw_url) {
            throw new Error('Gist content was truncated and no raw URL was returned')
        }
        const what = 'Reading the Gist blob'
        const response = await syncRequest(file.raw_url, {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT },
        }, what)
        return expectOK(response, what).body
    }

    private request (ctx: SyncContext, { method, path, body }: GistRequest): Promise<SyncResponse> {
        return syncRequest(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${ctx.secret}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                // GitHub rejects API requests without one.
                'User-Agent': USER_AGENT,
                'Content-Type': body ? 'application/json' : undefined,
            },
            body,
        }, `GitHub ${method} ${path}`)
    }

    /** POST/PATCH JSON and decode the response, failing loudly on non-2xx. */
    private async send<T> (ctx: SyncContext, request: GistRequest, what: string): Promise<T> {
        return parse<T>(expectOK(await this.request(ctx, request), what))
    }
}
