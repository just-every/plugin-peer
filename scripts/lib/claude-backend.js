"use strict";

const { spawnSync } = require("node:child_process");

// No Bash: the read-only guarantee is structural. Git state is collected by
// the hook process (see git-context.js) and injected into the prompt instead.
const READ_ONLY_TOOLS = "Read,Glob,Grep";
const READ_ONLY_ALLOWED_TOOLS = "Read,Glob,Grep";
// CLAUDECODE/CLAUDE_CODE_* would confuse the child into nested-session mode.
// ANTHROPIC_API_KEY/AUTH_TOKEN would silently switch billing from the user's
// subscription login to raw API billing; the claude backend never needs them.
// NODE_OPTIONS could inject code into the child if it is a Node binary.
const STRIPPED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "NODE_OPTIONS"
];
const MIN_RETRY_TIMEOUT_MS = 30000;

function buildClaudeArgs({ schema, model, systemPrompt, resumeSessionId, effort }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--model", model,
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--tools", READ_ONLY_TOOLS,
    "--allowedTools", READ_ONLY_ALLOWED_TOOLS,
    "--permission-mode", "dontAsk"
  ];
  if (effort) args.push("--effort", effort);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return args;
}

function childEnv(env = process.env) {
  const copy = { ...env };
  for (const name of STRIPPED_ENV_VARS) delete copy[name];
  return copy;
}

function defaultRunner({ bin, args, cwd, prompt, timeoutMs }) {
  return spawnSync(bin, args, {
    cwd,
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv()
  });
}

function runClaudeStructured({
  bin = "claude",
  prompt,
  freshPrompt,
  schema,
  model,
  systemPrompt,
  resumeSessionId,
  effort,
  cwd,
  timeoutMs,
  runner = defaultRunner
}) {
  const startedAt = Date.now();
  const attempt = (resume, text, budgetMs) => {
    const outcome = interpretResult(runner({
      bin,
      args: buildClaudeArgs({ schema, model, systemPrompt, resumeSessionId: resume, effort }),
      cwd,
      prompt: text,
      timeoutMs: budgetMs
    }), { bin, timeoutMs: budgetMs });
    return { ...outcome, resumed: Boolean(resume) };
  };
  if (!resumeSessionId) return attempt(null, prompt, timeoutMs);
  try {
    return attempt(resumeSessionId, prompt, timeoutMs);
  } catch (error) {
    if (!isResumeFailure(error)) throw error;
    // The stored session is gone; start fresh within the remaining budget so
    // the hook's own timeout is not exceeded by two full-length attempts.
    const remaining = Math.max(MIN_RETRY_TIMEOUT_MS, timeoutMs - (Date.now() - startedAt));
    return attempt(null, freshPrompt || prompt, remaining);
  }
}

function interpretResult(result, { bin, timeoutMs }) {
  const parsed = interpretBaseResult(result, { bin, timeoutMs });
  const structured = extractStructuredOutput(parsed);
  if (!structured) {
    throw new Error("claude CLI result did not include structured output matching the schema.");
  }
  return { structured, sessionId: parsed.session_id, result: parsed };
}

function interpretBaseResult(result, { bin, timeoutMs }) {
  if (result.error) {
    if (result.error.code === "ENOENT") {
      const error = new Error(`claude CLI not found (tried "${bin}").`);
      error.code = "ENOENT";
      throw error;
    }
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`claude CLI timed out after ${timeoutMs}ms.`);
    }
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`claude CLI was killed with ${result.signal} (likely the ${timeoutMs}ms timeout).`);
  }
  const parsed = parseCliJson(result.stdout);
  if (!parsed) {
    throw new Error(`claude CLI returned no JSON result${describeStreams(result)}`);
  }
  if (parsed.is_error) {
    const error = new Error(String(parsed.result || "claude CLI reported an error."));
    error.cliResult = parsed;
    throw error;
  }
  return parsed;
}

// One-shot, tool-less, non-persisted text call — used for cheap side tasks
// like transcript digests, typically with a small model.
function buildPlainArgs({ model }) {
  return [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--tools", "",
    "--no-session-persistence",
    "--permission-mode", "dontAsk"
  ];
}

function runClaudePlain({ bin = "claude", prompt, model, cwd, timeoutMs, runner = defaultRunner }) {
  const parsed = interpretBaseResult(runner({
    bin,
    args: buildPlainArgs({ model }),
    cwd,
    prompt,
    timeoutMs
  }), { bin, timeoutMs });
  return String(parsed.result || "").trim();
}

function parseCliJson(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    // Fall back to the last line that looks like a JSON object (e.g. when
    // warnings are printed before the result).
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const value = JSON.parse(lines[index]);
        if (value && typeof value === "object") return value;
      } catch {
        // keep looking
      }
    }
    return null;
  }
}

function extractStructuredOutput(parsed) {
  if (parsed.structured_output && typeof parsed.structured_output === "object") {
    return parsed.structured_output;
  }
  return parseLooseJson(parsed.result);
}

function parseLooseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = raw.indexOf("{");
  for (const candidate of [fenced && fenced[1], raw, brace >= 0 ? raw.slice(brace) : null]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function isResumeFailure(error) {
  const message = String((error && error.message) || "");
  return /no conversation found|session.*(not found|expired|does not exist)|unknown session|--resume/i.test(message);
}

function describeStreams(result) {
  const stderr = String(result.stderr || "").trim();
  const suffix = stderr ? `: ${stderr.slice(0, 500)}` : ` (exit status ${result.status}).`;
  return suffix;
}

module.exports = {
  READ_ONLY_ALLOWED_TOOLS,
  READ_ONLY_TOOLS,
  buildClaudeArgs,
  buildPlainArgs,
  childEnv,
  extractStructuredOutput,
  isResumeFailure,
  parseCliJson,
  runClaudePlain,
  runClaudeStructured
};
