import { useEffect, useMemo, useState } from "react"
import type { ChatSummary } from "../chat-types"
import type { Integration, IntegrationChannel } from "../integrations"
import { ROUTING_FIELDS, type RoutingPermission, type RoutingProposal, type RoutingRule, type RoutingTable } from "../routing"

type RoutingState = { table: RoutingTable, permissions: RoutingPermission[], proposals: RoutingProposal[], audit: unknown[] }
const request = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? "Request failed")
    return result
}
const summarizeFilter = (filter: RoutingRule["when"]): string => {
    if (filter.op === "all" || filter.op === "any") return `${filter.op.toUpperCase()} of ${filter.rules.length} conditions`
    if (filter.op === "not") return `NOT ${summarizeFilter(filter.rule)}`
    if (filter.op === "exists") return `${filter.field} exists`
    if (filter.op === "in") return `${filter.field} in ${filter.values.length} values`
    return `${filter.field} ${filter.op} ${JSON.stringify(filter.value)}`
}
const summarizeActions = (rule: RoutingRule, chatName: (id: string) => string): string => rule.actions.map(action => {
    if (action.type === "deliver") return action.destination.kind === "chat" ? `deliver to ${chatName(action.destination.chatId)}` : "start a chat"
    if (action.type === "add_instruction") return "add instructions"
    if (action.type === "label") return `label ${action.value}`
    return action.type
}).join(" · ")

const FILTER_OPS = ["eq", "neq", "contains", "starts_with", "ends_with", "matches", "exists"] as const
const DEFAULT_FILTER = JSON.stringify({ op: "contains", field: "message.text", value: "" }, null, 2)

