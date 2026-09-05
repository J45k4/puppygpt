export type ChatMessage = {
    id: string
    role: "user" | "assistant" | "activity" | "error"
    text: string
    detail?: string
    running?: boolean
    image?: { path: string, prompt: string }
}

export type ChatSummary = {
    accountId?: string | null
    id: string
    title: string
    cwd: string
    model: string
    status: "idle" | "running" | "error"
    updatedAt: string
}

export type Chat = ChatSummary & { messages: ChatMessage[] }

export type AppConfig = { cwd: string, authAvailable: boolean, settings: import("./settings").Settings }
