import { Injectable } from '@angular/core'
import { ConfigService, VaultService } from 'tabby-core'

export const VAULT_SECRET_TYPE_SYNC = 'sync:secret'

/**
 * Storage for the single per-transport secret (token / password / secret key).
 *
 * Policy, in order of preference:
 *  1. Tabby's vault - PBKDF2(100k, sha512) + AES-256-CBC under the user's
 *     passphrase. This is the only supported secure location.
 *  2. Plaintext in `config.yaml`, and only when the user explicitly opted in
 *     via `sync.allowPlaintextSecret`. There is deliberately no third option:
 *     a hardcoded/derived key would be obfuscation, not encryption.
 *
 * The secret is never written into the synced payload, so it never leaves the
 * machine even when the rest of the config is uploaded.
 */
@Injectable({ providedIn: 'root' })
export class SyncSecretStore {
    constructor (
        private config: ConfigService,
        private vault: VaultService,
    ) { }

    /** True when the vault exists and can hold secrets. */
    isVaultAvailable (): boolean {
        return !!this.vault.store
    }

    /** True when a secret can be persisted at all right now. */
    canStore (): boolean {
        return this.isVaultAvailable() || this.config.store.sync.allowPlaintextSecret
    }

    /** True when the secret currently lives unencrypted in config.yaml. */
    isPlaintext (transport: string): boolean {
        return !!this.config.store.sync.transports[transport]?.secretPlaintext
    }

    /**
     * Read the secret for a transport. May prompt for the vault passphrase.
     * @returns the secret, or `''` when none is stored.
     */
    async get (transport: string): Promise<string> {
        const plaintext = this.config.store.sync.transports[transport]?.secretPlaintext
        if (plaintext) {
            return plaintext
        }
        if (!this.isVaultAvailable()) {
            return ''
        }
        const secret = await this.vault.getSecret(VAULT_SECRET_TYPE_SYNC, { transport })
        return secret?.value ?? ''
    }

    /** Returns true when a secret is stored, without unlocking the vault. */
    async has (transport: string): Promise<boolean> {
        if (this.isPlaintext(transport)) {
            return true
        }
        if (!this.isVaultAvailable() || !this.vault.isOpen()) {
            // Can't tell without prompting; assume configured so auto-sync
            // gets a chance to unlock on demand.
            return this.isVaultAvailable()
        }
        return !!await this.vault.getSecret(VAULT_SECRET_TYPE_SYNC, { transport })
    }

    /**
     * Persist the secret. Prefers the vault; falls back to plaintext only with
     * an explicit opt-in.
     * @throws when neither location is available.
     */
    async set (transport: string, value: string): Promise<void> {
        if (!value) {
            await this.clear(transport)
            return
        }
        const options = this.config.store.sync.transports[transport] ??= {}
        if (this.isVaultAvailable()) {
            delete options.secretPlaintext
            await this.config.save()
            await this.vault.addSecret({
                type: VAULT_SECRET_TYPE_SYNC,
                key: { transport },
                value,
            })
            return
        }
        if (!this.config.store.sync.allowPlaintextSecret) {
            throw new Error('Enable the vault to store the sync credential, or explicitly allow plaintext storage')
        }
        options.secretPlaintext = value
        await this.config.save()
    }

    async clear (transport: string): Promise<void> {
        if (this.config.store.sync.transports[transport]?.secretPlaintext) {
            delete this.config.store.sync.transports[transport].secretPlaintext
            await this.config.save()
        }
        if (this.isVaultAvailable()) {
            await this.vault.removeSecret(VAULT_SECRET_TYPE_SYNC, { transport })
        }
    }
}
