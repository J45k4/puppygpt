import { WebhookStore } from "./webhooks"
import { describeAgentContext } from "./agent/agent"
import { IntegrationStore } from "./integrations"
import { Database } from "bun:sqlite"
import { mkdir, chmod, realpath, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { AgentSession, type AgentInteraction, type AgentTurnOptions } from "./agent"
import { resolveAuthFile } from "./agent/auth"
import { extractOutputText } from "./agent/responses"
import type { Chat, ChatMessage, ChatSummary, AppConfig } from "./chat-types"
import { defaultSettings, MODELS, validateSettings, type Settings } from "./settings"
import { hostPolicy, loadExecutionPolicy, selectTarget, type DockerControl } from "./agent/execution-targets"
import { EnvironmentStore, ENV_REAPER_INTERVAL_MS, type Environment } from "./environments"
import { GptStore } from "./gpts"
import { AccountStore } from "./accounts"

type Snapshot = ReturnType<AgentSession["contextSnapshot"]>
type Row = { data: string, context: string | null }

export class ChatStore {
    readonly integrations: IntegrationStore
    readonly webhooks: WebhookStore
    readonly gpts: GptStore
    readonly accounts: AccountStore
    readonly environments: EnvironmentStore
    private cleanupTimer?: ReturnType<typeof setInterval>
    private cleanupTask: Promise<void> = Promise.resolve()
    private sessions = new Map<string, AgentSession>()
    private live = new Map<string, Chat>()
    private listeners = new Set<(chat: Chat) => void>()
    private timers = new Map<string, ReturnType<typeof setTimeout>>()
    private tasks = new Set<Promise<void>>()
    private compacting = new Set<string>()
    private checkpointUsers = new Map<string, string[]>()
    private preparing = new Map<string, AbortController>()

    constructor(private db: Database, readonly cwd: string, private agentOptions: AgentTurnOptions = {}, accountDirectory = resolve(cwd, ".puppygpt", "accounts"), environmentControl?: DockerControl) {
        this.integrations = new IntegrationStore(db, resolve(accountDirectory, "..", "integrations.key"))
        this.gpts = new GptStore(db)
        this.environments = new EnvironmentStore(db, agentOptions.executionPolicy ?? hostPolicy, environmentControl)
        this.webhooks = new WebhookStore(db, this.environments)
        this.environments.setUsageGuard(id => this.list().some(chat => chat.status === "running" && (chat.environmentId ?? `default-${chat.executionTarget ?? (agentOptions.executionPolicy ?? hostPolicy).defaultTarget}`) === id))
        this.accounts = new AccountStore(db, accountDirectory, agentOptions)
        db.run("PRAGMA journal_mode = WAL")
        db.run("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, data TEXT NOT NULL, context TEXT)")
        db.run("PRAGMA foreign_keys = ON")
        db.transaction(() => {
            db.run(`CREATE TABLE IF NOT EXISTS messages (
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                id TEXT NOT NULL,
                position INTEGER NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'activity', 'error')),
                text TEXT NOT NULL,
                detail TEXT,
                running INTEGER,
                image TEXT,
                PRIMARY KEY (chat_id, id)
            )`)
            db.run("CREATE INDEX IF NOT EXISTS messages_chat_position ON messages(chat_id, position)")
            const columns = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all()
            for (const name of ["parent_message_id", "parent_chat_id"]) {
                if (!columns.some(column => column.name === name)) db.run(`ALTER TABLE messages ADD COLUMN ${name} TEXT`)
            }
            db.run(`CREATE TABLE IF NOT EXISTS context_checkpoints (
                chat_id TEXT NOT NULL, message_id TEXT NOT NULL, context TEXT NOT NULL,
                PRIMARY KEY(chat_id, message_id),
                FOREIGN KEY(chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE CASCADE
            )`)
            db.run(`UPDATE messages SET parent_message_id = (
                SELECT previous.id FROM messages previous WHERE previous.chat_id = messages.chat_id
                AND previous.position < messages.position ORDER BY previous.position DESC LIMIT 1
            ), parent_chat_id = chat_id WHERE parent_message_id IS NULL AND position > 0`)

            // Removing the embedded array marks each migrated row. Both writes are atomic.
            for (const row of db.query<Row, []>("SELECT data, context FROM chats WHERE json_type(data, '$.messages') = 'array'").all()) {
                this.save(JSON.parse(row.data))
            }
        })()
        for (const row of db.query<Row, []>("SELECT data, context FROM chats").all()) {
            const chat = this.hydrate(row)
            if (chat.status === "running") {
                chat.status = "error"
                chat.attentionId = crypto.randomUUID()
                for (const message of chat.messages) if (message.running) message.running = false
                chat.messages.push({ id: crypto.randomUUID(), role: "error", text: "The server restarted during this turn. Send a message to continue." })
                this.save(chat)
            }
        }
    }

    startEnvironmentCleanup() {
        if (this.cleanupTimer) return
        this.environments.initializeCleanup()
        this.cleanupTimer = setInterval(() => {
            this.cleanupTask = this.cleanupTask.then(() => this.environments.reap(Date.now(), (environment, text) => this.environmentNotice(environment, text)))
                .catch(error => console.error("Environment cleanup failed", error))
        }, ENV_REAPER_INTERVAL_MS)
        this.cleanupTimer.unref()
    }
    private environmentNotice(environment: Environment, text: string) {
        for (const summary of this.list()) {
            if ((summary.environmentId ?? `default-${summary.executionTarget ?? (this.agentOptions.executionPolicy ?? hostPolicy).defaultTarget}`) !== environment.id) continue
            const chat = this.get(summary.id)!
            chat.messages.push({ id: crypto.randomUUID(), role: "activity", text })
            chat.attentionId = crypto.randomUUID(); chat.attentionReason = "Environment cleanup"
            chat.updatedAt = new Date().toISOString()
            this.live.set(chat.id, chat); this.save(chat); this.publish(chat)
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
            const { messages, gpt, ...summary } = this.live.get(stored.id) ?? stored
            return { ...summary, ...(gpt ? { gptName: gpt.name } : {}) }
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    search(query: string): ChatSummary[] {
        const term = query.trim().toLowerCase()
        if (term.length > 500) throw new Error("Search must be 500 characters or fewer")
        if (!term) return this.list()
        const matches = (chat: Chat) => chat.title.toLowerCase().includes(term) || chat.messages.some(message => message.text.toLowerCase().includes(term))
        const rows = this.db.query<Row, [string, string]>(`SELECT data, context FROM chats
            WHERE instr(lower(json_extract(data, '$.title')), ?) > 0
            OR EXISTS (SELECT 1 FROM messages
                WHERE messages.chat_id = chats.id AND instr(lower(messages.text), ?) > 0)`).all(term, term)
        const found = new Map<string, Chat>()
        for (const row of rows) { const chat: Chat = JSON.parse(row.data); found.set(chat.id, chat) }
        for (const row of this.db.query<Row, []>("SELECT data, context FROM chats WHERE json_extract(data, '$.parentChatId') IS NOT NULL").all()) {
            const chat = this.hydrate(row)
            if (matches(chat)) found.set(chat.id, chat)
        }
        for (const chat of this.live.values()) {
            if (matches(chat)) found.set(chat.id, chat)
            else found.delete(chat.id)
        }
        return [...found.values()].map(({ messages, gpt, ...summary }) => ({ ...summary, ...(gpt ? { gptName: gpt.name } : {}) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    get(id: string): Chat | undefined {
        const live = this.live.get(id)
        if (live) return live
        const row = this.db.query<Row, [string]>("SELECT data, context FROM chats WHERE id = ?").get(id)
        return row ? this.hydrate(row) : undefined
    }

    async context(id: string) {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        const session = this.sessions.get(id)
        const row = this.db.query<Row, [string]>("SELECT data, context FROM chats WHERE id=?").get(id)
        let snapshot: Snapshot | null = session?.contextSnapshot() ?? (row?.context ? JSON.parse(row.context) : null)
        let source = session ? "live" : snapshot ? "saved" : "empty"
        if (!snapshot && chat.parentChatId && chat.forkMessageId) {
            const point = chat.messages.find(message => message.id === chat.forkMessageId)
            if (point) { snapshot = this.contextAt(chat, point); source = "branch" }
        }
        const { target } = this.environments.require(chat.environmentId ?? this.environments.defaultId(chat.executionTarget))
        const settings = this.settings()
        const configuration = await describeAgentContext({ ...this.agentOptions, cwd: chat.cwd,
            executionPolicy: { defaultTarget: target.id, targets: [target] },
            instructions: [this.agentOptions.instructions, settings.instructions, chat.gpt?.instructions].filter(Boolean).join("\n\n"),
        })
        return { chatId: id, title: chat.title, model: chat.model, cwd: chat.cwd,
            reasoningEffort: chat.gpt?.reasoningEffort ?? settings.reasoningEffort,
            source, snapshot, ...configuration }
    }

    async create(cwd = this.settings().cwd, model = this.settings().model, executionTarget?: string, environmentId?: string, gptId?: string): Promise<Chat> {
        const gpt = gptId ? this.gpts.get(gptId) : undefined
        if (gpt) model = gpt.model
        const directory = await realpath(resolve(cwd))
        if (!(await stat(directory)).isDirectory()) throw new Error("Choose an existing workspace directory")
        if (!MODELS.some(item => item.id === model)) throw new Error("Unsupported model")
        const chat: Chat = { id: crypto.randomUUID(), title: "New chat", cwd: directory, model, status: "idle", updatedAt: new Date().toISOString(), messages: [] }
        if (gpt) chat.gpt = gpt
        chat.executionTarget = selectTarget(this.agentOptions.executionPolicy ?? hostPolicy, executionTarget).id
        chat.environmentId = environmentId ?? this.environments.createForChat(chat.executionTarget, chat.id).id
        chat.executionTarget = this.environments.require(chat.environmentId).target.id
        chat.accountId = this.settings().accountId ?? null
        if (chat.accountId) this.accounts.authFile(chat.accountId)
        this.save(chat)
        this.publish(chat)
        return chat
    }

    private contextAt(chat: Chat, message: ChatMessage): Snapshot {
        const checkpoint = this.db.query<{ context: string }, [string, string]>("SELECT context FROM context_checkpoints WHERE chat_id = ? AND message_id = ?")
            .get(message.sourceChatId ?? chat.id, message.id)
        if (checkpoint) return JSON.parse(checkpoint.context)
        // Older history has no historical model snapshots. Reconstruct only the visible prefix.
        const prefix = chat.messages.slice(0, chat.messages.findIndex(item => item.id === message.id) + 1)
        return { sessionId: crypto.randomUUID(), active: false, capturedAt: new Date().toISOString(), items: prefix.map(item => ({
            role: item.role === "user" ? "user" : "assistant",
            content: [{ type: item.role === "user" ? "input_text" : "output_text", text: [item.text, item.detail, item.image ? `Image: ${item.image.path} (${item.image.prompt})` : ""].filter(Boolean).join("\n") || "[Image]" }],
        })) }
    }

    async fork(id: string, messageId: string, options: { prompt?: string, selection?: { text: string, start: number, end: number }, environmentId?: string, cwd?: string } = {}): Promise<Chat> {
        const source = this.get(id)
        if (!source) throw new Error("Chat not found")
        if (source.status === "running") throw new Error("Wait for this turn to finish before branching")
        const index = source.messages.findIndex(message => message.id === messageId)
        const message = source.messages[index]
        if (!message || !["user", "assistant"].includes(message.role) || message.running) throw new Error("Choose a completed user or assistant message")
        if (options.prompt !== undefined && (!options.prompt.trim() || options.prompt.length > 32_000)) throw new Error("Enter a question of 1–32,000 characters")
        const selection = options.selection
        if (selection && (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > message.text.length || selection.text.length > 16_000 || message.text.slice(selection.start, selection.end) !== selection.text)) throw new Error("The selected text does not match the source message")
        const environmentId = options.environmentId ?? source.environmentId ?? this.environments.defaultId(source.executionTarget)
        const { target } = this.environments.require(environmentId)
        const cwd = await realpath(resolve(options.cwd ?? source.cwd))
        if (!(await stat(cwd)).isDirectory()) throw new Error("Choose an existing workspace directory")
        // Recheck after filesystem I/O so a new source turn cannot race fork creation.
        if (this.get(id)?.status === "running") throw new Error("Wait for this turn to finish before branching")
        const exact = !!this.db.query("SELECT 1 FROM context_checkpoints WHERE chat_id = ? AND message_id = ?").get(message.sourceChatId ?? id, message.id)
        const fork: Chat = {
            id: crypto.randomUUID(), title: options.prompt?.trim().slice(0, 64) ?? `Fork: ${source.title}`.slice(0, 64),
            parentChatId: id, forkMessageId: messageId, forkPreview: message.text.slice(0, 160), forkContext: exact ? "exact" : "transcript", selection,
            cwd, model: source.model, accountId: source.accountId, gpt: source.gpt ? structuredClone(source.gpt) : undefined,
            environmentId, executionTarget: target.id, status: "idle", updatedAt: new Date().toISOString(),
            messages: structuredClone(source.messages.slice(0, index + 1)),
        }
        this.save(fork)
        this.live.set(fork.id, fork)
        this.publish(fork)
        if (options.prompt) {
            const prompt = selection ? `Question about this passage from the preceding message:\n\n<selected_passage>\n${selection.text}\n</selected_passage>\n\n${options.prompt.trim()}` : options.prompt.trim()
            return this.send(fork.id, prompt, options.prompt.trim())
        }
        return fork
    }

    markViewed(id: string, attentionId: string): void {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        // An acknowledgement for an older turn must not clear a newer completion.
        if (!attentionId || chat.attentionId !== attentionId || chat.status === "running") return
        delete chat.attentionId; delete chat.attentionReason
        this.live.set(id, chat)
        this.save(chat); this.publish(chat)
    }

    setModel(id: string, model: string): Chat {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        if (!MODELS.some(item => item.id === model)) throw new Error("Unsupported model")
        if (chat.status === "running" || this.sessions.get(id)?.active) throw new Error("Wait for the current turn to finish before changing model")
        chat.model = model
        chat.updatedAt = new Date().toISOString()
        // Rebuild on the next turn using the persisted conversation context.
        this.sessions.delete(id)
        this.live.set(id, chat)
        this.save(chat); this.publish(chat)
        return chat
    }

    setExecutionTarget(id: string, targetId: string): Chat { return this.setEnvironment(id, this.environments.defaultId(targetId)) }

    setEnvironment(id: string, environmentId: string): Chat {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        if (chat.status === "running" || this.sessions.get(id)?.active) throw new Error("Wait for the current turn to finish before changing execution target")
        if (chat.environmentId !== environmentId && chat.environmentId && this.environments.get(chat.environmentId)?.ownerChatId) throw new Error("This chat keeps its own environment. Start a new chat to use another runtime.")
        const {target} = this.environments.require(environmentId)
        chat.executionTarget = target.id
        chat.environmentId = environmentId
        chat.updatedAt = new Date().toISOString()
        this.sessions.delete(id)
        this.live.set(id, chat)
        this.save(chat); this.publish(chat)
        return chat
    }

    private hydrate(row: Row, seen = new Set<string>()): Chat {
        const chat: Chat = JSON.parse(row.data)
        if (seen.has(chat.id)) throw new Error("Invalid branch ancestry")
        seen.add(chat.id)
        let inherited: ChatMessage[] = []
        if (chat.parentChatId && chat.forkMessageId) {
            const parentRow = this.db.query<Row, [string]>("SELECT data, context FROM chats WHERE id = ?").get(chat.parentChatId)
            if (!parentRow) throw new Error("Branch source is missing")
            const parent = this.hydrate(parentRow, seen)
            const index = parent.messages.findIndex(message => message.id === chat.forkMessageId)
            if (index < 0) throw new Error("Branch point is missing")
            inherited = parent.messages.slice(0, index + 1)
        }
        const rows = this.db.query<{
            id: string, role: ChatMessage["role"], text: string, detail: string | null,
            running: number | null, image: string | null, parent_message_id: string | null, parent_chat_id: string | null,
            checkpoint: number,
        }, [string]>(`SELECT m.*, EXISTS(SELECT 1 FROM context_checkpoints c WHERE c.chat_id = m.chat_id AND c.message_id = m.id) AS checkpoint
            FROM messages m WHERE chat_id = ? ORDER BY position`).all(chat.id)
        return { ...chat, messages: [...inherited, ...rows.map(({ id, role, text, detail, running, image, parent_message_id, parent_chat_id, checkpoint }) => ({
            id, role, text, sourceChatId: chat.id,
            ...(parent_message_id ? { parentMessageId: parent_message_id, parentChatId: parent_chat_id! } : {}),
            ...(role === "user" || role === "assistant" ? { forkContext: checkpoint ? "exact" as const : "transcript" as const } : {}),
            ...(detail !== null ? { detail } : {}),
            ...(running !== null ? { running: !!running } : {}),
            ...(image !== null ? { image: JSON.parse(image) } : {}),
        }))] }
    }

    private saveMessage(chat: Chat, message: ChatMessage) {
        if (message.sourceChatId && message.sourceChatId !== chat.id) return
        message.sourceChatId = chat.id
        const previous = chat.messages[chat.messages.indexOf(message) - 1]
        message.parentMessageId = previous?.id
        message.parentChatId = previous?.sourceChatId ?? (previous ? chat.id : undefined)
        this.db.query(`INSERT INTO messages (chat_id, id, position, role, text, detail, running, image, parent_message_id, parent_chat_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id, id) DO UPDATE SET position = excluded.position, role = excluded.role,
                text = excluded.text, detail = excluded.detail, running = excluded.running, image = excluded.image,
                parent_message_id = excluded.parent_message_id, parent_chat_id = excluded.parent_chat_id
            WHERE position IS NOT excluded.position OR role IS NOT excluded.role OR text IS NOT excluded.text
                OR detail IS NOT excluded.detail OR running IS NOT excluded.running OR image IS NOT excluded.image
                OR parent_message_id IS NOT excluded.parent_message_id OR parent_chat_id IS NOT excluded.parent_chat_id`)
            .run(chat.id, message.id, chat.messages.indexOf(message), message.role, message.text,
                message.detail ?? null, message.running === undefined ? null : Number(message.running),
                message.image ? JSON.stringify(message.image) : null, message.parentMessageId ?? null, message.parentChatId ?? null)
    }

    private save(chat: Chat, snapshot?: Snapshot) {
        this.db.transaction(() => {
            const head = chat.messages.at(-1)
            chat.headMessageId = head?.id
            chat.headChatId = head?.sourceChatId ?? (head ? chat.id : undefined)
            const { messages, ...metadata } = chat
            this.db.query("INSERT INTO chats (id, data, context) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, context = COALESCE(excluded.context, chats.context)")
                .run(chat.id, JSON.stringify(metadata), snapshot ? JSON.stringify(snapshot) : null)
            const ids = new Set(messages.map(message => message.id))
            for (const row of this.db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE chat_id = ?").all(chat.id)) {
                if (!ids.has(row.id)) this.db.query("DELETE FROM messages WHERE chat_id = ? AND id = ?").run(chat.id, row.id)
            }
            for (const message of messages) this.saveMessage(chat, message)
        })()
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

    private sessionFor(chat: Chat): AgentSession {
        const environmentId = chat.environmentId ?? this.environments.defaultId(chat.executionTarget)
        this.environments.assertAvailable(environmentId)
        const { target } = this.environments.require(environmentId)
        const executionPolicy = { defaultTarget: target.id, targets: [target] }
        const authStorage = chat.accountId ? this.accounts.credentials(chat.accountId) : undefined
        const authFile = this.agentOptions.authFile
        let session = this.sessions.get(chat.id)
        if (!session) {
            const row = this.db.query<Row, [string]>("SELECT data, context FROM chats WHERE id = ?").get(chat.id)
            let snapshot: Snapshot | undefined = row?.context ? JSON.parse(row.context) : undefined
            if (!snapshot && chat.parentChatId && chat.forkMessageId) {
                const point = chat.messages.find(message => message.id === chat.forkMessageId)!
                snapshot = { ...this.contextAt(chat, point), sessionId: crypto.randomUUID(), active: false }
            }
            session = new AgentSession({ ...this.agentOptions, execute: this.agentOptions.execute ?? (input => this.environments.execute(environmentId, input)), executionPolicy, authFile, authStorage, cwd: chat.cwd, model: chat.model }, snapshot)
            this.sessions.set(chat.id, session)
        }
        return session
    }

    compact(id: string): Chat {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        if (chat.status === "running") throw new Error("Wait for the current turn to finish before compacting")
        const session = this.sessionFor(chat)
        if (session.active) throw new Error("Wait for the current turn to finish before compacting")
        if (!session.contextSnapshot().items.length) throw new Error("There is no agent context to compact")
        const turnId = crypto.randomUUID()
        const settings = this.settings()
        this.environments.touch(chat.environmentId ?? this.environments.defaultId(chat.executionTarget))
        chat.status = "running"
        this.live.set(id, chat)
        this.compacting.add(id)
        this.save(chat); this.publish(chat)
        const task = session.compact({
            reasoningEffort: chat.gpt?.reasoningEffort ?? settings.reasoningEffort,
            instructions: [this.agentOptions.instructions, settings.instructions, chat.gpt?.instructions].filter(Boolean).join("\n\n"),
            onInteraction: event => this.interact(chat, turnId, event),
        }).then(() => { chat.status = "idle" }).catch(error => {
            chat.status = error?.name === "AbortError" ? "idle" : "error"
            chat.messages.push({ id: crypto.randomUUID(), role: error?.name === "AbortError" ? "activity" : "error", text: error?.name === "AbortError" ? "Compaction stopped" : error instanceof Error ? error.message : "Compaction failed" })
        }).finally(() => {
            this.compacting.delete(id)
            for (const message of chat.messages) if (message.running) message.running = false
            chat.updatedAt = new Date().toISOString()
            this.save(chat, session.contextSnapshot())
            this.publish(chat)
            this.environments.touch(chat.environmentId ?? this.environments.defaultId(chat.executionTarget))
            this.tasks.delete(task)
        })
        this.tasks.add(task)
        return chat
    }

    send(id: string, prompt: string, displayText = prompt): Chat {
        const chat = this.get(id)
        if (!chat) throw new Error("Chat not found")
        const environmentId = chat.environmentId ?? this.environments.defaultId(chat.executionTarget)
        const {target} = this.environments.require(environmentId)
        if (this.compacting.has(id)) throw new Error("Wait for compaction to finish before sending a message")
        if (!prompt.trim() || prompt.length > 64_000) throw new Error("Enter a message of 1–64,000 characters")
        const session = this.sessionFor(chat)
        if (chat.status === "running" && !session.active) throw new Error("This turn is finishing. Try again in a moment.")
        const steering = session.active
        if (steering && !session.steer(prompt.trim())) throw new Error("The agent is stopping. Wait for it to stop before sending another message.")
        const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", text: displayText.trim() }
        chat.messages.push(userMessage)
        this.checkpointUsers.set(id, [...(this.checkpointUsers.get(id) ?? []), userMessage.id])
        if (chat.title === "New chat") chat.title = prompt.trim().replace(/\s+/g, " ").slice(0, 64)
        chat.updatedAt = new Date().toISOString()
        this.live.set(id, chat)
        if (steering) {
            this.save(chat)
            this.publish(chat)
            return chat
        }
        this.environments.touch(chat.environmentId ?? this.environments.defaultId(chat.executionTarget))
        chat.status = "running"
        this.save(chat)
        this.publish(chat)
        const turnId = crypto.randomUUID()
        const currentSession = session
        const settings = this.settings()
        const preparation = new AbortController()
        this.preparing.set(id, preparation)
        const prepare = async () => {
            const environment = this.environments.get(environmentId)
            if ((environment?.ownerChatId === chat.id || environment?.destroyedAt) && target.kind === "docker") {
                const current = await this.environments.reconcile(environmentId)
                if (current.status === "stopped") await this.environments.action(environmentId, "start")
                else if (current.status !== "ready") throw new Error(`Environment is ${current.status}. Open Environments to repair it.`)
            }
        }
        const task = prepare().then(() => {
            preparation.signal.throwIfAborted()
            this.preparing.delete(id)
            return currentSession.run(prompt.trim(), {
            reasoningEffort: chat.gpt?.reasoningEffort ?? settings.reasoningEffort,
            instructions: [this.agentOptions.instructions, settings.instructions, chat.gpt?.instructions].filter(Boolean).join("\n\n"),
            onInteraction: event => this.interact(chat, turnId, event),
        })
        }).then(() => {
            chat.status = "idle"
        }).catch(error => {
            const cancelled = error?.name === "AbortError"
            chat.status = cancelled ? "idle" : "error"
            chat.messages.push({ id: crypto.randomUUID(), role: cancelled ? "activity" : "error", text: cancelled ? "Stopped" : error instanceof Error ? error.message : "The agent could not finish this turn." })
        }).finally(() => {
            this.preparing.delete(id)
            this.checkpointUsers.delete(id)
            for (const message of chat.messages) if (message.running) message.running = false
            chat.updatedAt = new Date().toISOString()
            chat.attentionId = turnId; delete chat.attentionReason
            this.save(chat, currentSession.contextSnapshot())
            this.publish(chat)
            this.environments.touch(chat.environmentId ?? this.environments.defaultId(chat.executionTarget))
            this.tasks.delete(task)
        })
        this.tasks.add(task)
        return chat
    }

    private interact(chat: Chat, turnId: string, event: AgentInteraction) {
        let changed: ChatMessage | undefined
        if (event.type === "checkpoint") {
            const id = event.kind === "user" ? this.checkpointUsers.get(chat.id)?.shift() : `${turnId}:answer:${event.step}`
            const message = chat.messages.find(message => message.id === id)
            if (message) {
                // Queued steering belongs where it entered the model history, after the preceding response.
                if (event.kind === "user" && chat.messages.at(-1) !== message) {
                    chat.messages.splice(chat.messages.indexOf(message), 1)
                    chat.messages.push(message)
                    this.save(chat)
                }
                this.db.query("INSERT OR IGNORE INTO context_checkpoints (chat_id, message_id, context) VALUES (?, ?, ?)").run(chat.id, message.id, JSON.stringify(event.snapshot))
                message.forkContext = "exact"
            }
        } else if (event.type === "request") {
            const id = `${turnId}:answer:${event.step}`
            chat.messages = chat.messages.filter(message => message.id !== id)
            this.save(chat)
        } else if (event.type === "text_delta" || event.type === "final" || event.type === "response") {
            const id = `${turnId}:answer:${event.step}`
            const text = event.type === "response" ? extractOutputText(event.response.output) : event.text
            if (!text) return
            let message = chat.messages.find(message => message.id === id)
            if (!message) {
                message = { id, role: "assistant", text: "" }
                chat.messages.push(message)
            }
            changed = message
            message.text = event.type === "text_delta" ? message.text + text : text
        } else if (event.type === "imagegen_result") {
            const id = `${turnId}:${event.callId}`
            const message = chat.messages.find(message => message.id === id)
            if (message) {
                message.role = "assistant"
                message.text = ""
                message.running = false
                message.image = { path: event.path, prompt: event.prompt }
                changed = message
            }
        } else if (event.type === "tool_start" || event.type === "image_start" || event.type === "web_search" || event.type === "imagegen_start") {
            const id = `${turnId}:${event.callId}`
            let message = chat.messages.find(message => message.id === id)
            if (!message) {
                message = { id, role: "activity", text: "", running: true }
                chat.messages.push(message)
            }
            changed = message
            message.text = event.type === "tool_start" ? `[${event.target ?? "host"}] ${event.command}` : event.type === "image_start" ? `Viewing ${event.path}` : event.type === "imagegen_start" ? "Generating image" : "Searching the web"
            if (event.type === "imagegen_start") message.detail = event.prompt
            if (event.type === "web_search") message.running = event.status !== "completed"
        } else if (event.type === "tool_output") {
            const message = chat.messages.find(message => message.id === `${turnId}:${event.callId}`)
            changed = message
            if (message) message.detail = ((message.detail ?? "") + event.chunk.text).slice(-16_384)
        } else if (event.type === "tool_result" || event.type === "tool_error" || event.type === "image_result") {
            const message = chat.messages.find(message => message.id === `${turnId}:${event.callId}`)
            if (message) {
                changed = message
                message.running = false
                if (event.type === "tool_error") message.detail = event.error
                if (event.type === "tool_result") message.detail = `${(event.result.stdout + event.result.stderr).slice(-16_384)}\n${event.result.backgrounded ? "Continuing in background" : `Exit ${event.result.exitCode}${event.result.timedOut ? " · timed out" : ""}`}\nFull output: ${event.result.outputPath}`
            }
        } else if (event.type === "compaction_start") {
            changed = { id: `${turnId}:${event.compactionId}`, role: "activity", text: "Compacting conversation", running: true }
            chat.messages.push(changed)
        } else if (event.type === "compaction_complete" || event.type === "compaction_error") {
            const message = chat.messages.find(message => message.id === `${turnId}:${event.compactionId}`)
            changed = message
            if (message) { message.running = false; message.text = event.type === "compaction_complete" ? "Conversation compacted" : event.cancelled ? "Compaction interrupted" : "Compaction failed" }
        }
        if (changed) this.saveMessage(chat, changed)
        this.publish(chat)
    }

    stop(id: string) {
        const preparation = this.preparing.get(id)
        if (preparation) { preparation.abort(); return true }
        return this.sessions.get(id)?.stop() ?? false
    }

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
        clearInterval(this.cleanupTimer)
        await this.cleanupTask
        await this.accounts.close()
        for (const preparation of this.preparing.values()) preparation.abort()
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
    const executionPolicy = await loadExecutionPolicy(resolve(process.env.PUPPYGPT_WORKDIR ?? process.cwd()), dirname(databasePath), process.env.PUPPYGPT_EXECUTION_CONFIG)
    const store = new ChatStore(db, resolve(process.env.PUPPYGPT_WORKDIR ?? process.cwd()), { maxRetries: 3, executionPolicy }, resolve(dirname(databasePath), "accounts"))
    await store.accounts.migrateCredentials()
    store.startEnvironmentCleanup()
    return store
}
