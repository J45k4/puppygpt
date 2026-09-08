import { Database } from "bun:sqlite"
import { Cron } from "croner"
import type { AgentFunctionTool } from "./agent/agent"
import type { JsonObject } from "./agent/types"
import type { Gpt } from "./gpts"

export const SCHEDULE_MISFIRE_GRACE_MS = 120_000

export type ScheduleTemplate = {
    sourceChatId: string
    cwd: string
    model: string
    executionTarget: string
    accountId: string | null
    gpt?: Gpt
}
export type ScheduleTarget = { kind: "chat", chatId: string } | { kind: "new_chat", template: ScheduleTemplate }
export type ScheduleTiming =
    | { kind: "once", runAt: string, timezone: string }
    | { kind: "cron", expression: string, timezone: string, startAt: string, endAt?: string, maxRuns?: number }
    | { kind: "interval", every: number, unit: "minutes" | "hours" | "days" | "months", timezone: string, startAt: string, endAt?: string, maxRuns?: number }
export type ScheduleStatus = "active" | "paused" | "completed" | "archived"
export type Schedule = {
    id: string
    revision: number
    name: string
    prompt: string
    target: ScheduleTarget
    timing: ScheduleTiming
    owner: { type: "user" | "agent", id: string }
    status: ScheduleStatus
    nextRunAt?: string
    lastRunAt?: string
    runCount: number
    lastError?: string
    createdAt: string
    updatedAt: string
}
export type ScheduleRun = {
    id: string
    scheduleId: string
    scheduledAt: string
    status: "running" | "succeeded" | "failed" | "interrupted" | "missed"
    startedAt: string
    finishedAt?: string
    chatId?: string
    error?: string
}
export type SchedulePermission = { principalId: string, level: "observe" | "propose" | "manage", scope: "own" | "all", updatedAt: string }
export type ScheduleProposal = { id: string, principalId: string, operation: string, input: JsonObject, status: "pending" | "approved" | "rejected", createdAt: string }
export type ScheduleInput = { name: string, prompt: string, target: ScheduleTarget, timing: ScheduleTiming }
export type ScheduleExecution = (schedule: Schedule, run: ScheduleRun) => Promise<{ chatId: string }>

