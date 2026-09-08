import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { ChatStore } from "./chats"
import { createChatApi } from "./chat-api"
import { ScheduleStore, validateScheduleTiming, type ScheduleInput } from "./schedules"
import type { JsonObject } from "./agent/types"

const principal = "11111111-1111-4111-8111-111111111111"
const target = { kind: "chat" as const, chatId: principal }
const once = (runAt = "2026-09-07T10:01:00") => ({ kind: "once" as const, runAt, timezone: "Europe/Helsinki" })
const input = (timing: ScheduleInput["timing"] = once()): ScheduleInput => ({ name: "Morning check", prompt: "Check the deployment", target, timing })

test("schedule timing validates five-field cron and previews timezone-aware occurrences", () => {
    const now = new Date("2026-09-07T06:00:00Z")
    const store = new ScheduleStore(new Database(":memory:"), () => now)
    const timing = { kind: "cron", expression: "*/15 * * * *", timezone: "Europe/Helsinki", startAt: "2026-09-07T09:05" }
    expect(store.preview(timing, 3)).toEqual(["2026-09-07T06:15:00.000Z", "2026-09-07T06:30:00.000Z", "2026-09-07T06:45:00.000Z"])
    expect(() => validateScheduleTiming({ ...timing, expression: "0 */5 * * * *" })).toThrow("five-field")
    expect(() => validateScheduleTiming({ ...timing, timezone: "Moon/Base" })).toThrow("IANA")
    expect(() => validateScheduleTiming({ ...timing, endAt: "2026-09-01T10:00" })).toThrow("after the start")
})

test("daily cron preserves local wall time across daylight saving changes", () => {
    const store = new ScheduleStore(new Database(":memory:"), () => new Date("2026-03-28T00:00:00Z"))
    expect(store.preview({ kind: "cron", expression: "0 9 * * *", timezone: "Europe/Helsinki", startAt: "2026-03-28T00:00" }, 3)).toEqual([
        "2026-03-28T07:00:00.000Z", "2026-03-29T06:00:00.000Z", "2026-03-30T06:00:00.000Z",
    ])
})

test("schedule dates reject calendar overflow for every input date", () => {
    for (const date of ["2099-02-31T09:00", "2100-02-29T09:00", "2099-04-31T09:00", "2099-13-01T09:00", "2099-01-00T09:00", "2099-01-01T24:00", "2099-01-01T09:60"]) {
        expect(() => validateScheduleTiming(once(date))).toThrow("valid calendar")
        expect(() => validateScheduleTiming({ kind: "cron", expression: "0 9 * * *", timezone: "UTC", startAt: date })).toThrow("valid calendar")
        expect(() => validateScheduleTiming({ kind: "interval", every: 2, unit: "days", timezone: "UTC", startAt: "2099-01-01T09:00", endAt: date })).toThrow("valid calendar")
    }
    expect(validateScheduleTiming(once("2096-02-29T09:00"))).toMatchObject({ runAt: "2096-02-29T09:00:00" })
})

test("intervals stay anchored across month boundaries, DST, and shorter months", () => {
    const store = new ScheduleStore(new Database(":memory:"), () => new Date("2026-01-01T00:00Z"))
    const timing = { kind: "interval", every: 2, unit: "days", timezone: "UTC", startAt: "2026-01-30T09:00" }
    expect(store.preview(timing, 4)).toEqual(["2026-01-30T09:00:00.000Z", "2026-02-01T09:00:00.000Z", "2026-02-03T09:00:00.000Z", "2026-02-05T09:00:00.000Z"])
    expect(store.preview({ ...timing, timezone: "Europe/Helsinki", startAt: "2026-03-28T09:00" }, 3)).toEqual(["2026-03-28T07:00:00.000Z", "2026-03-30T06:00:00.000Z", "2026-04-01T06:00:00.000Z"])
    expect(store.preview({ ...timing, timezone: "Europe/Helsinki", startAt: "2026-10-24T09:00" }, 3)).toEqual(["2026-10-24T06:00:00.000Z", "2026-10-26T07:00:00.000Z", "2026-10-28T07:00:00.000Z"])
    expect(store.preview({ ...timing, every: 1, unit: "months", startAt: "2026-01-31T09:00" }, 3)).toEqual(["2026-01-31T09:00:00.000Z", "2026-02-28T09:00:00.000Z", "2026-03-31T09:00:00.000Z"])
    expect(store.preview({ ...timing, every: 7, unit: "hours", startAt: "2026-01-31T20:00" }, 3)).toEqual(["2026-01-31T20:00:00.000Z", "2026-02-01T03:00:00.000Z", "2026-02-01T10:00:00.000Z"])
    expect(store.preview({ ...timing, every: 40, unit: "minutes", startAt: "2026-01-31T23:50" }, 3)).toEqual(["2026-01-31T23:50:00.000Z", "2026-02-01T00:30:00.000Z", "2026-02-01T01:10:00.000Z"])
})

