import { useEffect, useState } from "react"
import type { Integration } from "./integrations"
async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? "Request failed")
    return result
}
export function IntegrationsPanel() {
    const [items, setItems] = useState<Integration[]>([])
    const [loading, setLoading] = useState(true)
    const [editing, setEditing] = useState<string | null | undefined>()
    const [provider, setProvider] = useState<Integration["provider"]>("telegram")
    const [name, setName] = useState("")
    const [token, setToken] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [status, setStatus] = useState("")
    const [removing, setRemoving] = useState<string | null>(null)
    const refresh = () => request<Integration[]>("/api/integrations").then(setItems)
    useEffect(() => { void refresh().catch(error => setError(error.message)).finally(() => setLoading(false)) }, [])
    const edit = (item?: Integration) => { setEditing(item?.id ?? null); setProvider(item?.provider ?? "telegram"); setName(item?.name ?? ""); setToken(""); setError(""); setStatus("") }
    const save = async () => {
        if (busy) return
        setBusy(true); setError(""); setStatus("")
        try {
            await request(`/api/integrations${editing ? `/${editing}` : ""}`, { provider, name, ...(token ? { token } : {}) })
            setToken(""); setEditing(undefined); await refresh(); setStatus("Connection saved")
        } catch (error) { setError(error instanceof Error ? error.message : "Could not save connection") }
        finally { setBusy(false) }
    }
    const action = async (item: Integration, action: "test" | "remove") => {
        setBusy(true); setError(""); setStatus("")
        try {
            await request(`/api/integrations/${item.id}/${action}`, {})
            await refresh(); setRemoving(null); setStatus(action === "test" ? `${item.name}: connection verified` : "Connection removed")
        } catch (error) { setError(error instanceof Error ? error.message : "Request failed") }
        finally { setBusy(false) }
    }
    return <div className="integrations-panel">
        {error && <p className="settings-error" role="alert">{error}</p>}
        {status && <p className="settings-help" role="status">{status}</p>}
        {loading ? <p role="status">Loading integrations…</p> : <>
            {items.map(item => <section className="settings-card" key={item.id}>
                <h3>{item.name}</h3><p className="settings-help">{item.provider === "telegram" ? "Telegram" : "Discord"}{item.identity ? ` · ${item.identity}` : " · Not tested"}</p>
                <div className="integration-actions"><button type="button" disabled={busy} onClick={() => edit(item)}>Edit</button><button type="button" disabled={busy} onClick={() => void action(item, "test")}>Test connection</button><button type="button" disabled={busy} onClick={() => setRemoving(item.id)}>Remove</button></div>
                {removing === item.id && <div className="integration-actions"><span>Remove this saved connection?</span><button type="button" disabled={busy} onClick={() => void action(item, "remove")}>Remove connection</button><button type="button" onClick={() => setRemoving(null)}>Cancel</button></div>}
            </section>)}
            {editing === undefined ? <button type="button" className="settings-secondary" onClick={() => edit()}>Add integration</button> : <fieldset className="settings-card" disabled={busy} onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); void save() } }}>
                <legend>{editing ? "Edit connection" : "Add integration"}</legend>
                <label htmlFor="integration-provider">Service</label><select id="integration-provider" value={provider} disabled={!!editing || busy} onChange={event => setProvider(event.target.value as Integration["provider"])}><option value="telegram">Telegram</option><option value="discord">Discord</option></select>
                <label htmlFor="integration-name">Name</label><input id="integration-name" value={name} maxLength={80} placeholder="My bot" autoComplete="off" onChange={event => setName(event.target.value)} />
                <label htmlFor="integration-token">Bot token</label><input id="integration-token" type="password" value={token} maxLength={512} placeholder={editing ? "Leave blank to keep the current token" : "Paste bot token"} autoComplete="new-password" spellCheck={false} onChange={event => setToken(event.target.value)} />
                <p className="settings-help">Stored encrypted. {provider === "telegram" ? <a href="https://core.telegram.org/bots/tutorial#obtain-your-bot-token" target="_blank" rel="noreferrer">Get a Telegram bot token</a> : <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Open Discord Developer Portal</a>}</p>
                <div className="integration-actions"><button type="button" disabled={busy || !name.trim() || (!editing && !token.trim())} onClick={() => void save()}>{busy ? "Saving…" : "Save connection"}</button><button type="button" onClick={() => { setToken(""); setEditing(undefined) }}>Cancel</button></div>
            </fieldset>}
            <p className="settings-help">Save and verify service access here. Message handling and agent tools are configured separately.</p>
        </>}
    </div>
}
