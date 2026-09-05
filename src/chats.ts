import { Database } from "bun:sqlite"
import { mkdir, chmod, realpath, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { AgentSession, type AgentInteraction, type AgentTurnOptions } from "./agent"
import { resolveAuthFile } from "./agent/auth"
import { extractOutputText } from "./agent/responses"
import type { Chat, ChatSummary, AppConfig } from "./chat-types"
import { defaultSettings, MODELS, validateSettings, type Settings } from "./settings"
import { hostPolicy, selectTarget, validatePolicy } from "./agent/execution-targets"
import { EnvironmentStore } from "./environments"
import { AccountStore } from "./accounts"

type Snapshot = ReturnType<AgentSession["contextSnapshot"]>
type Row = { data: string, context: string | null }

export class ChatStore {
    readonly accounts: AccountStore
    readonly environments: EnvironmentStore
    private sessions = new Map<string, AgentSession>()
    private live = new Map<string, Chat>()
    private listeners = new Set<(chat: Chat) => void>()
    private timers = new Map<string, ReturnType<typeof setTimeout>>()
    private tasks = new Set<Promise<void>>()

    constructor(private db: Database, readonly cwd: string, private agentOptions: AgentTurnOptions = {}, accountDirectory = resolve(cwd, ".puppygpt", "accounts")) {
        this.environments = new EnvironmentStore(db, agentOptions.executionPolicy ?? hostPolicy)
        this.accounts = new AccountStore(db, accountDirectory, agentOptions)
        db.run("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, data TEXT NOT NULL, context TEXT)")
        for (const row of db.query<Row, []>("SELECT data, context FROM chats").all()) {
            const chat: Chat = JSON.parse(row.data)
            if (chat.status === "running") {
                chat.status = "error"
                for (const message of chat.messages) message.running = false
                chat.messages.push({ id: crypto.randomUUID(), role: "error", text: "The server restarted during this turn. Send a message to continue." })
                this.save(chat)
            }
        }
    }

    async config(): Promise<AppConfig> {
        let authAvailable = false
        try { authAvailable = this.settings().accountId ? !!await this.accounts.credentials(this.settings().accountId!).read() : await Bun.file(resolveAuthFile(this.agentOptions.authFile)).exists() } catch {}
        const settings = this.settings()
        const policy = this.agentOptions.executionPolicy ?? hostPolicy
        return { cwd: settings.cwd, authAvailable, settings, execution: { environments: await this.environments.reconcileAll(), defaultEnvironmentId: this.environments.defaultId(), defaultTarget: policy.defaultTarget, targets: policy.targets.map(({ id, kind }) => ({ id, kind })) } }
    }

    settings(): Settings {
        const row = this.db.query<{ data: string }, []>("SELECT data FROM settings WHERE id = 1").get()
        return row ? validateSettings(JSON.parse(row.data)) : defaultSettings(this.cwd)
    }

    async saveSettings(value: unknown): Promise<Settings> {
        const settings = validateSettings(value)
        if (settings.accountId) this.accounts.authFile(settings.accountId)
        const directory = await realpath(resolve(this.cwd, settings.cwd)).catch(() => { throw new Error("Choose an existing workspace directory") })
        if (!(await stat(directory)).isDirectory()) throw new Error("Choose an existing workspace directory")
        settings.cwd = directory
        this.db.query("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(settings))
        return settings
    }

    list(): ChatSummary[] {
        return this.db.query<Row, []>("SELECT data, context FROM chats").all().map(row => {
            const stored: Chat = JSON.parse(row.data)
            const { messages, ...summary } = this.live.get(stored.id) ?? stored
            return summary
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    get(id: string): Chat | undefined {
        const live = this.live.get(id)
        if (live) return live
        const row = this.db.query<Row, [string]>("SELECT data, context FROM chats WHERE id = ?").get(id)
        return row ? JSON.parse(row.data) : undefined
    }

    async create(cwd = this.settings().cwd, model = this.settings().model, executionTarget?: string, environmentId?: string): Promise<Chat> {
        const directory = await realpath(resolve(cwd))
        if (!(await stat(directory)).isDirectory()) throw new Error("Choose an existing workspace directory")
        if (!MODELS.some(item => item.id === model)) throw new Error("Unsupported model")
        const chat: Chat = { id: crypto.randomUUID(), title: "New chat", cwd: directory, model, status: "idle", updatedAt: new Date().toISOString(), messages: [] }
        chat.executionTarget = selectTarget(this.agentOptions.executionPolicy ?? hostPolicy, executionTarget).id
        chat.environmentId = environmentId ?? this.environments.defaultId(chat.executionTarget)
        chat.executionTarget = this.environments.require(chat.environmentId).target.id
        chat.accountId = this.settings().accountId ?? null
        if (chat.accountId) this.accounts.authFile(chat.accountId)
        this.save(chat)
        this.publish(chat)
        return chat
    }

    setExecutionTarget(id: string, targetId: string): Chat { return this.setEnvironment(id, this.environments.defaultId(targetId)) }

    setEnvironment(id: string, environmentId: string): Chat {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        if (chat.status === "running" || this.sessions.get(id)?.active) throw new Error("Wait for the current turn to finish before changing execution target")
        const {target} = this.environments.require(environmentId)
        chat.executionTarget = target.id
        chat.environmentId = environmentId
        chat.updatedAt = new Date().toISOString()
        this.sessions.delete(id)
        this.live.set(id, chat)
        this.save(chat); this.publish(chat)
        return chat
    }

    private save(chat: Chat, snapshot?: Snapshot) {
        this.db.query("INSERT INTO chats (id, data, context) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, context = COALESCE(excluded.context, chats.context)")
            .run(chat.id, JSON.stringify(chat), snapshot ? JSON.stringify(snapshot) : null)
    }

    subscribe(listener: (chat: Chat) => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    private publish(chat: Chat) {
        if (this.timers.has(chat.id)) return
        this.timers.set(chat.id, setTimeout(() => {
            this.timers.delete(chat.id)
            for (const listener of this.listeners) listener(chat)
        }, 40))
    }

    send(id: string, prompt: string): Chat {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        const environmentId = chat.environmentId ?? this.environments.defaultId(chat.executionTarget)
        const {target} = this.environments.require(environmentId)
        const executionPolicy = { defaultTarget: target.id, targets: [target] }
        const authStorage = chat.accountId ? this.accounts.credentials(chat.accountId) : undefined
        const authFile = this.agentOptions.authFile
        if (!prompt.trim() || prompt.length > 64_000) throw new Error("Enter a message of 1–64,000 characters")
        let session = this.sessions.get(id)
        if (!session) {
            const row = this.db.query<Row, [string]>("SELECT data, context FROM chats WHERE id = ?").get(id)
            session = new AgentSession({ ...this.agentOptions, execute: this.agentOptions.execute ?? (input => this.environments.execute(environmentId, input)), executionPolicy, authFile, authStorage, cwd: chat.cwd, model: chat.model }, row?.context ? JSON.parse(row.context) : undefined)
            this.sessions.set(id, session)
        }
        if (chat.status === "running" && !session.active) throw new Error("This turn is finishing. Try again in a moment.")
        const steering = session.active
        if (steering && !session.steer(prompt.trim())) throw new Error("The agent is stopping. Wait for it to stop before sending another message.")
        chat.messages.push({ id: crypto.randomUUID(), role: "user", text: prompt.trim() })
        if (chat.title === "New chat") chat.title = prompt.trim().replace(/\s+/g, " ").slice(0, 64)
        chat.updatedAt = new Date().toISOString()
        this.live.set(id, chat)
        if (steering) {
            this.save(chat)
            this.publish(chat)
            return chat
        }
        chat.status = "running"
        this.save(chat)
        this.publish(chat)
        const turnId = crypto.randomUUID()
        const currentSession = session
        const settings = this.settings()
        const task = currentSession.run(prompt.trim(), {
            reasoningEffort: settings.reasoningEffort,
            instructions: [this.agentOptions.instructions, settings.instructions].filter(Boolean).join("\n\n"),
            onInteraction: event => this.interact(chat, turnId, event),
        }).then(() => {
            chat.status = "idle"
        }).catch(error => {
            const cancelled = error?.name === "AbortError"
            chat.status = cancelled ? "idle" : "error"
            chat.messages.push({ id: crypto.randomUUID(), role: cancelled ? "activity" : "error", text: cancelled ? "Stopped" : error instanceof Error ? error.message : "The agent could not finish this turn." })
        }).finally(() => {
            for (const message of chat.messages) message.running = false
            chat.updatedAt = new Date().toISOString()
            this.save(chat, currentSession.contextSnapshot())
            this.publish(chat)
            this.tasks.delete(task)
        })
        this.tasks.add(task)
        return chat
    }

    private interact(chat: Chat, turnId: string, event: AgentInteraction) {
        if (event.type === "request") {
            const id = `${turnId}:answer:${event.step}`
            chat.messages = chat.messages.filter(message => message.id !== id)
        } else if (event.type === "text_delta" || event.type === "final" || event.type === "response") {
            const id = `${turnId}:answer:${event.step}`
            const text = event.type === "response" ? extractOutputText(event.response.output) : event.text
            if (!text) return
            let message = chat.messages.find(message => message.id === id)
            if (!message) {
                message = { id, role: "assistant", text: "" }
                chat.messages.push(message)
            }
            message.text = event.type === "text_delta" ? message.text + text : text
        } else if (event.type === "imagegen_result") {
            const id = `${turnId}:${event.callId}`
            const message = chat.messages.find(message => message.id === id)
            if (message) {
                message.role = "assistant"
                message.text = ""
                message.running = false
                message.image = { path: event.path, prompt: event.prompt }
                // Keep completed image artifacts discoverable even if this turn is interrupted.
                this.save(chat)
            }
        } else if (event.type === "tool_start" || event.type === "image_start" || event.type === "web_search" || event.type === "imagegen_start") {
            const id = `${turnId}:${event.callId}`
            let message = chat.messages.find(message => message.id === id)
            if (!message) {
                message = { id, role: "activity", text: "", running: true }
                chat.messages.push(message)
            }
            message.text = event.type === "tool_start" ? `[${event.target ?? "host"}] ${event.command}` : event.type === "image_start" ? `Viewing ${event.path}` : event.type === "imagegen_start" ? "Generating image" : "Searching the web"
            if (event.type === "imagegen_start") message.detail = event.prompt
            if (event.type === "web_search") message.running = event.status !== "completed"
        } else if (event.type === "tool_output") {
            const message = chat.messages.find(message => message.id === `${turnId}:${event.callId}`)
            if (message) message.detail = ((message.detail ?? "") + event.chunk.text).slice(-16_384)
        } else if (event.type === "tool_result" || event.type === "tool_error" || event.type === "image_result") {
            const message = chat.messages.find(message => message.id === `${turnId}:${event.callId}`)
            if (message) {
                message.running = false
                if (event.type === "tool_error") message.detail = event.error
                if (event.type === "tool_result") message.detail = `${(event.result.stdout + event.result.stderr).slice(-16_384)}\n${event.result.backgrounded ? "Continuing in background" : `Exit ${event.result.exitCode}${event.result.timedOut ? " · timed out" : ""}`}\nFull output: ${event.result.outputPath}`
            }
        } else if (event.type === "compaction_start") {
            chat.messages.push({ id: `${turnId}:${event.compactionId}`, role: "activity", text: "Compacting conversation", running: true })
        } else if (event.type === "compaction_complete" || event.type === "compaction_error") {
            const message = chat.messages.find(message => message.id === `${turnId}:${event.compactionId}`)
            if (message) { message.running = false; message.text = event.type === "compaction_complete" ? "Conversation compacted" : "Compaction failed" }
        }
        this.publish(chat)
    }

    stop(id: string) { return this.sessions.get(id)?.stop() ?? false }

    async removeAccount(id: string) {
        if (this.list().some(chat => chat.accountId === id && chat.status === "running")) throw new Error("Stop this account’s running chats before removing it")
        await this.accounts.remove(id)
        const settings = this.settings()
        if (settings.accountId === id) {
            settings.accountId = null
            this.db.query("UPDATE settings SET data = ? WHERE id = 1").run(JSON.stringify(settings))
        }
    }

    async settled() { await Promise.all(this.tasks) }

    async close() {
        await this.accounts.close()
        for (const session of this.sessions.values()) session.stop()
        await this.settled()
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.listeners.clear()
        this.db.close()
    }
}

export const openChatStore = async () => {
    const databasePath = resolve(process.env.PUPPYGPT_DATA_DIR ?? ".puppygpt", "chats.sqlite")
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 })
    const db = new Database(databasePath, { create: true })
    await chmod(databasePath, 0o600)
    const policyPath = process.env.PUPPYGPT_EXECUTION_CONFIG
    const executionPolicy = policyPath ? validatePolicy(await Bun.file(resolve(policyPath)).json()) : hostPolicy
    const store = new ChatStore(db, resolve(process.env.PUPPYGPT_WORKDIR ?? process.cwd()), { maxRetries: 3, executionPolicy }, resolve(dirname(databasePath), "accounts"))
    await store.accounts.migrateCredentials()
    return store
}