test("recurrence previews honor end time and remaining maximum runs", () => {
    const store = new ScheduleStore(new Database(":memory:"), () => new Date("2026-01-01T00:00Z"))
    for (const timing of [{ kind: "cron", expression: "0 9 * * *" }, { kind: "interval", every: 1, unit: "days" }]) {
        const value = { ...timing, timezone: "UTC", startAt: "2026-01-01T09:00", maxRuns: 1 }
        expect(store.preview(value, 5)).toEqual(["2026-01-01T09:00:00.000Z"])
        expect(store.preview(value, 5, undefined, 1)).toEqual([])
        expect(store.preview({ ...value, maxRuns: 3 }, 5, undefined, 1)).toHaveLength(2)
        expect(store.preview({ ...value, maxRuns: 5, endAt: "2026-01-02T09:00" }, 5)).toHaveLength(2)
    }
})

test("interval execution, pause/resume and restart retain the original anchor and limits", async () => {
    let now = new Date("2026-01-30T08:00Z")
    const db = new Database(":memory:"), store = new ScheduleStore(db, () => now)
    const schedule = store.create(input({ kind: "interval", every: 2, unit: "days", timezone: "UTC", startAt: "2026-01-30T09:00", maxRuns: 2 }))
    now = new Date("2026-01-30T09:00Z")
    await store.tick(async () => ({ chatId: principal })); await store.settled()
    expect(store.get(schedule.id)).toMatchObject({ runCount: 1, nextRunAt: "2026-02-01T09:00:00.000Z" })
    const paused = store.setStatus(schedule.id, "pause", store.get(schedule.id).revision)
    now = new Date("2026-01-31T12:00Z")
    const resumed = store.setStatus(schedule.id, "resume", paused.revision)
    expect(resumed.nextRunAt).toBe("2026-02-01T09:00:00.000Z")
    const reopened = new ScheduleStore(db, () => now)
    now = new Date("2026-02-01T09:00Z")
    await reopened.tick(async () => ({ chatId: principal })); await reopened.settled()
    expect(reopened.get(schedule.id)).toMatchObject({ status: "completed", runCount: 2 })
    expect(reopened.runs(schedule.id)).toHaveLength(2)
})

test("agent interval schedules require limits and validate their interval", () => {
    const store = new ScheduleStore(new Database(":memory:"), () => new Date("2026-01-01T00:00Z"))
    const timing = { kind: "interval" as const, every: 2, unit: "days" as const, timezone: "UTC", startAt: "2026-01-30T09:00" }
    expect(() => store.agentTool(principal, value => value).execute({ operation: "create", schedule: input(timing) })).toThrow("end time or maximum runs")
    for (const every of [0, -1, 1.5, 1_000_001]) expect(() => validateScheduleTiming({ ...timing, every })).toThrow("Interval")
    expect(() => validateScheduleTiming({ ...timing, unit: "years" })).toThrow("Choose minutes")
})

