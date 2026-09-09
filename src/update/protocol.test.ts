import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { download, newer, verifyAsset, verifyManifest } from "./protocol"
import { RELEASE_REPOSITORY } from "./trust"

const keys = generateKeyPairSync("ed25519")
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
const payload = Buffer.from("verified binary")
const asset = { name: "puppygpt-linux-x64", size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") }
const manifest = { schema: 1 as const, repository: RELEASE_REPOSITORY, version: "v1.2.3", assets: [asset] }
function signed(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  return [bytes, sign(null, bytes, keys.privateKey), publicKey] as const
}
describe("signed release trust", () => {
  test("accepts authentic manifest and exact payload", () => {
    expect(verifyManifest(...signed(manifest))).toEqual(manifest)
    expect(() => verifyAsset(payload, asset)).not.toThrow()
  })
  test("rejects unset trust anchor", () => {
    const [bytes, signature] = signed(manifest)
    expect(() => verifyManifest(bytes, signature, "")).toThrow("not been configured")
  })
  test("rejects tampering, wrong keys and truncated signatures", () => {
    const [bytes, signature] = signed(manifest)
    expect(() => verifyManifest(Buffer.concat([bytes, Buffer.from(" ")]), signature, publicKey)).toThrow("signature")
    expect(() => verifyManifest(bytes, signature.subarray(1), publicKey)).toThrow("signature")
    const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
    expect(() => verifyManifest(bytes, signature, wrongKey)).toThrow("signature")
    expect(() => verifyAsset(Buffer.from("changed binary!"), asset)).toThrow("checksum")
    expect(() => verifyAsset(payload.subarray(1), asset)).toThrow("checksum")
  })
  test("rejects signed but invalid identities, paths, sizes and versions", () => {
    for (const value of [
      { ...manifest, repository: "attacker/repo" },
      { ...manifest, schema: 2 },
      { ...manifest, version: "../../outside" },
      { ...manifest, version: "v1.2.3-beta" },
      { ...manifest, assets: [{ ...asset, name: "../puppygpt-linux-x64" }] },
      { ...manifest, assets: [{ ...asset, size: 300 * 1024 * 1024 }] },
      { ...manifest, assets: [asset, asset] },
    ]) expect(() => verifyManifest(...signed(value))).toThrow()
  })
  test("version ordering prevents downgrade and replay", () => {
    expect(newer("v1.10.0", "v1.9.9")).toBeTrue()
    expect(newer("v1.9.9", "v1.10.0")).toBeFalse()
    expect(newer("v1.10.0", "v1.10.0")).toBeFalse()
    expect(() => newer("v01.1.0", "v1.0.0")).toThrow()
  })
  test("download bounds apply even without Content-Length", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(payload); c.close() } })) })
    try {
      expect(await download(server.url.href, payload.length)).toEqual(payload)
      await expect(download(server.url.href, payload.length - 1)).rejects.toThrow("size limit")
    } finally { await server.stop(true) }
  })
})
