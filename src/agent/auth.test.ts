import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getFreshAuth, login } from "./auth"
import type { FetchLike } from "./types"

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        recursive: true,
        force: true,
    })))
})

const temporaryAuthFile = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-"))
    temporaryDirectories.push(directory)
    return join(directory, "auth.json")
}

const jwt = (claims: Record<string, unknown>): string => {
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return `header.${encoded}.signature`
}

test("device login saves Codex-compatible subscription credentials", async () => {
    const authFile = await temporaryAuthFile()
    const accessToken = jwt({ exp: 2_000_000_000, chatgpt_account_id: "account-1" })
    const responses = [
        new Response(JSON.stringify({
            device_auth_id: "device-1",
            user_code: "ABCD-EFGH",
            interval: "1",
        })),
        new Response(JSON.stringify({
            authorization_code: "authorization-1",
            code_verifier: "verifier-1",
        })),
        new Response(JSON.stringify({
            access_token: accessToken,
            refresh_token: "refresh-1",
            id_token: jwt({ email: "agent@example.com" }),
        })),
    ]
    const requests: string[] = []
    const fetchImpl: FetchLike = async input => {
        requests.push(input.toString())
        const response = responses.shift()
        if (!response) {
            throw new Error("Unexpected request")
        }
        return response
    }
    let shownCode = ""
    const auth = await login({
        authFile,
        issuer: "https://auth.example.test",
        fetchImpl,
        onDeviceCode: (url, code) => {
            shownCode = `${url} ${code}`
        },
    })

    expect(auth.accountId).toBe("account-1")
    expect(shownCode).toBe("https://auth.example.test/codex/device ABCD-EFGH")
    expect(requests).toEqual([
        "https://auth.example.test/api/accounts/deviceauth/usercode",
        "https://auth.example.test/api/accounts/deviceauth/token",
        "https://auth.example.test/oauth/token",
    ])
    const saved = JSON.parse(await readFile(authFile, "utf8"))
    expect(saved.auth_mode).toBe("chatgpt")
    expect(saved.tokens.access_token).toBe(accessToken)
    expect(saved.tokens.refresh_token).toBe("refresh-1")
    expect(saved.tokens.account_id).toBe("account-1")
    expect((await stat(authFile)).mode & 0o777).toBe(0o600)
})

test("expired credentials refresh without losing the refresh token", async () => {
    const authFile = await temporaryAuthFile()
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
            access_token: jwt({ exp: 1 }),
            refresh_token: "refresh-old",
            account_id: "account-old",
        },
    }))
    let requestBody = ""
    const fetchImpl: FetchLike = async (_input, init) => {
        requestBody = String(init?.body)
        return new Response(JSON.stringify({
            access_token: jwt({ exp: 2_000_000_000 }),
        }))
    }
    const auth = await getFreshAuth({
        authFile,
        issuer: "https://auth.example.test",
        fetchImpl,
        now: () => 10_000,
    })

    expect(requestBody).toContain("grant_type=refresh_token")
    expect(requestBody).toContain("refresh_token=refresh-old")
    expect(auth.refreshToken).toBe("refresh-old")
    expect(auth.accountId).toBe("account-old")
})

test("concurrent chats share one credential refresh", async () => {
    const authFile = await temporaryAuthFile()
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt({ exp: 1 }), refresh_token: "old" } }))
    let refreshes = 0
    const options = { authFile, fetchImpl: async () => {
        refreshes++
        await Bun.sleep(5)
        return Response.json({ access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "rotated" })
    } }
    const results = await Promise.all([getFreshAuth(options), getFreshAuth(options)])
    expect(refreshes).toBe(1)
    expect(results.map(result => result.refreshToken)).toEqual(["rotated", "rotated"])
})
