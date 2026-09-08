import { useEffect, useMemo, useState } from "react"
import type { ChatSummary } from "../chat-types"
import type { Schedule, SchedulePermission, ScheduleProposal, ScheduleRun, ScheduleTiming } from "../schedules"
import { Icon } from "./Icon"

type ScheduleState = { schedules: Schedule[], permissions: SchedulePermission[], proposals: ScheduleProposal[] }
const request = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? "Request failed")
    return result
}
const inputDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const initialStart = () => { const date = new Date(Date.now() + 60 * 60_000); date.setSeconds(0, 0); return inputDate(date) }
const targetId = (schedule: Schedule) => schedule.target.kind === "chat" ? schedule.target.chatId : schedule.target.template.sourceChatId
const targetLabel = (schedule: Schedule, chats: ChatSummary[]) => {
    const target = schedule.target
    return target.kind === "chat"
        ? chats.find(chat => chat.id === target.chatId)?.title ?? "Missing chat"
        : `Fresh agent from ${chats.find(chat => chat.id === target.template.sourceChatId)?.title ?? "template"}`
}
const humanTime = (value?: string) => value ? new Date(value).toLocaleString() : "—"

function RunHistory({ scheduleId, onOpenChat }: { scheduleId: string, onOpenChat: (id: string) => void }) {
    const [runs, setRuns] = useState<ScheduleRun[] | null>(null)
    const [error, setError] = useState("")
    const [open, setOpen] = useState(false)
    useEffect(() => {
        if (!open) return
        let active = true, pending = false
        const refresh = async () => {
            if (pending) return
            pending = true
            try { const next = await request<ScheduleRun[]>(`/api/schedules/${scheduleId}/runs`); if (active) { setRuns(next); setError("") } }
            catch (error) { if (active) setError(error instanceof Error ? error.message : "Could not load history") }
            finally { pending = false }
        }
        void refresh()
        const timer = setInterval(() => void refresh(), 5000)
        return () => { active = false; clearInterval(timer) }
    }, [open, scheduleId])
    return <details className="schedule-history" onToggle={event => setOpen(event.currentTarget.open)}><summary>Run history</summary>
        {error && <p className="settings-error">{error}</p>}{runs === null ? <p className="settings-help">Open to load history.</p> : !runs.length ? <p className="settings-help">No runs yet.</p> : <ol>{runs.map(run => <li key={run.id}><span className={`schedule-run-status ${run.status}`}>{run.status}</span><time>{humanTime(run.scheduledAt)}</time>{run.chatId && <button type="button" onClick={() => onOpenChat(run.chatId!)}>Open chat</button>}{run.error && <span>{run.error}</span>}</li>)}</ol>}
    </details>
}

