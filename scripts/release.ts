import { createHash, createPrivateKey, sign } from "node:crypto"
import { basename } from "node:path"
import { mkdir } from "node:fs/promises"
import { verifyManifest, type ReleaseManifest } from "../src/update/protocol"
import { RELEASE_REPOSITORY } from "../src/update/trust"
import pkg from "../package.json"

const [version, ...paths] = process.argv.slice(2)
if (!version || !paths.length) throw new Error("Usage: bun scripts/release.ts v1.2.3 <binaries...>")
if (version !== `v${pkg.version}`) throw new Error("Release tag must match package.json version")
const key = createPrivateKey(process.env.RELEASE_SIGNING_PRIVATE_KEY ?? "")
if (key.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519 PKCS8 PEM")
const manifest: ReleaseManifest = { schema: 1, repository: RELEASE_REPOSITORY, version, assets: [] }
for (const path of paths) {
  const bytes = await Bun.file(path).arrayBuffer()
  manifest.assets.push({ name: basename(path), size: bytes.byteLength, sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex") })
}
const bytes = Buffer.from(JSON.stringify(manifest)), signature = sign(null, bytes, key)
// Also ensures the Actions secret matches the public key embedded in this checkout.
verifyManifest(bytes, signature)
await mkdir("release", { recursive: true })
await Bun.write("release/manifest.json", bytes)
await Bun.write("release/manifest.sig", signature)
