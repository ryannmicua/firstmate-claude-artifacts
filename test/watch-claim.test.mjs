// Advisory per-page watch claims.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DOC, ROOT, tempDir } from "./helpers.mjs";

const TOOL = path.join(ROOT, "skills", "claude-artifact-watcher", "scripts", "watch-claim.mjs");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";

function home(tasks = ["task-a", "task-b"]) {
  const dir = tempDir("fca-claim-");
  mkdirSync(path.join(dir, "state"));
  for (const task of tasks) writeFileSync(path.join(dir, "state", `${task}.meta`), "kind=task\n");
  return dir;
}

function claim(args, env = {}) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test("the first task claims a page and a second live task is refused", () => {
  const h = home();
  assert.match(claim(["claim", `https://claude.ai/code/artifact/plan-${DOC}`, "--task", "task-a"], { FM_HOME: h }).out, /^claimed: 123e4567/);
  const refused = claim(["claim", DOC, "--task", "task-b"], { FM_HOME: h });
  assert.equal(refused.status, 3);
  assert.match(refused.out, /refused: .* held by live task task-a/);
  assert.match(claim(["list"], { FM_HOME: h }).out, new RegExp(`${DOC}\\ttask-a\\tlive`));
});

test("a relaunch of the same task keeps its claim", () => {
  const h = home();
  claim(["claim", DOC], { FM_HOME: h, FM_TASK_ID: "task-a" });
  const again = claim(["claim", DOC], { FM_HOME: h, FM_TASK_ID: "task-a" });
  assert.equal(again.status, 0);
  assert.match(again.out, /^kept: /);
  assert.match(claim(["list"], { FM_HOME: h }).out, new RegExp(`${DOC}\\ttask-a\\tlive`));
});

test("a claim whose task no longer exists is stale and may be taken over", () => {
  const h = home();
  claim(["claim", DOC, "--task", "task-a"], { FM_HOME: h });
  rmSync(path.join(h, "state", "task-a.meta"));
  assert.match(claim(["list"], { FM_HOME: h }).out, /task-a\tstale/);
  const taken = claim(["claim", DOC, "--task", "task-b"], { FM_HOME: h });
  assert.equal(taken.status, 0);
  assert.match(taken.out, /taken-over: .* from stale holder task-a/);
});

test("a watcher attaches the discovered page id to its existing claim", () => {
  const h = home();
  claim(["claim", DOC, "--task", "task-a"], { FM_HOME: h });
  const attached = claim(["claim", DOC, SLUG, "--task", "task-a"], { FM_HOME: h });
  assert.equal(attached.status, 0);
  assert.match(attached.out, new RegExp(`kept: ${DOC}`));
  assert.match(attached.out, new RegExp(`claimed: ${SLUG}`));
  const refused = claim(["claim", SLUG, "--task", "task-b"], { FM_HOME: h });
  assert.equal(refused.status, 3);
  assert.match(claim(["list"], { FM_HOME: h }).out, new RegExp(`${SLUG}\\ttask-a\\tlive`));
});

test("a conflicting discovered id refuses atomically and release-task frees the original claim", () => {
  const h = home();
  claim(["claim", DOC, "--task", "task-a"], { FM_HOME: h });
  claim(["claim", SLUG, "--task", "task-b"], { FM_HOME: h });
  assert.equal(claim(["claim", DOC, SLUG, "--task", "task-a"], { FM_HOME: h }).status, 3);
  assert.match(claim(["list"], { FM_HOME: h }).out, new RegExp(`${DOC}\\ttask-a\\tlive`));
  assert.match(claim(["release-task", "--task", "task-a"], { FM_HOME: h }).out, new RegExp(`released: ${DOC}`));
  assert.doesNotMatch(claim(["list"], { FM_HOME: h }).out, new RegExp(`${DOC}\\ttask-a`));
  assert.match(claim(["list"], { FM_HOME: h }).out, new RegExp(`${SLUG}\\ttask-b\\tlive`));
});

test("list shows pages, holders, and liveness", () => {
  const h = home();
  claim(["claim", DOC, "--task", "task-a"], { FM_HOME: h });
  claim(["claim", SLUG, "--task", "task-b"], { FM_HOME: h });
  rmSync(path.join(h, "state", "task-b.meta"));
  const list = claim(["list"], { FM_HOME: h }).out;
  assert.match(list, /^page\tholder\tstate\tsince/);
  assert.match(list, new RegExp(`${DOC}\ttask-a\tlive`));
  assert.match(list, new RegExp(`${SLUG}\ttask-b\tstale`));
});

test("the home comes from --home, FM_HOME, or FM_TASK_INBOX, and claims are per home", () => {
  const one = home();
  const two = home();
  claim(["claim", DOC, "--task", "task-a"], { FM_TASK_INBOX: path.join(one, "state", "task-a.inbox") });
  assert.match(claim(["list", "--home", one]).out, /task-a\tlive/);
  assert.match(claim(["list"], { FM_HOME: two }).out, /^no claims/);
  assert.equal(claim(["claim", DOC, "--task", "task-b"], { FM_HOME: two }).status, 0);
  assert.deepEqual(readdirSync(path.join(one, "state", "fca-watch-claims")).filter((n) => n.endsWith(".json")), [`${DOC}.json`]);
});

test("FM_STATE_OVERRIDE selects the state directory", () => {
  const h = home();
  claim(["claim", DOC, "--task", "task-a"], { FM_STATE_OVERRIDE: path.join(h, "state") });
  assert.match(claim(["list"], { FM_HOME: h }).out, /task-a\tlive/);
});

test("usage errors exit 2", () => {
  const h = home();
  assert.equal(claim(["claim", DOC], { FM_HOME: h }).status, 2);
  assert.equal(claim(["claim", "https://example.com/x", "--task", "task-a"], { FM_HOME: h }).status, 2);
  assert.equal(claim(["claim", DOC, "--task", "../x"], { FM_HOME: h }).status, 2);
  assert.equal(claim(["list"], {}).status, 2);
  assert.equal(claim(["list", "--home", "/nonexistent-home"]).status, 2);
  assert.equal(claim(["bogus"], { FM_HOME: h }).status, 2);
  assert.equal(claim(["--help"]).status, 0);
});

test("direct invocation works from a skill path containing spaces", () => {
  const dir = tempDir("fca skill path ");
  const scriptDir = path.join(dir, "installed skill", "scripts");
  mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, "watch-claim.mjs");
  copyFileSync(TOOL, script);
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^watch-claim: advisory per-page watch claims/);
});

test("concurrent claims by two live tasks leave exactly one holder", async () => {
  const h = home();
  const runAsync = (task) => new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, "claim", DOC, "--task", task], { env: { PATH: process.env.PATH, FM_HOME: h } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (status) => resolve({ status, out }));
  });
  const results = await Promise.all(["task-a", "task-b", "task-a", "task-b"].map(runAsync));
  const holders = new Set(results.filter((r) => r.status === 0).map((r) => r.out.match(/by (task-[ab])/)[1]));
  assert.equal(holders.size, 1);
  assert.ok(results.some((r) => r.status === 3));
});
