"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { additionalContextOutput } = require("../scripts/lib/hook-output");
const { submittedPrompt } = require("../scripts/lib/context");
const { hasPeerInvocation, stripPeerInvocation } = require("../scripts/lib/invocation");
const { boundedPath, createWorkspaceTools } = require("../scripts/lib/workspace-tools");
const { formatAdditionalContext, runPeerReview, shouldEnableWorkspaceTools } = require("../scripts/lib/peer-client");
const { readSessionState } = require("../scripts/lib/session-state");

function fakeCreateToolFunction(fn, _description, _params, _returns, name) {
  return { name, function: fn };
}

test("additionalContext output matches Codex UserPromptSubmit schema shape", () => {
  assert.deepStrictEqual(additionalContextOutput("hello"), {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "hello"
    }
  });
});

test("submittedPrompt prefers hook prompt", () => {
  assert.strictEqual(submittedPrompt({ prompt: "  hi  " }), "hi");
});

test("workspace tools reject paths outside cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-tools-"));
  assert.throws(() => boundedPath(dir, "../outside"), /escapes/);
});

test("workspace tools can read bounded files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-tools-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "needle\n", "utf8");
  const readTool = createWorkspaceTools(dir, fakeCreateToolFunction).find((tool) => tool.name === "read_file");
  assert.strictEqual(await readTool.function("a.txt"), "needle\n");
});

test("formatAdditionalContext includes amended prompt and notes", () => {
  const text = formatAdditionalContext({
    amended_prompt: "Do it with tests.",
    review: "Added verification.",
    confidence: "high"
  });
  assert.match(text, /# Peer prompt review/);
  assert.match(text, /Do it with tests/);
  assert.match(text, /Added verification/);
});

test("formatAdditionalContext asks Codex to visibly summarize the peer review", () => {
  const text = formatAdditionalContext({
    amended_prompt: "Do it with tests.",
    review: "Added verification.",
    confidence: "high"
  });
  assert.match(text, /Briefly acknowledge the Peer review/);
});

test("workspace tools are enabled only when the prompt asks for workspace context", () => {
  assert.strictEqual(shouldEnableWorkspaceTools({ prompt: "Improve this prompt." }), false);
  assert.strictEqual(shouldEnableWorkspaceTools({ prompt: "Inspect src/parser.js before improving this." }), true);
  assert.strictEqual(shouldEnableWorkspaceTools({ prompt: "Improve this prompt.", enable_workspace_tools: true }), true);
});

test("peer hook invocation requires [peer] and strips it from review input", () => {
  assert.strictEqual(hasPeerInvocation("Please review this"), false);
  assert.strictEqual(hasPeerInvocation("[peer] Please review this"), true);
  assert.strictEqual(hasPeerInvocation("$peer Please review this"), false);
  assert.strictEqual(hasPeerInvocation("Peer:peer Please review this"), false);
  assert.strictEqual(stripPeerInvocation("[peer] Please review this"), "Please review this");
  assert.strictEqual(stripPeerInvocation("$peer Please review this"), "$peer Please review this");
  assert.strictEqual(stripPeerInvocation("Peer:peer Please review this"), "Peer:peer Please review this");
  assert.strictEqual(stripPeerInvocation("Run [peer]: on this prompt"), "Run on this prompt");
});

test("UserPromptSubmit hook noops without [peer]", () => {
  const hookInput = {
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    session_id: "session-test",
    turn_id: "turn-test",
    model: "test-model",
    permission_mode: "default",
    prompt: "ordinary prompt"
  };
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "user-prompt-submit.js")], {
    input: JSON.stringify(hookInput),
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "" }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { continue: true });
});

test("runPeerReview retries until return_prompt is called", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peer-retry-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CODEX_HOME = home;
  let calls = 0;
  let secondMessages = null;
  try {
    const review = await runPeerReview({ prompt: "ship it", cwd: process.cwd() }, {
      config: { model: "test-model", timeoutMs: 1000, maxContextChars: 4000 },
      createToolFunction: fakeCreateToolFunction,
      ensemble: {
        ensembleRequest(messages, agent) {
          calls += 1;
          if (calls === 2) {
            secondMessages = messages;
            const returnTool = agent.tools.find((tool) => tool.name === "return_prompt");
            assert.deepStrictEqual(agent.tools.map((tool) => tool.name), ["return_prompt"]);
            returnTool.function("ship it, but verify it", "added tests", "high");
          }
          return (async function* stream() {})();
        },
        async ensembleResult() {
          if (calls === 1) {
            return {
              completed: false,
              failure: { error: "Tool call rounds limit reached (8)" },
              responseOutputs: [{ type: "message", role: "assistant", content: "I inspected package.json but forgot to return." }],
              requestStatus: "failed",
              messageIds: new Set(),
              startTime: new Date()
            };
          }
          return {
            completed: true,
            message: "done",
            requestStatus: "completed",
            messageIds: new Set(),
            startTime: new Date()
          };
        }
      }
    });
    assert.strictEqual(calls, 2);
    assert.ok(secondMessages.some((message) => message.content === "I inspected package.json but forgot to return."));
    assert.ok(secondMessages.some((message) => /Continue the same message thread/.test(String(message.content || ""))));
    assert.strictEqual(review.amended_prompt, "ship it, but verify it");
    assert.strictEqual(review.confidence, "high");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});

test("runPeerReview persists bounded peer review history", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peer-history-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CODEX_HOME = home;
  try {
    const input = { prompt: "prompt 0", cwd: process.cwd(), session_id: "peer-history-session" };
    for (let index = 0; index < 55; index += 1) {
      await runPeerReview({ ...input, prompt: `prompt ${index}` }, {
        config: { model: "test-model", timeoutMs: 1000, maxContextChars: 4000 },
        createToolFunction: fakeCreateToolFunction,
        ensemble: {
          ensembleRequest(_messages, agent) {
            const returnTool = agent.tools.find((tool) => tool.name === "return_prompt");
            returnTool.function(`prompt ${index} improved`, `review ${index}`, "high");
            return (async function* stream() {})();
          },
          async ensembleResult() {
            return { completed: true, message: "done", requestStatus: "completed", messageIds: new Set(), startTime: new Date() };
          }
        }
      });
    }
    const state = readSessionState("peer", input);
    assert.strictEqual(state.reviews.length, 50);
    assert.strictEqual(state.reviews[0].prompt, "prompt 5");
    assert.strictEqual(state.reviews[49].amended_prompt, "prompt 54 improved");
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});
