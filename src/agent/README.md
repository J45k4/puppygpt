# PuppyGPT agent

Standalone Bun agent loop adapted from SetaGPT's `setagpt/src`. No runtime
dependencies, database, worker server, or company integrations are required.

```ts
import { AgentSession } from "./src/agent"

const session = new AgentSession({
    cwd: "/absolute/path/to/workspace",
    model: "gpt-5.6-sol",
    instructions: "Keep changes focused and verify the result.",
    onInteraction: event => {
        if (event.type === "tool_start") console.log(event.command)
        if (event.type === "tool_output") process.stdout.write(event.chunk.text)
    },
})

console.log(await session.run("List the files and explain this project"))
console.log(await session.run("Now inspect its tests"))
```

Use `runAgent({ prompt, ...options })` for a single turn. During an active turn,
`session.steer(text)` queues guidance and backgrounds the current shell command
so the model can respond. `session.stop()` cancels the active request or foreground
command. Already backgrounded commands continue until completion or their timeout.
Concurrent `run()` calls on the same session are rejected.

The loop retains Responses output, returns tool results by call ID, and continues
until a final answer. It supports `exec`, `view_image`, `imagegen`, hosted web search, bounded
command previews, interaction events, transient retries, and Codex context
compaction. `contextSnapshot()` returns a copy of the in-memory conversation;
the chat server saves completed-turn snapshots and passes them as the second
`AgentSession` constructor argument to resume after a restart.

`cwd` defaults to `PUPPYGPT_WORKDIR` or the current directory. Its root `AGENTS.md`
is loaded on each turn. Commands run with the host user's permissions and inherited
environment; the working directory is not a sandbox. Full command output is saved
under `<cwd>/.puppygpt/exec-results/`. Image reads are limited to the working directory.

`imagegen` uses the same Codex authentication and provider endpoint as the agent,
calling `images/generations` or `images/edits` with `gpt-image-2`. Its arguments are
`prompt` and optionally `referenced_image_paths` (up to five workspace images) or
`num_last_images_to_include` (1–5 recent conversation images). Omit references for
new images. Size, quality, and background use `auto`; request transparency in the
prompt. Generated PNGs are saved under `<cwd>/.puppygpt/generated_images/` and
returned as visual model input. The chat UI displays them with a download link.
The tool has a five-minute timeout, honors Stop, and refreshes authentication once
on HTTP 401. Other failures are returned to the model without automatic replay.

Authentication uses the same ChatGPT subscription transport as SetaGPT:
`authFile`, then `$CODEX_HOME/auth.json`, then `$HOME/.codex/auth.json`.
Expired tokens are refreshed and saved back to that file. `login()` exposes the
device login flow for callers that need it; importing the module does not log in
or start a server. No credentials are included in this project.

Options include `model`, `reasoningEffort`, `fastMode`, `maxSteps`, `maxRetries`,
`contextWindow`, `endpoint`, and `issuer`. The copied model defaults are SetaGPT's
defaults, not an independent model recommendation. The transport uses the Codex
subscription endpoint and its compaction extension, not the public API-key endpoint.
General tool-call semantics: [OpenAI function calling documentation](https://developers.openai.com/api/docs/guides/function-calling).

Tests inject `fetchImpl`, `execute`, `inspectImage`, and `loadWorkspaceInstructions`
to exercise the loop without a live account. They also execute real shell commands
in temporary directories. No live model request is part of the test suite.

```bash
bun test
bun run check
bun run build:agent
bun run build
```
