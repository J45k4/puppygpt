import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises"
import { createExecutor, validatePolicy, type ExecutionPolicy, type DockerControl } from "./execution-targets"
import { runProcess, type ExecResult, type ProcessOptions } from "./exec"
const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function workspace() { const root = await mkdtemp("/tmp/puppygpt-targets-"); roots.push(root); return root }
const policy = (root: string): ExecutionPolicy => ({ defaultTarget: "box", targets: [{ id: "box", kind: "docker", image: "test-image:local", workspaceRoot: root, maxTimeoutMs: 500 }] })
const result: ExecResult = { exitCode: 0, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, outputPath: "test", outputSha256: null, timedOut: false, durationMs: 0, truncated: false, liveOutputTruncated: false }

test("host target executes and enforces the runtime timeout", async () => {
    const root = await workspace()
    const execute = createExecutor({ defaultTarget: "machine", targets: [{ id: "machine", kind: "host", maxTimeoutMs: 100 }] })
    const output = await execute({ command: "printf target-ok", cwd: root })
    expect(output.target).toBe("machine"); expect(output.stdout).toBe("target-ok")
    const timeout = await execute({ command: "sleep 5", cwd: root, timeoutMs: 5000 })
    expect(timeout.timedOut).toBeTrue(); expect(timeout.durationMs).toBeLessThan(2000)
})
test("Docker-only policy rejects host and arbitrary targets before starting a process", async () => {
    const root = await workspace(); let calls = 0
    const execute = createExecutor(policy(root), { control: async () => { calls++; return "" }, process: async () => { calls++; return result } })
    for (const target of ["host", "ssh", "box --privileged"]) await expect(execute({ target, command: "true", cwd: root })).rejects.toThrow("not allowed")
    expect(calls).toBe(0)
    expect(() => validatePolicy({ defaultTarget: "host", targets: policy(root).targets })).toThrow("not allowed")
    expect(() => validatePolicy({ defaultTarget: "x", targets: [{ id: "x", kind: "docker", image: "--privileged", workspaceRoot: root }] })).toThrow()
})
test("Docker arguments come from policy, mask app data, use the local socket, and clean up", async () => {
    const root = await workspace(); const requests: string[][] = []; let launch: ProcessOptions | undefined
    const control: DockerControl = async (socket, args) => { expect(socket).toBe("/var/run/docker.sock"); requests.push(args); return args[0] === "inspect" ? JSON.stringify({ Status: "exited", ExitCode: 7 }) : "container-id" }
    const execute = createExecutor(policy(root), { control, process: async (input, options) => {
        launch = options; expect(input.target).toBe("box"); expect(input.backgroundSignal).toBeUndefined(); expect(input.timeoutMs).toBe(500)
        return { ...result, exitCode: await options.exitCode!(0), target: input.target }
    } })
    const command = "printf '%s' '--privileged; $(echo nope)'"
    expect((await execute({ command, cwd: root, timeoutMs: 9999, backgroundSignal: new AbortController().signal })).exitCode).toBe(7)
    const create = requests[0]!
    expect(create.slice(-3)).toEqual(["test-image:local", "-c", command])
    for (const flag of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pull=never"]) expect(create).toContain(flag)
    expect(create[create.indexOf("--network") + 1]).toBe("none")
    expect(create).toContain("/workspace/.puppygpt:rw,noexec,nosuid,nodev,size=1m")
    expect(create.some(arg => arg.includes("docker.sock"))).toBeFalse()
    expect(launch!.argv.slice(0,5)).toEqual(["docker", "--host", "unix:///var/run/docker.sock", "start", "--attach"])
    expect(Object.keys(launch!.env!)).toEqual(["PATH", "HOME", "LANG"])
    expect(requests.at(-1)!.slice(0,3)).toEqual(["rm", "--force", "--volumes"])
})
test("Docker working directory cannot escape via parent paths or symlinks", async () => {
    const root = await workspace(), outside = await workspace(); await symlink(outside, `${root}/escape`)
    let calls = 0
    const execute = createExecutor(policy(root), { control: async () => { calls++; return "" } })
    await expect(execute({ cwd: outside, command: "true" })).rejects.toThrow("outside")
    await expect(execute({ cwd: `${root}/escape`, command: "true" })).rejects.toThrow("outside")
    await mkdir(`${root}/.puppygpt`)
    await expect(execute({ cwd: `${root}/.puppygpt`, command: "true" })).rejects.toThrow("Runtime data")
    expect(calls).toBe(0)
})
test("Docker failure never falls back to host and launch failure removes the created container", async () => {
    const root = await workspace(); let starts = 0; const operations: string[] = []
    const execute = createExecutor(policy(root), { control: async (_s,args) => { operations.push(args[0]!); return "id" }, process: async () => { starts++; throw new Error("attach failed") } })
    await expect(execute({ command: "true", cwd: root })).rejects.toThrow("attach failed")
    expect(starts).toBe(1); expect(operations).toEqual(["create", "rm"])
    const denied = createExecutor(policy(root), { control: async () => { throw new Error("socket denied") }, process: async () => { starts++; return result } })
    await expect(denied({ command: "true", cwd: root })).rejects.toThrow("socket denied")
    expect(starts).toBe(1)
})
test("timeout removes Docker container before returning; pre-cancelled calls do nothing", async () => {
    const root = await workspace(); const operations: string[] = []
    const execute = createExecutor(policy(root), { control: async (_s,args) => { operations.push(args[0]!); return "id" }, process: async (input, options) => runProcess({ ...input, timeoutMs: 100 }, { ...options, argv: ["bash", "-c", "sleep 5"] }) })
    const output = await execute({ command: "sleep 5", cwd: root })
    expect(output.timedOut).toBeTrue(); expect(operations).toEqual(["create", "rm"])
    const c = new AbortController(); c.abort()
    await expect(execute({ command: "true", cwd: root, signal: c.signal })).rejects.toThrow()
    expect(operations).toEqual(["create", "rm"])
})

test("rootless target maps workspace ownership only after verifying the daemon", async () => {
    const { dockerUser } = await import("./execution-targets")
    const target = { id: "rootless", kind: "docker" as const, image: "test", workspaceRoot: "/tmp", rootless: true, socketPath: "/run/user/1000/docker.sock" }
    expect(await dockerUser(target, async (socket, args) => {
        expect(socket).toBe(target.socketPath)
        expect(args).toEqual(["info", "--format", "{{json .SecurityOptions}}"])
        return '["name=seccomp,profile=builtin","name=rootless"]'
    })).toBe("0:0")
    await expect(dockerUser(target, async () => '["name=seccomp,profile=builtin"]')).rejects.toThrow("verified rootless daemon")
    await expect(dockerUser(target, async () => { throw new Error("permission denied") })).rejects.toThrow("permission denied")
    expect(() => validatePolicy({ defaultTarget: target.id, targets: [{ ...target, rootless: "true" }] })).toThrow("rootless")
})