test("scheduler claims once, enforces max runs, and records execution results", async () => {
    let now = new Date("2026-09-07T07:00:00Z")
    const store = new ScheduleStore(new Database(":memory:"), () => now)
    const schedule = store.create(input(once("2026-09-07T10:01")))
    expect(schedule.nextRunAt).toBe("2026-09-07T07:01:00.000Z")
    now = new Date("2026-09-07T07:01:30Z")
    await store.tick(async () => ({ chatId: principal })); await store.settled()
    expect(store.get(schedule.id)).toMatchObject({ status: "completed", runCount: 1 })
    expect(store.runs(schedule.id)[0]).toMatchObject({ status: "succeeded", chatId: principal })

    const recurring = store.create(input({ kind: "cron", expression: "* * * * *", timezone: "UTC", startAt: "2026-09-07T07:02", maxRuns: 1 }))
    now = new Date("2026-09-07T07:02:00Z")
    await store.tick(async () => { throw new Error("agent failed") }); await store.settled()
    expect(store.get(recurring.id)).toMatchObject({ status: "completed", runCount: 1, lastError: "agent failed" })
    expect(store.runs(recurring.id)[0]?.status).toBe("failed")
})

test("scheduler skips occurrences older than the two-minute grace and resumes in the future", async () => {
    let now = new Date("2026-09-07T07:00:00Z")
    const store = new ScheduleStore(new Database(":memory:"), () => now)
    const schedule = store.create(input({ kind: "cron", expression: "* * * * *", timezone: "UTC", startAt: "2026-09-07T07:01", endAt: "2026-09-07T08:00" }))
    now = new Date("2026-09-07T07:04:01Z")
    let executions = 0
    await store.tick(async () => { executions++; return { chatId: principal } })
    expect(executions).toBe(0)
    expect(store.runs(schedule.id)[0]?.status).toBe("missed")
    expect(store.get(schedule.id).nextRunAt).toBe("2026-09-07T07:05:00.000Z")
})

test("startup marks claimed runs interrupted and exposes the error on the schedule", () => {
    const db = new Database(":memory:"), now = new Date("2026-09-07T07:00:00Z")
    const first = new ScheduleStore(db, () => now), schedule = first.create(input(once("2026-09-07T10:01")))
    const run = { id: crypto.randomUUID(), scheduleId: schedule.id, scheduledAt: "2026-09-07T07:01:00.000Z", status: "running", startedAt: now.toISOString() }
    db.query("INSERT INTO schedule_runs (id, schedule_id, scheduled_at, data) VALUES (?, ?, ?, ?)").run(run.id, run.scheduleId, run.scheduledAt, JSON.stringify(run))
    const reopened = new ScheduleStore(db, () => new Date("2026-09-07T07:02:00Z"))
    expect(reopened.runs(schedule.id)[0]).toMatchObject({ status: "interrupted", error: expect.stringContaining("restarted") })
    expect(reopened.get(schedule.id).lastError).toContain("restarted")
})

test("agent permissions default to own management and require bounded recurrence", () => {
    const db = new Database(":memory:"), store = new ScheduleStore(db, () => new Date("2026-09-07T07:00:00Z"))
    const tool = store.agentTool(principal, value => value)
    expect(store.permission(principal)).toMatchObject({ level: "manage", scope: "own" })
    expect(() => tool.execute({ operation: "create", schedule: input({ kind: "cron", expression: "* * * * *", timezone: "UTC", startAt: "2026-09-07T07:01" }) })).toThrow("end time or maximum runs")
    const created = tool.execute({ operation: "create", schedule: input({ kind: "cron", expression: "* * * * *", timezone: "UTC", startAt: "2026-09-07T07:01", maxRuns: 2 }) }) as { applied: boolean, result: { id: string } }
    expect(created.applied).toBeTrue()
    store.setPermission(principal, { level: "propose", scope: "own" })
    const proposal = tool.execute({ operation: "pause", schedule_id: created.result.id, expected_revision: 1 }) as { applied: boolean }
    expect(proposal.applied).toBeFalse()
    expect(store.get(created.result.id).status).toBe("active")
})

