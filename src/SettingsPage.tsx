import { useEffect, useRef, useState, type FormEvent } from "react"
import { MODELS, type Settings } from "./settings"
import { AccountsPanel } from "./AccountsPanel"
import type { SettingsSection } from "./navigation"
import { Icon } from "./Icon"

const sections = [
    { id: "accounts", label: "Accounts", icon: "chat" as const, description: "Connect accounts and choose credentials for new chats." },
    { id: "preferences", label: "Preferences", icon: "settings" as const, description: "Choose your default workspace, model, and chat behavior." },
    { id: "agent", label: "Agent", icon: "spark" as const, description: "Set how PuppyGPT reasons and follows your instructions." },
] as const

export function SettingsPage({ section, onSectionChange, onSave, onClose }: {
    section: SettingsSection, onSectionChange: (section: SettingsSection) => void,
    onSave: (settings: Settings) => void, onClose: () => void,
}) {
    const currentSection = sections.find(item => item.id === section)!
    const changeSection = onSectionChange
    const [saved, setSaved] = useState<Settings | null>(null)
    const [draft, setDraft] = useState<Settings | null>(null)
    const [error, setError] = useState("")
    const [saving, setSaving] = useState(false)
    const [status, setStatus] = useState("")
    const [reload, setReload] = useState(0)
    const heading = useRef<HTMLHeadingElement>(null)
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
    useEffect(() => { heading.current?.focus() }, [])
    useEffect(() => {
        const controller = new AbortController()
        setError("")
        fetch("/api/settings", { signal: controller.signal }).then(async response => {
            const data = await response.json()
            if (!response.ok) throw new Error(data.error ?? "Could not load settings")
            setSaved(data); setDraft(data)
        }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
        return () => controller.abort()
    }, [reload])
    useEffect(() => {
        if (!dirty) return
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
        window.addEventListener("beforeunload", warn)
        return () => window.removeEventListener("beforeunload", warn)
    }, [dirty])
    const update = (patch: Partial<Settings>) => { setDraft(current => current ? { ...current, ...patch } : null); setStatus("") }
    const save = async (event: FormEvent) => {
        event.preventDefault()
        if (!draft || saving) return
        setSaving(true); setError(""); setStatus("")
        try {
            const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error ?? "Could not save settings")
            setSaved(data); setDraft(data); onSave(data); setStatus("Settings saved")
        } catch (error) { setError(error instanceof Error ? error.message : "Could not save settings") }
        finally { setSaving(false) }
    }
    return <div className="settings-scroll"><div className="settings-page">
        <div className="settings-heading"><p className="eyebrow">MAKE YOURSELF AT HOME</p><h1 ref={heading} tabIndex={-1}>Settings</h1><p>A few preferences to make PuppyGPT feel like yours.</p></div>
        <div className="settings-layout"><nav className="settings-menu" role="tablist" aria-label="Settings sections" aria-orientation="vertical">{sections.map((item, index) => <button key={item.id} type="button" role="tab" id={`settings-tab-${item.id}`} aria-controls={`settings-panel-${item.id}`} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => changeSection(item.id)} onKeyDown={event => {
            let target = index
            if (["ArrowDown", "ArrowRight"].includes(event.key)) target = (index + 1) % sections.length
            else if (["ArrowUp", "ArrowLeft"].includes(event.key)) target = (index + sections.length - 1) % sections.length
            else if (event.key === "Home") target = 0
            else if (event.key === "End") target = sections.length - 1
            else return
            event.preventDefault(); changeSection(sections[target]!.id); document.getElementById(`settings-tab-${sections[target]!.id}`)?.focus()
        }}><Icon name={item.icon} size={18} /><span>{item.label}</span></button>)}</nav><div className="settings-detail"><div className="settings-section-heading"><h2>{currentSection.label}</h2><p>{currentSection.description}</p></div>
        {error && <div className="settings-error" role="alert">{error}{!draft && <button onClick={() => setReload(value => value + 1)}>Try again</button>}</div>}
        {!draft ? !error && <p role="status">Loading settings…</p> : <form onSubmit={save} noValidate>
            <div role="tabpanel" id="settings-panel-accounts" aria-labelledby="settings-tab-accounts" hidden={section !== "accounts"}>
            <AccountsPanel selectedId={draft.accountId ?? null} onSelect={accountId => update({ accountId })} />
            </div>
            <div role="tabpanel" id="settings-panel-preferences" aria-labelledby="settings-tab-preferences" hidden={section !== "preferences"}>
            <fieldset disabled={saving} className="settings-card"><legend>New chat defaults</legend><p className="settings-help">Existing chats keep their current workspace and model.</p>
                <label htmlFor="default-workspace">Workspace</label><input id="default-workspace" required value={draft.cwd} onChange={event => update({ cwd: event.target.value })} aria-describedby="workspace-help" />
                <p id="workspace-help" className="settings-help">The local folder where new chats start working.</p>
                <label htmlFor="default-model">Default model</label><select id="default-model" value={draft.model} onChange={event => update({ model: event.target.value })}>{MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select>
            </fieldset>
            <fieldset disabled={saving} className="settings-card"><legend>Chat</legend><label className="settings-check"><span><strong>Enter to send</strong><span className="settings-help">When off, Enter adds a new line. Ctrl/⌘ + Enter always sends.</span></span><input type="checkbox" checked={draft.enterToSend} onChange={event => update({ enterToSend: event.target.checked })} /></label></fieldset>
            </div>
            <div role="tabpanel" id="settings-panel-agent" aria-labelledby="settings-tab-agent" hidden={section !== "agent"}>
            <fieldset disabled={saving} className="settings-card"><legend>Agent preferences</legend><p className="settings-help">Applies from the next message you send after the current turn finishes.</p>
                <label htmlFor="reasoning-effort">Reasoning effort</label><select id="reasoning-effort" value={draft.reasoningEffort} onChange={event => update({ reasoningEffort: event.target.value as Settings["reasoningEffort"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
                <label htmlFor="custom-instructions">Custom instructions <span className="settings-optional">Optional</span></label><textarea id="custom-instructions" rows={5} maxLength={16_000} value={draft.instructions} placeholder="For example: keep explanations concise and run tests after changing code." onChange={event => update({ instructions: event.target.value })} aria-describedby="instructions-help" />
                <p id="instructions-help" className="settings-help">Added alongside the workspace’s AGENTS.md instructions.</p>
            </fieldset>
            </div>
            <div className="settings-actions"><span role="status">{status || (dirty ? "Unsaved changes" : "")}</span><button type="button" disabled={saving} className="settings-secondary" onClick={() => { if (dirty) { setDraft(saved); setError(""); setStatus("") } else onClose() }}>{dirty ? "Discard changes" : "Back to chat"}</button><button className="settings-save" type="submit" disabled={saving || !dirty}>{saving ? "Saving…" : "Save changes"}</button></div>
        </form>}
    </div></div></div></div>
}
