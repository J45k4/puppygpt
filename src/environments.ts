import { deliverWebhook, type WebhookPayload, type WebhookReply } from "./webhooks"
import type { ShellSession } from "./terminal"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import { relative, isAbsolute } from "node:path"
import { dockerUser, dockerControl, hostPolicy, selectTarget, validatePolicy, type ExecutionPolicy } from "./agent/execution-targets"
import { runProcess, type ExecInput, type ExecResult } from "./agent/exec"

export type Environment = { id: string, name: string, targetId: string, kind: "host" | "docker", handle?: { containerId: string }, status: "ready" | "stopped" | "missing" | "unavailable", createdAt: string, lastUsedAt?: string, policyHash: string, ownerChatId?: string, cleanupEnabled?: boolean, autoStopEnabled?: boolean, stoppedAt?: string, stopReason?: "auto" | "manual", destroyedAt?: string, cleanupNotifiedAt?: string, autoStopAt?: string, destroyAt?: string, cleanupPaused?: boolean }
export const ENV_IDLE_MS = 4 * 60 * 60 * 1000
export const ENV_AUTO_DESTROY_MS = 24 * 60 * 60 * 1000
export const ENV_MANUAL_DESTROY_MS = 7 * 24 * 60 * 60 * 1000
export const ENV_REAPER_INTERVAL_MS = 30 * 60 * 1000
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export class EnvironmentStore {
    private policy: ExecutionPolicy
    private active = new Map<string, number>()
    private changing = new Set<string>()
    private chatBusy: (id: string) => boolean = () => false
    private reaping = false
    constructor(private db: Database, policy = hostPolicy, private control = dockerControl) {
        this.policy = validatePolicy(policy)
        db.run("CREATE TABLE IF NOT EXISTS execution_environments (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        for (const target of this.policy.targets) {
            const id = `default-${target.id}`
            if (!this.get(id)) this.save({ id, name: target.kind === "host" ? "Host" : `Docker · ${target.id}`, targetId: target.id, kind: target.kind, status: target.kind === "host" ? "ready" : "stopped", createdAt: new Date().toISOString(), policyHash: hash(target) })
        }
    }
    setUsageGuard(guard: (id: string) => boolean) { this.chatBusy = guard }
    assertAvailable(id: string) { if (this.changing.has(id)) throw new Error("Environment is changing state. Try again shortly.") }
    touch(id: string, now = Date.now()) {
        const e = this.get(id)
        if (e) { e.lastUsedAt = new Date(now).toISOString(); this.save(e) }
    }
    setAutoStop(id: string, enabled: boolean, now = Date.now()) {
        this.assertAvailable(id)
        const { e, target } = this.require(id)
        if (target.kind !== "docker") throw new Error("Auto-stop only applies to Docker environments")
        e.autoStopEnabled = enabled
        if (enabled) e.lastUsedAt = new Date(now).toISOString()
        this.save(e); return e
    }
    setCleanup(id: string, enabled: boolean, now = Date.now()) {
        this.assertAvailable(id)
        const { e, target } = this.require(id)
        if (target.kind !== "docker") throw new Error("Cleanup only applies to Docker environments")
        e.cleanupEnabled = enabled
        if (enabled) { e.lastUsedAt = new Date(now).toISOString(); if (e.stoppedAt) e.stoppedAt = e.lastUsedAt; delete e.cleanupNotifiedAt }
        this.save(e); return e
    }
    initializeCleanup(now = Date.now()) {
        for (const e of this.list()) if (e.kind === "docker" && e.cleanupEnabled === undefined) {
            e.cleanupEnabled = true; e.lastUsedAt = new Date(now).toISOString()
            if (e.status === "stopped" && e.handle) { e.stoppedAt = e.lastUsedAt; e.stopReason = "manual" }
            this.save(e)
        }
    }
    async reap(now = Date.now(), notify: (e: Environment, text: string) => void = () => {}) {
        if (this.reaping) return
        this.reaping = true
        try {
            for (const item of this.list()) {
                if (item.kind !== "docker" || item.cleanupEnabled === false || !item.handle || this.changing.has(item.id) || this.active.get(item.id) || this.chatBusy(item.id)) continue
                try {
                    const e = await this.reconcile(item.id)
                    if (e.cleanupEnabled === false || this.active.get(e.id) || this.chatBusy(e.id)) continue
                    if (e.status === "ready" && e.autoStopEnabled !== false && now - Date.parse(e.lastUsedAt ?? e.createdAt) >= ENV_IDLE_MS) {
                        const stopped = await this.action(e.id, "stop", { automatic: true, now })
                        if (stopped) notify(stopped, "Environment stopped after 4 hours idle. Its container will be removed after 24 hours stopped; mounted workspace files are preserved. Start it again or enable Keep environment to retain it.")
                    } else if (e.status === "stopped" && e.stoppedAt) {
                        const deadline = Date.parse(e.stoppedAt) + (e.stopReason === "auto" ? ENV_AUTO_DESTROY_MS : ENV_MANUAL_DESTROY_MS)
                        if (now >= deadline) {
                            const expired = await this.action(e.id, "expire", { automatic: true, now })
                            if (expired) notify(expired, "Idle environment container removed. Mounted workspace files and chat history are preserved. The next message creates a fresh container; container-local files and installed tools were removed.")
                        } else if (now >= deadline - 60 * 60 * 1000 && !e.cleanupNotifiedAt) {
                            e.cleanupNotifiedAt = new Date(now).toISOString(); this.save(e)
                            notify(e, `Environment container is scheduled for removal at ${new Date(deadline).toLocaleString()}. Start it or enable Keep environment to retain its container-local files.`)
                        }
                    }
                } catch (error) { console.warn("Environment cleanup skipped", item.id, error instanceof Error ? error.message : String(error)) }
            }
        } finally { this.reaping = false }
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
    createForChat(targetId: string, chatId: string) {
        const names = new Set(this.list().map(environment => environment.name.toLowerCase()))
        let index = 1
        while (names.has(`chat-${index}`)) index++
        return this.create(`chat-${index}`, targetId, chatId)
    }
    create(name: string, targetId: string, ownerChatId?: string) {
        if (!name.trim() || name.length > 80) throw new Error("Choose an environment name of 1–80 characters")
        const target = selectTarget(this.policy, targetId)
        const e: Environment = { id: crypto.randomUUID(), name: name.trim(), kind: target.kind, targetId, ownerChatId, status: target.kind === "host" ? "ready" : "stopped", createdAt: new Date().toISOString(), policyHash: hash(target), ...(target.kind === "docker" ? { cleanupEnabled: true, autoStopEnabled: true } : {}) }
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
        const latest = this.get(id)
        if (latest) Object.assign(e, latest, { status: e.status })
        if (e.status === "ready") { if (e.stoppedAt) e.lastUsedAt = new Date().toISOString(); delete e.stoppedAt; delete e.stopReason; delete e.cleanupNotifiedAt }
        else if (e.status === "stopped" && e.handle && !e.stoppedAt) { e.stoppedAt = new Date().toISOString(); e.stopReason = "manual" }
        this.save(e); return e
    }
    cleanupTiming(e: Environment): Environment {
        if (e.kind !== "docker" || e.cleanupEnabled === false || !e.handle || !["ready", "stopped"].includes(e.status)) return e
        if (e.status === "ready" && e.autoStopEnabled === false) return e
        const cleanupPaused = !!this.active.get(e.id) || this.chatBusy(e.id) || this.changing.has(e.id)
        const deadline = e.status === "ready"
            ? Date.parse(e.lastUsedAt ?? e.createdAt) + ENV_IDLE_MS
            : e.stoppedAt ? Date.parse(e.stoppedAt) + (e.stopReason === "auto" ? ENV_AUTO_DESTROY_MS : ENV_MANUAL_DESTROY_MS) : NaN
        return { ...e, cleanupPaused, ...(Number.isFinite(deadline) ? e.status === "ready" ? { autoStopAt: new Date(deadline).toISOString() } : { destroyAt: new Date(deadline).toISOString() } : {}) }
    }
    async reconcileAll() { return (await Promise.all(this.list().map(e => this.reconcile(e.id)))).map(e => this.cleanupTiming(e)) }
    async action(id: string, action: "start" | "stop" | "delete" | "expire", options: { automatic?: boolean, now?: number } = {}) {
        if (this.changing.has(id) || this.active.get(id)) throw new Error("Environment is busy. Wait for its commands to finish.")
        const {e, target} = this.require(id)
        if (target.kind === "host") throw new Error("Host environment is managed by the runtime")
        if (options.automatic && (e.cleanupEnabled === false || (action === "stop" && e.autoStopEnabled === false) || this.chatBusy(id))) return null
        const now = new Date(options.now ?? Date.now()).toISOString()
        this.changing.add(id)
        const socket = target.socketPath ?? "/var/run/docker.sock"
        try {
            if (e.handle) {
                const actual = await this.reconcile(id, true)
                if (actual.status === "unavailable") throw new Error("Could not verify environment container")
                if (action === "expire" && actual.status !== "stopped") throw new Error("Only a verified stopped container can expire")
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
                    const containerId = await this.control(socket, ["create", "--init", "--name", containerName, "--label", `puppygpt.environment=${e.id}`, "--pull=never", "--network", target.network ?? "none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", String(target.pidsLimit ?? 128), "--memory", `${target.memoryMb ?? 512}m`, "--cpus", String(target.cpus ?? 1), "--user", await dockerUser(target, this.control), "--mount", `type=bind,src=${root},dst=/workspace${target.readOnly ? ",readonly" : ""}`, "--tmpfs", "/workspace/.puppygpt:rw,noexec,nosuid,nodev,size=1m", "--workdir", "/workspace", "--env", "HOME=/tmp", "--entrypoint", "/bin/sh", target.image, "-c", "exec sleep infinity"])
                    e.handle = { containerId }; this.save(e)
                }
                await this.control(socket, ["start", e.handle.containerId])
                // Cancellation uses process groups; reject images that cannot provide them.
                try { await this.control(socket, ["exec", e.handle.containerId, "/bin/sh", "-c", "command -v setsid >/dev/null && command -v kill >/dev/null"]) }
                catch { await this.control(socket, ["stop", "--time", "3", e.handle.containerId]); throw new Error("Image must provide setsid and shell kill for command cancellation") }
                e.status = "ready"; e.lastUsedAt = now
                delete e.stoppedAt; delete e.stopReason; delete e.cleanupNotifiedAt; delete e.destroyedAt
            } else if (action === "stop") {
                if (e.handle) await this.control(socket, ["stop", "--time", "3", e.handle.containerId])
                e.status = "stopped"; e.stoppedAt = now; e.stopReason = options.automatic ? "auto" : "manual"; delete e.cleanupNotifiedAt
            } else if (action === "expire") {
                if (e.handle) await this.control(socket, ["rm", "--volumes", e.handle.containerId])
                delete e.handle; delete e.stoppedAt; delete e.stopReason; delete e.cleanupNotifiedAt
                e.status = "stopped"; e.destroyedAt = now
            } else {
                if (e.handle) await this.control(socket, ["rm", "--force", "--volumes", e.handle.containerId])
                this.db.query("DELETE FROM execution_environments WHERE id = ?").run(id); return null
            }
            this.save(e); return e
        } finally { this.changing.delete(id) }
    }
    async openTerminal(id: string, hostCwd: string, onData: (data: Uint8Array) => void, onExit: (code: number) => void): Promise<ShellSession> {
        if (this.changing.has(id)) throw new Error("Environment is changing state")
        const { target } = this.require(id)
        this.active.set(id, (this.active.get(id) ?? 0) + 1)
        let released = false
        const release = () => { if (!released) { released = true; this.active.set(id, (this.active.get(id) ?? 1) - 1); this.touch(id) } }
        try {
            const current = await this.reconcile(id)
            if (current.status !== "ready") throw new Error(`Environment is ${current.status}. Start it before opening a terminal.`)
            const cwd = await realpath(target.kind === "docker" ? target.workspaceRoot : hostCwd)
            const job = `/tmp/puppygpt-terminal-${crypto.randomUUID()}`
            const socket = target.kind === "docker" ? target.socketPath ?? "/var/run/docker.sock" : ""
            const container = current.handle?.containerId
            if (target.kind === "docker" && !container) throw new Error("Environment container is missing")
            const wrapper = 'mkdir -p "$1"; test ! -e "$1/cancelled" || exit 125; echo $$ > "$1/pid"; test ! -e "$1/cancelled" || exit 125; exec /bin/bash -i'
            const argv = target.kind === "docker"
                ? ["docker", "--host", `unix://${socket}`, "exec", "-it", "--workdir", "/workspace", "--env", "TERM=xterm-256color", container!, "/bin/sh", "-c", wrapper, "sh", job]
                : ["/bin/bash", "-i"]
            const proc = Bun.spawn(argv, { cwd, env: target.kind === "docker" ? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TERM: "xterm-256color" } : { ...process.env, TERM: "xterm-256color" }, terminal: { cols: 80, rows: 24, data: (_terminal, data) => onData(data) } })
            const terminal = proc.terminal!
            let closing: Promise<void> | undefined
            const close = () => closing ??= (async () => {
                try {
                    if (target.kind === "docker") await this.control(socket, ["exec", container!, "/bin/sh", "-c", 'mkdir -p "$1"; touch "$1/cancelled"; if test -f "$1/pid"; then kill -HUP "-$(cat "$1/pid")" 2>/dev/null || true; fi', "sh", job])
                    else { try { process.kill(-proc.pid, "SIGHUP") } catch {} }
                    await Bun.sleep(100)
                } finally { proc.kill("SIGKILL"); terminal.close(); await proc.exited; release() }
            })()
            void proc.exited.then(code => { onExit(code); return close() }).catch(error => console.error("Terminal exit cleanup failed:", error))
            const latest = this.get(id)
            if (latest) { latest.lastUsedAt = new Date().toISOString(); this.save(latest) }
            return { write: data => { if (!closing) terminal.write(data) }, resize: (cols, rows) => { if (!closing) terminal.resize(cols, rows) }, close }
        } catch (error) { release(); throw error }
    }
    async forwardWebhook(id: string, payload: WebhookPayload, signal?: AbortSignal): Promise<WebhookReply> {
        this.assertAvailable(id)
        const { target } = this.require(id)
        this.active.set(id, (this.active.get(id) ?? 0) + 1)
        try {
            const current = await this.reconcile(id)
            if (current.status !== "ready") throw new Error("Environment is not running")
            this.touch(id)
            if (target.kind === "host") return await deliverWebhook(payload)
            if (!current.handle) throw new Error("Environment container is missing")
            const script = `const deliver = ${deliverWebhook.toString()}; console.log(JSON.stringify(await deliver(JSON.parse(process.argv[1]))))`
            return JSON.parse(await this.control(target.socketPath ?? "/var/run/docker.sock", ["exec", current.handle.containerId, "bun", "-e", script, JSON.stringify(payload)], signal))
        } finally { this.active.set(id, Math.max(0, (this.active.get(id) ?? 1) - 1)); this.touch(id) }
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
        } finally { this.active.set(id, (this.active.get(id) ?? 1) - 1); this.touch(id) }
    }
}
