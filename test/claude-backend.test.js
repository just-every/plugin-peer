"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildClaudeArgs,
  childEnv,
  extractStructuredOutput,
  isResumeFailure,
  parseCliJson
} = require("../scripts/lib/claude-backend");
const { readSessionState, updateSessionState } = require("../scripts/lib/session-state");
const { runPeerReview } = require("../scripts/lib/peer-client");

function cliResult({ structured, sessionId = "11111111-1111-4111-8111-111111111111", isError = false, result = "ok" } = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      result,
      session_id: sessionId,
      structured_output: structured,
      total_cost_usd: 0.1
    }),
    stderr: ""
  };
}

function withTempCodexHome(fn) {
  const previous = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-claude-"));
  process.env.CODEX_HOME = dir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    });
}

const CLAUDE_CONFIG = {
  backend: "claude",
  claudeBin: "claude",
  model: "test-model",
  effort: "",
  timeoutMs: 1000,
  maxContextChars: 4000
};

test("buildClaudeArgs is read-only, structured, and resumable", () => {
  const args = buildClaudeArgs({
    schema: { type: "object" },
    model: "test-model",
    systemPrompt: "sys",
    resumeSessionId: "abc",
    effort: "high"
  });
  assert.strictEqual(args[0], "-p");
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("--permission-mode") && args.includes("dontAsk"));
  const tools = args[args.indexOf("--tools") + 1];
  assert.strictEqual(tools, "Read,Glob,Grep");
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.ok(!/Bash|Write|Edit/.test(tools + allowed), "no shell or write tools may reach the child");
  assert.ok(args.includes("--strict-mcp-config"), "workspace MCP configs must be ignored");
  assert.strictEqual(args[args.indexOf("--setting-sources") + 1], "user", "workspace settings must not expand permissions");
  assert.strictEqual(args[args.indexOf("--resume") + 1], "abc");
  assert.strictEqual(args[args.indexOf("--effort") + 1], "high");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.strictEqual(settings.disableAllHooks, true);
});

test("childEnv strips nested-session, billing, and injection variables", () => {
  const env = childEnv({
    PATH: "/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "x",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ANTHROPIC_API_KEY: "sk-secret",
    ANTHROPIC_AUTH_TOKEN: "tok",
    NODE_OPTIONS: "--require evil.js"
  });
  assert.strictEqual(env.PATH, "/bin");
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "NODE_OPTIONS"]) {
    assert.ok(!(name in env), `${name} must not reach the claude child`);
  }
});

test("loadEnv only imports allowlisted keys from .env files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-env-"));
  fs.writeFileSync(path.join(dir, ".env"), [
    "NODE_OPTIONS=--require ./payload.js",
    "GIT_EXTERNAL_DIFF=./evil.sh",
    "ANTHROPIC_BASE_URL=https://attacker.example",
    "PEER_TEST_ALLOWED_KEY=yes",
    "ANTHROPIC_API_KEY=sk-from-env"
  ].join("\n"), "utf8");
  const saved = {};
  for (const key of ["NODE_OPTIONS", "GIT_EXTERNAL_DIFF", "ANTHROPIC_BASE_URL", "PEER_TEST_ALLOWED_KEY", "ANTHROPIC_API_KEY"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    require("../scripts/lib/env").loadEnv({ cwd: dir, pluginRoot: dir });
    assert.strictEqual(process.env.PEER_TEST_ALLOWED_KEY, "yes");
    assert.strictEqual(process.env.ANTHROPIC_API_KEY, "sk-from-env");
    assert.strictEqual(process.env.NODE_OPTIONS, undefined);
    assert.strictEqual(process.env.GIT_EXTERNAL_DIFF, undefined);
    assert.strictEqual(process.env.ANTHROPIC_BASE_URL, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.PEER_TEST_ALLOWED_KEY;
  }
});

test("collectGitContext reports status and commits from a real repo", () => {
  const { collectGitContext } = require("../scripts/lib/git-context");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-git-"));
  const git = (...args) => {
    const result = require("node:child_process").spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
  };
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "initial");
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n", "utf8");
  const context = collectGitContext(dir, { includeDiff: true });
  assert.match(context, /## Workspace git state/);
  assert.match(context, /initial/);
  assert.match(context, /a\.txt/);
  assert.match(context, /\+two/);
  assert.strictEqual(collectGitContext(fs.mkdtempSync(path.join(os.tmpdir(), "peer-nogit-"))), "");
});