test("scheduled wakeups enter an idle chat agent loop and persist run history", async () => {
    const root = await mkdtemp("/tmp/puppygpt-schedule-")
    const authFile = `${root}/auth.json`, db = new Database(":memory:")
    const claims = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `h.${claims}.s`, refresh_token: "fake" } }))
    const response = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Scheduled work done" }] }] } })}\n\n`)
    const store = new ChatStore(db, root, { authFile, fetchImpl: async () => response() })
    try {
        const chat = await store.create(root)
        const schedule = store.schedules.create(store.prepareScheduleInput({ name: "Wake test", prompt: "Inspect the service", target: { kind: "chat", chatId: chat.id }, timing: { kind: "once", runAt: "2099-01-01T00:00", timezone: "UTC" } }))
        const current = store.schedules.get(schedule.id); current.nextRunAt = new Date().toISOString()
        db.query("UPDATE schedules SET data = ? WHERE id = ?").run(JSON.stringify(current), current.id)
        await store.runSchedulesNow()
        expect(store.schedules.runs(schedule.id)[0]).toMatchObject({ status: "succeeded", chatId: chat.id })
        expect(store.get(chat.id)?.messages.map(message => message.text)).toEqual(["Scheduled · Wake test\nInspect the service", "Scheduled work done"])
    } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test("a busy target launches a fresh related chat instead of steering the active turn", async () => {
    const root = await mkdtemp("/tmp/puppygpt-schedule-busy-"), db = new Database(":memory:")
    const authFile = `${root}/auth.json`, claims = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `h.${claims}.s`, refresh_token: "fake" } }))
    let calls = 0, started!: () => void
    const firstStarted = new Promise<void>(resolve => { started = resolve })
    const store = new ChatStore(db, root, { authFile, fetchImpl: async (_url, init) => {
        calls += 1
        if (calls === 1) { started(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true })) }
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Fresh agent done" }] }] } })}\n\n`)
    } })
    try {
        const source = await store.create(root)
        store.send(source.id, "Keep working"); await firstStarted
        const schedule = store.schedules.create(store.prepareScheduleInput({ name: "Parallel check", prompt: "Run independently", target: { kind: "chat", chatId: source.id }, timing: { kind: "once", runAt: "2099-01-01T00:00", timezone: "UTC" } }))
        const due = store.schedules.get(schedule.id); due.nextRunAt = new Date().toISOString(); db.query("UPDATE schedules SET data = ? WHERE id = ?").run(JSON.stringify(due), due.id)
        await store.runSchedulesNow()
        const run = store.schedules.runs(schedule.id)[0]!
        expect(run.status).toBe("succeeded"); expect(run.chatId).not.toBe(source.id)
        expect(store.get(run.chatId!)).toMatchObject({ cwd: source.cwd, model: source.model, title: expect.stringContaining("Parallel check") })
        expect(store.get(source.id)?.messages.filter(message => message.role === "user")).toHaveLength(1)
        store.stop(source.id); await store.settled()
    } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test("schedule APIs preserve same-origin checks and revisioned lifecycle", async () => {
    const root = await mkdtemp("/tmp/puppygpt-schedule-api-"), store = new ChatStore(new Database(":memory:"), root)
    try {
        const chat = await store.create(root), api = createChatApi(store)
        const schedule = { name: "API wake", prompt: "Check status", target: { kind: "chat", chatId: chat.id }, timing: { kind: "once", runAt: "2099-01-01T00:00", timezone: "UTC" } }
        const call = (path: string, body: JsonObject, origin?: string) => api(new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }))
        expect((await call("/api/schedules", { schedule }, "https://foreign.test")).status).toBe(403)
        const created = await call("/api/schedules", { schedule }); expect(created.status).toBe(201)
        const item = await created.json() as { id: string, revision: number }
        const paused = await call(`/api/schedules/${item.id}/pause`, { expectedRevision: item.revision }); expect(paused.status).toBe(200)
        const conflict = await call(`/api/schedules/${item.id}/resume`, { expectedRevision: item.revision }); expect(conflict.status).toBe(400); expect(await conflict.text()).toContain("current revision")
        const preview = await call("/api/schedules/preview", { timing: { kind: "cron", expression: "0 9 * * *", timezone: "UTC", startAt: "2099-01-01T00:00" }, count: 2 }); expect(preview.status).toBe(200); expect((await preview.json()).nextRuns).toHaveLength(2)
    } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
