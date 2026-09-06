import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Chat } from "./chat-types"
import { Icon } from "./Icon"

export function DownloadChatButton({ chat }: { chat: Chat }) {
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const dialog = useRef<HTMLDialogElement>(null)
    const request = useRef<AbortController | null>(null)
    const images = chat.messages.filter(message => message.image).length
    useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
    useEffect(() => () => request.current?.abort(), [])
    const close = () => { request.current?.abort(); setOpen(false) }
    const download = async (format: "md" | "zip") => {
        const controller = new AbortController(); request.current = controller
        setBusy(true); setError("")
        try {
            const response = await fetch(`/api/chats/${encodeURIComponent(chat.id)}/download?format=${format}`, { signal: controller.signal })
            if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "Download failed") }
            const blob = await response.blob()
            if (controller.signal.aborted) return
            const url = URL.createObjectURL(blob)
            const link = document.createElement("a")
            link.href = url; link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `chat.${format}`
            document.body.append(link); link.click(); link.remove()
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
            setOpen(false)
        } catch (error) {
            if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : "Download failed"); setOpen(true) }
        } finally { if (request.current === controller) { request.current = null; setBusy(false) } }
    }
    return <>
        <button className="icon-button chat-download" disabled={busy} aria-label="Download chat" title="Download chat" onClick={() => { setError(""); if (images) setOpen(true); else void download("md") }}><Icon name="download" size={20} /></button>
        {createPortal(<dialog ref={dialog} className="chat-download-dialog" aria-labelledby="chat-download-heading" onCancel={close} onClose={close}>
            <h2 id="chat-download-heading">Download chat</h2>
            <p>{images ? `This chat contains ${images} ${images === 1 ? "image" : "images"}. What would you like to download?` : "Download this conversation as a Markdown file."}</p>
            {error && <p className="error-banner" role="alert">{error}</p>}
            <div className="download-choices">
                <button disabled={busy} onClick={() => void download("md")}><strong>Text only</strong><span>Markdown transcript without image files</span></button>
                {images > 0 && <button disabled={busy} onClick={() => void download("zip")}><strong>Text and images</strong><span>One ZIP with the transcript and all images</span></button>}
            </div>
            <div className="download-dialog-footer">{busy && <span role="status">Preparing download…</span>}<button onClick={close}>Cancel</button></div>
        </dialog>, document.body)}
    </>
}