test("parseCliJson tolerates leading warnings", () => {
  const parsed = parseCliJson(`Warning: something\n{"type":"result","is_error":false,"session_id":"s"}`);
  assert.strictEqual(parsed.session_id, "s");
});

test("extractStructuredOutput falls back to fenced JSON in result text", () => {
  const structured = extractStructuredOutput({
    result: 'Here you go:\n```json\n{"amended_prompt":"do it right"}\n```'
  });
  assert.strictEqual(structured.amended_prompt, "do it right");
});

test("isResumeFailure matches session-loss errors only", () => {
  assert.ok(isResumeFailure(new Error("No conversation found with session ID: abc")));
  assert.ok(!isResumeFailure(new Error("rate limited")));
});

test("claude backend review persists the session and resumes on the next call", () => withTempCodexHome(async () => {
  const input = {
    prompt: "ship it",
    cwd: process.cwd(),
    session_id: "codex-session",
    transcript_path: "/tmp/transcript.jsonl"
  };
  const calls = [];
  const runner = (invocation) => {
    calls.push(invocation);
    return cliResult({
      structured: { amended_prompt: "ship it, verified", review: "added verification", confidence: "high" }
    });
  };

  const first = await runPeerReview(input, { config: CLAUDE_CONFIG, runClaude: runner });
  assert.strictEqual(first.status, "ready");
  assert.strictEqual(first.backend, "claude");
  assert.strictEqual(first.amended_prompt, "ship it, verified");
  assert.strictEqual(first.resumed, false);
  assert.ok(!calls[0].args.includes("--resume"));
  assert.strictEqual(readSessionState("peer", input).claude_session_id, "11111111-1111-4111-8111-111111111111");

  const second = await runPeerReview(input, { config: CLAUDE_CONFIG, runClaude: runner });
  assert.strictEqual(second.resumed, true);
  assert.strictEqual(calls[1].args[calls[1].args.indexOf("--resume") + 1], "11111111-1111-4111-8111-111111111111");
  assert.match(calls[1].prompt, /new prompt was submitted/);
}));

test("claude backend retries fresh when the stored session is gone", () => withTempCodexHome(async () => {
  const input = {
    prompt: "continue the work",
    cwd: process.cwd(),
    session_id: "codex-session-2",
    transcript_path: "/tmp/transcript2.jsonl"
  };
  updateSessionState("peer", input, { claude_session_id: "dead-session" });
  const calls = [];
  const runner = (invocation) => {
    calls.push(invocation);
    if (invocation.args.includes("--resume")) {
      return { status: 1, stdout: "", stderr: "No conversation found with session ID: dead-session" };
    }
    return cliResult({
      structured: { amended_prompt: "fresh brief", review: "restarted", confidence: "medium" },
      sessionId: "22222222-2222-4222-8222-222222222222"
    });
  };

  const review = await runPeerReview(input, { config: CLAUDE_CONFIG, runClaude: runner });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(review.amended_prompt, "fresh brief");
  assert.strictEqual(review.resumed, false);
  assert.strictEqual(readSessionState("peer", input).claude_session_id, "22222222-2222-4222-8222-222222222222");
}));

test("claude backend surfaces CLI errors", () => withTempCodexHome(async () => {
  const input = { prompt: "do it", cwd: process.cwd(), session_id: "codex-session-3" };
  const runner = () => cliResult({ isError: true, result: "Failed to authenticate.", structured: undefined });
  await assert.rejects(
    runPeerReview(input, { config: CLAUDE_CONFIG, runClaude: runner }),
    /Failed to authenticate/
  );
}));

test("auto backend falls back to ensemble when claude CLI is missing and a key exists", () => withTempCodexHome(async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const runner = () => ({ error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) });
    const review = await runPeerReview({ prompt: "do it", cwd: process.cwd(), session_id: "codex-session-4" }, {
      config: { ...CLAUDE_CONFIG, backend: "auto" },
      runClaude: runner,
      createToolFunction: (fn, _d, _p, _r, name) => ({ name, function: fn }),
      ensemble: {
        ensembleRequest(_messages, agent) {
          const returnTool = agent.tools.find((tool) => tool.name === "return_prompt");
          returnTool.function("ensemble brief", "fallback", "low");
          return (async function* stream() {})();
        },
        async ensembleResult() {
          return { completed: true, message: "done", requestStatus: "completed", messageIds: new Set(), startTime: new Date() };
        }
      }
    });
    assert.strictEqual(review.backend, "ensemble");
    assert.strictEqual(review.amended_prompt, "ensemble brief");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
}));
