import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import { relative, isAbsolute } from "node:path"
import { dockerControl, hostPolicy, selectTarget, validatePolicy, type ExecutionPolicy } from "./agent/execution-targets"
import { runProcess, type ExecInput, type ExecResult } from "./agent/exec"

export type Environment = { id: string, name: string, targetId: string, kind: "host" | "docker", handle?: { containerId: string }, status: "ready" | "stopped" | "missing" | "unavailable", createdAt: string, lastUsedAt?: string, policyHash: string }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export class EnvironmentStore {
    private policy: ExecutionPolicy
    private active = new Map<string, number>()
    private changing = new Set<string>()
    constructor(private db: Database, policy = hostPolicy, private control = dockerControl) {
        this.policy = validatePolicy(policy)
        db.run("CREATE TABLE IF NOT EXISTS execution_environments (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        for (const target of this.policy.targets) {
            const id = `default-${target.id}`
            if (!this.get(id)) this.save({ id, name: target.kind === "host" ? "Host" : `Docker · ${target.id}`, targetId: target.id, kind: target.kind, status: target.kind === "host" ? "ready" : "stopped", createdAt: new Date().toISOString(), policyHash: hash(target) })
        }
    }
    get(id: string): Environment | undefined {
        const row = this.db.query<{ data: string }, [string]>("SELECT data FROM execution_environments WHERE id = ?").get(id)
        return row ? JSON.parse(row.data) : undefined
    }
    list(): Environment[] { return this.db.query<{data:string}, []>("SELECT data FROM execution_environments ORDER BY rowid").all().map(r => JSON.parse(r.data)) }
    private save(e: Environment) { this.db.query("INSERT OR REPLACE INTO execution_environments VALUES (?, ?)").run(e.id, JSON.stringify(e)) }
    defaultId(targetId = this.policy.defaultTarget) { selectTarget(this.policy, targetId); return `default-${targetId}` }
    require(id: string) {
        const e = this.get(id)
        if (!e) throw new Error("Environment not found")
        const target = selectTarget(this.policy, e.targetId)
        if (e.policyHash !== hash(target)) throw new Error("Environment configuration changed. Restore its configuration before using or deleting it.")
        return { e, target }
    }
    create(name: string, targetId: string) {
        if (!name.trim() || name.length > 80) throw new Error("Choose an environment name of 1–80 characters")
        const target = selectTarget(this.policy, targetId)
        const e: Environment = { id: crypto.randomUUID(), name: name.trim(), kind: target.kind, targetId, status: target.kind === "host" ? "ready" : "stopped", createdAt: new Date().toISOString(), policyHash: hash(target) }
        this.save(e); return e
    }
    async reconcile(id: string, duringAction = false) {
        const e = this.get(id)
        if (!e) throw new Error("Environment not found")
        if (this.changing.has(id) && !duringAction) return e
        try {
            const {target} = this.require(id)
            if (target.kind === "host") e.status = "ready"
            else if (e.handle) {
                const raw = await this.control(target.socketPath ?? "/var/run/docker.sock", ["inspect", "--format", "{{json .}}", e.handle.containerId])
                const inspected = JSON.parse(raw)
                if (inspected.Config?.Labels?.["puppygpt.environment"] !== e.id) throw new Error("Environment container identity mismatch")
                e.status = inspected.State.Running ? "ready" : "stopped"
            } else e.status = "stopped"
        } catch (error) { e.status = error instanceof Error && /No such (object|container)/i.test(error.message) ? "missing" : "unavailable" }
        this.save(e); return e
    }
    async reconcileAll() { return Promise.all(this.list().map(e => this.reconcile(e.id))) }
    async action(id: string, action: "start" | "stop" | "delete") {
        if (this.changing.has(id) || this.active.get(id)) throw new Error("Environment is busy. Wait for its commands to finish.")
        const {e, target} = this.require(id)
        if (target.kind === "host") throw new Error("Host environment is managed by the runtime")
        this.changing.add(id)
        const socket = target.socketPath ?? "/var/run/docker.sock"
        try {
            if (e.handle) {
                const actual = await this.reconcile(id, true)
                if (actual.status === "unavailable") throw new Error("Could not verify environment container")
                if (actual.status === "missing") {
                    if (action === "delete") { this.db.query("DELETE FROM execution_environments WHERE id = ?").run(id); return null }
                    throw new Error("Environment container is missing. Delete this environment and create a replacement.")
                }
            }
            if (action === "start") {
                if (!e.handle) {
                    const root = await realpath(target.workspaceRoot)
                    await mkdir(`${root}/.puppygpt`, { recursive: true, mode: 0o700 })
                    const containerName = `puppygpt-env-${crypto.randomUUID()}`
                    e.handle = { containerId: containerName }; this.save(e)
                    const containerId = await this.control(socket, ["create", "--name", containerName, "--label", `puppygpt.environment=${e.id}`, "--pull=never", "--network", target.network ?? "none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", String(target.pidsLimit ?? 128), "--memory", `${target.memoryMb ?? 512}m`, "--cpus", String(target.cpus ?? 1), "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--mount", `type=bind,src=${root},dst=/workspace${target.readOnly ? ",readonly" : ""}`, "--tmpfs", "/workspace/.puppygpt:rw,noexec,nosuid,nodev,size=1m", "--workdir", "/workspace", "--env", "HOME=/tmp", "--entrypoint", "/bin/sh", target.image, "-c", "exec sleep infinity"])
                    e.handle = { containerId }; this.save(e)
                }
                await this.control(socket, ["start", e.handle.containerId])
                // Cancellation uses process groups; reject images that cannot provide them.
                try { await this.control(socket, ["exec", e.handle.containerId, "/bin/sh", "-c", "command -v setsid >/dev/null && command -v kill >/dev/null"]) }
                catch { await this.control(socket, ["stop", "--time", "3", e.handle.containerId]); throw new Error("Image must provide setsid and shell kill for command cancellation") }
                e.status = "ready"
            } else if (action === "stop") {
                if (e.handle) await this.control(socket, ["stop", "--time", "3", e.handle.containerId])
                e.status = "stopped"
            } else {
                if (e.handle) await this.control(socket, ["rm", "--force", "--volumes", e.handle.containerId])
                this.db.query("DELETE FROM execution_environments WHERE id = ?").run(id); return null
            }
            this.save(e); return e
        } finally { this.changing.delete(id) }
    }
    async execute(id: string, input: ExecInput): Promise<ExecResult> {
        if (this.changing.has(id)) throw new Error("Environment is changing state")
        const {e, target} = this.require(id)
        if (input.target && input.target !== target.id) throw new Error("Execution target does not match the selected environment")
        input.signal?.throwIfAborted()
        this.active.set(id, (this.active.get(id) ?? 0) + 1)
        try {
            const scoped = { ...input, target: target.id, timeoutMs: Math.min(input.timeoutMs ?? 120000, target.maxTimeoutMs ?? 600000), backgroundSignal: undefined }
            let result: ExecResult
            if (target.kind === "host") result = await runProcess(scoped, { argv: ["bash", "-c", input.command] })
            else {
                const current = await this.reconcile(id)
                if (current.status !== "ready" || !current.handle) throw new Error(`Environment is ${current.status}. Start it from Environments before executing commands.`)
                const root = await realpath(target.workspaceRoot), cwd = await realpath(input.cwd), sub = relative(root,cwd)
                if (sub === ".." || sub.startsWith("../") || isAbsolute(sub) || sub.split("/").includes(".puppygpt")) throw new Error("Working directory is outside the environment workspace")
                const socket = target.socketPath ?? "/var/run/docker.sock", container = current.handle.containerId
                const job = `/tmp/puppygpt-job-${crypto.randomUUID()}`
                const wrapper = 'mkdir -p "$1"; test ! -e "$1/cancelled" || exit 125; echo $$ > "$1/pid"; test ! -e "$1/cancelled" || exit 125; exec /bin/sh -c "$2"'
                const cancel = async () => { await this.control(socket,["exec",container,"/bin/sh","-c",'mkdir -p "$1"; touch "$1/cancelled"; if test -f "$1/pid"; then kill -KILL "-$(cat "$1/pid")" 2>/dev/null || true; fi',"sh",job]) }
                result = await runProcess({...scoped,cwd}, { argv: ["docker","--host",`unix://${socket}`,"exec","--workdir",`/workspace${sub ? `/${sub}` : ""}`,container,"setsid","--wait","/bin/sh","-c",wrapper,"sh",job,input.command], onTerminate: cancel, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } })
            }
            const latest = this.get(id)
            if (latest) { latest.lastUsedAt = new Date().toISOString(); this.save(latest) }
            return result
        } finally { this.active.set(id, (this.active.get(id) ?? 1) - 1) }
    }
}
