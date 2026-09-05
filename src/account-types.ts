export type ConnectedAccount = { id: string, provider: "openai", label: string, email?: string, createdAt: string }
export type AccountLogin = {
    id: string, status: "starting" | "pending" | "connected" | "cancelled" | "error",
    verificationUrl?: string, userCode?: string, expiresAt: string, account?: ConnectedAccount, error?: string,
}

export type LocalAccount = { available: boolean, email?: string, name?: string, plan?: string }
