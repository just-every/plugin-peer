"use strict";

function continueOutput(output = {}) {
  return { continue: true, ...output };
}

function additionalContextOutput(additionalContext) {
  return continueOutput({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext
    }
  });
}

function writeHookOutput(output = {}) {
  process.stdout.write(JSON.stringify(output));
}

function writeContinue(output = {}) {
  writeHookOutput(continueOutput(output));
}

module.exports = {
  additionalContextOutput,
  continueOutput,
  writeContinue,
  writeHookOutput
};
