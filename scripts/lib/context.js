"use strict";

const fs = require("node:fs");

function submittedPrompt(input) {
  if (typeof input.prompt === "string" && input.prompt.trim()) return clean(input.prompt);
  const recent = readRecentConversation(input.transcript_path);
  const last = [...recent].reverse().find((message) => message.role === "user");
  return last ? last.text : "";
}

function readRecentConversation(transcriptPath, maxMessages = 8, maxChars = 8000) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return [];
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = extractMessage(event);
    if (message) messages.push(message);
  }
  let selected = messages.slice(-maxMessages);
  while (selected.map((message) => message.text).join("\n").length > maxChars && selected.length > 1) {
    selected = selected.slice(1);
  }
  return selected;
}

function extractMessage(event) {
  const payload = event && event.payload;
  if (!payload || payload.type !== "message") return null;
  if (payload.role !== "user" && payload.role !== "assistant") return null;
  const text = clean(extractText(payload.content));
  return text ? { role: payload.role, text } : null;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    return part.text || part.input_text || part.output_text || "";
  }).filter(Boolean).join("\n");
}

function clean(value) {
  return String(value || "").replace(/\0/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

module.exports = {
  extractText,
  readRecentConversation,
  submittedPrompt
};
