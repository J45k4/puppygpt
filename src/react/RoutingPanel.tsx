import { useEffect, useMemo, useState } from "react"
import type { ChatSummary } from "../chat-types"
import type { Integration } from "../integrations"
import type { RoutingPermission, RoutingProposal, RoutingRule, RoutingTable } from "../routing"

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
const summarizeActions = (rule: RoutingRule): string => rule.actions.map(action => {
    if (action.type === "deliver") return action.destination.kind === "chat" ? "deliver to chat" : "start a chat"
    if (action.type === "add_instruction") return "add instructions"
    if (action.type === "label") return `label ${action.value}`
    return action.type
}).join(" · ")

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
    const refresh = async () => setState(await request<RoutingState>("/api/routing"))
    useEffect(() => { void Promise.all([refresh(), request<ChatSummary[]>("/api/chats").then(setChats)]).catch(error => setError(error.message)) }, [])
    const permission = useMemo(() => state?.permissions.find(item => item.principalId === principalId), [state, principalId])
    useEffect(() => {
        if (!principalId) return
        setLevel(permission?.level ?? "observe")
        setIntegrationId(permission?.integrationIds[0] ?? "*")
        setOwnRulesOnly(permission?.ownRulesOnly ?? true)
    }, [principalId, permission])
    const mutate = async (action: () => Promise<unknown>, message: string) => {
        if (busy) return
        setBusy(true); setError(""); setStatus("")
        try { await action(); await refresh(); setStatus(message) }
        catch (error) { setError(error instanceof Error ? error.message : "Request failed") }
        finally { setBusy(false) }
    }
    const integrationName = (id: string) => id === "*" ? "Any connection" : integrations.find(item => item.id === id)?.name ?? id
    return <div className="routing-panel">
        <div className="routing-heading"><div><h3>Subscriptions</h3><p className="settings-help">One ordered table combines the connection, filter AST, and destination actions.</p></div><span className="routing-revision">rev {state?.table.revision ?? "–"}</span></div>
        {error && <p className="settings-error" role="alert">{error}</p>}
        {status && <p className="settings-help routing-status" role="status">{status}</p>}
        {!state ? <p role="status">Loading routes…</p> : <>
            <section className="settings-card routing-rules"><div className="routing-card-heading"><div><h4>Routing table</h4><p className="settings-help">Rules run from top to bottom. Agents use the routing tool to test or change them.</p></div></div>
                {!state.table.rules.length ? <div className="routing-empty"><strong>No subscription rules yet</strong><span>Grant a chat propose or manage access, then ask its agent to create a route.</span></div> : state.table.rules.map((rule, index) => <article className={`routing-rule ${rule.enabled ? "" : "disabled"}`} key={rule.id}>
                    <span className="routing-order">{index + 1}</span><div className="routing-rule-body"><div><strong>{rule.name}</strong><span className="routing-owner">{rule.owner.type} · {rule.protection}</span></div><p>{integrationName(rule.source.integrationId)} · {summarizeFilter(rule.when)}</p><p className="settings-help">{summarizeActions(rule)}{rule.continue ? " · continue matching" : ""}</p><details><summary>AST</summary><pre>{JSON.stringify({ source: rule.source, when: rule.when, actions: rule.actions, continue: rule.continue }, null, 2)}</pre></details></div>
                    {rule.enabled && <button type="button" disabled={busy} onClick={() => void mutate(() => request(`/api/routing/rules/${rule.id}/disable`, { expectedRevision: state.table.revision }), "Rule disabled")}>Disable</button>}
                </article>)}
            </section>
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
