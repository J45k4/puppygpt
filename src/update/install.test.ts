import { expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { RELEASE_PUBLIC_KEY } from "./trust"

const source = await Bun.file(join(import.meta.dir, "../../install.sh")).text()
test("installer uses the same embedded release trust anchor", () => {
    expect(source).toContain(`PUBLIC_KEY='${RELEASE_PUBLIC_KEY}'`)
})
for (const scenario of ["valid", "tampered", "bad-signature"] as const) test(`service installer: ${scenario}`, async () => {
    const root = await mkdtemp("/tmp/puppygpt-install-test-")
    try {
        const home = join(root, "home with spaces"), commands = join(root, "commands")
        await mkdir(home); await mkdir(commands)
        await mkdir(join(root, "runtime"), { mode: 0o700 })
        const keys = generateKeyPairSync("ed25519")
        const key = keys.publicKey.export({ type: "spki", format: "pem" }).toString().trim()
        await Bun.write(join(root, "install.sh"), source.replace(RELEASE_PUBLIC_KEY, key))
        const payload = Buffer.from("#!/bin/sh\nexit 0\n")
        const manifest = Buffer.from(JSON.stringify({ schema: 1, repository: "J45k4/puppygpt", version: "v0.0.1", assets: [{ name: "puppygpt-linux-x64", size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") }] }))
        await Bun.write(join(root, "manifest.json"), manifest)
        await Bun.write(join(root, "manifest.sig"), scenario === "bad-signature" ? Buffer.alloc(64) : sign(null, manifest, keys.privateKey))
        await Bun.write(join(root, "puppygpt-linux-x64"), scenario === "tampered" ? Buffer.alloc(payload.length) : payload)
        const shell = async (name: string, body: string) => { const path = join(commands, name); await Bun.write(path, `#!/bin/bash\n${body}\n`); await chmod(path, 0o700) }
        // Only transport and systemd are mocked. OpenSSL/hash verification is real.
        await shell("curl", 'while (($#)); do if [[ $1 == --output ]]; then output=$2; shift 2; else url=$1; shift; fi; done\ncp "$FIXTURES/${url##*/}" "$output"')
        await shell("uname", 'if [[ $1 == -s ]]; then echo Linux; else echo x86_64; fi')
        await shell("systemctl", 'echo unexpected-systemctl-call >&2; exit 99')
        const run = () => Bun.spawn(["bash", join(root, "install.sh"), "--version", "v0.0.1", "--port", "3119", "--no-start"], { env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local/share"), XDG_CONFIG_HOME: join(home, ".config"), PATH: `${commands}:${process.env.PATH}`, FIXTURES: root }, stdout: "pipe", stderr: "pipe" })
        const child = run(), error = await new Response(child.stderr).text()
        const code = await child.exited
        const binary = Bun.file(join(home, ".local/share/puppygpt/bin/puppygpt"))
        if (scenario !== "valid") {
            expect(code).not.toBe(0)
            expect(error).toContain(scenario === "tampered" ? "checksum mismatch" : "signature verification failed")
            expect(await binary.exists()).toBeFalse()
            return
        }
        expect(error).toBe("")
        expect(code).toBe(0)
        expect(await binary.bytes()).toEqual(payload)
        const unitPath = join(home, ".config/systemd/user/puppygpt.service")
        const unit = await Bun.file(unitPath).text()
        expect(unit).toContain('" --auto-update')
        expect(unit).toContain("KillMode=control-group")
        expect(unit).toContain("Restart=on-failure")
        expect(unit).toContain("ExecStopPost=-")
        expect(await Bun.file(join(home, ".config/puppygpt/service.env")).text()).toContain("PORT=3119")
        const verify = Bun.spawn(["systemd-analyze", "--user", "verify", unitPath], { env: { ...process.env, XDG_RUNTIME_DIR: join(root, "runtime") }, stdout: "pipe", stderr: "pipe" })
        const verifyError = await new Response(verify.stderr).text()
        expect({ code: await verify.exited, error: verifyError }).toEqual({ code: 0, error: "" })
        const repeat = run()
        expect(await repeat.exited).not.toBe(0)
        expect(await new Response(repeat.stderr).text()).toContain("already exists")
        expect(await binary.bytes()).toEqual(payload)
    } finally { await rm(root, { recursive: true, force: true }) }
}, 15_000)