function ChannelPicker({ integrationId, value, onChange }: { integrationId: string, value: string, onChange: (value: string) => void }) {
    const [channels, setChannels] = useState<IntegrationChannel[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState("")
    const [custom, setCustom] = useState(false)
    useEffect(() => {
        if (!integrationId || integrationId === "*") { setChannels(null); setCustom(true); return }
        let active = true
        setLoading(true); setLoadError("")
        fetch(`/api/integrations/${integrationId}/channels`).then(async response => {
            const body = await response.json()
            if (!response.ok) throw new Error(body.error ?? "Request failed")
            return body as IntegrationChannel[]
        }).then(list => {
            if (!active) return
            setChannels(list); setCustom(list.length === 0)
        }).catch(error => {
            if (!active) return
            setLoadError(error instanceof Error ? error.message : "Could not list channels")
            setChannels([]); setCustom(true)
        }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
    }, [integrationId])
    if (!integrationId || integrationId === "*") return <><input value={value} placeholder="channel-id" autoComplete="off" spellCheck={false} onChange={event => onChange(event.target.value)} /><span className="settings-help">Pick a specific connection to list its channels.</span></>
    if (loading) return <p className="settings-help" role="status">Loading channels…</p>
    return <>
        {!custom && channels && <select value={channels.some(channel => channel.id === value) ? value : ""} onChange={event => {
            if (event.target.value === "__custom") { setCustom(true); return }
            onChange(event.target.value)
        }}>
            <option value="">Choose a channel…</option>
            {channels.map(channel => <option value={channel.id} key={channel.id}>{channel.name}</option>)}
            <option value="__custom">Enter ID manually…</option>
        </select>}
        {(custom || (channels && !channels.length)) && <input value={value} placeholder="channel-id" autoComplete="off" spellCheck={false} onChange={event => onChange(event.target.value)} />}
        {loadError && <span className="settings-help">{loadError} You can still paste an ID manually.</span>}
        {channels && !channels.length && !loadError && <span className="settings-help">No channels found. For Discord the bot must be invited to a server with text channels; for Telegram message the bot first so it appears in recent updates. You can still paste an ID manually.</span>}
        {channels && !!channels.length && custom && <span className="settings-help">Manual entry. <button type="button" onClick={() => setCustom(false)}>Back to list</button></span>}
    </>
}

function ChatPicker({ chats, value, onChange, onChatsRefresh }: { chats: ChatSummary[], value: string, onChange: (id: string) => void, onChatsRefresh: () => Promise<void> }) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState("")
    const [creating, setCreating] = useState(false)
    const [naming, setNaming] = useState(false)
    const [newName, setNewName] = useState("")
    const [createError, setCreateError] = useState("")
    const selected = chats.find(chat => chat.id === value)
    const filtered = chats.filter(chat => chat.title.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 50)
    const createNew = async () => {
        if (creating) return
        setCreating(true); setCreateError("")
        try {
            const chat = await request<{ id: string }>("/api/chats", newName.trim() ? { title: newName.trim() } : {})
            await onChatsRefresh()
            onChange(chat.id)
            setOpen(false); setQuery(""); setNaming(false); setNewName("")
        } catch (error) { setCreateError(error instanceof Error ? error.message : "Could not create chat") }
        finally { setCreating(false) }
    }
    const close = () => { setOpen(false); setQuery(""); setNaming(false); setNewName(""); setCreateError("") }
    return <div className="chat-picker">
        <button type="button" className="chat-picker-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen(!open); setQuery(""); setNaming(false); setNewName(""); setCreateError("") }}>
            <span>{selected ? selected.title : value ? "Missing chat — pick another" : "Choose a chat…"}</span><span aria-hidden="true">▾</span>
        </button>
        {open && <div className="chat-picker-popover" role="listbox">
            <input autoFocus value={query} placeholder="Search chats…" autoComplete="off" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") close() }} />
            <div className="chat-picker-list">
                {!filtered.length ? <p className="settings-help">No matches. Create a fresh chat below.</p> : filtered.map(chat => <button key={chat.id} type="button" role="option" aria-selected={chat.id === value} className={chat.id === value ? "selected" : ""} onClick={() => { onChange(chat.id); close() }}>{chat.title}</button>)}
            </div>
            {naming
                ? <div className="chat-picker-create"><input value={newName} maxLength={64} placeholder="Chat name" autoComplete="off" onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void createNew() } if (event.key === "Escape") setNaming(false) }} /><div className="chat-picker-footer"><button type="button" disabled={creating || !newName.trim()} onClick={() => void createNew()}>{creating ? "Creating…" : "Create chat"}</button><button type="button" onClick={() => { setNaming(false); setNewName("") }}>Back</button></div></div>
                : <div className="chat-picker-footer"><button type="button" onClick={() => { setNaming(true); setNewName(query.trim()); setCreateError("") }}>＋ New chat</button><button type="button" onClick={close}>Close</button></div>}
            {createError && <p className="settings-error">{createError}</p>}
        </div>}
    </div>
}

function describeRuleForEdit(rule: RoutingRule) {
    const deliver = rule.actions.find(action => action.type === "deliver")
    const instruction = rule.actions.find(action => action.type === "add_instruction")
    const label = rule.actions.find(action => action.type === "label")
    const reply = rule.actions.find(action => action.type === "reply")
    const ignore = rule.actions.some(action => action.type === "ignore")
    return {
        name: rule.name,
        integrationId: rule.source.integrationId,
        filterJson: JSON.stringify(rule.when, null, 2),
        destinationKind: ignore && !deliver ? "ignore" as const : deliver?.destination.kind ?? "chat" as const,
        destChatId: deliver?.destination.kind === "chat" ? deliver.destination.chatId : "",
        environmentId: deliver?.destination.kind === "new_chat" ? deliver.destination.environmentId ?? "" : "",
        instruction: instruction?.type === "add_instruction" ? instruction.text : "",
        labelText: label?.type === "label" ? label.value : "",
        replyText: reply?.type === "reply" ? reply.text : "",
        continueFlag: rule.continue,
        enabledFlag: rule.enabled,
    }
}

