"use strict";

const { config, hasApiKey, loadEnv } = require("./env");
const { readRecentConversation } = require("./context");
const { runClaudeStructured } = require("./claude-backend");
const { collectGitContext } = require("./git-context");
const { readSessionState, updateSessionState } = require("./session-state");
const {
  buildPrompt,
  buildRetryPrompt,
  isReturnPromptRetryable,
  normalizeConfidence,
  runEnsembleReview,
  shouldEnableWorkspaceTools
} = require("./ensemble-backend");

const STATE_NAMESPACE = "peer";

const PEER_SCHEMA = {
  type: "object",
  properties: {
    amended_prompt: {
      type: "string",
      description: "The improved working brief Codex should follow. Preserve the user's intent; add scope, constraints, concrete files, and verification steps."
    },
    review: {
      type: "string",
      description: "Short explanation of what you changed or flagged, and why."
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "How confident you are that the amended brief is right."
    }
  },
  required: ["amended_prompt", "review", "confidence"],
  additionalProperties: false
};

const CLAUDE_SYSTEM_PROMPT = [
  "You are Fable acting as the senior peer reviewer for a Codex coding agent.",
  "Codex executes all work; you provide oversight. Never write code or edit files yourself, and do not produce the implementation.",
  "Turn each submitted prompt into a sharper working brief: preserve the user's intent, tighten scope, add missing constraints, name the concrete files and interfaces involved, call out risks and likely failure modes, and define verification steps Codex can run.",
  "Use your read-only tools (Read, Glob, Grep) when workspace facts would change the brief; current git state is included in each request. Keep exploration proportionate to the prompt.",
  "This session persists across the Codex thread: earlier prompts you reviewed are already in your context. Build on what you learned instead of re-exploring."
].join("\n");

async function runPeerReview(input, options = {}) {
  loadEnv({ cwd: input.cwd || options.cwd, pluginRoot: options.pluginRoot });
  const cfg = { ...config(), ...(options.config || {}) };
  const prompt = String(input.prompt || "");
  if (!prompt.trim()) return { status: "skipped", reason: "empty prompt" };
  const backend = options.config && options.config.backend
    ? options.config.backend
    : (options.ensemble ? "ensemble" : cfg.backend);
  if (backend === "ensemble") return runEnsembleReview({ ...input, prompt }, options, cfg);
  try {
    return await runClaudeReview({ ...input, prompt }, options, cfg);
  } catch (error) {
    if (backend === "auto" && error.code === "ENOENT" && hasApiKey()) {
      return runEnsembleReview({ ...input, prompt }, options, cfg);
    }
    throw error;
  }
}

async function runClaudeReview(input, options, cfg) {
  const cwd = input.cwd || options.cwd || process.cwd();
  const conversation = input.conversation || readRecentConversation(input.transcript_path);
  const state = readSessionState(STATE_NAMESPACE, input);
  const resumeSessionId = state.claude_session_id || null;
  const gitContext = collectGitContext(cwd);
  const buildPromptFor = (resumed) => buildClaudeReviewPrompt({
    prompt: input.prompt,
    conversation,
    gitContext,
    resumed,
    maxContextChars: cfg.maxContextChars
  });
  const outcome = runClaudeStructured({
    bin: cfg.claudeBin,
    prompt: buildPromptFor(Boolean(resumeSessionId)),
    freshPrompt: buildPromptFor(false),
    schema: PEER_SCHEMA,
    model: cfg.model,
    systemPrompt: CLAUDE_SYSTEM_PROMPT,
    resumeSessionId,
    effort: cfg.effort,
    cwd,
    timeoutMs: cfg.timeoutMs,
    runner: options.runClaude
  });
  updateSessionState(STATE_NAMESPACE, input, {
    claude_session_id: outcome.sessionId,
    cwd,
    model: cfg.model
  });
  const structured = outcome.structured;
  const amended = String(structured.amended_prompt || "").trim();
  if (!amended) throw new Error("Peer review returned an empty amended_prompt.");
  return {
    status: "ready",
    amended_prompt: amended,
    review: String(structured.review || "").trim(),
    confidence: normalizeConfidence(structured.confidence),
    model: cfg.model,
    backend: "claude",
    resumed: outcome.resumed,
    claude_session_id: outcome.sessionId,
    usage: outcome.result && outcome.result.total_cost_usd
  };
}

function buildClaudeReviewPrompt({ prompt, conversation, gitContext, resumed, maxContextChars }) {
  const context = (conversation || []).map((message) => `${message.role}: ${message.text}`).join("\n\n");
  const parts = [
    resumed
      ? "A new prompt was submitted in the Codex session you are peer-reviewing. Review it before Codex acts."
      : "You are starting peer review of a Codex session. Review this first prompt before Codex acts.",
    "",
    "Submitted prompt:",
    prompt,
    "",
    context ? `Recent conversation:\n${truncate(context, maxContextChars)}` : "Recent conversation: none"
  ];
  if (gitContext) parts.push("", gitContext);
  return parts.join("\n");
}

function truncate(text, maxChars) {
  const raw = String(text || "");
  if (!maxChars || raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n[conversation truncated]`;
}

function formatAdditionalContext(review) {
  return [
    "# Peer prompt review (Fable)",
    "",
    "A senior peer reviewed this prompt before execution. Treat the brief below as guidance for how to do the work; the user's own message remains authoritative if they conflict.",
    "",
    "## Amended brief",
    review.amended_prompt,
    "",
    "## Reviewer notes",
    review.review || "No additional notes.",
    "",
    `Confidence: ${review.confidence || "medium"}`
  ].join("\n");
}

module.exports = {
  CLAUDE_SYSTEM_PROMPT,
  PEER_SCHEMA,
  buildClaudeReviewPrompt,
  buildPrompt,
  buildRetryPrompt,
  formatAdditionalContext,
  isReturnPromptRetryable,
  runPeerReview,
  shouldEnableWorkspaceTools
};
