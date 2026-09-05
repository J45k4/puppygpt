import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { JsonObject } from "./agent/types"

// Version | 12-byte nonce | 16-byte authentication tag | ciphertext.
export class CredentialVault {
    constructor(readonly keyPath: string, private hasEncryptedCredentials: () => boolean) {}
    private key(): Buffer {
        if (!existsSync(this.keyPath)) {
            if (this.hasEncryptedCredentials()) throw new Error("Credential encryption key is missing. Restore auth.key from backup.")
            mkdirSync(dirname(this.keyPath), { recursive: true, mode: 0o700 })
            const temporary = `${this.keyPath}.${crypto.randomUUID()}.tmp`
            try {
                writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: "wx", flush: true })
                try {
                    linkSync(temporary, this.keyPath)
                    const directory = openSync(dirname(this.keyPath), "r")
                    try { fsyncSync(directory) } finally { closeSync(directory) }
                } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e }
            } finally { if (existsSync(temporary)) unlinkSync(temporary) }
        }
        const key = readFileSync(this.keyPath)
        if (key.length !== 32) throw new Error("Credential encryption key is invalid. Restore auth.key from backup.")
        chmodSync(this.keyPath, 0o600)
        return key
    }
    encrypt(id: string, raw: JsonObject): Buffer {
        const nonce = randomBytes(12)
        const cipher = createCipheriv("aes-256-gcm", this.key(), nonce)
        cipher.setAAD(Buffer.from(`puppygpt:account-auth:v1:${id}`))
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(raw), "utf8"), cipher.final()])
        return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
    }
    decrypt(id: string, blob: Uint8Array): JsonObject {
        const key = this.key()
        try {
            const bytes = Buffer.from(blob)
            if (bytes.length < 30 || bytes[0] !== 1) throw new Error()
            const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13))
            cipher.setAAD(Buffer.from(`puppygpt:account-auth:v1:${id}`))
            cipher.setAuthTag(bytes.subarray(13, 29))
            return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString("utf8"))
        } catch { throw new Error("Could not decrypt account credentials. Check the encryption key and database backup.") }
    }
}
