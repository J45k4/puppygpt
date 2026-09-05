export type JsonObject = Record<string, unknown>

export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>

export const asObject = (value: unknown): JsonObject | undefined => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as JsonObject
    }
}

export const asString = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.length) {
        return value
    }
}

export const asNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value
    }
}

export const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => {
    setTimeout(resolve, milliseconds)
})
