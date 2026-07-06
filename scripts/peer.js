#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { formatAdditionalContext, runPeerReview } = require("./lib/peer-client");

async function main() {
  const stdin = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8").trim();
  const input = stdin ? parseInput(stdin) : { prompt: process.argv.slice(2).join(" ") };
  const review = await runPeerReview({ cwd: process.cwd(), ...input });
  process.stdout.write(`${JSON.stringify({ ...review, additionalContext: review.status === "ready" ? formatAdditionalContext(review) : "" }, null, 2)}\n`);
}

function parseInput(raw) {
  if (raw.startsWith("{")) return JSON.parse(raw);
  return { prompt: raw };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