type DataRow = { data: string }
const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
}
const text = (value: unknown, label: string, max: number): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be 1-${max} characters`)
    return value.trim()
}
const timezone = (value: unknown): string => {
    const result = text(value, "Timezone", 100)
    try { new Intl.DateTimeFormat("en", { timeZone: result }).format() } catch { throw new Error("Choose a valid IANA timezone") }
    return result
}
const localDate = (value: unknown, label: string): string => {
    const result = text(value, label, 32)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(result)) throw new Error(`${label} must be a local date and time`)
    const normalized = result.length === 16 ? `${result}:00` : result
    const parsed = new Date(`${normalized}Z`)
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== normalized) throw new Error(`${label} must be a valid calendar date and time`)
    return normalized
}
const localInstant = (value: string, zone: string): Date => {
    const result = new Cron(value, { timezone: zone, paused: true }).nextRun(new Date(0))
    if (!result) throw new Error("Date is outside the supported range")
    return result
}
const cronFor = (timing: Extract<ScheduleTiming, { kind: "cron" }>) => new Cron(timing.expression, {
    timezone: timing.timezone, mode: "5-part", paused: true, domAndDow: false,
})
const intervalNext = (timing: Extract<ScheduleTiming, { kind: "interval" }>, after: Date): Date | null => {
    const start = localInstant(timing.startAt, timing.timezone)
    if (timing.unit === "minutes" || timing.unit === "hours") {
        const step = timing.every * (timing.unit === "minutes" ? 60_000 : 3_600_000)
        const index = Math.max(0, Math.floor((after.getTime() - start.getTime()) / step) + 1)
        const next = new Date(start.getTime() + index * step)
        return Number.isFinite(next.getTime()) && next.getUTCFullYear() <= 9999 ? next : null
    }
    // Calendar intervals preserve the original local time and never reset at a month boundary.
    const anchor = new Date(`${timing.startAt}Z`)
    const parts = new Intl.DateTimeFormat("en", { timeZone: timing.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(after)
    const part = (type: string) => Number(parts.find(part => part.type === type)!.value)
    const localDay = new Date(0)
    localDay.setUTCFullYear(part("year"), part("month") - 1, part("day")); localDay.setUTCHours(0, 0, 0, 0)
    const distance = timing.unit === "days" ? (localDay.getTime() - anchor.getTime()) / 86_400_000
        : (localDay.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + localDay.getUTCMonth() - anchor.getUTCMonth()
    let index = Math.max(0, Math.floor(distance / timing.every) - 1)
    while (true) {
        const candidate = new Date(anchor)
        if (timing.unit === "days") candidate.setUTCDate(anchor.getUTCDate() + index * timing.every)
        else {
            candidate.setUTCDate(1); candidate.setUTCMonth(anchor.getUTCMonth() + index * timing.every)
            const endOfMonth = new Date(candidate); endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1, 0)
            candidate.setUTCDate(Math.min(anchor.getUTCDate(), endOfMonth.getUTCDate()))
        }
        if (!Number.isFinite(candidate.getTime()) || candidate.getUTCFullYear() > 9999) return null
        const next = localInstant(candidate.toISOString().slice(0, 19), timing.timezone)
        if (next > after) return next
        index += 1
    }
}
const nextFor = (timing: ScheduleTiming, after: Date): Date | null => {
    if (timing.kind === "once") {
        const at = localInstant(timing.runAt, timing.timezone)
        return at.getTime() > after.getTime() ? at : null
    }
    const start = localInstant(timing.startAt, timing.timezone)
    const reference = new Date(Math.max(after.getTime(), start.getTime() - 1_000))
    const next = timing.kind === "interval" ? intervalNext(timing, after) : cronFor(timing).nextRun(reference)
    if (!next) return null
    const end = timing.endAt ? localInstant(timing.endAt, timing.timezone) : undefined
    return end && next > end ? null : next
}

export const validateScheduleTiming = (value: unknown): ScheduleTiming => {
    const input = object(value, "Timing")
    const kind = input.kind
    const zone = timezone(input.timezone)
    if (kind === "once") {
        const runAt = localDate(input.runAt, "Run time")
        localInstant(runAt, zone)
        return { kind, runAt, timezone: zone }
    }
    if (kind !== "cron" && kind !== "interval") throw new Error("Timing kind must be once, interval, or cron")
    const startAt = localDate(input.startAt, "Start time")
    const endAt = input.endAt === undefined || input.endAt === "" ? undefined : localDate(input.endAt, "End time")
    const maxRuns = input.maxRuns === undefined || input.maxRuns === null || input.maxRuns === "" ? undefined : Number(input.maxRuns)
    if (maxRuns !== undefined && (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 1_000_000)) throw new Error("Maximum runs must be an integer from 1 to 1,000,000")
    localInstant(startAt, zone)
    if (endAt && localInstant(endAt, zone).getTime() < localInstant(startAt, zone).getTime()) throw new Error("End time must be after the start time")
    if (kind === "interval") {
        if (!Number.isSafeInteger(input.every) || Number(input.every) < 1 || Number(input.every) > 1_000_000) throw new Error("Interval must be an integer from 1 to 1,000,000")
        if (!["minutes", "hours", "days", "months"].includes(String(input.unit))) throw new Error("Choose minutes, hours, days, or months")
        return { kind, every: input.every as number, unit: input.unit as Extract<ScheduleTiming, { kind: "interval" }>["unit"], timezone: zone, startAt, ...(endAt ? { endAt } : {}), ...(maxRuns ? { maxRuns } : {}) }
    }
    const expression = text(input.expression, "Cron expression", 200).replace(/\s+/g, " ")
    if (expression.split(" ").length !== 5) throw new Error("Use a five-field cron expression without seconds or year")
    const timing: Extract<ScheduleTiming, { kind: "cron" }> = { kind, expression, timezone: zone, startAt, ...(endAt ? { endAt } : {}), ...(maxRuns ? { maxRuns } : {}) }
    cronFor(timing)
    return timing
}

const validateTarget = (value: unknown): ScheduleTarget => {
    const input = object(value, "Target")
    if (input.kind === "chat") return { kind: "chat", chatId: text(input.chatId, "Chat ID", 128) }
    if (input.kind !== "new_chat") throw new Error("Target kind must be chat or new_chat")
    const source = object(input.template, "New chat template")
    const template: ScheduleTemplate = {
        sourceChatId: text(source.sourceChatId, "Template chat ID", 128), cwd: text(source.cwd, "Workspace", 4096),
        model: text(source.model, "Model", 100), executionTarget: text(source.executionTarget, "Execution target", 128),
        accountId: source.accountId === null ? null : text(source.accountId, "Account ID", 128),
    }
    if (source.gpt !== undefined) template.gpt = structuredClone(object(source.gpt, "GPT")) as Gpt
    return { kind: "new_chat", template }
}
const validateInput = (value: unknown): ScheduleInput => {
    const input = object(value, "Schedule")
    return { name: text(input.name, "Schedule name", 120), prompt: text(input.prompt, "Schedule prompt", 32_000), target: validateTarget(input.target), timing: validateScheduleTiming(input.timing) }
}

export class ScheduleStore {
    private timer?: ReturnType<typeof setInterval>
    private ticking = false
    private executions = new Set<Promise<void>>()
    constructor(private db: Database, private now: () => Date = () => new Date()) {
        db.run("CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(schedule_id, scheduled_at))")
        db.run("CREATE TABLE IF NOT EXISTS schedule_permissions (principal_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS schedule_proposals (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS schedule_audit (position INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)")
        const interruptedAt = this.now().toISOString()
        for (const row of db.query<DataRow, []>("SELECT data FROM schedule_runs WHERE json_extract(data, '$.status') = 'running'").all()) {
            const run = JSON.parse(row.data) as ScheduleRun
            run.status = "interrupted"; run.finishedAt = interruptedAt; run.error = "PuppyGPT restarted during this scheduled run"
            db.query("UPDATE schedule_runs SET data = ? WHERE id = ?").run(JSON.stringify(run), run.id)
            const scheduleRow = db.query<DataRow, [string]>("SELECT data FROM schedules WHERE id = ?").get(run.scheduleId)
            if (scheduleRow) { const schedule = JSON.parse(scheduleRow.data) as Schedule; schedule.lastError = run.error; schedule.updatedAt = interruptedAt; db.query("UPDATE schedules SET data = ? WHERE id = ?").run(JSON.stringify(schedule), schedule.id) }
        }
    }

    list(includeArchived = false): Schedule[] { return this.db.query<DataRow, []>("SELECT data FROM schedules ORDER BY json_extract(data, '$.createdAt') DESC").all().map(row => JSON.parse(row.data)).filter(item => includeArchived || item.status !== "archived") }
    get(id: string): Schedule { const row = this.db.query<DataRow, [string]>("SELECT data FROM schedules WHERE id = ?").get(id); if (!row) throw new Error("Schedule not found"); return JSON.parse(row.data) }
    runs(id: string, limit = 100): ScheduleRun[] { this.get(id); return this.db.query<DataRow, [string, number]>("SELECT data FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_at DESC LIMIT ?").all(id, Math.max(1, Math.min(limit, 500))).map(row => JSON.parse(row.data)) }
    audit(limit = 100): unknown[] { return this.db.query<DataRow, [number]>("SELECT data FROM schedule_audit ORDER BY position DESC LIMIT ?").all(Math.max(1, Math.min(limit, 500))).map(row => JSON.parse(row.data)) }
    permission(principalId: string): SchedulePermission { const row = this.db.query<DataRow, [string]>("SELECT data FROM schedule_permissions WHERE principal_id = ?").get(principalId); return row ? JSON.parse(row.data) : { principalId, level: "manage", scope: "own", updatedAt: this.now().toISOString() } }
    permissions(): SchedulePermission[] { return this.db.query<DataRow, []>("SELECT data FROM schedule_permissions ORDER BY principal_id").all().map(row => JSON.parse(row.data)) }
    proposals(): ScheduleProposal[] { return this.db.query<DataRow, []>("SELECT data FROM schedule_proposals ORDER BY rowid DESC").all().map(row => JSON.parse(row.data)) }

    preview(value: unknown, count = 5, from = this.now(), runCount = 0): string[] {
        const timing = validateScheduleTiming(value)
        if (timing.kind === "once") { const at = localInstant(timing.runAt, timing.timezone); return at >= from ? [at.toISOString()] : [] }
        const result: string[] = []
        let cursor = new Date(from.getTime() - 1_000)
        const remaining = timing.maxRuns === undefined ? 20 : Math.max(0, timing.maxRuns - runCount)
        for (let index = 0; index < Math.min(Math.max(1, Math.min(count, 20)), remaining); index += 1) {
            const next = nextFor(timing, cursor)
            if (!next) break
            result.push(next.toISOString()); cursor = next
        }
        return result
    }
    private next(timing: ScheduleTiming, from: Date): string | undefined { return nextFor(timing, new Date(from.getTime() - 1_000))?.toISOString() }
    private write(schedule: Schedule, actor: string, operation: string) {
        this.db.transaction(() => {
            this.db.query("INSERT INTO schedules (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(schedule.id, JSON.stringify(schedule))
            this.db.query("INSERT INTO schedule_audit (data) VALUES (?)").run(JSON.stringify({ at: this.now().toISOString(), actor, operation, scheduleId: schedule.id, revision: schedule.revision }))
        })()
    }
    create(value: unknown, actor = "user:local", owner: Schedule["owner"] = { type: "user", id: "local" }, requireRecurringLimit = false): Schedule {
        const input = validateInput(value)
        if (requireRecurringLimit && input.timing.kind !== "once" && !input.timing.endAt && !input.timing.maxRuns) throw new Error("Agent-created recurring schedules need an end time or maximum runs")
        const now = this.now(), nextRunAt = this.next(input.timing, now)
        if (!nextRunAt) throw new Error("Schedule has no future occurrence")
        const schedule: Schedule = { ...input, id: crypto.randomUUID(), revision: 1, owner, status: "active", nextRunAt, runCount: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() }
        this.write(schedule, actor, "schedule.create")
        return schedule
    }
    update(id: string, value: unknown, expectedRevision: number, actor = "user:local", requireRecurringLimit = false): Schedule {
        const current = this.get(id)
        if (current.revision !== expectedRevision) throw new Error(`Schedule changed: expected revision ${expectedRevision}, current revision ${current.revision}`)
        const input = validateInput(value)
        if (requireRecurringLimit && input.timing.kind !== "once" && !input.timing.endAt && !input.timing.maxRuns) throw new Error("Agent-created recurring schedules need an end time or maximum runs")
        const nextRunAt = this.next(input.timing, this.now())
        const maxed = input.timing.kind !== "once" && input.timing.maxRuns !== undefined && current.runCount >= input.timing.maxRuns
        const status = current.status === "archived" ? "archived" : nextRunAt && !maxed ? current.status === "paused" ? "paused" : "active" : "completed"
        const schedule: Schedule = { ...current, ...input, revision: current.revision + 1, status, updatedAt: this.now().toISOString() }
        delete schedule.lastError
        if (status === "active" && nextRunAt) schedule.nextRunAt = nextRunAt; else delete schedule.nextRunAt
        this.write(schedule, actor, "schedule.update")
        return schedule
    }
    setStatus(id: string, operation: "pause" | "resume" | "archive", expectedRevision: number, actor = "user:local"): Schedule {
        const schedule = this.get(id)
        if (schedule.revision !== expectedRevision) throw new Error(`Schedule changed: expected revision ${expectedRevision}, current revision ${schedule.revision}`)
        if (operation === "pause") { if (schedule.status !== "active") throw new Error("Only active schedules can be paused"); schedule.status = "paused"; delete schedule.nextRunAt }
        if (operation === "archive") { schedule.status = "archived"; delete schedule.nextRunAt }
        if (operation === "resume") {
            if (schedule.status !== "paused") throw new Error("Only paused schedules can be resumed")
            if (schedule.timing.kind !== "once" && schedule.timing.maxRuns !== undefined && schedule.runCount >= schedule.timing.maxRuns) throw new Error("Schedule has reached its maximum runs")
            const next = this.next(schedule.timing, this.now()); if (!next) throw new Error("Schedule has no future occurrence")
            schedule.status = "active"; schedule.nextRunAt = next; delete schedule.lastError
        }
        schedule.revision += 1; schedule.updatedAt = this.now().toISOString()
        this.write(schedule, actor, `schedule.${operation}`)
        return schedule
    }
    setPermission(principalId: string, value: unknown): SchedulePermission {
        const input = object(value, "Permission")
        if (!["observe", "propose", "manage"].includes(String(input.level))) throw new Error("Access level must be observe, propose, or manage")
        if (!["own", "all"].includes(String(input.scope))) throw new Error("Access scope must be own or all")
        const permission: SchedulePermission = { principalId: text(principalId, "Principal ID", 128), level: input.level as SchedulePermission["level"], scope: input.scope as SchedulePermission["scope"], updatedAt: this.now().toISOString() }
        this.db.transaction(() => {
            this.db.query("INSERT INTO schedule_permissions (principal_id, data) VALUES (?, ?) ON CONFLICT(principal_id) DO UPDATE SET data=excluded.data").run(principalId, JSON.stringify(permission))
            this.db.query("INSERT INTO schedule_audit (data) VALUES (?)").run(JSON.stringify({ at: permission.updatedAt, actor: "user:local", operation: "permission.update", principalId }))
        })()
        return permission
    }
    private propose(principalId: string, operation: string, input: JsonObject): ScheduleProposal {
        const proposal: ScheduleProposal = { id: crypto.randomUUID(), principalId, operation, input, status: "pending", createdAt: this.now().toISOString() }
        this.db.transaction(() => {
            this.db.query("INSERT INTO schedule_proposals (id, data) VALUES (?, ?)").run(proposal.id, JSON.stringify(proposal))
            this.db.query("INSERT INTO schedule_audit (data) VALUES (?)").run(JSON.stringify({ at: proposal.createdAt, actor: `agent:${principalId}`, operation: "proposal.create", proposalId: proposal.id }))
        })()
        return proposal
    }
    resolveProposal(id: string, approve: boolean): ScheduleProposal {
        const row = this.db.query<DataRow, [string]>("SELECT data FROM schedule_proposals WHERE id = ?").get(id)
        if (!row) throw new Error("Schedule proposal not found")
        const proposal = JSON.parse(row.data) as ScheduleProposal
        if (proposal.status !== "pending") throw new Error("Schedule proposal was already resolved")
        if (approve) this.applyOperation(proposal.operation, proposal.input, "user:local", { type: "agent", id: proposal.principalId }, true)
        proposal.status = approve ? "approved" : "rejected"
        this.db.transaction(() => {
            this.db.query("UPDATE schedule_proposals SET data = ? WHERE id = ?").run(JSON.stringify(proposal), id)
            this.db.query("INSERT INTO schedule_audit (data) VALUES (?)").run(JSON.stringify({ at: this.now().toISOString(), actor: "user:local", operation: `proposal.${proposal.status}`, proposalId: id }))
        })()
        return proposal
    }
    pauseForError(id: string, error: string): Schedule {
        const schedule = this.get(id)
        schedule.status = "paused"; delete schedule.nextRunAt; schedule.lastError = error; schedule.revision += 1; schedule.updatedAt = this.now().toISOString()
        this.write(schedule, "system:scheduler", "schedule.pause_error")
        return schedule
    }
    private assertOwn(principalId: string, schedule: Schedule, permission: SchedulePermission) {
        if (permission.scope === "own" && (schedule.owner.type !== "agent" || schedule.owner.id !== principalId)) throw new Error("This agent can only manage schedules it owns")
    }
    private applyOperation(operation: string, input: JsonObject, actor: string, owner: Schedule["owner"], requireLimit: boolean): unknown {
        if (operation === "create") return this.create(input.schedule, actor, owner, requireLimit)
        const id = text(input.schedule_id, "Schedule ID", 128), expected = Number(input.expected_revision)
        if (!Number.isSafeInteger(expected)) throw new Error("expected_revision is required")
        if (operation === "update") return this.update(id, input.schedule, expected, actor, requireLimit)
        if (["pause", "resume", "archive"].includes(operation)) return this.setStatus(id, operation as "pause" | "resume" | "archive", expected, actor)
        throw new Error("Unknown schedule operation")
    }
    agentTool(principalId: string, prepare: (value: unknown) => unknown): AgentFunctionTool {
        return { definition: SCHEDULE_TOOL, label: input => `Schedule · ${String(input.operation ?? "inspect")}`, execute: input => {
            const operation = String(input.operation ?? ""), permission = this.permission(principalId)
            const visible = () => this.list().filter(schedule => permission.scope === "all" || (schedule.owner.type === "agent" && schedule.owner.id === principalId) || (schedule.target.kind === "chat" && schedule.target.chatId === principalId))
            if (operation === "list") return { schedules: visible(), permission, proposals: this.proposals().filter(item => item.principalId === principalId) }
            if (operation === "preview") return { nextRuns: this.preview(input.timing, Number(input.count) || 5) }
            if (!["create", "update", "pause", "resume", "archive"].includes(operation)) throw new Error("Unknown schedule operation")
            if (permission.level === "observe") throw new Error("This agent has observe-only schedule access")
            const prepared: JsonObject = { ...input }
            if (operation === "create" || operation === "update") prepared.schedule = prepare(input.schedule)
            if (operation !== "create") this.assertOwn(principalId, this.get(text(input.schedule_id, "Schedule ID", 128)), permission)
            if (permission.scope === "own" && (operation === "create" || operation === "update")) {
                const target = validateTarget(object(prepared.schedule, "Schedule").target)
                const source = target.kind === "chat" ? target.chatId : target.template.sourceChatId
                if (source !== principalId) throw new Error("This agent can only target itself or fresh agents based on itself")
            }
            if (permission.level === "propose") return { applied: false, proposal: this.propose(principalId, operation, prepared) }
            return { applied: true, result: this.applyOperation(operation, prepared, `agent:${principalId}`, { type: "agent", id: principalId }, true) }
        } }
    }

    start(execute: ScheduleExecution) {
        if (this.timer) return
        const run = () => void this.tick(execute).catch(error => console.error("Schedule tick failed", error))
        run(); this.timer = setInterval(run, 15_000); this.timer.unref()
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined }
    async tick(execute: ScheduleExecution): Promise<void> {
        if (this.ticking) return
        this.ticking = true
        try {
            const now = this.now()
            for (const current of this.list().filter(schedule => schedule.status === "active" && schedule.nextRunAt && new Date(schedule.nextRunAt) <= now)) {
                const schedule = this.get(current.id)
                if (schedule.status !== "active" || !schedule.nextRunAt) continue
                const scheduledAt = schedule.nextRunAt
                if (now.getTime() - new Date(scheduledAt).getTime() > SCHEDULE_MISFIRE_GRACE_MS) {
                    const run: ScheduleRun = { id: crypto.randomUUID(), scheduleId: schedule.id, scheduledAt, status: "missed", startedAt: now.toISOString(), finishedAt: now.toISOString(), error: "One or more occurrences were missed while PuppyGPT was unavailable" }
                    const next = nextFor(schedule.timing, now)?.toISOString()
                    schedule.revision += 1; schedule.updatedAt = now.toISOString(); schedule.lastError = run.error
                    if (next) schedule.nextRunAt = next; else { schedule.status = "completed"; delete schedule.nextRunAt }
                    this.db.transaction(() => { this.db.query("INSERT OR IGNORE INTO schedule_runs (id, schedule_id, scheduled_at, data) VALUES (?, ?, ?, ?)").run(run.id, run.scheduleId, run.scheduledAt, JSON.stringify(run)); this.db.query("UPDATE schedules SET data = ? WHERE id = ?").run(JSON.stringify(schedule), schedule.id) })()
                    continue
                }
                const run: ScheduleRun = { id: crypto.randomUUID(), scheduleId: schedule.id, scheduledAt, status: "running", startedAt: now.toISOString() }
                const next = schedule.timing.kind === "once" ? undefined : nextFor(schedule.timing, new Date(scheduledAt))?.toISOString()
                schedule.runCount += 1; schedule.lastRunAt = scheduledAt; schedule.revision += 1; schedule.updatedAt = now.toISOString(); delete schedule.lastError
                const maxed = schedule.timing.kind !== "once" && schedule.timing.maxRuns !== undefined && schedule.runCount >= schedule.timing.maxRuns
                if (next && !maxed) schedule.nextRunAt = next; else { schedule.status = "completed"; delete schedule.nextRunAt }
                const claimed = this.db.transaction(() => {
                    const inserted = this.db.query("INSERT OR IGNORE INTO schedule_runs (id, schedule_id, scheduled_at, data) VALUES (?, ?, ?, ?)").run(run.id, run.scheduleId, run.scheduledAt, JSON.stringify(run))
                    if (!inserted.changes) return false
                    this.db.query("UPDATE schedules SET data = ? WHERE id = ?").run(JSON.stringify(schedule), schedule.id)
                    return true
                })()
                if (!claimed) continue
                const task = execute(structuredClone(schedule), run).then(result => { run.status = "succeeded"; run.chatId = result.chatId }).catch(error => {
                    run.status = "failed"; run.error = error instanceof Error ? error.message : String(error)
                    const latest = this.get(schedule.id); latest.lastError = run.error; latest.updatedAt = this.now().toISOString(); this.db.query("UPDATE schedules SET data = ? WHERE id = ?").run(JSON.stringify(latest), latest.id)
                }).finally(() => {
                    run.finishedAt = this.now().toISOString(); this.db.query("UPDATE schedule_runs SET data = ? WHERE id = ?").run(JSON.stringify(run), run.id); this.executions.delete(task)
                })
                this.executions.add(task)
            }
        } finally { this.ticking = false }
    }
    async settled() { await Promise.all(this.executions) }
    async close() { this.stop(); await Promise.all(this.executions) }
}

export const SCHEDULE_TOOL: JsonObject = {
    type: "function", name: "schedules", strict: false,
    description: "List, preview, create, update, pause, resume, or archive persistent agent wakeup schedules. Timing uses kind once (runAt), cron (expression and startAt), or interval (every, unit, startAt); all require an IANA timezone. Interval units: minutes/hours are elapsed time, days/months preserve local time from startAt (short months use their last day). Recurrence supports endAt and maxRuns; agent-created recurrence requires at least one limit.",
    parameters: { type: "object", properties: {
        operation: { type: "string", enum: ["list", "preview", "create", "update", "pause", "resume", "archive"] },
        schedule_id: { type: "string" }, expected_revision: { type: "integer" }, count: { type: "integer" },
        timing: { type: "object" }, schedule: { type: "object" },
    }, required: ["operation"] },
}
