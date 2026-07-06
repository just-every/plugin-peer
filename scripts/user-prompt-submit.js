#!/usr/bin/env node
"use strict";

const { disabled, loadEnv } = require("./lib/env");
const { isChildSession, readHookInput } = require("./lib/hook-input");
const { additionalContextOutput, writeContinue, writeHookOutput } = require("./lib/hook-output");
const { submittedPrompt } = require("./lib/context");
const { hasPeerInvocation, stripPeerInvocation } = require("./lib/invocation");
const { formatAdditionalContext, runPeerReview } = require("./lib/peer-client");

async function main() {
  try {
    const input = readHookInput("UserPromptSubmit");
    loadEnv({ cwd: input.cwd });
    if (disabled() || isChildSession(input)) {
      writeContinue();
      return;
    }
    const submitted = submittedPrompt(input);
    if (!hasPeerInvocation(submitted)) {
      writeContinue();
      return;
    }
    const prompt = stripPeerInvocation(submitted);
    const review = await runPeerReview({ ...input, prompt });
    if (review.status === "ready") {
      writeHookOutput(additionalContextOutput(formatAdditionalContext(review)));
      return;
    }
  } catch (error) {
    process.stderr.write(`Peer could not review the prompt: ${error.message}\n`);
  }
  writeContinue();
}

main().catch((error) => {
  process.stderr.write(`Peer UserPromptSubmit failed: ${error.message}\n`);
  writeContinue();
});
