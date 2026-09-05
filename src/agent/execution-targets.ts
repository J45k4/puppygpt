import { realpath } from "node:fs/promises"
import { isAbsolute, relative, join } from "node:path"
import { runProcess, type ExecInput, type ExecResult } from "./exec"

export type ExecutionTarget = { id: string, kind: "host", maxTimeoutMs?: number } | {
    id: string, kind: "docker", image: string, workspaceRoot: string, socketPath?: string,
    network?: "none" | "bridge", readOnly?: boolean, memoryMb?: number, cpus?: number, pidsLimit?: number, maxTimeoutMs?: number,
}
export type ExecutionPolicy = { defaultTarget: string, targets: ExecutionTarget[] }
export const hostPolicy: ExecutionPolicy = { defaultTarget: "host", targets: [{ id: "host", kind: "host" }] }
export function validatePolicy(value: unknown): ExecutionPolicy {
    const p = value as ExecutionPolicy
    if (!p || !Array.isArray(p.targets) || !p.targets.length || p.targets.length > 16) throw new Error("Execution policy must define 1–16 targets")
    const ids = new Set<string>()
    for (const target of p.targets) {
        if (!target || !/^[a-z][a-z0-9_-]{0,39}$/.test(target.id) || ids.has(target.id)) throw new Error("Invalid or duplicate execution target ID")
        ids.add(target.id)
        if (!["host", "docker"].includes(target.kind)) throw new Error("Unsupported execution target kind")
        if (target.maxTimeoutMs !== undefined && (!Number.isInteger(target.maxTimeoutMs) || target.maxTimeoutMs < 100 || target.maxTimeoutMs > 600_000)) throw new Error("Invalid execution timeout limit")
        if (target.kind === "docker") {
            if (typeof target.image !== "string" || !target.image || target.image.startsWith("-") || /\s/.test(target.image)) throw new Error("Docker target needs an image")
            if (typeof target.workspaceRoot !== "string" || !isAbsolute(target.workspaceRoot) || target.workspaceRoot.includes(",")) throw new Error("Docker workspaceRoot must be an absolute path without commas")
            if (target.socketPath !== undefined && (!isAbsolute(target.socketPath) || target.socketPath.includes("\0"))) throw new Error("Docker requires a local Unix socket path")
            if (target.network !== undefined && !["none", "bridge"].includes(target.network)) throw new Error("Invalid Docker network policy")
            if (target.readOnly !== undefined && typeof target.readOnly !== "boolean") throw new Error("Invalid Docker workspace access")
            for (const key of ["memoryMb", "cpus", "pidsLimit"] as const) if (target[key] !== undefined && (!Number.isFinite(target[key]) || target[key]! <= 0)) throw new Error(`Invalid Docker ${key}`)
        }
    }
    if (!ids.has(p.defaultTarget)) throw new Error("Default execution target is not allowed")
    return structuredClone(p)
}
export function selectTarget(policy: ExecutionPolicy, id?: string): ExecutionTarget {
    const target = policy.targets.find(t => t.id === (id ?? policy.defaultTarget))
    if (!target) throw new Error(`Execution target is not allowed: ${id}`)
    return target
}
export function targetDescription(policy: ExecutionPolicy) {
    return policy.targets.map(t => `${t.id}: ${t.kind === "host" ? "host shell with the runtime user's permissions" : `Docker container (${t.image}), workspace at /workspace, network ${t.network ?? "none"}, workspace ${t.readOnly ? "read-only" : "writable"}; no backgrounding`}`).join("; ")
}
// Injectable transport allows lifecycle tests without access to a Docker daemon.
export type DockerControl = (socket: string, args: string[], signal?: AbortSignal) => Promise<string>
export const dockerControl: DockerControl = async (socket, args, signal) => {
    signal?.throwIfAborted()
    const process = Bun.spawn(["docker", "--host", `unix://${socket}`, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: dockerEnv() })
    const stop = () => process.kill("SIGKILL")
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) stop()
    const timer = setTimeout(stop, 15_000)
    try {
        const [code, out, err] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
        signal?.throwIfAborted()
        if (code !== 0) throw new Error(`Docker ${args[0]} failed: ${err.trim().slice(0, 1500)}`)
        return out.trim()
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop) }
}
function dockerEnv(): Record<string, string | undefined> {
    return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG }
}
export function createExecutor(policyInput: ExecutionPolicy, dependencies: { control?: DockerControl, process?: typeof runProcess } = {}) {
    const policy = validatePolicy(policyInput), control = dependencies.control ?? dockerControl, processRunner = dependencies.process ?? runProcess
    return async (input: ExecInput): Promise<ExecResult> => {
        input.signal?.throwIfAborted()
        const target = selectTarget(policy, input.target)
        if (typeof input.command !== "string" || !input.command.trim()) throw new Error("A command is required")
        if (input.timeoutMs !== undefined && !Number.isFinite(input.timeoutMs)) throw new Error("Invalid execution timeout")
        const timeoutMs = Math.min(input.timeoutMs ?? 120_000, target.maxTimeoutMs ?? 600_000)
        const scoped = { ...input, target: target.id, timeoutMs }
        if (target.kind === "host") return processRunner(scoped, { argv: ["bash", "-c", input.command] })
        const root = await realpath(target.workspaceRoot), cwd = await realpath(input.cwd)
        const subpath = relative(root, cwd)
        if (subpath === ".." || subpath.startsWith("../") || isAbsolute(subpath)) throw new Error("Working directory is outside this Docker target's workspace")
        // Runtime data is always masked, even when the repository is writable.
        if (subpath.split("/").includes(".puppygpt")) throw new Error("Runtime data cannot be a Docker working directory")
        const socket = target.socketPath ?? "/var/run/docker.sock"
        const name = `puppygpt-exec-${crypto.randomUUID()}`
        const args = ["create", "--name", name, "--pull=never", "--network", target.network ?? "none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", String(target.pidsLimit ?? 128), "--memory", `${target.memoryMb ?? 512}m`, "--cpus", String(target.cpus ?? 1), "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--mount", `type=bind,src=${root},dst=/workspace${target.readOnly ? ",readonly" : ""}`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--tmpfs", "/workspace/.puppygpt:rw,noexec,nosuid,nodev,size=1m", "--workdir", `/workspace${subpath ? `/${subpath}` : ""}`, "--env", "HOME=/tmp", "--entrypoint", "/bin/sh", target.image, "-c", input.command]
        let created = false
        let cleanup: Promise<void> | undefined
        const remove = () => cleanup ??= control(socket, ["rm", "--force", "--volumes", name]).then(() => {})
        try {
            // Creation has its own bounded timeout; cancellation is checked before starting it.
            // Do not abort creation mid-request: it could leave an unknown container behind.
            await control(socket, args); created = true
            input.signal?.throwIfAborted()
            return await processRunner({ ...scoped, cwd, backgroundSignal: undefined, outputDirectory: input.outputDirectory ?? join(cwd, ".puppygpt", "exec-results") }, { argv: ["docker", "--host", `unix://${socket}`, "start", "--attach", name], env: dockerEnv(), onTerminate: remove, exitCode: async () => {
                const state = JSON.parse(await control(socket, ["inspect", "--format", "{{json .State}}", name]))
                if (state.Status !== "exited" || !Number.isInteger(state.ExitCode)) throw new Error("Docker command did not reach a completed state")
                return state.ExitCode
            } })
        } finally {
            if (created) await remove()
        }
    }
}
