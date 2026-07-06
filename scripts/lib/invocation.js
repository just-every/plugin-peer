"use strict";

const PEER_TOKEN = /(^|[^\w-])\$peer\b:?/i;

function hasPeerInvocation(prompt) {
  return PEER_TOKEN.test(String(prompt || ""));
}

function stripPeerInvocation(prompt) {
  return String(prompt || "").replace(PEER_TOKEN, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

module.exports = {
  hasPeerInvocation,
  stripPeerInvocation
};
