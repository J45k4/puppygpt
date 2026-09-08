import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react"
import { VOICES, type VoiceState } from "../voice-protocol"

type Call = { id: string, controller: AbortController, peer?: RTCPeerConnection, stream?: MediaStream, audio?: HTMLAudioElement, poll?: ReturnType<typeof setTimeout>, timeout?: ReturnType<typeof setTimeout> }

export type VoicePanelHandle = { start: () => void }

export function VoicePanel({ chatId, ref, onActiveChange }: { chatId: string, ref?: Ref<VoicePanelHandle>, onActiveChange: (active: boolean) => void }) {
    const [voice, setVoice] = useState<string>("cove")
    const [status, setStatus] = useState("idle")
    const [error, setError] = useState("")
    const [muted, setMuted] = useState(false)
    const call = useRef<Call | null>(null)
    const active = status === "connecting" || status === "connected"
    useEffect(() => { onActiveChange(active); return () => onActiveChange(false) }, [active, onActiveChange])
    const stop = (update = true) => {
        const current = call.current
        call.current = null
        if (current) {
            current.controller.abort()
            clearTimeout(current.poll); clearTimeout(current.timeout)
            current.stream?.getTracks().forEach(track => track.stop())
            current.peer?.close()
            if (current.audio) { current.audio.pause(); current.audio.srcObject = null }
            void fetch(`/api/chats/${chatId}/voice/${current.id}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true }).catch(() => {})
        }
        if (update) { setStatus("idle"); setMuted(false) }
    }
    useEffect(() => {
        const unload = () => stop(false)
        window.addEventListener("pagehide", unload)
        return () => { window.removeEventListener("pagehide", unload); stop(false) }
    }, [chatId])

    const start = async () => {
        if (call.current) return
        setError(""); setStatus("connecting"); setMuted(false)
        const current: Call = { id: crypto.randomUUID(), controller: new AbortController() }
        call.current = current
        const fail = (message: string) => {
            if (call.current !== current) return
            stop(); setError(message)
        }
        current.timeout = setTimeout(() => fail("Voice connection timed out. Try again."), 40_000)
        try {
            if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("Voice requires a browser with microphone and WebRTC support on localhost or HTTPS.")
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
            if (call.current !== current) { stream.getTracks().forEach(track => track.stop()); return }
            current.stream = stream
            const peer = new RTCPeerConnection()
            current.peer = peer
            const audio = new Audio()
            audio.autoplay = true
            current.audio = audio
            peer.ontrack = event => {
                audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
                void audio.play().catch(() => fail("Your browser blocked voice playback. Allow audio and start again."))
            }
            peer.onconnectionstatechange = () => {
                if (call.current !== current) return
                if (peer.connectionState === "connected") { clearTimeout(current.timeout); setStatus("connected") }
                if (["failed", "disconnected", "closed"].includes(peer.connectionState)) fail("Voice disconnected. Start a new call to reconnect.")
            }
            for (const track of stream.getTracks()) peer.addTrack(track, stream)
            // GPT-Live events and delegation are owned by the server sideband.
            peer.createDataChannel("oai-events")
            await peer.setLocalDescription(await peer.createOffer())
            if (call.current !== current) return
            const response = await fetch(`/api/chats/${chatId}/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.controller.signal, body: JSON.stringify({ id: current.id, sdp: peer.localDescription?.sdp, voice }) })
            const result = await response.json()
            if (!response.ok) throw new Error(result.error ?? "Voice could not connect")
            if (call.current !== current) return
            await peer.setRemoteDescription({ type: "answer", sdp: result.sdp })
            const poll = async () => {
                if (call.current !== current) return
                try {
                    const response = await fetch(`/api/chats/${chatId}/voice/${current.id}`, { signal: current.controller.signal })
                    const state: VoiceState & { error?: string } = await response.json()
                    if (!response.ok || state.status === "error" || state.status === "closed") { fail(state.error ?? "Voice call ended"); return }
                    if (call.current === current) current.poll = setTimeout(() => void poll(), 2000)
                } catch { if (call.current === current) fail("Lost contact with PuppyGPT. Start a new call to reconnect.") }
            }
            void poll()
        } catch (error) { fail(error instanceof Error ? error.message : "Voice could not start") }
    }
    useImperativeHandle(ref, () => ({ start: () => { void start() } }))
    const state = status === "connected" ? muted ? "muted" : "live" : status === "connecting" ? "connecting" : "off"
    return <section className="voice-panel" data-state={state} aria-label="Voice conversation">
        <div className="voice-controls">
            <span className="voice-status" role="status"><span className="voice-status-dot" aria-hidden="true" />{state === "live" ? "Voice call live · Mic on" : state === "muted" ? "Voice call live · Mic muted" : state === "connecting" ? "Connecting voice…" : "Voice is off"}</span>
            <label>Voice <select aria-label="Speaker voice" value={voice} disabled={active} onChange={event => setVoice(event.target.value)}>{VOICES.map(value => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
            {active && <>
                <button type="button" disabled={status === "connecting"} aria-pressed={muted} onClick={() => { const next = !muted; call.current?.stream?.getAudioTracks().forEach(track => { track.enabled = !next }); setMuted(next) }}>{muted ? "Unmute" : "Mute"}</button>
                <button type="button" className="voice-end-button" onClick={() => stop()}>{status === "connecting" ? "Cancel" : "End call"}</button>
            </>}
        </div>
        <p>{state === "off" ? "Your microphone is off. Click the waveform in the empty composer to start a voice call." : state === "connecting" ? "Allow microphone access if your browser asks. You can cancel at any time." : state === "muted" ? "You can still hear replies. Unmute to speak. Ending the call leaves accepted tasks running." : "Your microphone is on. Speak naturally, or mute to pause your microphone. Ending the call leaves accepted tasks running."}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
}
