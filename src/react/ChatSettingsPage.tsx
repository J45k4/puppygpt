import { useEffect, useState } from "react"
import type { Chat } from "../chat-types"
import type { Gpt } from "../gpts"
export function ChatSettingsPage({ chatId, onBack, onSave }: { chatId: string, onBack: () => void, onSave: (chat: Chat) => void }) {
    const [chat, setChat] = useState<Chat | null>(null)
    const [gpts, setGpts] = useState<Gpt[]>([])
    const [selected, setSelected] = useState("")
    const [error, setError] = useState("")
    const [status, setStatus] = useState("")
    const [busy, setBusy] = useState(false)
    useEffect(() => {
        const controller = new AbortController()
        const get = async (path: string) => { const response = await fetch(path, { signal: controller.signal }); const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "Could not load settings"); return value }
        Promise.all([get(`/api/chats/${encodeURIComponent(chatId)}`), get("/api/gpts")]).then(([current, list]) => { if (!controller.signal.aborted) { setChat(current); setSelected(current.gpt?.id ?? ""); setGpts(list) } }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
        return () => controller.abort()
    }, [chatId])
    const selectedGpt = gpts.find(gpt => gpt.id === selected) ?? (chat?.gpt?.id === selected ? chat.gpt : undefined)
    const save = async () => {
        setBusy(true); setError(""); setStatus("")
        try {
            const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/gpt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gptId: selected || null }) })
            const current = await response.json()
            if (!response.ok) throw new Error(current.error ?? "Could not save chat settings")
            setChat(current); onSave(current); setStatus("Saved. Applies to the next message.")
        } catch (error) { setError(error instanceof Error ? error.message : "Could not save chat settings") }
        finally { setBusy(false) }
    }
    return <div className="settings-scroll"><div className="context-page">
        <div className="context-heading"><h1>Chat settings</h1><button onClick={onBack}>Back to chat</button></div>
        {error && <p className="settings-error" role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        {!chat && !error && <p role="status">Loading chat settings…</p>}
        {chat && <><p>{chat.title}</p><fieldset className="settings-card" disabled={busy}>
            <legend>GPT</legend><label htmlFor="chat-gpt">Use GPT</label>
            <select id="chat-gpt" value={selected} onChange={event => { setSelected(event.target.value); setStatus("") }}>
                <option value="">Default PuppyGPT</option>
                {chat.gpt && !gpts.some(gpt => gpt.id === chat.gpt!.id) && <option value={chat.gpt.id} disabled>{chat.gpt.name} (deleted; current configuration retained)</option>}
                {gpts.map(gpt => <option key={gpt.id} value={gpt.id}>{gpt.name}</option>)}
            </select>
            <p className="settings-help">Choosing a GPT applies its model, reasoning effort, and instructions to future messages. Conversation history stays in this chat. Default PuppyGPT uses workspace instructions and keeps the current model.</p>
            {selectedGpt && <><p>{selectedGpt.description}</p><p>{selectedGpt.model} · {selectedGpt.reasoningEffort} reasoning</p><details><summary>GPT instructions</summary><pre style={{ whiteSpace: "pre-wrap" }}>{selectedGpt.instructions || "No additional instructions"}</pre></details></>}
            <button type="button" className="settings-save" style={{ marginTop: 20, fontWeight: 600 }} onClick={() => void save()} disabled={busy || (!!selected && !gpts.some(gpt => gpt.id === selected))}>{busy ? "Saving…" : "Save chat settings"}</button>
        </fieldset></>}
    </div></div>
}
