import { Injectable } from '@angular/core'

import { SyncConflictError, SyncContext, SyncRemote, SyncTransport, SyncTransportInfo } from '../api'
import { SyncResponse, expectOK, header, normalizeETag, syncRequest } from './http'

/**
 * `404` is the normal answer for a file that does not exist yet. `409` is what
 * WebDAV returns when an ancestor collection is missing, and `410` when the
 * resource was deleted - both mean "nothing stored here" for our purposes.
 */
function isMissing (response: SyncResponse): boolean {
    return [404, 409, 410].includes(response.status)
}

/**
 * Plain HTTP file storage: Nextcloud, ownCloud, Apache `mod_dav`, Synology,
 * anything that speaks `GET`/`PUT` with Basic auth.
 *
 * Conditional writes use `If-Match`, which is core HTTP (RFC 9110) and required
 * of WebDAV servers, so a server ignoring it is misbehaving - and even then the
 * overwrite is caught on the next cycle by the revision compare.
 */
@Injectable()
export class WebDAVSyncTransport extends SyncTransport {
    readonly info: SyncTransportInfo = {
        id: 'webdav',
        name: 'WebDAV',
        icon: 'fas fa-hdd',
        description: 'Any WebDAV server: Nextcloud, ownCloud, Synology, mod_dav.',
        secretLabel: 'Password',
        secretPlaceholder: 'Account or app password',
        fields: [
            {
                key: 'url',
                label: 'File URL',
                type: 'url',
                required: true,
                placeholder: 'https://cloud.example.com/remote.php/dav/files/me/tabby-config.yaml',
                hint: 'Full URL of the file itself. Parent folders must already exist.',
            },
            {
                key: 'username',
                label: 'Username',
                type: 'text',
                required: true,
            },
        ],
    }

    async read (ctx: SyncContext): Promise<SyncRemote|null> {
        const response = await this.request(ctx, 'GET')
        if (isMissing(response)) {
            return null
        }
        expectOK(response, 'Reading the WebDAV file')
        return {
            content: response.body,
            revision: normalizeETag(header(response, 'etag')),
        }
    }

    async write (ctx: SyncContext, content: string, expectedRevision: string|null): Promise<string|null> {
        const response = await this.request(ctx, 'PUT', {
            headers: {
                'Content-Type': 'application/x-yaml',
                // No revision means create-or-force: the caller owns that decision.
                'If-Match': expectedRevision ? `"${expectedRevision}"` : undefined,
            },
            body: content,
        })
        if (response.status === 412) {
            throw new SyncConflictError()
        }
        expectOK(response, 'Writing the WebDAV file')

        // Most servers answer `204 No Content` with no ETag; re-read to learn it.
        return normalizeETag(header(response, 'etag')) ?? (await this.read(ctx))?.revision ?? null
    }

    async validate (ctx: SyncContext): Promise<void> {
        const response = await this.request(ctx, 'HEAD')
        if (isMissing(response)) {
            // Not created yet is fine; the first upload will create it.
            return
        }
        expectOK(response, 'Checking the WebDAV URL')
    }

    private request (
        ctx: SyncContext,
        method: string,
        { headers = {}, body }: { headers?: Record<string, string|undefined>, body?: string } = {},
    ): Promise<SyncResponse> {
        const credentials = Buffer
            .from(`${ctx.options.username ?? ''}:${ctx.secret}`, 'utf8')
            .toString('base64')
        return syncRequest(ctx.options.url!, {
            method,
            headers: {
                ...headers,
                Authorization: `Basic ${credentials}`,
            },
            body,
        }, `WebDAV ${method}`)
    }
}