export function SchedulesPage({ chats, initialChatId, startCreating = false, onOpenChat, onEditorClose }: { chats: ChatSummary[], initialChatId: string | null, startCreating?: boolean, onOpenChat: (id: string) => void, onEditorClose?: () => void }) {
    const [state, setState] = useState<ScheduleState | null>(null)
    const [editing, setEditing] = useState<Schedule | null | undefined>(startCreating ? null : undefined)
    const [name, setName] = useState("")
    const [prompt, setPrompt] = useState("")
    const [targetKind, setTargetKind] = useState<"chat" | "new_chat">("chat")
    const [chatId, setChatId] = useState(initialChatId ?? chats[0]?.id ?? "")
    const [timingKind, setTimingKind] = useState<ScheduleTiming["kind"]>("once")
    const [startAt, setStartAt] = useState(initialStart)
    const [endAt, setEndAt] = useState("")
    const [maxRuns, setMaxRuns] = useState("")
    const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")
    const [expression, setExpression] = useState("0 9 * * *")
    const [every, setEvery] = useState(1)
    const [unit, setUnit] = useState<"minutes" | "hours" | "days" | "months">("days")
    const [preview, setPreview] = useState<string[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [status, setStatus] = useState("")
    const [showArchived, setShowArchived] = useState(false)
    const [permissionChat, setPermissionChat] = useState("")
    const [permissionDraft, setPermissionDraft] = useState<Pick<SchedulePermission, "level" | "scope"> | null>(null)
    const refresh = () => request<ScheduleState>(`/api/schedules${showArchived ? "?archived=1" : ""}`).then(setState)
    useEffect(() => { void refresh().catch(error => setError(error.message)); const timer = setInterval(() => void refresh().catch(() => {}), 5000); return () => clearInterval(timer) }, [showArchived])
    useEffect(() => { if (!chatId && chats.length) setChatId(initialChatId ?? chats[0]!.id) }, [chats, chatId, initialChatId])
    const selectedPermission = useMemo(() => state?.permissions.find(item => item.principalId === permissionChat), [state, permissionChat])
    const permissionLevel = permissionDraft?.level ?? selectedPermission?.level ?? "manage"
    const permissionScope = permissionDraft?.scope ?? selectedPermission?.scope ?? "own"
    const timing = (): ScheduleTiming => {
        if (timingKind === "once") return { kind: "once", runAt: startAt, timezone }
        const limits = { timezone, startAt, ...(endAt ? { endAt } : {}), ...(maxRuns ? { maxRuns: Number(maxRuns) } : {}) }
        return timingKind === "interval" ? { kind: "interval", every, unit, ...limits } : { kind: "cron", expression, ...limits }
    }
    const openEditor = (schedule?: Schedule) => {
        setEditing(schedule ?? null); setError(""); setStatus(""); setPreview([])
        if (!schedule) { setName(""); setPrompt(""); setTargetKind("chat"); setChatId(initialChatId ?? chats[0]?.id ?? ""); setTimingKind("once"); setStartAt(initialStart()); setEndAt(""); setMaxRuns(""); setEvery(1); setUnit("days"); setExpression("0 9 * * *"); return }
        setName(schedule.name); setPrompt(schedule.prompt); setTargetKind(schedule.target.kind); setChatId(targetId(schedule)); setTimingKind(schedule.timing.kind); setTimezone(schedule.timing.timezone)
        if (schedule.timing.kind === "once") { setStartAt(schedule.timing.runAt.slice(0, 16)); setEndAt(""); setMaxRuns("") }
        else {
            setStartAt(schedule.timing.startAt.slice(0, 16)); setEndAt(schedule.timing.endAt?.slice(0, 16) ?? ""); setMaxRuns(schedule.timing.maxRuns?.toString() ?? "")
            if (schedule.timing.kind === "interval") { setEvery(schedule.timing.every); setUnit(schedule.timing.unit) }
            else setExpression(schedule.timing.expression)
        }
    }
    const closeEditor = () => { setEditing(undefined); onEditorClose?.() }
    const mutate = async (action: () => Promise<unknown>, message: string) => { if (busy) return; setBusy(true); setError(""); setStatus(""); try { await action(); await refresh(); setStatus(message) } catch (error) { setError(error instanceof Error ? error.message : "Request failed") } finally { setBusy(false) } }
    const save = () => mutate(async () => {
        const schedule = { name, prompt, target: targetKind === "chat" ? { kind: "chat", chatId } : { kind: "new_chat", sourceChatId: chatId }, timing: timing() }
        await request(editing ? `/api/schedules/${editing.id}` : "/api/schedules", editing ? { schedule, expectedRevision: editing.revision } : { schedule })
        closeEditor()
    }, editing ? "Schedule updated" : "Schedule created")
    const showPreview = () => mutate(async () => { const result = await request<{ nextRuns: string[] }>("/api/schedules/preview", { timing: timing(), count: 5, ...(editing ? { scheduleId: editing.id } : {}) }); setPreview(result.nextRuns) }, "Preview updated")
    const visible = state?.schedules ?? []
    return <div className="settings-scroll"><div className="schedules-page">
        <header className="page-heading schedule-page-heading"><div><span className="eyebrow">AUTOMATED WAKEUPS</span><h1>Schedules</h1><p>Wake an existing conversation or launch a fresh agent on a clock.</p></div><div className="schedule-heading-actions"><label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived</label><button type="button" className="settings-save" disabled={!chats.length} onClick={() => openEditor()}><Icon name="plus" size={15} />New schedule</button></div></header>
        {error && <div className="settings-error" role="alert">{error}</div>}{status && <p className="schedule-status" role="status">{status}</p>}
        {!state ? <p role="status">Loading schedules…</p> : !visible.length ? <section className="schedule-empty"><Icon name="clock" size={28} /><h2>No wakeups configured</h2><p>Create one here, or ask an agent to schedule its next check.</p></section> : <div className="schedule-grid">{visible.map(schedule => <article className="schedule-card" key={schedule.id}>
            <div className="schedule-card-top"><span className={`schedule-state ${schedule.status}`}>{schedule.status}</span><span className="schedule-owner">{schedule.owner.type === "agent" ? "agent" : "human"}</span></div><h2>{schedule.name}</h2><p className="schedule-prompt">{schedule.prompt}</p>
            <dl><div><dt>Next</dt><dd>{humanTime(schedule.nextRunAt)}</dd></div><div><dt>Target</dt><dd>{targetLabel(schedule, chats)}</dd></div><div><dt>Timing</dt><dd>{schedule.timing.kind === "once" ? `Once · ${schedule.timing.timezone}` : `${schedule.timing.kind === "interval" ? `Every ${schedule.timing.every} ${schedule.timing.unit}` : schedule.timing.expression} · ${schedule.timing.timezone}`}</dd></div><div><dt>Runs</dt><dd>{schedule.runCount}{schedule.timing.kind !== "once" && schedule.timing.maxRuns ? ` / ${schedule.timing.maxRuns}` : ""}</dd></div></dl>
            {schedule.lastError && <p className="schedule-error">{schedule.lastError}</p>}{schedule.status !== "archived" && <div className="schedule-actions"><button type="button" onClick={() => openEditor(schedule)}>Edit</button>{schedule.status === "active" && <button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/schedules/${schedule.id}/pause`, { expectedRevision: schedule.revision }), "Schedule paused")}>Pause</button>}{schedule.status === "paused" && <button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/schedules/${schedule.id}/resume`, { expectedRevision: schedule.revision }), "Schedule resumed")}>Resume</button>}<button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/schedules/${schedule.id}/archive`, { expectedRevision: schedule.revision }), "Schedule archived")}>Archive</button></div>}<RunHistory scheduleId={schedule.id} onOpenChat={onOpenChat} />
        </article>)}</div>}
        {editing !== undefined && <section className="schedule-editor" aria-label={editing ? "Edit schedule" : "New schedule"}><div className="schedule-editor-heading"><div><span className="eyebrow">{editing ? "EDIT WAKEUP" : "NEW WAKEUP"}</span><h2>{editing ? editing.name : "Schedule an agent"}</h2></div><button type="button" className="icon-button" aria-label="Close editor" onClick={closeEditor}>×</button></div>
            <label>Name<input value={name} maxLength={120} onChange={event => setName(event.target.value)} placeholder="Morning deployment check" /></label><label>Prompt<textarea value={prompt} maxLength={32_000} rows={5} onChange={event => setPrompt(event.target.value)} placeholder="Check the deployment and report anything that needs attention." /></label>
            <div className="schedule-form-row"><label>Target<select value={targetKind} onChange={event => setTargetKind(event.target.value as typeof targetKind)}><option value="chat">Specific chat</option><option value="new_chat">Fresh agent every run</option></select></label><label>{targetKind === "chat" ? "Chat" : "Agent template"}<select value={chatId} onChange={event => setChatId(event.target.value)}>{chats.map(chat => <option value={chat.id} key={chat.id}>{chat.title}</option>)}</select></label></div>
            <div className="schedule-form-row"><label>Timing<select value={timingKind} onChange={event => setTimingKind(event.target.value as typeof timingKind)}><option value="once">Once</option><option value="interval">Repeat every</option><option value="cron">Recurring cron</option></select></label><label>Timezone<input value={timezone} onChange={event => setTimezone(event.target.value)} spellCheck={false} /></label></div>
            <label>{timingKind === "once" ? "Run at" : "Start at"}<input type="datetime-local" value={startAt} onChange={event => setStartAt(event.target.value)} /></label>
            {timingKind !== "once" && <>
                {timingKind === "interval" ? <><div className="schedule-repeat"><span>Repeat every</span><input aria-label="Repeat interval" type="number" min={1} max={1_000_000} value={every} onChange={event => setEvery(Number(event.target.value))} /><select aria-label="Interval unit" value={unit} onChange={event => setUnit(event.target.value as typeof unit)}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option><option value="months">months</option></select></div><p className="settings-help">Starts at the selected time. Days and months keep the local time; shorter months use their last day. Minutes and hours measure elapsed time.</p></> : <label>Advanced cron<input value={expression} onChange={event => setExpression(event.target.value)} spellCheck={false} className="mono-input" /></label>}
                <div className="schedule-form-row"><label>End at <span className="settings-optional">Optional</span><input type="datetime-local" value={endAt} onChange={event => setEndAt(event.target.value)} /></label><label>Maximum runs <span className="settings-optional">Optional</span><input type="number" min={1} max={1_000_000} value={maxRuns} onChange={event => setMaxRuns(event.target.value)} /></label></div>
            </>}
            <div className="schedule-preview"><button type="button" disabled={busy || !startAt || (timingKind === "cron" && !expression)} onClick={() => void showPreview()}>Preview next runs</button>{!!preview.length && <ol>{preview.map(value => <li key={value}>{humanTime(value)}</li>)}</ol>}</div>
            <div className="schedule-editor-actions"><button type="button" className="settings-secondary" onClick={closeEditor}>Cancel</button><button type="button" className="settings-save" disabled={busy || !name.trim() || !prompt.trim() || !chatId || !startAt} onClick={() => void save()}>{busy ? "Saving…" : "Save schedule"}</button></div>
        </section>}
        <section className="settings-card schedule-access"><h2>Agent access</h2><p className="settings-help">New agents may manage schedules they own. Privileges cannot be changed by the agent itself.</p><label>Chat agent<select value={permissionChat} onChange={event => { setPermissionChat(event.target.value); setPermissionDraft(null) }}><option value="">Choose a chat…</option>{chats.map(chat => <option value={chat.id} key={chat.id}>{chat.title}</option>)}</select></label>{permissionChat && <div className="schedule-form-row"><label>Access<select value={permissionLevel} onChange={event => setPermissionDraft({ level: event.target.value as SchedulePermission["level"], scope: permissionScope })}><option value="observe">Observe</option><option value="propose">Propose changes</option><option value="manage">Manage</option></select></label><label>Scope<select value={permissionScope} onChange={event => setPermissionDraft({ level: permissionLevel, scope: event.target.value as SchedulePermission["scope"] })}><option value="own">Own schedules</option><option value="all">All schedules</option></select></label></div>}{permissionChat && <button type="button" className="settings-secondary" disabled={busy} onClick={() => void mutate(() => request(`/api/schedule-permissions/${permissionChat}`, { level: permissionLevel, scope: permissionScope }), "Agent access saved")}>Save agent access</button>}</section>
        {!!state?.proposals.filter(item => item.status === "pending").length && <section className="settings-card schedule-proposals"><h2>Pending proposals</h2>{state.proposals.filter(item => item.status === "pending").map(proposal => <article key={proposal.id}><strong>{proposal.operation}</strong><span>{chats.find(chat => chat.id === proposal.principalId)?.title ?? proposal.principalId}</span><pre>{JSON.stringify(proposal.input, null, 2)}</pre><div className="schedule-actions"><button type="button" onClick={() => void mutate(() => request(`/api/schedule-proposals/${proposal.id}/approve`, {}), "Proposal approved")}>Approve</button><button type="button" onClick={() => void mutate(() => request(`/api/schedule-proposals/${proposal.id}/reject`, {}), "Proposal rejected")}>Reject</button></div></article>)}</section>}
    </div></div>
}
