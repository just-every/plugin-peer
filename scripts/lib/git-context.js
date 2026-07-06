"use strict";

const { spawnSync } = require("node:child_process");

// The Fable child has no shell access, so the hook collects git state itself
// and injects it into the prompt. Git runs with a sanitized environment so a
// hostile workspace .env (GIT_EXTERNAL_DIFF etc.) cannot execute code, and
// with flags that make every subcommand read-only.
function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function runGit(cwd, args, maxBytes) {
  const result = spawnSync("git", ["--no-pager", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    env: gitEnv()
  });
  if (result.error || result.status !== 0 || !result.stdout) return "";
  const output = result.stdout.trim();
  if (output.length <= maxBytes) return output;
  return `${output.slice(0, maxBytes)}\n[truncated]`;
}

function collectGitContext(cwd, { includeDiff = false, maxDiffBytes = 20000 } = {}) {
  if (runGit(cwd, ["rev-parse", "--is-inside-work-tree"], 100) !== "true") return "";
  const sections = [];
  const status = runGit(cwd, ["status", "--short", "--branch"], 4000);
  if (status) sections.push(`Branch and status:\n${status}`);
  const log = runGit(cwd, ["log", "--oneline", "-8"], 2000);
  if (log) sections.push(`Recent commits:\n${log}`);
  const unstaged = runGit(cwd, ["diff", "--stat", "--no-ext-diff"], 4000);
  if (unstaged) sections.push(`Unstaged diffstat:\n${unstaged}`);
  const staged = runGit(cwd, ["diff", "--cached", "--stat", "--no-ext-diff"], 4000);
  if (staged) sections.push(`Staged diffstat:\n${staged}`);
  if (includeDiff) {
    const diff = runGit(cwd, ["diff", "--no-ext-diff"], maxDiffBytes);
    if (diff) sections.push(`Working tree diff:\n${diff}`);
  }
  if (sections.length === 0) return "";
  return [
    "## Workspace git state",
    "",
    "Collected by the hook at review time. You have no shell access; use Read/Glob/Grep for anything deeper.",
    "",
    sections.join("\n\n")
  ].join("\n");
}

module.exports = { collectGitContext };
