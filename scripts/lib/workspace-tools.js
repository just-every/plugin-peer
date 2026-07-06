"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 60000;

function createWorkspaceTools(cwd, createToolFunction) {
  const root = path.resolve(cwd);
  return [
    createToolFunction(
      async function list_files(dir = ".", limit = 200) {
        const start = boundedPath(root, dir);
        const files = [];
        walk(start, root, files, Math.min(Number(limit) || 200, 500));
        return files.join("\n");
      },
      "List workspace files under a relative directory.",
      {
        dir: { type: "string", description: "Relative directory to list.", optional: true },
        limit: { type: "number", description: "Maximum number of files.", optional: true }
      },
      undefined,
      "list_files"
    ),
    createToolFunction(
      async function read_file(file, max_bytes = DEFAULT_MAX_BYTES) {
        const target = boundedPath(root, file);
        const stat = fs.statSync(target);
        if (!stat.isFile()) throw new Error("read_file target is not a file");
        const bytes = Math.min(Number(max_bytes) || DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
        return fs.readFileSync(target).subarray(0, bytes).toString("utf8");
      },
      "Read a workspace file by relative path.",
      {
        file: { type: "string", description: "Relative file path to read." },
        max_bytes: { type: "number", description: "Maximum bytes to read.", optional: true }
      },
      undefined,
      "read_file",
      false
    ),
    createToolFunction(
      async function search_files(query, dir = ".", limit = 50) {
        const start = boundedPath(root, dir);
        const matches = [];
        search(start, root, String(query || ""), matches, Math.min(Number(limit) || 50, 200));
        return matches.join("\n");
      },
      "Search text files for a query string.",
      {
        query: { type: "string", description: "String to search for." },
        dir: { type: "string", description: "Relative directory to search.", optional: true },
        limit: { type: "number", description: "Maximum matching lines.", optional: true }
      },
      undefined,
      "search_files"
    ),
    createToolFunction(
      async function git_diff(max_bytes = DEFAULT_MAX_BYTES) {
        const result = childProcess.spawnSync("git", ["diff", "--no-ext-diff"], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: Math.min(Number(max_bytes) || DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES)
        });
        if (result.status !== 0) return result.stderr || "";
        return result.stdout.slice(0, Math.min(Number(max_bytes) || DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES));
      },
      "Read the current git diff for the workspace.",
      {
        max_bytes: { type: "number", description: "Maximum bytes to return.", optional: true }
      },
      undefined,
      "git_diff",
      false
    )
  ];
}

function boundedPath(root, requested) {
  const target = path.resolve(root, requested || ".");
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes workspace root.");
  }
  return target;
}

function walk(dir, root, files, limit) {
  if (files.length >= limit) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= limit || skipName(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) walk(full, root, files, limit);
    else if (entry.isFile()) files.push(rel);
  }
}

function search(dir, root, query, matches, limit) {
  if (!query || matches.length >= limit) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (matches.length >= limit || skipName(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      search(full, root, query, matches, limit);
      continue;
    }
    if (!entry.isFile()) continue;
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length < limit && line.includes(query)) {
        matches.push(`${path.relative(root, full)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

function skipName(name) {
  return name === ".git" || name === "node_modules" || name === ".DS_Store";
}

module.exports = {
  boundedPath,
  createWorkspaceTools
};
