import type { ChatMessage } from "./chat-types"

export function isCompactionMessage(message: ChatMessage) {
    return message.role === "activity" && ["Compacting conversation", "Conversation compacted", "Compaction failed", "Compaction interrupted"].includes(message.text)
}

export function CompactionMarker({ message }: { message: ChatMessage }) {
    const label = message.running ? "Compacting context…" : message.text === "Conversation compacted" ? "Context compacted" : message.text === "Compaction failed" ? "Compaction failed" : "Compaction interrupted"
    return <div className="branch-divider compaction-marker" role={message.running ? "status" : undefined} title={message.text === "Conversation compacted" ? "The agent condensed its context here. Earlier messages remain in the conversation." : label}>
        {message.running ? <span className="spinner" /> : <svg width="16" height="18" viewBox="0 0 16 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 2l5 4 5-4M3 16l5-4 5 4M2 9h12" />
        </svg>}
        <span>{label}</span>
    </div>
}
