import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOC, DOC2, DOC_ALIAS } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "package", "bin", "check-tool-scope.mjs");
const TOOL_READ = "mcp__claude_ai_Claude_Docs__read";
const TOOL_QUERY = "mcp__claude_ai_Claude_Docs__query";
const OTHER_DOC = "QaWsEdRfTgYhUjIkOlPmNb";

function preTool(toolName, toolInput, allowedIds = [DOC, DOC_ALIAS, DOC2]) {
  return spawnSync(process.execPath, [HOOK, ...allowedIds], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  });
}

test("the pre-tool hook permits configured read and query ids, including an explicit alias", () => {
  for (const [tool, input] of [
    [TOOL_READ, { ref: { object: "project", id: DOC } }],
    [TOOL_READ, { ref: { object: "project", id: DOC_ALIAS } }],
    [TOOL_QUERY, { object: "utterance", container: { kind: "project", id: DOC2 } }],
  ]) {
    const result = preTool(tool, input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "allow");
  }
});

test("the pre-tool hook denies reads of docs outside the source allowlist", () => {
  for (const [tool, input] of [
    [TOOL_READ, { ref: { object: "project", id: OTHER_DOC } }],
    [TOOL_QUERY, { object: "utterance", container: { kind: "project", id: OTHER_DOC } }],
  ]) {
    const result = preTool(tool, input, [DOC]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
});

test("the pre-tool hook denies malformed and non-read/query calls", () => {
  const result = preTool("Bash", { command: "cat private" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  const missingScope = spawnSync(process.execPath, [HOOK], { input: "{}", encoding: "utf8" });
  assert.equal(missingScope.status, 0, missingScope.stderr);
  assert.equal(JSON.parse(missingScope.stdout).hookSpecificOutput.permissionDecision, "deny");
  const invalidEvent = spawnSync(process.execPath, [HOOK, DOC], { input: "not-json", encoding: "utf8" });
  assert.equal(invalidEvent.status, 0, invalidEvent.stderr);
  assert.equal(JSON.parse(invalidEvent.stdout).hookSpecificOutput.permissionDecision, "deny");
});
