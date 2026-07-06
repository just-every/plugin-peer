# Peer

Peer asks Fable 5 to review a Codex prompt before the turn runs, then injects the amended brief as hidden additional context. Fable oversees; Codex executes.

The hook is opt-in per prompt. Start a prompt with `$peer` or include `$peer` in the prompt to activate review for that turn. Prompts without `$peer` are passed through unchanged and do not call Fable.

It does not replace the submitted prompt because Codex hook output does not currently support direct prompt replacement. It uses the supported `UserPromptSubmit` `additionalContext` path.

## How Fable is called

Peer talks to Fable through the Claude Code CLI in headless mode (`claude -p`) by default:

- **Subscription auth** — uses your existing `claude` login (OAuth), no `ANTHROPIC_API_KEY` needed.
- **Persistent reviewer session** — the first `$peer` review creates a Claude session; later reviews in the same Codex thread `--resume` it, so Fable keeps the goal and everything it already learned instead of starting fresh each time. Session ids are stored under `$CODEX_HOME/peer/sessions/` (default `~/.codex/peer/sessions/`).
- **Structurally read-only** — the child gets `--tools Read,Glob,Grep` only (no Bash, no write tools), `--permission-mode dontAsk`, `--setting-sources user`, `--strict-mcp-config`, and hooks disabled, so a hostile workspace cannot expand its permissions. Git state (branch, status, recent commits, diffstat) is collected by the hook with a sanitized environment and injected into the prompt instead.
- **Structured output** — the review comes back through `--json-schema`, so there is no retry protocol around a required tool call.
- **No key leakage** — `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` and `NODE_OPTIONS` are stripped from the child environment, so reviews bill your subscription, never a stray API key. `.env` files are read with an allowlist: only `PEER_*` keys and `ANTHROPIC_API_KEY` are imported.

If the `claude` CLI is not installed and `ANTHROPIC_API_KEY` is set, Peer falls back to the legacy `@just-every/ensemble` API backend.

## Configuration

Optional environment variables (environment, project `.env`, plugin `.env`, or `~/.env`):

```bash
PEER_DISABLED=1              # turn the hook off
PEER_BACKEND=auto            # auto (default) | claude | ensemble
PEER_CLAUDE_BIN=claude       # path to the Claude Code CLI
PEER_MODEL=claude-fable-5    # model passed to the backend
PEER_EFFORT=                 # optional --effort for the claude backend (low..max)
PEER_TIMEOUT_MS=1200000      # per-review timeout (20 minutes)
PEER_MAX_CONTEXT_CHARS=12000 # cap on conversation context sent with the prompt
```

`ANTHROPIC_API_KEY` is only required for the `ensemble` backend.

## CLI

```bash
node scripts/peer.js "Implement this feature, but check the tests first."
```

JSON:

```bash
printf '%s\n' '{"prompt":"Review this request","cwd":"/path/to/repo"}' | node scripts/peer.js
```

CLI invocations from the same `cwd` resume the same reviewer session.

## Hooks

`hooks/hooks.json` registers a `UserPromptSubmit` command hook. The hook is a no-op unless the submitted prompt contains `$peer`. Plugin installation and hook trust are handled by Codex; this repository does not install or trust hooks automatically.

## Development

```bash
npm test
```
