"use strict";

const { requireKey } = require("./env");
const { readRecentConversation } = require("./context");
const { createWorkspaceTools } = require("./workspace-tools");

const BASE_INSTRUCTIONS = [
  "You are Fable acting as a real-time peer programmer for Codex.",
  "Your job is to improve the submitted prompt before Codex acts.",
  "Preserve the user's intent. Tighten scope, add missing constraints, point out likely issues, and make the work more verifiable.",
  "Use read-only tools only when workspace context would materially improve the prompt.",
  "You must call return_prompt with the amended prompt. Do not finish without calling return_prompt.",
  "End position: the conversation is complete only after return_prompt has been called with amended_prompt, review, and confidence."
].join("\n");

async function runEnsembleReview(input, options, cfg) {
  requireKey();
  const ensemble = options.ensemble || await loadEnsemble();
  const createToolFunction = options.createToolFunction || ensemble.createToolFunction;
  const cwd = input.cwd || options.cwd || process.cwd();
  const conversation = input.conversation || readRecentConversation(input.transcript_path);
  const prompt = input.prompt || "";
  const workspaceToolsEnabled = shouldEnableWorkspaceTools(input);

  let returned = null;
  const workspaceTools = createWorkspaceTools(cwd, createToolFunction);
  const returnTool = createToolFunction(
      async function return_prompt(amended_prompt, review = "", confidence = "medium") {
        returned = {
          amended_prompt: String(amended_prompt || "").trim(),
          review: String(review || "").trim(),
          confidence: normalizeConfidence(confidence)
        };
        return "Prompt received.";
      },
      "Return the final amended prompt and review. This tool is required.",
      {
        amended_prompt: { type: "string", description: "The improved prompt Codex should use as its working brief." },
        review: { type: "string", description: "Short explanation of what changed and why.", optional: true },
        confidence: { type: "string", description: "low, medium, or high.", enum: ["low", "medium", "high"], optional: true }
      },
      undefined,
      "return_prompt",
      false
  );

  const messages = [{
    type: "message",
    role: "user",
    content: buildPrompt({ prompt, conversation, maxContextChars: cfg.maxContextChars })
  }];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    returned = null;
    const agent = {
      model: cfg.model,
      instructions: BASE_INSTRUCTIONS,
      tools: attempt === 1 && workspaceToolsEnabled ? [...workspaceTools, returnTool] : [returnTool],
      maxToolCallRoundsPerTurn: 8,
      maxToolCalls: 20,
      modelSettings: { timeout_ms: cfg.timeoutMs }
    };
    const result = await ensemble.ensembleResult(ensemble.ensembleRequest(messages, agent));
    appendResultToThread(messages, result);
    if (!result.completed) {
      const reason = result.failure?.error || result.error || "Peer Fable request failed.";
      if (isReturnPromptRetryable(reason) && attempt < 3) {
        messages.push({
          type: "message",
          role: "user",
          content: buildRetryPrompt({ reason, nextAttempt: attempt + 1 })
        });
        continue;
      }
      throw new Error(reason);
    }
    if (returned && returned.amended_prompt) {
      return {
        status: "ready",
        ...returned,
        attempts: attempt,
        model: cfg.model,
        backend: "ensemble",
        usage: result.cost
      };
    }
    if (attempt < 3) {
      messages.push({
        type: "message",
        role: "user",
        content: buildRetryPrompt({
          reason: result.message || "The previous attempt completed without calling return_prompt.",
          nextAttempt: attempt + 1
        })
      });
    }
  }
  throw new Error("Fable did not call return_prompt after 3 attempts.");
}

function isReturnPromptRetryable(reason) {
  return /tool call rounds limit reached|tool calls limit reached/i.test(String(reason || ""));
}

function buildPrompt({ prompt, conversation, maxContextChars }) {
  const context = conversation.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  const body = [
    "Review and improve this Codex prompt.",
    "",
    "Required end position: call return_prompt with amended_prompt, review, and confidence. Do not end in plain text.",
    "",
    "Submitted prompt:",
    prompt,
    "",
    context ? `Recent conversation:\n${context}` : "Recent conversation: none"
  ].join("\n");
  return body.slice(0, maxContextChars);
}

function appendResultToThread(messages, result) {
  if (Array.isArray(result.responseOutputs) && result.responseOutputs.length > 0) {
    messages.push(...result.responseOutputs);
    return;
  }
  if (result.message) {
    messages.push({ type: "message", role: "assistant", content: result.message });
  }
}

function buildRetryPrompt({ reason, nextAttempt }) {
  return [
    `Continue the same message thread for attempt ${nextAttempt}.`,
    "Use the tool calls, tool outputs, and reasoning already present in this thread. Do not repeat workspace exploration.",
    "Only the return_prompt tool is available now.",
    "Required end position: the next assistant tool action should be return_prompt({ amended_prompt, review, confidence }).",
    "",
    "Previous attempt did not reach that end position:",
    String(reason || "return_prompt was not called.")
  ].join("\n");
}

function normalizeConfidence(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

function shouldEnableWorkspaceTools(input) {
  if (input.enable_workspace_tools === true) return true;
  const text = String(input.prompt || "");
  return /(?:\b(?:repo|repository|workspace|diff|file|files|read|inspect|search|grep)\b|(?:^|\s)[./~][^\s]+|\.[A-Za-z0-9]{1,8}\b)/i.test(text);
}

async function loadEnsemble() {
  return require("@just-every/ensemble");
}

module.exports = {
  buildPrompt,
  buildRetryPrompt,
  isReturnPromptRetryable,
  normalizeConfidence,
  runEnsembleReview,
  shouldEnableWorkspaceTools
};
