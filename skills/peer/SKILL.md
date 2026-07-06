---
name: peer
description: Use when the user wants Fable 5 to act as a real-time peer programmer, improving a Codex prompt, exposing missing constraints, or sharpening implementation instructions before work begins.
---

# Peer

Peer has two modes:

- Hook mode: users activate the hook by including the literal token `[peer]` in their prompt. Do not treat `Peer:peer`/`peer:peer` as hook activation.
- Skill mode: when this skill is explicitly selected, run Peer as a manual second-opinion reviewer.

Peer also has a manual CLI:

```bash
node scripts/peer.js "Improve this prompt before Codex acts on it."
```

Peer asks Fable 5 (via `claude -p` with read-only tools, including web search/fetch) to inspect the prompt, workspace, and current external facts when useful, then returns an amended brief. It does not edit files. Reviews in the same Codex session resume one persistent Fable session, so Fable remembers earlier prompts and findings.

The automatic hook injects the peer review as additional context; it does not replace the user's submitted prompt.

## Skill Behavior

If this skill is explicitly loaded for a user request, run the Peer CLI before answering so Fable can provide a second opinion. Use the plugin root as the working directory and pass the user's prompt as JSON:

```bash
printf '%s' '{"prompt":"<user prompt>","cwd":"<current repo cwd>"}' | node scripts/peer.js
```

Then use the returned `amended_prompt` and `review` in your response or next action. If the user is only asking how Peer works, answer from this documentation instead of running the CLI.

For hook-based use, the user must place `[peer]` in their prompt. Prompts without `[peer]` are intentionally passed through unchanged.
