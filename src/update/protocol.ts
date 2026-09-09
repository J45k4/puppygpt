import { createHash, createPublicKey, verify } from "node:crypto"
import { RELEASE_PUBLIC_KEY, RELEASE_REPOSITORY } from "./trust"

export interface ReleaseManifest {
  schema: 1
  repository: string
  version: string
  assets: { name: string; sha256: string; size: number }[]
}
export function versionParts(version: string): number[] {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected stable vMAJOR.MINOR.PATCH version")
  const parts = version.slice(1).split(".").map(Number)
  if (parts.some(p => !Number.isSafeInteger(p))) throw new Error("Version out of range")
  return parts
}
export function newer(candidate: string, current: string): boolean {
  const a = versionParts(candidate), b = versionParts(current)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}
export function verifyManifest(bytes: Uint8Array, signature: Uint8Array, publicKey = RELEASE_PUBLIC_KEY): ReleaseManifest {
  if (!publicKey) throw new Error("Release verification public key has not been configured")
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || !verify(null, bytes, key, signature)) throw new Error("Invalid release signature")
  const m = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseManifest
  if (m.schema !== 1 || m.repository !== RELEASE_REPOSITORY) throw new Error("Invalid release identity")
  versionParts(m.version)
  if (!Array.isArray(m.assets) || !m.assets.length || m.assets.length > 8) throw new Error("Invalid release assets")
  const names = new Set<string>()
  for (const a of m.assets) {
    if (!/^puppygpt-(linux|darwin)-(x64|arm64)$/.test(a.name) || names.has(a.name) || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > 256 * 1024 * 1024) throw new Error("Invalid release asset")
    names.add(a.name)
  }
  return m
}
export function verifyAsset(bytes: Uint8Array, asset: ReleaseManifest["assets"][number]) {
  if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Release asset checksum mismatch")
}
export async function download(url: string, limit: number): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "PuppyGPT-Updater" } })
  if (!response.ok || !response.body) throw new Error(`Release download failed: HTTP ${response.status}`)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error("Release download exceeds size limit")
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}
