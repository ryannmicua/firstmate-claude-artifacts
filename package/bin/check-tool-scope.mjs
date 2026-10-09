#!/usr/bin/env node

import { isDocId } from "../lib/config.mjs";
import { TOOL_QUERY, TOOL_READ } from "../lib/check.mjs";

const allowedIds = process.argv.slice(2);
const deny = () => {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "This check can access only its configured Claude Docs.",
    },
  })}\n`);
};

if (allowedIds.length === 0 || allowedIds.some((id) => !isDocId(id)) || new Set(allowedIds).size !== allowedIds.length) {
  deny();
  process.exit(0);
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

try {
  const event = JSON.parse(raw);
  const input = event?.tool_input;
  const allowed = event?.tool_name === TOOL_READ
    ? input?.ref?.object === "project" && allowedIds.includes(input.ref.id)
    : event?.tool_name === TOOL_QUERY
      ? input?.object === "utterance" && input?.container?.kind === "project" && allowedIds.includes(input.container.id)
      : false;
  if (!allowed) deny();
} catch {
  deny();
}
