import { useEffect, useState, type FormEvent } from "react"
import { Icon } from "./Icon"
import { MODELS } from "./settings"
import type { Gpt, GptInput } from "./gpts"
import type { Chat } from "./chat-types"
const blank = (): GptInput => ({ name: "", description: "", instructions: "", model: "gpt-6-astra", reasoningEffort: "medium" })
async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? "Request failed")
    return data
}
export function GptsPage({ onStart }: { onStart: (chat: Chat) => void }) {
    const [gpts, setGpts] = useState<Gpt[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState("")
    const [status, setStatus] = useState("")
    const [busy, setBusy] = useState(false)
    const [editing, setEditing] = useState<string | null>(null)
    const [draft, setDraft] = useState<GptInput>(blank)
    const [retry, setRetry] = useState(0)
    useEffect(() => {
        let disposed = false
        setLoading(true); setError("")
        request<Gpt[]>("/api/gpts").then(data => { if (!disposed) setGpts(data) }).catch(error => { if (!disposed) setError(error.message) }).finally(() => { if (!disposed) setLoading(false) })
        return () => { disposed = true }
    }, [retry])
    const edit = (gpt?: Gpt) => {
        setError(""); setStatus(""); setEditing(gpt?.id ?? "new")
        setDraft(gpt ? { name: gpt.name, description: gpt.description, instructions: gpt.instructions, model: gpt.model, reasoningEffort: gpt.reasoningEffort } : blank())
    }
    const save = async (event: FormEvent) => {
        event.preventDefault(); setBusy(true); setError(""); setStatus("")
        try {
            const saved = await request<Gpt>(editing === "new" ? "/api/gpts" : `/api/gpts/${editing}`, draft)
            setGpts(current => [saved, ...current.filter(item => item.id !== saved.id)])
            setEditing(null); setStatus(`${saved.name} saved.`)
        } catch (error) { setError(error instanceof Error ? error.message : "Could not save GPT") }
        finally { setBusy(false) }
    }
    const start = async (gpt: Gpt) => {
        setBusy(true); setError("")
        try { onStart(await request<Chat>("/api/chats", { gptId: gpt.id })) }
        catch (error) { setError(error instanceof Error ? error.message : "Could not start chat"); setBusy(false) }
    }
    const remove = async (gpt: Gpt) => {
        if (!window.confirm(`Delete ${gpt.name}? Existing chats will keep their configuration.`)) return
        setBusy(true); setError("")
        try { await request(`/api/gpts/${gpt.id}/delete`, {}); setGpts(current => current.filter(item => item.id !== gpt.id)); setStatus(`${gpt.name} deleted.`) }
        catch (error) { setError(error instanceof Error ? error.message : "Could not delete GPT") }
        finally { setBusy(false) }
    }
    return <div className="settings-scroll"><div className="gpts-page">
        <div className="gpts-heading"><div><h1>GPTs</h1><p>Create custom agents for the work you do.</p></div>{!editing && <button className="gpt-primary" disabled={busy || loading} onClick={() => edit()}><Icon name="plus" size={17} />Create GPT</button>}</div>
        {error && <div className="error-banner" role="alert">{error}{!editing && <button onClick={() => setRetry(n => n + 1)}>Retry</button>}</div>}
        {status && <p role="status">{status}</p>}
        {loading ? <p role="status">Loading GPTs…</p> : editing ? <form className="gpt-editor" onSubmit={save}>
            <h2>{editing === "new" ? "Create GPT" : "Edit GPT"}</h2>
            <fieldset disabled={busy}>
                <label>Name<input autoFocus required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Code reviewer" /></label>
                <label>Description<input maxLength={500} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="What does this agent help with?" /></label>
                <label>Instructions (optional)<textarea maxLength={16000} rows={9} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} placeholder="Describe its role, how it should work, and what it should focus on." /></label>
                <div className="gpt-options"><label>Model<select value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })}>{MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
                <label>Reasoning<select value={draft.reasoningEffort} onChange={event => setDraft({ ...draft, reasoningEffort: event.target.value as GptInput["reasoningEffort"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>
                <p className="gpt-note">Instructions are added to your workspace instructions. Changes apply to new chats; existing chats keep their saved configuration.</p>
                <div className="gpt-actions"><button type="submit" className="gpt-primary">{busy ? "Saving…" : "Save GPT"}</button><button type="button" onClick={() => { setEditing(null); setError("") }}>Cancel</button></div>
            </fieldset>
        </form> : gpts.length ? <div className="gpt-table-scroll"><table className="gpt-table" aria-label="Custom GPTs">
            <thead><tr><th scope="col">Name</th><th scope="col">Description</th><th scope="col">Model</th><th scope="col">Reasoning</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{gpts.map(gpt => <tr key={gpt.id}>
                <th scope="row">{gpt.name}</th><td className="gpt-description" title={gpt.description}>{gpt.description || "—"}</td><td>{MODELS.find(model => model.id === gpt.model)?.label}</td><td>{gpt.reasoningEffort}</td>
                <td><div className="gpt-table-actions"><button className="gpt-primary" disabled={busy} onClick={() => void start(gpt)}>Start chat</button><button disabled={busy} aria-label={`Edit ${gpt.name}`} onClick={() => edit(gpt)}>Edit</button><button disabled={busy} aria-label={`Delete ${gpt.name}`} onClick={() => void remove(gpt)}>Delete</button></div></td>
            </tr>)}</tbody>
        </table></div> : <div className="gpts-empty"><Icon name="spark" size={32} /><h2>Your agents, your way</h2><p>Create your first GPT with instructions tailored to your work.</p></div>}
    </div></div>
}
