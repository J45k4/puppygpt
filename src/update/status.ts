import pkg from "../../package.json"
import { download, newer, verifyManifest } from "./protocol"
import { RELEASE_PUBLIC_KEY, RELEASE_REPOSITORY } from "./trust"

export interface UpdateStatus {
  currentVersion: string
  available: boolean
  version?: string
  releaseUrl?: string
  verification?: "verified" | "unconfigured"
}

// Shared across tabs; only user-facing status checks initiate network requests.
export function createUpdateStatus(read = download, publicKey = RELEASE_PUBLIC_KEY, now = Date.now) {
  let cached: UpdateStatus = { currentVersion: `v${pkg.version}`, available: false }
  let expires = 0
  let pending: Promise<UpdateStatus> | undefined
  return (): Promise<UpdateStatus> => {
    if (pending) return pending
    if (now() < expires) return Promise.resolve(cached)
    pending = (async () => {
      try {
        const release = JSON.parse(new TextDecoder().decode(await read(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, 1024 * 1024)))
        const result: UpdateStatus = { currentVersion: `v${pkg.version}`, available: false }
        if (release.draft === false && release.prerelease === false && newer(release.tag_name, result.currentVersion)) {
          const version: string = release.tag_name
          if (publicKey) {
            const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${version}`
            const manifest = verifyManifest(await read(`${base}/manifest.json`, 64 * 1024), await read(`${base}/manifest.sig`, 64), publicKey)
            if (manifest.version !== version) throw new Error("Release version mismatch")
            if (!manifest.assets.some(a => a.name === `puppygpt-${process.platform}-${process.arch}`)) throw new Error("Unsupported platform")
          }
          Object.assign(result, { available: true, version, releaseUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${version}`, verification: publicKey ? "verified" : "unconfigured" })
        }
        cached = result
        expires = now() + 15 * 60_000
      } catch {
        // Fail quietly for offline, unpublished, rate-limited, or invalid releases.
        cached = { currentVersion: `v${pkg.version}`, available: false }
        expires = now() + 5 * 60_000
      } finally { pending = undefined }
      return cached
    })()
    return pending
  }
}
export const getUpdateStatus = createUpdateStatus()
