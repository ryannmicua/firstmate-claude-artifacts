// config_ref parsing and the check session's process handling.

import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CheckError, parseToolJson, runClaude } from "../package/lib/check.mjs";
import { ConfigError, DEFAULTS, parseConfigRef } from "../package/lib/config.mjs";
import { DOC, DOC2, DOC_ALIAS, tempDir } from "./helpers.mjs";

test("a bare doc reference takes every default", () => {
  assert.deepEqual(parseConfigRef(`doc:${DOC}`), { docs: [{ id: DOC, aliases: [DOC] }], ...DEFAULTS });
  assert.equal(DEFAULTS.model, "claude-haiku-5-5");
});

test("the 22-character artifact id form is accepted", () => {
  assert.deepEqual(parseConfigRef("doc:AbCdEfGhIjKlMnOpQrStUv").docs, [{ id: "AbCdEfGhIjKlMnOpQrStUv", aliases: ["AbCdEfGhIjKlMnOpQrStUv"] }]);
});

test("a source accepts several docs and explicit id aliases", () => {
  assert.deepEqual(parseConfigRef(`doc:${DOC}~${DOC_ALIAS},${DOC2}`).docs, [
    { id: DOC, aliases: [DOC, DOC_ALIAS] },
    { id: DOC2, aliases: [DOC2] },
  ]);
});

test("settings are parsed and bounded", () => {
  const config = parseConfigRef(`doc:${DOC}?model=claude-sonnet-5-5&every=900&wait=0&timeout=60&budget=0.25&failures=5&claude=/opt/claude/bin/claude`);
  assert.equal(config.model, "claude-sonnet-5-5");
  assert.equal(config.every, 900);
  assert.equal(config.wait, 0);
  assert.equal(config.timeout, 60);
  assert.equal(config.budget, 0.25);
  assert.equal(config.failures, 5);
  assert.equal(config.claude, "/opt/claude/bin/claude");
});

for (const bad of [
  "",
  "file:/tmp/x",
  "doc:",
  "doc:,,",
  "doc:../../etc",
  `doc:${DOC}?every=5`,
  `doc:${DOC}?every=abc`,
  `doc:${DOC}?wait=999`,
  `doc:${DOC}?timeout=1`,
  `doc:${DOC}?budget=0`,
  `doc:${DOC}?budget=50`,
  `doc:${DOC}?model=Claude Haiku`,
  `doc:${DOC}?model=$(id)`,
  `doc:${DOC}?claude=relative/claude`,
  `doc:${DOC}?claude=/a/../b`,
  `doc:${DOC}?colour=blue`,
  `doc:${DOC}?every=60&every=90`,
  `doc:${DOC}?every`,
  `doc:${DOC}?a=1?b=2`,
  `doc:${DOC}?claude=/${"x".repeat(600)}`,
  `doc:${DOC}~bad`,
  `doc:${DOC},${DOC}`,
  `doc:${DOC}~${DOC_ALIAS},${DOC_ALIAS}`,
]) {
  test(`config_ref ${JSON.stringify(bad.slice(0, 60))} is refused`, () => {
    assert.throws(() => parseConfigRef(bad), ConfigError);
  });
}

test("a session past its timeout is killed and reported", async () => {
  const dir = tempDir();
  const slow = path.join(dir, "slow");
  writeFileSync(slow, "#!/bin/sh\nsleep 3\n");
  chmodSync(slow, 0o755);
  const started = Date.now();
  await assert.rejects(runClaude({ binary: slow, args: [], prompt: "", cwd: path.join(dir, "run"), env: process.env, timeoutMs: 300 }), CheckError);
  assert.ok(Date.now() - started < 2500, "a descendant holding the pipe must not delay the timeout");
});

test("a nonzero exit is reported with the last stderr line", async () => {
  const dir = tempDir();
  const bad = path.join(dir, "bad");
  writeFileSync(bad, "#!/bin/sh\necho 'Error: not logged in' >&2\nexit 1\n");
  chmodSync(bad, 0o755);
  await assert.rejects(runClaude({ binary: bad, args: [], prompt: "", cwd: path.join(dir, "run"), env: process.env, timeoutMs: 5000 }), /not logged in/);
});

test("tool result JSON is found between notice lines and only as a verdict object", () => {
  assert.deepEqual(parseToolJson('<artifact-content-authored-by-others/>\nnotice\n{"verdict":"allow","rows":[]}\ntrailer'), { verdict: "allow", rows: [] });
  assert.equal(parseToolJson('{"rows":[]}'), null);
  assert.equal(parseToolJson("no json here"), null);
});
