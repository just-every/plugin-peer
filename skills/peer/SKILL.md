---
name: peer
description: Use when the user wants Fable 5 to act as a real-time peer programmer, improving a Codex prompt, exposing missing constraints, or sharpening implementation instructions before work begins.
---

# Peer

Peer is hook-first but also has a CLI:

```bash
node scripts/peer.js "Improve this prompt before Codex acts on it."
```

Peer asks Fable 5 (via `claude -p` with read-only tools) to inspect the prompt and workspace, then returns an amended brief. It does not edit files. Reviews in the same Codex session resume one persistent Fable session, so Fable remembers earlier prompts and findings.

The automatic hook injects the peer review as additional context; it does not replace the user's submitted prompt.

## Required Behavior

When this skill is explicitly loaded because the user invoked `peer:peer`/`Peer:peer`, run the Peer CLI before answering unless the user is only asking for documentation about Peer.

Use the plugin root as the working directory and pass the user's prompt as JSON:

```bash
printf '%s' '{"prompt":"<user prompt>","cwd":"<current repo cwd>"}' | node scripts/peer.js
```

Then use the returned `amended_prompt` and `review` in your response or next action. Do not merely say the skill was read.

For hook-based use, the user can place `$peer` or `peer:peer` in their prompt. Prompts without one of those tokens are intentionally passed through unchanged.
