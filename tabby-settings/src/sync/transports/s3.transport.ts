import { createHash, createHmac } from 'crypto'
import { Injectable } from '@angular/core'

import { SyncConflictError, SyncContext, SyncRemote, SyncTransport, SyncTransportInfo } from '../api'
import { SyncResponse, expectOK, header, normalizeETag, syncRequest } from './http'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'

/**
 * S3 canonicalization encodes every path character except the unreserved set,
 * which `encodeURIComponent` leaves out for `!'()*`.
 */
function encodeSegment (value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function sha256 (value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Path-style (`endpoint/bucket/key`) for compatible providers, because most of
 * them do not offer per-bucket subdomains; virtual-hosted style for real S3,
 * where path-style is deprecated.
 */
function objectURL (ctx: SyncContext): URL {
    const bucket = encodeSegment(ctx.options.bucket!)
    const key = (ctx.options.key ?? '').split('/').filter(Boolean).map(encodeSegment).join('/')
    if (!key) {
        throw new Error('S3 object key is empty')
    }
    const endpoint = ctx.options.endpoint?.trim()
    if (endpoint) {
        return new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`)
    }
    return new URL(`https://${ctx.options.bucket}.${SERVICE}.${ctx.options.region}.amazonaws.com/${key}`)
}

/** The parts of an outgoing request that SigV4 covers. */
interface SignedRequest {
    method: string
    url: URL
    headers: Record<string, string|undefined>
    body: string
}

/** SigV4, as specified for S3 (single-encoded path, `x-amz-content-sha256` required). */
function sign (ctx: SyncContext, { method, url, headers: extraHeaders, body }: SignedRequest): Record<string, string> {
    const now = new Date()
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256(body)

    const headers: Record<string, string> = {
        // Signed explicitly so the value we hash is the one that goes on the wire.
        Host: url.host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
    }
    for (const [key, value] of Object.entries(extraHeaders)) {
        if (value !== undefined) {
            headers[key] = value
        }
    }

    const canonicalNames = Object.keys(headers).map(name => name.toLowerCase()).sort()
    const lowered: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
        lowered[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ')
    }

    const canonicalRequest = [
        method,
        url.pathname,
        '',
        canonicalNames.map(name => `${name}:${lowered[name]}`).join('\n') + '\n',
        canonicalNames.join(';'),
        payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/${ctx.options.region}/${SERVICE}/aws4_request`
    const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n')

    let key = Buffer.from(`AWS4${ctx.secret}`, 'utf8')
    for (const part of [dateStamp, ctx.options.region!, SERVICE, 'aws4_request']) {
        key = createHmac('sha256', key).update(part, 'utf8').digest()
    }
    const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex')

    headers.Authorization = `${ALGORITHM} ` + [
        `Credential=${ctx.options.accessKeyId}/${scope}`,
        `SignedHeaders=${canonicalNames.join(';')}`,
        `Signature=${signature}`,
    ].join(', ')
    return headers
}

/**
 * S3 and every API-compatible service: MinIO, Backblaze B2, Wasabi,
 * Cloudflare R2, Hetzner, Scaleway.
 *
 * Requests are signed with SigV4 here rather than through the AWS SDK: the SDK
 * is a multi-megabyte dependency for exactly two operations, and signing is
 * ~40 lines. Conditional writes use `If-Match`, supported by S3 since 2024 and
 * by MinIO; a provider that ignores it loses only the early conflict signal,
 * because the revision compare still catches the overwrite on the next cycle.
 */
@Injectable()
export class S3SyncTransport extends SyncTransport {
    readonly info: SyncTransportInfo = {
        id: 's3',
        name: 'S3',
        icon: 'fas fa-cloud',
        description: 'Amazon S3 or any compatible service: MinIO, Backblaze B2, Wasabi, R2.',
        secretLabel: 'Secret access key',
        secretPlaceholder: 'Secret access key',
        fields: [
            {
                key: 'bucket',
                label: 'Bucket',
                type: 'text',
                required: true,
            },
            {
                key: 'key',
                label: 'Object key',
                type: 'text',
                required: true,
                placeholder: 'tabby/config.yaml',
            },
            {
                key: 'region',
                label: 'Region',
                type: 'text',
                required: true,
                placeholder: 'eu-central-1',
                hint: 'Cloudflare R2 uses "auto".',
            },
            {
                key: 'accessKeyId',
                label: 'Access key ID',
                type: 'text',
                required: true,
            },
            {
                key: 'endpoint',
                label: 'Endpoint',
                type: 'url',
                placeholder: 'leave empty for Amazon S3',
                hint: 'Base URL of a compatible provider. Requests then use path-style addressing.',
            },
        ],
    }

    async read (ctx: SyncContext): Promise<SyncRemote|null> {
        const response = await this.request(ctx, 'GET')
        if (response.status === 404) {
            return null
        }
        expectOK(response, 'Reading the S3 object')
        return {
            content: response.body,
            revision: normalizeETag(header(response, 'etag')),
        }
    }

    async write (ctx: SyncContext, content: string, expectedRevision: string|null): Promise<string|null> {
        const response = await this.request(ctx, 'PUT', {
            body: content,
            headers: {
                'Content-Type': 'application/x-yaml',
                // No revision means create-or-force: the caller owns that decision.
                'If-Match': expectedRevision ? `"${expectedRevision}"` : undefined,
            },
        })
        // 412 is the documented precondition failure; 409 is what S3 returns when
        // two conditional writes race each other.
        if (response.status === 412 || response.status === 409) {
            throw new SyncConflictError()
        }
        expectOK(response, 'Writing the S3 object')
        return normalizeETag(header(response, 'etag'))
    }

    async validate (ctx: SyncContext): Promise<void> {
        const response = await this.request(ctx, 'HEAD')
        if (response.status === 404) {
            // Not created yet is fine; the first upload will create it.
            return
        }
        expectOK(response, 'Checking the S3 object')
    }

    private request (
        ctx: SyncContext,
        method: string,
        { headers = {}, body }: { headers?: Record<string, string|undefined>, body?: string } = {},
    ): Promise<SyncResponse> {
        const url = objectURL(ctx)
        const what = `S3 ${method} ${url.pathname}`
        return syncRequest(url.toString(), {
            method,
            headers: sign(ctx, { method, url, headers, body: body ?? '' }),
            body,
        }, what)
    }
}