export function RoutingPanel({ integrations }: { integrations: Integration[] }) {
    const [state, setState] = useState<RoutingState | null>(null)
    const [chats, setChats] = useState<ChatSummary[]>([])
    const [principalId, setPrincipalId] = useState("")
    const [level, setLevel] = useState<RoutingPermission["level"]>("observe")
    const [integrationId, setIntegrationId] = useState("*")
    const [ownRulesOnly, setOwnRulesOnly] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [status, setStatus] = useState("")

    // Rule editor state
    const [editingId, setEditingId] = useState<string | null | undefined>(undefined)
    const [name, setName] = useState("")
    const [ruleIntegration, setRuleIntegration] = useState("*")
    const [filterMode, setFilterMode] = useState<"all" | "contains" | "custom">("contains")
    const [filterField, setFilterField] = useState<string>("message.text")
    const [filterOp, setFilterOp] = useState<string>("contains")
    const [filterValue, setFilterValue] = useState("")
    const [filterJson, setFilterJson] = useState(DEFAULT_FILTER)
    const [destinationKind, setDestinationKind] = useState<"chat" | "new_chat" | "ignore">("chat")
    const [destChatId, setDestChatId] = useState("")
    const [environmentId, setEnvironmentId] = useState("")
    const [instruction, setInstruction] = useState("")
    const [labelText, setLabelText] = useState("")
    const [replyText, setReplyText] = useState("")
    const [continueFlag, setContinueFlag] = useState(false)
    const [enabledFlag, setEnabledFlag] = useState(true)

    // Test-event state
    const [testIntegration, setTestIntegration] = useState("")
    const [testChannel, setTestChannel] = useState("")
    const [testText, setTestText] = useState("hello from discord")
    const [testResult, setTestResult] = useState<{ actions: unknown[], trace: { ruleName: string, selected: boolean }[] } | null>(null)

    // Quick-connect state: bot credentials -> chat without hand-writing filters
    const [quickIntegration, setQuickIntegration] = useState("")
    const [quickChat, setQuickChat] = useState("")
    const [quickScope, setQuickScope] = useState<"all" | "channel">("all")
    const [quickChannel, setQuickChannel] = useState("")

    const refresh = async () => setState(await request<RoutingState>("/api/routing"))
    const refreshChats = async () => setChats(await request<ChatSummary[]>("/api/chats"))
    useEffect(() => { void Promise.all([refresh(), refreshChats()]).catch(error => setError(error.message)) }, [])
    const permission = useMemo(() => state?.permissions.find(item => item.principalId === principalId), [state, principalId])
    useEffect(() => {
        if (!principalId) return
        setLevel(permission?.level ?? "observe")
        setIntegrationId(permission?.integrationIds[0] ?? "*")
        setOwnRulesOnly(permission?.ownRulesOnly ?? true)
    }, [principalId, permission])
    useEffect(() => {
        if (!testIntegration && integrations.length) setTestIntegration(integrations[0]!.id)
        if (!ruleIntegration || ruleIntegration === "*") setRuleIntegration(integrations[0]?.id ?? "*")
        if (!destChatId && chats.length) setDestChatId(chats[0]!.id)
        if (!quickIntegration && integrations.length) setQuickIntegration(integrations[0]!.id)
        if (!quickChat && chats.length) setQuickChat(chats[0]!.id)
    }, [integrations, chats, testIntegration, ruleIntegration, destChatId, quickIntegration, quickChat])
    const mutate = async (action: () => Promise<unknown>, message: string) => {
        if (busy) return
        setBusy(true); setError(""); setStatus("")
        try { await action(); await refresh(); setStatus(message) }
        catch (error) { setError(error instanceof Error ? error.message : "Request failed") }
        finally { setBusy(false) }
    }
    const integrationName = (id: string) => id === "*" ? "Any connection" : integrations.find(item => item.id === id)?.name ?? id
    const chatName = (id: string) => chats.find(chat => chat.id === id)?.title ?? id.slice(0, 8)

    const openEditor = (rule?: RoutingRule) => {
        setError(""); setStatus("")
        if (!rule) {
            setEditingId(null); setName(""); setRuleIntegration(integrations[0]?.id ?? "*")
            setFilterMode("contains"); setFilterField("message.text"); setFilterOp("contains"); setFilterValue("")
            setFilterJson(JSON.stringify({ op: "contains", field: "message.text", value: "" }, null, 2))
            setDestinationKind("chat"); setDestChatId(chats[0]?.id ?? ""); setEnvironmentId("")
            setInstruction(""); setLabelText(""); setReplyText(""); setContinueFlag(false); setEnabledFlag(true)
            return
        }
        const parsed = describeRuleForEdit(rule)
        setEditingId(rule.id); setName(parsed.name); setRuleIntegration(parsed.integrationId)
        setFilterJson(parsed.filterJson)
        try {
            const when = JSON.parse(parsed.filterJson) as { op: string, field?: string, value?: unknown }
            if (when.op === "exists") { setFilterMode("all"); setFilterField(String(when.field ?? "message.text")); setFilterOp("exists"); setFilterValue("") }
            else if (when.op === "contains" && typeof when.field === "string" && typeof when.value === "string") { setFilterMode("contains"); setFilterField(when.field); setFilterOp("contains"); setFilterValue(when.value) }
            else if (typeof when.field === "string" && (FILTER_OPS as readonly string[]).includes(when.op)) { setFilterMode("custom"); setFilterField(when.field); setFilterOp(when.op); setFilterValue(typeof when.value === "string" ? when.value : "") }
            else setFilterMode("custom")
        } catch { setFilterMode("custom") }
        setDestinationKind(parsed.destinationKind); setDestChatId(parsed.destChatId || chats[0]?.id || "")
        setEnvironmentId(parsed.environmentId); setInstruction(parsed.instruction)
        setLabelText(parsed.labelText); setReplyText(parsed.replyText)
        setContinueFlag(parsed.continueFlag); setEnabledFlag(parsed.enabledFlag)
    }

    const syncBuilderToJson = (mode: "all" | "contains" | "custom", field: string, op: string, value: string) => {
        if (mode === "all") setFilterJson(JSON.stringify({ op: "exists", field: "event.id" }, null, 2))
        else if (mode === "contains") setFilterJson(JSON.stringify({ op: "contains", field: "message.text", value }, null, 2))
        else if (op === "exists") setFilterJson(JSON.stringify({ op: "exists", field }, null, 2))
        else setFilterJson(JSON.stringify({ op, field, value }, null, 2))
    }

    const saveRule = () => void mutate(async () => {
        if (!state) throw new Error("Routing table is still loading")
        if (!name.trim()) throw new Error("Give the rule a name")
        let when: unknown
        try { when = JSON.parse(filterJson) } catch { throw new Error("Filter JSON is invalid") }
        const actions: RoutingRule["actions"] = []
        if (instruction.trim()) actions.push({ type: "add_instruction", text: instruction.trim() })
        if (labelText.trim()) actions.push({ type: "label", value: labelText.trim() })
        if (destinationKind === "ignore") actions.push({ type: "ignore" })
        else if (destinationKind === "chat") {
            if (!destChatId) throw new Error("Choose a destination chat")
            actions.push({ type: "deliver", destination: { kind: "chat", chatId: destChatId } })
        } else {
            actions.push({ type: "deliver", destination: { kind: "new_chat", ...(environmentId.trim() ? { environmentId: environmentId.trim() } : {}) } })
        }
        if (replyText.trim()) actions.push({ type: "reply", text: replyText.trim() })
        if (!actions.length) throw new Error("Add at least one action")
        const rule = { name: name.trim(), enabled: enabledFlag, source: { integrationId: ruleIntegration }, when, actions, continue: continueFlag }
        if (editingId) await request(`/api/routing/rules/${editingId}`, { expectedRevision: state.table.revision, rule })
        else await request("/api/routing/rules", { expectedRevision: state.table.revision, rule })
        setEditingId(undefined)
    }, editingId ? "Rule updated" : "Rule created")

    const runTest = () => void mutate(async () => {
        const event = {
            event: { id: `test-${Date.now()}`, type: "message.created", provider: integrations.find(item => item.id === testIntegration)?.provider ?? "discord", integrationId: testIntegration || "*" },
            sender: { id: "test-user", username: "tester" },
            conversation: { id: testChannel.trim() || "test-channel", type: "guild" },
            message: { id: "test-message", text: testText },
        }
        setTestResult(await request("/api/routing/test", { event }))
    }, "Test complete")

    const isChatDeliver = (action: RoutingRule["actions"][number]): action is Extract<RoutingRule["actions"][number], { type: "deliver" }> & { destination: { kind: "chat", chatId: string } } =>
        action.type === "deliver" && action.destination.kind === "chat"
    const isSimpleConnectionRule = (rule: RoutingRule) => {
        if (!rule.actions.find(isChatDeliver)) return false
        const when = rule.when as { op: string, field?: string, value?: unknown }
        return (when.op === "exists") || (when.op === "eq" && when.field === "conversation.id" && typeof when.value === "string")
    }
    const sameSimpleFilter = (a: unknown, b: unknown) => {
        const x = a as { op: string, field?: string, value?: unknown }, y = b as { op: string, field?: string, value?: unknown }
        if (x.op !== y.op) return false
        if (x.op === "exists") return x.field === y.field
        return x.field === y.field && JSON.stringify(x.value) === JSON.stringify(y.value)
    }
    const simpleConnections = (state?.table.rules ?? []).filter(isSimpleConnectionRule)
    const quickConnect = () => void mutate(async () => {
        if (!state) throw new Error("Routing table is still loading")
        if (!quickIntegration) throw new Error("Add a bot connection above first")
        if (!quickChat) throw new Error("Choose or create a chat first")
        const channel = quickScope === "channel" ? quickChannel.trim() : ""
        if (quickScope === "channel" && !channel) throw new Error("Choose a channel or switch back to All messages")
        const when = channel ? { op: "eq", field: "conversation.id", value: channel } : { op: "exists", field: "event.id" }
        const duplicate = state.table.rules.some(rule => rule.enabled
            && rule.source.integrationId === quickIntegration
            && sameSimpleFilter(rule.when, when)
            && rule.actions.some(action => isChatDeliver(action) && action.destination.chatId === quickChat))
        if (duplicate) throw new Error("This bot is already connected to that chat")
        // Rules match top-down with first-match-wins. A second "all messages"
        // connection for the same bot would never fire unless earlier overlapping
        // simple connections keep matching, so flip those to continue.
        let revision = state.table.revision
        for (const target of state.table.rules.filter(rule => rule.enabled && !rule.continue
            && rule.source.integrationId === quickIntegration && isSimpleConnectionRule(rule) && sameSimpleFilter(rule.when, when))) {
            await request(`/api/routing/rules/${target.id}`, { expectedRevision: revision, rule: { ...target, continue: true } })
            revision += 1
        }
        const rule = {
            name: `${integrationName(quickIntegration)} → ${chatName(quickChat)}${channel ? ` (${channel.slice(0, 24)})` : ""}`,
            enabled: true, source: { integrationId: quickIntegration }, when,
            actions: [{ type: "deliver", destination: { kind: "chat", chatId: quickChat } }], continue: false,
        }
        await request("/api/routing/rules", { expectedRevision: revision, rule })
        setQuickChannel("")
    }, "Bot connected to chat")

    return <div className="routing-panel">
        <div className="routing-heading"><div><h3>Subscriptions</h3><p className="settings-help">One ordered table combines the connection, filter AST, and destination actions.</p></div><span className="routing-revision">rev {state?.table.revision ?? "–"}</span></div>
        {error && <p className="settings-error" role="alert">{error}</p>}
        {status && <p className="settings-help routing-status" role="status">{status}</p>}
        {!state ? <p role="status">Loading routes…</p> : <>
            <section className="settings-card routing-quick"><div className="routing-card-heading"><div><h4>Quick connect</h4><p className="settings-help">Bot credentials → chat, no filters to write. Connect the same bot again for more chats — every matching chat receives messages. For keywords or advanced logic use New rule below.</p></div></div>
                {!integrations.length ? <div className="routing-empty"><strong>No bot accounts yet</strong><span>Add a Telegram or Discord connection above, then come back here.</span></div>
                : <>
                    <div className="routing-permission-grid">
                        <label>Bot<select value={quickIntegration} onChange={event => { setQuickIntegration(event.target.value); setQuickChannel("") }}>{integrations.map(item => <option value={item.id} key={item.id}>{item.name} ({item.provider})</option>)}</select></label>
                        <div className="routing-chat-field"><span>Chat</span><ChatPicker chats={chats} value={quickChat} onChange={setQuickChat} onChatsRefresh={refreshChats} /></div>
                    </div>
                    <div className="routing-permission-grid">
                        <label>Messages<select value={quickScope} onChange={event => { setQuickScope(event.target.value as typeof quickScope); setQuickChannel("") }}><option value="all">All messages</option><option value="channel">One channel only</option></select></label>
                        {quickScope === "channel" && <label>Channel<ChannelPicker integrationId={quickIntegration} value={quickChannel} onChange={setQuickChannel} /></label>}
                    </div>
                    <div className="integration-actions"><button type="button" className="settings-save" disabled={busy || !quickIntegration || !quickChat || (quickScope === "channel" && !quickChannel.trim())} onClick={quickConnect}>{busy ? "Connecting…" : "Connect bot to chat"}</button></div>
                    {!!simpleConnections.length && <div className="routing-connections">{simpleConnections.map(rule => {
                        const deliver = rule.actions.find(isChatDeliver)
                        const chatId = deliver ? deliver.destination.chatId : ""
                        const when = rule.when as { op: string, value?: unknown }
                        return <div className="routing-connection" key={rule.id}><span><strong>{integrationName(rule.source.integrationId)}</strong> → {chatName(chatId)} · {when.op === "eq" ? `channel ${String(when.value).slice(0, 18)}` : "all messages"}{rule.enabled ? "" : " · disabled"}</span>{rule.enabled
                            ? <button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/rules/${rule.id}/disable`, { expectedRevision: state.table.revision }), "Connection removed")}>Disconnect</button>
                            : <button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/rules/${rule.id}`, { expectedRevision: state.table.revision, rule: { ...rule, enabled: true } }), "Connection restored")}>Reconnect</button>}</div>
                    })}</div>}
                </>}
            </section>
            <section className="settings-card routing-rules"><div className="routing-card-heading"><div><h4>Advanced rules</h4><p className="settings-help">Rules run from top to bottom. First match wins unless Continue is on.</p></div><button type="button" className="settings-secondary" disabled={busy} onClick={() => openEditor()}>New rule</button></div>
                {!state.table.rules.length ? <div className="routing-empty"><strong>No subscription rules yet</strong><span>Create one here, or grant a chat propose/manage access and ask its agent.</span></div> : state.table.rules.map((rule, index) => <article className={`routing-rule ${rule.enabled ? "" : "disabled"}`} key={rule.id}>
                    <span className="routing-order">{index + 1}</span><div className="routing-rule-body"><div><strong>{rule.name}</strong><span className="routing-owner">{rule.owner.type} · {rule.protection}{rule.enabled ? "" : " · disabled"}</span></div><p>{integrationName(rule.source.integrationId)} · {summarizeFilter(rule.when)}</p><p className="settings-help">{summarizeActions(rule, chatName)}{rule.continue ? " · continue matching" : ""}</p><details><summary>AST</summary><pre>{JSON.stringify({ source: rule.source, when: rule.when, actions: rule.actions, continue: rule.continue }, null, 2)}</pre></details></div>
                    <div className="integration-actions routing-rule-actions"><button type="button" disabled={busy} onClick={() => openEditor(rule)}>Edit</button>{rule.enabled
                        ? <button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/rules/${rule.id}/disable`, { expectedRevision: state.table.revision }), "Rule disabled")}>Disable</button>
                        : <button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/rules/${rule.id}`, { expectedRevision: state.table.revision, rule: { ...rule, enabled: true } }), "Rule enabled")}>Enable</button>}</div>
                </article>)}
            </section>
            {editingId !== undefined && <section className="settings-card routing-editor" aria-label={editingId ? "Edit rule" : "New rule"}>
                <div className="routing-card-heading"><div><h4>{editingId ? "Edit rule" : "New rule"}</h4><p className="settings-help">Route Discord/Telegram events into a chat. Revision {state.table.revision}.</p></div><button type="button" className="icon-button" aria-label="Close editor" onClick={() => setEditingId(undefined)}>×</button></div>
                <label>Rule name<input value={name} maxLength={120} placeholder="Discord #general to main chat" onChange={event => setName(event.target.value)} /></label>
                <div className="routing-permission-grid">
                    <label>Connection<select value={ruleIntegration} onChange={event => setRuleIntegration(event.target.value)}><option value="*">Any connection</option>{integrations.map(item => <option value={item.id} key={item.id}>{item.name} ({item.provider})</option>)}</select>{!integrations.length && <span className="settings-help">No bot accounts yet — this rule will apply to any future connection.</span>}</label>
                    <label>Destination<select value={destinationKind} onChange={event => setDestinationKind(event.target.value as typeof destinationKind)}><option value="chat">Deliver to chat</option><option value="new_chat">Start a fresh chat</option><option value="ignore">Ignore</option></select></label>
                </div>
                {destinationKind === "chat" && <div className="routing-chat-field"><span>Chat</span><ChatPicker chats={chats} value={destChatId} onChange={setDestChatId} onChatsRefresh={refreshChats} /></div>}
                {destinationKind === "new_chat" && <label>Environment ID <span className="settings-optional">Optional</span><input value={environmentId} placeholder="Leave blank for default" onChange={event => setEnvironmentId(event.target.value)} /></label>}
                <div className="routing-permission-grid">
                    <label>Filter preset<select value={filterMode} onChange={event => { const mode = event.target.value as typeof filterMode; setFilterMode(mode); syncBuilderToJson(mode, filterField, filterOp, filterValue) }}><option value="all">All events</option><option value="contains">Message contains…</option><option value="custom">Custom condition</option></select></label>
                    {filterMode === "custom" && <label>Field<select value={filterField} onChange={event => { setFilterField(event.target.value); syncBuilderToJson(filterMode, event.target.value, filterOp, filterValue) }}>{ROUTING_FIELDS.map(field => <option value={field} key={field}>{field}</option>)}</select></label>}
                </div>
                {filterMode === "contains" && <label>Contains text<input value={filterValue} placeholder="deploy" onChange={event => { setFilterValue(event.target.value); syncBuilderToJson(filterMode, filterField, filterOp, event.target.value) }} /></label>}
                {filterMode === "custom" && <div className="routing-permission-grid"><label>Operator<select value={filterOp} onChange={event => { setFilterOp(event.target.value); syncBuilderToJson(filterMode, filterField, event.target.value, filterValue) }}>{FILTER_OPS.map(op => <option value={op} key={op}>{op}</option>)}</select></label><label>Value{filterField === "conversation.id" && ruleIntegration !== "*" ? <ChannelPicker integrationId={ruleIntegration} value={filterValue} onChange={value => { setFilterValue(value); syncBuilderToJson(filterMode, filterField, filterOp, value) }} /> : <input value={filterValue} disabled={filterOp === "exists"} placeholder="channel-id or keyword" onChange={event => { setFilterValue(event.target.value); syncBuilderToJson(filterMode, filterField, filterOp, event.target.value) }} />}</label></div>}
                <label>Filter JSON <span className="settings-help">Advanced: edited directly on save.</span><textarea className="mono-input routing-json" rows={5} spellCheck={false} value={filterJson} onChange={event => setFilterJson(event.target.value)} /></label>
                <label>Agent instruction <span className="settings-optional">Optional</span><textarea rows={2} value={instruction} placeholder="Treat this as a support request." onChange={event => setInstruction(event.target.value)} /></label>
                <div className="routing-permission-grid"><label>Label <span className="settings-optional">Optional</span><input value={labelText} maxLength={128} placeholder="discord" onChange={event => setLabelText(event.target.value)} /></label><label>Reply text <span className="settings-optional">Optional</span><input value={replyText} placeholder="Ack returned to receiver" onChange={event => setReplyText(event.target.value)} /></label></div>
                <div className="routing-permission-grid"><label className="settings-check"><span><strong>Enabled</strong></span><input type="checkbox" checked={enabledFlag} onChange={event => setEnabledFlag(event.target.checked)} /></label><label className="settings-check"><span><strong>Continue matching</strong><span className="settings-help">Run later rules too.</span></span><input type="checkbox" checked={continueFlag} onChange={event => setContinueFlag(event.target.checked)} /></label></div>
                <div className="integration-actions"><button type="button" className="settings-save" disabled={busy || !name.trim()} onClick={saveRule}>{busy ? "Saving…" : editingId ? "Save changes" : "Create rule"}</button><button type="button" onClick={() => setEditingId(undefined)}>Cancel</button></div>
            </section>}
            <section className="settings-card"><div className="routing-card-heading"><div><h4>Test routing</h4><p className="settings-help">Dry-run a Discord/Telegram event without delivering it.</p></div></div>
                {!integrations.length ? <div className="routing-empty"><strong>No bot accounts yet</strong><span>Add a Telegram or Discord connection above to dry-run routing.</span></div> : <>
                <div className="routing-permission-grid"><label>Connection<select value={testIntegration} onChange={event => setTestIntegration(event.target.value)}>{!testIntegration && <option value="">Choose a connection…</option>}{integrations.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Channel / conversation ID<ChannelPicker integrationId={testIntegration} value={testChannel} onChange={setTestChannel} /></label></div>
                <label>Message text<input value={testText} onChange={event => setTestText(event.target.value)} /></label>
                <div className="integration-actions"><button type="button" disabled={busy || !testIntegration} onClick={runTest}>Run test</button>{testResult && <span className="settings-help">{testResult.actions.length} action(s)</span>}</div>
                {testResult && <><p className="settings-help">Matched: {testResult.trace.filter(item => item.selected).map(item => item.ruleName).join(", ") || "none (fallback)"}</p><details open><summary>Result</summary><pre>{JSON.stringify(testResult, null, 2)}</pre></details></>}
                </>}
            </section>
            <section className="settings-card"><h4>Fallback</h4><p className="settings-help">Runs when no rule matches. Currently: {state.table.fallback.length ? state.table.fallback.map(action => action.type).join(", ") : "nothing (drop)"}.</p><div className="integration-actions"><button type="button" disabled={busy} onClick={() => void mutate(() => request("/api/routing/fallback", { expectedRevision: state.table.revision, actions: [{ type: "ignore" }] }), "Fallback set to ignore")}>Set fallback to ignore</button></div></section>
            <section className="settings-card"><h4>Agent access</h4><p className="settings-help">Privileges live outside the routing AST. An agent cannot raise its own access.</p>
                <label htmlFor="routing-agent">Chat agent</label><select id="routing-agent" value={principalId} onChange={event => setPrincipalId(event.target.value)}><option value="">Choose a chat…</option>{chats.map(chat => <option value={chat.id} key={chat.id}>{chat.title}</option>)}</select>
                {principalId && <div className="routing-permission-grid"><label>Access<select value={level} onChange={event => setLevel(event.target.value as RoutingPermission["level"])}><option value="observe">Observe</option><option value="propose">Propose changes</option><option value="manage">Manage rules</option></select></label><label>Connection scope<select value={integrationId} onChange={event => setIntegrationId(event.target.value)}><option value="*">All connections</option>{integrations.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>}
                {principalId && <label className="settings-check routing-own"><span><strong>Own rules only</strong><span className="settings-help">Limit changes to rules created by this agent.</span></span><input type="checkbox" checked={ownRulesOnly} onChange={event => setOwnRulesOnly(event.target.checked)} /></label>}
                {principalId && <button type="button" className="settings-secondary" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/permissions/${principalId}`, { level, integrationIds: [integrationId], ownRulesOnly }), "Agent access saved")}>Save agent access</button>}
            </section>
            {!!state.proposals.filter(item => item.status === "pending").length && <section className="settings-card"><h4>Pending proposals</h4>{state.proposals.filter(item => item.status === "pending").map(proposal => <article className="routing-proposal" key={proposal.id}><div><strong>{proposal.operation}</strong><span className="settings-help">From {chats.find(chat => chat.id === proposal.principalId)?.title ?? proposal.principalId}</span></div><details><summary>Review change</summary><pre>{JSON.stringify(proposal.input, null, 2)}</pre></details><div className="integration-actions"><button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/proposals/${proposal.id}/approve`, {}), "Proposal approved")}>Approve</button><button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/proposals/${proposal.id}/reject`, {}), "Proposal rejected")}>Reject</button></div></article>)}</section>}
        </>}
    </div>
}
