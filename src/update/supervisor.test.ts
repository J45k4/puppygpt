import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, generateKeyPairSync, sign } from "node:crypto"

async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await Bun.sleep(100) }
  throw new Error("Timed out waiting for supervisor")
}
for (const scenario of ["success", "rollback", "busy"] as const) test(`supervisor ${scenario} with signed release and real child processes`, async () => {
  const root = await mkdtemp(join(tmpdir(), "puppygpt-update-test-"))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    await mkdir(join(root, "src/update"), { recursive: true })
    for (const file of ["supervisor.ts", "protocol.ts"]) await Bun.write(join(root, "src/update", file), Bun.file(join(import.meta.dir, file)))
    await Bun.write(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }))
    const keys = generateKeyPairSync("ed25519")
    await Bun.write(join(root, "src/update/trust.ts"), `export const RELEASE_REPOSITORY = "J45k4/puppygpt"; export const RELEASE_PUBLIC_KEY = ${JSON.stringify(keys.publicKey.export({ type: "spki", format: "pem" }).toString())}`)
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = probe.port!
    await probe.stop(true)
    const app = (version: string) => `#!${process.execPath}\nawait Bun.write(${JSON.stringify(join(root, `${version}.started`))}, "started");
${version === "new" && scenario === "rollback" ? "process.exit(1)" : `Bun.serve({hostname:"127.0.0.1",port:${port},fetch:()=>Response.json({token:process.env.PUPPYGPT_HEALTH_TOKEN,busy:${scenario === "busy"}})});`}`
    const initial = join(root, "initial")
    await Bun.write(initial, app("old")); await chmod(initial, 0o700)
    const payload = Buffer.from(app("new"))
    const name = `puppygpt-${process.platform}-${process.arch}`
    const manifest = Buffer.from(JSON.stringify({ schema: 1, repository: "J45k4/puppygpt", version: "v0.2.0", assets: [{ name, size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") }] }))
    await Bun.write(join(root, "manifest.json"), manifest)
    await Bun.write(join(root, "manifest.sig"), sign(null, manifest, keys.privateKey))
    await Bun.write(join(root, name), payload)
    await Bun.write(join(root, "runner.ts"), `import { supervise } from "./src/update/supervisor";
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url, options) => {
  const value = String(url);
  if (value.startsWith("https://api.github.com/")) return Response.json({tag_name:"v0.2.0",draft:false,prerelease:false});
  if (value.startsWith("https://github.com/")) return new Response(Bun.file(${JSON.stringify(root)} + "/" + value.split("/").at(-1)));
  return originalFetch(url,options);
}) as typeof fetch;
await supervise();`)
    child = Bun.spawn([process.execPath, join(root, "runner.ts")], { cwd: root, env: { ...process.env, PORT: String(port), PUPPYGPT_INITIAL_BINARY: initial, PUPPYGPT_UPDATE_DIR: join(root, "updates"), PUPPYGPT_WORKDIR: root }, stdout: "pipe", stderr: "pipe" })
    if (scenario === "success") {
      await eventually(() => Bun.file(join(root, "updates/current.json")).exists())
      expect(await Bun.file(join(root, "updates/current.json")).json()).toEqual({ version: "v0.2.0" })
      expect(await Bun.file(join(root, "new.started")).exists()).toBeTrue()
    } else if (scenario === "rollback") {
      await eventually(() => Bun.file(join(root, "new.started")).exists())
      await Bun.sleep(1200)
      expect(child.exitCode).toBeNull()
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(response.ok).toBeTrue()
      expect(await Bun.file(join(root, "updates/current.json")).exists()).toBeFalse()
    } else {
      await eventually(() => Bun.file(join(root, "updates/v0.2.0", name)).exists())
      await Bun.sleep(500)
      expect(await Bun.file(join(root, "new.started")).exists()).toBeFalse()
      expect(await Bun.file(join(root, "updates/current.json")).exists()).toBeFalse()
    }
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    child = undefined
    expect(await Bun.file(join(root, "old.started")).exists()).toBeTrue()
  } finally {
    if (child) { child.kill("SIGTERM"); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
