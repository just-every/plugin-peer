"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadEnv({ cwd = process.cwd(), pluginRoot = path.resolve(__dirname, "..", "..") } = {}) {
  for (const file of [path.join(cwd, ".env"), path.join(pluginRoot, ".env"), path.join(os.homedir(), ".env")]) {
    loadEnvFile(file);
  }
}

// Only keys this plugin actually uses may be imported from .env files. A
// cloned repository's .env must never be able to set NODE_OPTIONS,
// GIT_EXTERNAL_DIFF, ANTHROPIC_BASE_URL, or anything else that changes how
// spawned processes behave.
function allowedEnvKey(key) {
  return key === "ANTHROPIC_API_KEY" || key.startsWith("PEER_");
}

function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed && allowedEnvKey(parsed.key) && process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

function parseEnvLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const source = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = source.indexOf("=");
  if (eq <= 0) return null;
  const key = source.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, value: unquote(source.slice(eq + 1).trim()) };
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  const comment = value.match(/^(.*?)(?:\s+#.*)$/);
  return comment ? comment[1].trimEnd() : value;
}

function disabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.PEER_DISABLED || "").trim().toLowerCase());
}

function config() {
  return {
    backend: normalizeBackend(process.env.PEER_BACKEND),
    claudeBin: process.env.PEER_CLAUDE_BIN || "claude",
    model: process.env.PEER_MODEL || "claude-fable-5",
    effort: process.env.PEER_EFFORT || "",
    timeoutMs: positiveInt(process.env.PEER_TIMEOUT_MS, 1200000),
    maxContextChars: positiveInt(process.env.PEER_MAX_CONTEXT_CHARS, 12000)
  };
}

function normalizeBackend(value) {
  const backend = String(value || "").trim().toLowerCase();
  return ["claude", "ensemble"].includes(backend) ? backend : "auto";
}

function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

function requireKey() {
  if (!hasApiKey()) {
    throw new Error("ANTHROPIC_API_KEY is required for the Peer ensemble backend.");
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  config,
  disabled,
  hasApiKey,
  loadEnv,
  parseEnvLine,
  requireKey
};
