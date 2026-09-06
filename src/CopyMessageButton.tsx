import { useEffect, useRef, useState } from "react"
import { Icon } from "./Icon"

export function CopyMessageButton({ text }: { text: string }) {
    const [status, setStatus] = useState<"idle" | "copied" | "error">("idle")
    const [busy, setBusy] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    const label = status === "copied" ? "Copied" : status === "error" ? "Copy failed — try again" : "Copy message"
    return <button type="button" className="copy-message" aria-label={label} title={label} disabled={busy} onClick={async event => {
        event.preventDefault(); event.stopPropagation()
        setBusy(true); clearTimeout(timer.current)
        try {
            const previousFocus = document.activeElement as HTMLElement | null
            const field = document.createElement("textarea")
            field.value = text; field.readOnly = true
            field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0"
            document.body.append(field)
            let copied = false
            try { field.select(); copied = document.execCommand("copy") }
            finally { field.remove(); previousFocus?.focus({ preventScroll: true }) }
            if (!copied) await navigator.clipboard.writeText(text)
            setStatus("copied")
        }
        catch { setStatus("error") }
        finally { setBusy(false); timer.current = setTimeout(() => setStatus("idle"), 2500) }
    }}><Icon name={status === "copied" ? "check" : "copy"} size={14} /><span className={status === "idle" ? "sr-only" : "copy-message-status"} role="status">{status === "idle" ? "" : label}</span></button>
}
