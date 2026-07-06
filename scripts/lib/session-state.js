"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sessionKey(input) {
  const basis = [
    input && input.session_id,
    input && input.transcript_path,
    input && input.cwd
  ].filter(Boolean).join("\n");
  return crypto.createHash("sha256").update(basis || "unknown").digest("hex");
}

function sessionDir(namespace) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, namespace, "sessions");
}

function sessionPath(namespace, input) {
  return path.join(sessionDir(namespace), `${sessionKey(input)}.json`);
}

function readSessionState(namespace, input) {
  try {
    const state = JSON.parse(fs.readFileSync(sessionPath(namespace, input), "utf8"));
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function updateSessionState(namespace, input, patch) {
  const state = {
    ...readSessionState(namespace, input),
    ...patch,
    updated_at: new Date().toISOString()
  };
  fs.mkdirSync(sessionDir(namespace), { recursive: true });
  const target = sessionPath(namespace, input);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return state;
}

module.exports = {
  readSessionState,
  sessionDir,
  sessionKey,
  sessionPath,
  updateSessionState
};
