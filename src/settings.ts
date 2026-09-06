export const MODELS = [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
] as const

export type Settings = {
    accountId?: string | null
    cwd: string
    model: string
    reasoningEffort: "low" | "medium" | "high"
    instructions: string
    enterToSend: boolean
}

export const defaultSettings = (cwd: string): Settings => ({
    cwd, model: "gpt-6-astra", reasoningEffort: "medium", instructions: "", enterToSend: true, accountId: null,
})

export function validateSettings(value: unknown): Settings {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected settings")
    const settings = value as Record<string, unknown>
    if (Object.keys(settings).some(key => !["cwd", "model", "reasoningEffort", "instructions", "enterToSend", "accountId"].includes(key))) throw new Error("Unknown setting")
    if (settings.accountId != null && (typeof settings.accountId !== "string" || !/^[a-f0-9-]{36}$/.test(settings.accountId))) throw new Error("Invalid account")
    if (typeof settings.cwd !== "string" || !settings.cwd.trim()) throw new Error("Choose an existing workspace directory")
    if (!MODELS.some(model => model.id === settings.model)) throw new Error("Unsupported model")
    if (!["low", "medium", "high"].includes(String(settings.reasoningEffort))) throw new Error("Invalid reasoning effort")
    if (typeof settings.instructions !== "string" || settings.instructions.length > 16_000) throw new Error("Custom instructions must be at most 16,000 characters")
    if (typeof settings.enterToSend !== "boolean") throw new Error("Invalid Enter-to-send preference")
    return { cwd: settings.cwd.trim(), model: settings.model as string, reasoningEffort: settings.reasoningEffort as Settings["reasoningEffort"], instructions: settings.instructions, enterToSend: settings.enterToSend, accountId: settings.accountId as string | null | undefined ?? null }
}
