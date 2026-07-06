---
name: peer
description: Use when the user wants Fable 5 to act as a real-time peer programmer, improving a Codex prompt, exposing missing constraints, or sharpening implementation instructions before work begins.
---

# Peer

Peer is primarily a hook. Users activate the hook by including the literal token `$peer` in their prompt. Do not treat `Peer:peer`/`peer:peer` as hook activation; those names only load this informational skill.

Peer also has a manual CLI:

```bash
node scripts/peer.js "Improve this prompt before Codex acts on it."
```

Peer asks Fable 5 (via `claude -p` with read-only tools) to inspect the prompt and workspace, then returns an amended brief. It does not edit files. Reviews in the same Codex session resume one persistent Fable session, so Fable remembers earlier prompts and findings.

The automatic hook injects the peer review as additional context; it does not replace the user's submitted prompt.

## Skill Behavior

If this skill is explicitly loaded, explain how Peer works or how to activate it. Do not run the Peer CLI merely because this skill was selected; hook activation must happen before the turn through `$peer`.

Only run the manual CLI if the user explicitly asks to run Peer from the terminal. Use the plugin root as the working directory and pass the prompt as JSON:

```bash
printf '%s' '{"prompt":"<user prompt>","cwd":"<current repo cwd>"}' | node scripts/peer.js
```

Then use the returned `amended_prompt` and `review` in your response or next action.

For hook-based use, the user must place `$peer` in their prompt. Prompts without `$peer` are intentionally passed through unchanged.
