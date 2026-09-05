import { randomUUID } from "node:crypto"
import { chmod, mkdir, rename } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { asNumber, asObject, asString, type FetchLike, type JsonObject } from "./types"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEFAULT_ISSUER = "https://auth.openai.com"
const REFRESH_MARGIN_MS = 60 * 1000
const DEVICE_AUTH_TIMEOUT_MS = 5 * 60 * 1000
const POLLING_SAFETY_MARGIN_MS = 3000

type TokenResponse = {
    accessToken: string
    refreshToken?: string
    idToken?: string
    expiresIn?: number
}

export type AgentAuth = {
    accessToken: string
    refreshToken: string
    idToken?: string
    accountId?: string
    expiresAt: number
    raw: JsonObject
}

export type AuthStorage = { key: object, read: () => Promise<JsonObject>, write: (raw: JsonObject) => Promise<void> }

type AuthOptions = {
    authStorage?: AuthStorage
    authFile?: string
    fetchImpl?: FetchLike
    issuer?: string
    now?: () => number
}

type LoginOptions = AuthOptions & {
    signal?: AbortSignal
    onDeviceCode?: (verificationUrl: string, userCode: string) => void
    sleepImpl?: (milliseconds: number) => Promise<void>
}

const parseJwtClaims = (token: string): JsonObject | undefined => {
    const encodedClaims = token.split(".")[1]
    if (!encodedClaims) {
        return
    }

    try {
        return asObject(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")))
    } catch {
        return
    }
}

const extractAccountId = (idToken: string | undefined, accessToken: string): string | undefined => {
    for (const token of [idToken, accessToken]) {
        if (!token) {
            continue
        }
        const claims = parseJwtClaims(token)
        const authClaims = asObject(claims?.["https://api.openai.com/auth"])
        const organizations = Array.isArray(claims?.organizations) ? claims.organizations : []
        const organization = asObject(organizations[0])
        const accountId = asString(claims?.chatgpt_account_id)
            ?? asString(authClaims?.chatgpt_account_id)
            ?? asString(organization?.id)
        if (accountId) {
            return accountId
        }
    }
}

const parseTokenResponse = async (response: Response, action: string): Promise<TokenResponse> => {
    if (!response.ok) {
        throw new Error(`${action} failed with status ${response.status}`)
    }
    const body = asObject(await response.json())
    const accessToken = asString(body?.access_token)
    if (!accessToken) {
        throw new Error(`${action} did not return an access token`)
    }
    return {
        accessToken,
        refreshToken: asString(body?.refresh_token),
        idToken: asString(body?.id_token),
        expiresIn: asNumber(body?.expires_in),
    }
}

const parseAuthJson = (raw: JsonObject): AgentAuth => {
    const tokens = asObject(raw.tokens)
    const accessToken = asString(tokens?.access_token)
    const refreshToken = asString(tokens?.refresh_token)
    if (raw.auth_mode !== "chatgpt" || !accessToken || !refreshToken) {
        throw new Error("Auth file does not contain ChatGPT subscription credentials")
    }
    const expiresAt = (asNumber(parseJwtClaims(accessToken)?.exp) ?? 0) * 1000
    return {
        accessToken,
        refreshToken,
        idToken: asString(tokens?.id_token),
        accountId: asString(tokens?.account_id)
            ?? extractAccountId(asString(tokens?.id_token), accessToken),
        expiresAt,
        raw,
    }
}

const persistTokens = async (
    authFile: string,
    tokens: TokenResponse,
    previous: JsonObject = {},
    now = Date.now(),
    storage?: AuthStorage,
): Promise<AgentAuth> => {
    const previousTokens = asObject(previous.tokens) ?? {}
    const refreshToken = tokens.refreshToken ?? asString(previousTokens.refresh_token)
    if (!refreshToken) {
        throw new Error("Token response did not include a refresh token")
    }
    const idToken = tokens.idToken ?? asString(previousTokens.id_token)
    const accountId = extractAccountId(idToken, tokens.accessToken)
        ?? asString(previousTokens.account_id)
    const raw: JsonObject = {
        ...previous,
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
            ...previousTokens,
            id_token: idToken ?? null,
            access_token: tokens.accessToken,
            refresh_token: refreshToken,
            account_id: accountId ?? null,
        },
        last_refresh: new Date(now).toISOString(),
    }
    if (storage) await storage.write(raw)
    else {
    const temporaryFile = `${authFile}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(dirname(authFile), { recursive: true })
    await Bun.write(temporaryFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryFile, 0o600)
    await rename(temporaryFile, authFile)
    await chmod(authFile, 0o600)

    }

    const auth = parseAuthJson(raw)
    if (!auth.expiresAt && tokens.expiresIn) {
        auth.expiresAt = now + tokens.expiresIn * 1000
    }
    return auth
}

export const resolveAuthFile = (authFile?: string): string => {
    if (authFile) {
        return authFile
    }
    const codexHome = process.env.CODEX_HOME?.trim()
    if (codexHome) {
        return join(codexHome, "auth.json")
    }
    const userHome = process.env.HOME?.trim()
    if (!userHome) {
        throw new Error("Cannot resolve auth file because HOME is not set")
    }
    return join(userHome, ".codex", "auth.json")
}

const loadFreshAuth = async (
    options: AuthOptions & { forceRefresh?: boolean } = {},
): Promise<AgentAuth> => {
    const authFile = resolveAuthFile(options.authFile)
    if (!options.authStorage && !await Bun.file(authFile).exists()) {
        throw new Error(`No subscription credentials found at ${authFile}`)
    }
    const raw = asObject(options.authStorage ? await options.authStorage.read() : await Bun.file(authFile).json())
    if (!raw) {
        throw new Error(`Invalid auth file at ${authFile}`)
    }
    const auth = parseAuthJson(raw)
    const now = options.now?.() ?? Date.now()
    if (!options.forceRefresh && auth.expiresAt > now + REFRESH_MARGIN_MS) {
        return auth
    }
    const issuer = options.issuer ?? process.env.PUPPYGPT_AUTH_ISSUER ?? DEFAULT_ISSUER
    const response = await (options.fetchImpl ?? fetch)(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: auth.refreshToken,
            client_id: CLIENT_ID,
        }).toString(),
    })
    const tokens = await parseTokenResponse(response, "Token refresh")
    return persistTokens(authFile, tokens, raw, now, options.authStorage)
}

export const login = async (options: LoginOptions = {}): Promise<AgentAuth> => {
    const issuer = options.issuer ?? process.env.PUPPYGPT_AUTH_ISSUER ?? DEFAULT_ISSUER
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(DEVICE_AUTH_TIMEOUT_MS)]) : AbortSignal.timeout(DEVICE_AUTH_TIMEOUT_MS)
    const fetchImpl: FetchLike = (input, init) => (options.fetchImpl ?? fetch)(input, { ...init, signal })
    const now = options.now ?? Date.now
    const started = await fetchImpl(`${issuer}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "puppygpt-agent/0.1.0",
        },
        body: JSON.stringify({ client_id: CLIENT_ID }),
    })
    if (!started.ok) {
        throw new Error(`Device authorization failed to start with status ${started.status}`)
    }
    const device = asObject(await started.json())
    const deviceAuthId = asString(device?.device_auth_id)
    const userCode = asString(device?.user_code)
    if (!deviceAuthId || !userCode) {
        throw new Error("Device authorization response was incomplete")
    }
    const interval = Math.max(Number.parseInt(asString(device?.interval) ?? "5", 10) || 5, 1) * 1000
    options.onDeviceCode?.(`${issuer}/codex/device`, userCode)

    const deadline = now() + DEVICE_AUTH_TIMEOUT_MS
    let ready: JsonObject | undefined
    while (now() < deadline) {
        signal.throwIfAborted()
        const polled = await fetchImpl(`${issuer}/api/accounts/deviceauth/token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "puppygpt-agent/0.1.0",
            },
            body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        })
        if (polled.ok) {
            ready = asObject(await polled.json())
            break
        }
        if (polled.status !== 403 && polled.status !== 404) {
            throw new Error(`Device authorization failed with status ${polled.status}`)
        }
        if (options.sleepImpl) await options.sleepImpl(interval + POLLING_SAFETY_MARGIN_MS)
        else await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason) }
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, interval + POLLING_SAFETY_MARGIN_MS)
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
        })
    }

    const authorizationCode = asString(ready?.authorization_code)
    const codeVerifier = asString(ready?.code_verifier)
    if (!authorizationCode || !codeVerifier) {
        throw new Error("Device authorization timed out")
    }
    const exchanged = await fetchImpl(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: authorizationCode,
            redirect_uri: `${issuer}/deviceauth/callback`,
            client_id: CLIENT_ID,
            code_verifier: codeVerifier,
        }).toString(),
    })
    const tokens = await parseTokenResponse(exchanged, "Token exchange")
    signal.throwIfAborted()
    if (!tokens.refreshToken) throw new Error("OpenAI did not return reusable credentials")
    return persistTokens(resolveAuthFile(options.authFile), tokens, {}, now(), options.authStorage)
}

const refreshing = new Map<string | object, Promise<AgentAuth>>()
export const getFreshAuth = (options: AuthOptions & { forceRefresh?: boolean } = {}): Promise<AgentAuth> => {
    const key = options.authStorage?.key ?? resolve(resolveAuthFile(options.authFile))
    const active = refreshing.get(key)
    if (active) return active
    const task = loadFreshAuth(options).finally(() => { if (refreshing.get(key) === task) refreshing.delete(key) })
    refreshing.set(key, task)
    return task
}
