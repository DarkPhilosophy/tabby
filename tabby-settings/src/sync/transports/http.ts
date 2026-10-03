import * as http from 'http'
import * as https from 'https'

import { SyncAuthError } from '../api'

/**
 * HTTP layer shared by every transport.
 *
 * Deliberately built on Node's `http`/`https` rather than `fetch`: the renderer
 * runs with `webSecurity` on, so a `fetch` from the app origin is subject to
 * CORS. Two consequences would break sync outright:
 *
 *  - WebDAV servers and most S3 endpoints send no `Access-Control-Allow-Origin`,
 *    so the request never leaves the renderer.
 *  - Even where CORS is allowed, response headers are hidden unless the server
 *    lists them in `Access-Control-Expose-Headers`. `ETag` almost never is -
 *    and the whole optimistic-concurrency design depends on reading it.
 *
 * Node's stack has neither restriction, and `nodeIntegration` is enabled.
 */

/** Hard ceiling on a remote document; a hostile remote must not exhaust memory. */
const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT = 30000
const MAX_REDIRECTS = 3

export interface SyncRequestOptions {
    method: string
    /** `undefined` values are dropped, so callers can pass conditional headers inline. */
    headers?: Record<string, string|undefined>
    body?: string|Buffer
    timeout?: number
}

export interface SyncResponse {
    status: number
    ok: boolean
    /** Response body decoded as UTF-8. */
    body: string
    /** Lowercased header names; repeated headers are joined with `, `. */
    headers: Record<string, string>
}

function describe (error: unknown, what: string): Error {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(`${what} failed: ${message}`)
}

function cleanHeaders (headers: Record<string, string|undefined> = {}): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
            result[key] = value
        }
    }
    return result
}

function flattenHeaders (headers: http.IncomingHttpHeaders): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue
        }
        result[key] = Array.isArray(value) ? value.join(', ') : value
    }
    return result
}

function isLoopback (hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function parseURL (value: string, what: string): URL {
    try {
        return new URL(value)
    } catch {
        throw new Error(`${what}: not a valid URL: ${value}`)
    }
}

/**
 * Config sync must never run over a cleartext channel: the remote document is
 * parsed as YAML and merged into the local config, including profiles whose
 * `command`/`env` the terminal later executes. A network attacker able to MITM
 * plain HTTP would get arbitrary command execution on the next sync.
 *
 * Loopback is exempt - there is no network to attack, and local MinIO/WebDAV
 * instances are a legitimate setup.
 */
function requireSecureURL (value: string, what: string): URL {
    const url = parseURL(value, what)
    if (url.protocol === 'https:') {
        return url
    }
    if (url.protocol === 'http:' && isLoopback(url.hostname)) {
        return url
    }
    throw new Error(`${what}: refusing to sync config over ${url.protocol}//. Use HTTPS (${value})`)
}

function once (url: URL, options: SyncRequestOptions, what: string): Promise<SyncResponse> {
    const transport = url.protocol === 'https:' ? https : http
    const body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body

    return new Promise<SyncResponse>((resolve, reject) => {
        const request = transport.request(url, {
            method: options.method,
            headers: {
                ...cleanHeaders(options.headers),
                ...body ? { 'Content-Length': String(body.length) } : {},
            },
        }, response => {
            const chunks: Buffer[] = []
            let size = 0
            response.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_BODY_BYTES) {
                    request.destroy()
                    reject(new Error(`${what}: response exceeded ${MAX_BODY_BYTES} bytes`))
                    return
                }
                chunks.push(chunk)
            })
            response.on('end', () => {
                const status = response.statusCode ?? 0
                resolve({
                    status,
                    ok: status >= 200 && status < 300,
                    body: Buffer.concat(chunks).toString('utf8'),
                    headers: flattenHeaders(response.headers),
                })
            })
            response.on('error', error => reject(describe(error, what)))
        })

        request.setTimeout(options.timeout ?? DEFAULT_TIMEOUT, () => {
            request.destroy(new Error(`${what} timed out`))
        })
        request.on('error', error => reject(describe(error, what)))
        if (body) {
            request.write(body)
        }
        request.end()
    })
}

export function header (response: SyncResponse, name: string): string|null {
    return response.headers[name.toLowerCase()] ?? null
}

/**
 * Perform a request and read the whole body.
 *
 * Normalizes the failure modes every transport must distinguish: credential
 * problems (`SyncAuthError`, so the UI can say "check your token") and
 * everything else (plain `Error` carrying the provider's own message).
 * Non-2xx statuses are *returned*, not thrown - `404` in particular means
 * "no document yet" and is a normal part of the protocol.
 */
export async function syncRequest (
    url: string,
    options: SyncRequestOptions,
    what: string,
): Promise<SyncResponse> {
    let target = requireSecureURL(url, what)
    let redirects = 0

    for (;;) {
        const response = await once(target, options, what)
        const { location } = response.headers
        const isRedirect = [301, 302, 303, 307, 308].includes(response.status)

        if (!isRedirect || !location) {
            if (response.status === 401 || response.status === 403) {
                throw new SyncAuthError(`${what} rejected (HTTP ${response.status})`)
            }
            return response
        }

        // Only idempotent, body-less requests may be replayed elsewhere. Redirecting
        // a PUT would resend both the credential and the config to a host the user
        // never named - refuse and let them fix the endpoint.
        if (options.method !== 'GET' && options.method !== 'HEAD') {
            throw new Error(
                `${what} was redirected to ${location} (HTTP ${response.status}). ` +
                'Point the transport at the final URL - redirects are not followed for writes.',
            )
        }
        if (++redirects > MAX_REDIRECTS) {
            throw new Error(`${what} exceeded ${MAX_REDIRECTS} redirects`)
        }
        target = requireSecureURL(new URL(location, target.toString()).toString(), what)
    }
}

/** Raise a descriptive error for a non-2xx response, including the body. */
export function raiseHTTPError (response: SyncResponse, what: string): never {
    const body = response.body.trim()
    const detail = body ? `: ${body.slice(0, 300)}` : ''
    throw new Error(`${what} failed with HTTP ${response.status}${detail}`)
}

export function expectOK (response: SyncResponse, what: string): SyncResponse {
    if (!response.ok) {
        raiseHTTPError(response, what)
    }
    return response
}

/**
 * ETags are quoted and may carry a `W/` weak prefix; providers are not
 * consistent about either, so compare a stripped form.
 */
export function normalizeETag (value: string|null): string|null {
    if (!value) {
        return null
    }
    return value.replace(/^W\//, '').replace(/^"|"$/g, '') || null
}
