import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { Injectable } from '@angular/core'

import { SyncConflictError, SyncContext, SyncRemote, SyncTransport, SyncTransportInfo } from '../api'

/** `~` is what users actually type, and no shell expands it for us here. */
function resolvePath (ctx: SyncContext): string {
    const value = (ctx.options.path ?? '').trim()
    if (!value) {
        throw new Error('Sync file path is empty')
    }
    const home = process.env.HOME ?? process.env.USERPROFILE
    const expanded = home && /^~($|[/\\])/.test(value) ? home + value.slice(1) : value
    return path.resolve(expanded)
}

function hash (content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Stores the config document in a plain file.
 *
 * The point is to delegate transport to whatever already replicates a folder:
 * Syncthing, the Dropbox/Nextcloud/Drive desktop clients, an NFS or SMB mount,
 * a git-annex checkout. No credentials, no network code, no provider API to
 * break - and it is the only option that works fully offline.
 *
 * The revision is the content hash, which makes conflict detection exact rather
 * than timestamp-based.
 */
@Injectable()
export class LocalFileSyncTransport extends SyncTransport {
    readonly info: SyncTransportInfo = {
        id: 'local-file',
        name: 'Local file',
        icon: 'fas fa-folder-open',
        secretLabel: null,
        description: 'A file in a folder that something else replicates: Syncthing, Dropbox, an NFS mount.',
        fields: [
            {
                key: 'path',
                label: 'File path',
                type: 'text',
                required: true,
                placeholder: '~/Sync/tabby-config.yaml',
                hint: 'Created on the first upload, together with its parent folders.',
            },
        ],
    }

    async read (ctx: SyncContext): Promise<SyncRemote|null> {
        const content = await this.readFile(ctx)
        if (content === null) {
            return null
        }
        return { content, revision: hash(content) }
    }

    async write (ctx: SyncContext, content: string, expectedRevision: string|null): Promise<string|null> {
        if (expectedRevision) {
            const current = await this.readFile(ctx)
            if (current !== null && hash(current) !== expectedRevision) {
                throw new SyncConflictError()
            }
        }
        const target = resolvePath(ctx)
        await fs.mkdir(path.dirname(target), { recursive: true })
        // Write-then-rename so a crash or a mid-write read by the replication
        // agent can never observe a truncated config.
        const temporary = `${target}.tabby-sync.tmp`
        await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temporary, target)
        return hash(content)
    }

    async validate (ctx: SyncContext): Promise<void> {
        const target = resolvePath(ctx)
        const parent = path.dirname(target)
        try {
            await fs.access(parent)
        } catch {
            throw new Error(`Folder does not exist: ${parent}`)
        }
        const stat = await fs.stat(target).catch(() => null)
        if (stat && !stat.isFile()) {
            throw new Error(`Not a regular file: ${target}`)
        }
    }

    private async readFile (ctx: SyncContext): Promise<string|null> {
        try {
            return await fs.readFile(resolvePath(ctx), 'utf8')
        } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') {
                return null
            }
            throw error
        }
    }
}
