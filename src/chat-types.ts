export type ChatMessage = {
    id: string
    sourceChatId?: string
    parentMessageId?: string
    parentChatId?: string
    forkContext?: "exact" | "transcript"
    role: "user" | "assistant" | "activity" | "error"
    text: string
    detail?: string
    running?: boolean
    image?: { path: string, prompt: string }
}

export type ChatSummary = {
    parentChatId?: string
    forkMessageId?: string
    forkPreview?: string
    headMessageId?: string
    headChatId?: string
    forkContext?: "exact" | "transcript"
    selection?: { text: string, start: number, end: number }

    gptName?: string
    attentionReason?: string
    attentionId?: string
    executionTarget?: string
    environmentId?: string
    accountId?: string | null
    id: string
    title: string
    cwd: string
    model: string
    status: "idle" | "running" | "error"
    updatedAt: string
}

export type Chat = ChatSummary & { messages: ChatMessage[], gpt?: import("./gpts").Gpt }

export type AppConfig = { execution: { environments: import("./environments").Environment[], defaultEnvironmentId: string, defaultTarget: string, targets: { id: string, kind: "host" | "docker" }[] }, cwd: string, authAvailable: boolean, settings: import("./settings").Settings }
