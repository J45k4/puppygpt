import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { createUpdateStatus } from "./status"
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const release = { tag_name: "v9.0.0", draft: false, prerelease: false }
test("new release is reported without claiming verification before key setup; checks are cached", async () => {
    let calls = 0
    const status = createUpdateStatus(async () => { calls++; return bytes(release) }, "")
    const results = await Promise.all([status(), status()])
    expect(results[0]).toMatchObject({ available: true, version: "v9.0.0", verification: "unconfigured", releaseUrl: "https://github.com/J45k4/puppygpt/releases/tag/v9.0.0" })
    await status()
    expect(calls).toBe(1)
})
test("old, draft, prerelease and malformed versions have no update icon", async () => {
    for (const value of [{ ...release, tag_name: "v0.0.0" }, { ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: "../../evil" }]) {
        expect((await createUpdateStatus(async () => bytes(value), "")()).available).toBeFalse()
    }
})
test("network failure is quiet and retried after the error cache expires", async () => {
    let time = 1, calls = 0
    const status = createUpdateStatus(async () => { if (++calls === 1) throw new Error("offline"); return bytes(release) }, "", () => time)
    expect((await status()).available).toBeFalse()
    await status(); expect(calls).toBe(1)
    time += 300_001
    expect((await status()).available).toBeTrue()
})
test("configured key requires authentic manifest for this platform and release", async () => {
    const keys = generateKeyPairSync("ed25519")
    const key = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
    const manifest = bytes({ schema: 1, repository: "J45k4/puppygpt", version: "v9.0.0", assets: [{ name: `puppygpt-${process.platform}-${process.arch}`, size: 10, sha256: "a".repeat(64) }] })
    const signature = sign(null, manifest, keys.privateKey)
    const read = async (url: string) => url.endsWith("manifest.sig") ? signature : url.endsWith("manifest.json") ? manifest : bytes(release)
    expect((await createUpdateStatus(read, key)()).verification).toBe("verified")
    const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
    expect((await createUpdateStatus(read, wrong)()).available).toBeFalse()
})
