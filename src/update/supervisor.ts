import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { download, newer, verifyAsset, verifyManifest } from "./protocol"
import { RELEASE_PUBLIC_KEY, RELEASE_REPOSITORY } from "./trust"
import pkg from "../../package.json"

// This process remains alive while the application binary is replaced.
export async function supervise(initialBinary?: string) {
  if (!RELEASE_PUBLIC_KEY) throw new Error("Set src/update/trust.ts RELEASE_PUBLIC_KEY before enabling automatic updates")
  const root = resolve(process.env.PUPPYGPT_UPDATE_DIR ?? ".puppygpt/updates")
  const workdir = resolve(process.env.PUPPYGPT_WORKDIR ?? process.cwd())
  const dataDir = resolve(process.env.PUPPYGPT_DATA_DIR ?? ".puppygpt")
  const platform = `puppygpt-${process.platform}-${process.arch}`
  if (!/^puppygpt-(linux|darwin)-(x64|arm64)$/.test(platform)) throw new Error("Unsupported update platform")
  const interval = Number(process.env.PUPPYGPT_UPDATE_INTERVAL_MS ?? 3_600_000)
  if (!Number.isFinite(interval) || interval < 60_000) throw new Error("Update interval must be at least 60000 ms")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lock = join(root, "supervisor.lock")
  await mkdir(lock) // Exclusive ownership; stale locks require manual recovery after SIGKILL.
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stopping = false
  let healthToken = ""
  let stopPromise: Promise<void> | undefined
  const stop = async () => {
    if (!child) return stopPromise
    const previous = child
    child = undefined
    stopPromise = (async () => {
      previous.kill("SIGTERM")
      const timer = setTimeout(() => previous.kill("SIGKILL"), 30_000)
      await previous.exited
      clearTimeout(timer)
    })()
    await stopPromise
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; void stop() })
  const launch = async (binary: string) => {
    const token = crypto.randomUUID()
    healthToken = token
    child = Bun.spawn([binary], { cwd: workdir, env: { ...process.env, NODE_ENV: "production", PUPPYGPT_DATA_DIR: dataDir, PUPPYGPT_WORKDIR: workdir, PUPPYGPT_HEALTH_TOKEN: token }, stdout: "inherit", stderr: "inherit" })
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      if (child.exitCode !== null) break
      try {
        const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) })
        if (r.ok && (await r.json() as { token?: string }).token === token) return
      } catch {}
      await Bun.sleep(500)
    }
    await stop()
    throw new Error("Application failed its startup health check")
  }
  const checkedBinary = async (version: string) => {
    const dir = join(root, version)
    const m = verifyManifest(await Bun.file(join(dir, "manifest.json")).bytes(), await Bun.file(join(dir, "manifest.sig")).bytes())
    if (m.version !== version) throw new Error("Installed release version mismatch")
    const asset = m.assets.find(a => a.name === platform)
    if (!asset) throw new Error("Missing platform asset")
    const binary = join(dir, platform)
    verifyAsset(await Bun.file(binary).bytes(), asset)
    return binary
  }
  let current = `v${pkg.version}`
  let binary = resolve(initialBinary ?? process.env.PUPPYGPT_INITIAL_BINARY ?? "dist/puppygpt")
  try {
    const stateFile = Bun.file(join(root, "current.json"))
    if (await stateFile.exists()) {
      current = (await stateFile.json()).version
      // Validate before using a version as a path component.
      if (newer(`v${pkg.version}`, current)) throw new Error("Saved release is older than the installed supervisor")
      binary = await checkedBinary(current)
    }
    await launch(binary)
    while (!stopping) {
      try {
        const release = JSON.parse(new TextDecoder().decode(await download(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, 1024 * 1024)))
        if (!release.draft && !release.prerelease && newer(release.tag_name, current)) {
          const version: string = release.tag_name
          const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${version}`
          const bytes = await download(`${base}/manifest.json`, 64 * 1024)
          const signature = await download(`${base}/manifest.sig`, 64)
          const manifest = verifyManifest(bytes, signature)
          if (manifest.version !== version) throw new Error("Release tag does not match signed version")
          const asset = manifest.assets.find(a => a.name === platform)
          if (!asset) throw new Error("Release does not support this platform")
          const payload = await download(`${base}/${platform}`, asset.size)
          verifyAsset(payload, asset)
          const stage = join(root, `stage-${crypto.randomUUID()}`), destination = join(root, version)
          await mkdir(stage, { mode: 0o700 })
          try {
            await Bun.write(join(stage, platform), payload)
            await chmod(join(stage, platform), 0o700)
            await Bun.write(join(stage, "manifest.json"), bytes)
            await Bun.write(join(stage, "manifest.sig"), signature)
            await rm(destination, { recursive: true, force: true })
            await rename(stage, destination)
          } finally { await rm(stage, { recursive: true, force: true }) }
          if (stopping) break
          const readiness = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`, { headers: { Authorization: `Bearer ${healthToken}` }, signal: AbortSignal.timeout(1000) })
          const health = await readiness.json() as { token?: string; busy?: boolean }
          if (!readiness.ok || health.token !== healthToken || health.busy !== false) throw new Error("Update deferred until application is healthy and chats are idle")
          await stop()
          try {
            const next = await checkedBinary(version)
            await launch(next)
            await Bun.write(join(root, "current.tmp"), JSON.stringify({ version }))
            await rename(join(root, "current.tmp"), join(root, "current.json"))
            binary = next
            current = version
            console.log(`Updated PuppyGPT to ${version}`)
          } catch (error) {
            await stop()
            if (!stopping) await launch(binary)
            throw error
          }
        }
      } catch (error) { console.error("Automatic update failed:", error instanceof Error ? error.message : String(error)) }
      const until = Date.now() + interval
      while (!stopping && Date.now() < until) {
        if (child?.exitCode !== null) throw new Error("Application exited; supervisor must be restarted")
        await Bun.sleep(500)
      }
    }
  } finally { await stop(); await rm(lock, { recursive: true, force: true }) }
}
if (import.meta.main) await supervise()
