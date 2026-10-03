import { Provider } from '@angular/core'

import { SyncTransport } from '../api'
import { GithubGistSyncTransport } from './githubGist.transport'
import { LocalFileSyncTransport } from './localFile.transport'
import { S3SyncTransport } from './s3.transport'
import { WebDAVSyncTransport } from './webdav.transport'

/**
 * Every built-in transport, registered under the `SyncTransport` multi-token.
 *
 * Third-party plugins extend sync by adding their own provider against the same
 * token - `SyncService` and the settings UI discover them without changes.
 */
export const SYNC_TRANSPORT_PROVIDERS: Provider[] = [
    { provide: SyncTransport, useClass: GithubGistSyncTransport, multi: true },
    { provide: SyncTransport, useClass: WebDAVSyncTransport, multi: true },
    { provide: SyncTransport, useClass: S3SyncTransport, multi: true },
    { provide: SyncTransport, useClass: LocalFileSyncTransport, multi: true },
]

export { GithubGistSyncTransport, WebDAVSyncTransport, S3SyncTransport, LocalFileSyncTransport }
