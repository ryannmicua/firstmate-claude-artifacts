// Shared helpers for the offline tests. Every doc, tab, author, and comment
// here is invented.

import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = path.join(ROOT, "package", "bin", "claude-doc-comments");
export const EXTENSION_ID = "io.github.ryannmicua.firstmate-claude-artifacts";
export const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package", "firstmate-extension.json"), "utf8")).version;
export const DOC = "123e4567-e89b-42d3-a456-426614174000";
export const TAB1 = "aaaa1111-0001";
export const TAB2 = "bbbb2222-0002";

export function rid(ch) {
  return `sha256:${ch.repeat(64)}`;
}

export function tempDir(prefix = "fca-test-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function row(tab, seq, body, extra = {}) {
  const { via = "web", to, parent, name = "Pat Example", kind } = extra;
  const value = kind === "resolve"
    ? { kind: "resolve", parent: parent || { object: "utterance", id: "c0000000-root" } }
    : { body, parent: parent || { object: "node", id: `${tab}-body` }, ...(to ? { to } : {}) };
  return {
    tab,
    seq,
    at: "2026-01-02T03:04:05.000Z",
    verb: "create",
    id: `c${String(seq).padStart(7, "0")}-${tab.slice(0, 4)}`,
    actor: { principal: "u_invented1", channel: "external", via, self: true, name },
    payload: { value },
  };
}

// A sandbox: a fake claude with its scenario, and a private state directory.
export function sandbox(scenario = {}) {
  const dir = tempDir();
  const fakeDir = path.join(dir, "fake");
  const state = path.join(dir, "state");
  spawnSync("mkdir", ["-p", fakeDir, state]);
  chmodSync(state, 0o700);
  const claude = path.join(fakeDir, "claude");
  copyFileSync(path.join(ROOT, "test", "fixtures", "fake-claude.mjs"), claude);
  chmodSync(claude, 0o755);
  const box = {
    dir,
    state,
    claude,
    setScenario(next) {
      writeFileSync(path.join(fakeDir, "scenario.json"), JSON.stringify({
        doc: DOC,
        title: "Invented picnic plan",
        tabs: [{ id: TAB1, name: "Plan" }],
        rows: [],
        mode: "ok",
        ...next,
      }));
    },
    calls() {
      const file = path.join(fakeDir, "calls.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    stateFiles() {
      const dirPath = path.join(state, "sources");
      if (!existsSync(dirPath)) return [];
      return readdirSync(dirPath).filter((name) => name.endsWith(".json")).map((name) => path.join(dirPath, name));
    },
    readState() {
      const files = box.stateFiles();
      if (files.length !== 1) throw new Error(`expected one state file, found ${files.length}`);
      return JSON.parse(readFileSync(files[0], "utf8"));
    },
    // Make the next poll due now, as if the cadence interval had passed.
    makeDue() {
      for (const file of box.stateFiles()) {
        const value = JSON.parse(readFileSync(file, "utf8"));
        value.last_check_at = 0;
        writeFileSync(file, JSON.stringify(value));
      }
    },
    configRef(extra = "") {
      return `doc:${DOC}?wait=0&claude=${claude}${extra}`;
    },
  };
  box.setScenario(scenario);
  return box;
}

export function run(verb, input, { env = {}, raw = false } = {}) {
  const result = spawnSync(ENTRY, [verb], {
    input: raw ? input : JSON.stringify(input),
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", HOME: os.tmpdir(), ...env },
    encoding: "utf8",
    timeout: 60000,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

export function handshakeRequest(overrides = {}) {
  return {
    schema: "firstmate.extension-handshake-request.v1",
    request_id: rid("a"),
    host_protocols: [1],
    extension_id: EXTENSION_ID,
    extension_version: VERSION,
    package_digest: rid("b"),
    capability: { name: "process-event-adapter", versions: [1], adapter_names: ["claude-doc-comments"] },
    ...overrides,
  };
}

export function invokeRequest(operation, input, overrides = {}) {
  return {
    schema: "firstmate.extension-request.v1",
    request_id: rid("c"),
    host_protocol: 1,
    extension_id: EXTENSION_ID,
    extension_version: VERSION,
    package_digest: rid("b"),
    capability: "process-event-adapter",
    capability_version: 1,
    adapter: "claude-doc-comments",
    operation,
    input,
    ...overrides,
  };
}

export function poll(box, requestId, extraConfig = "") {
  return run("invoke", invokeRequest("source.poll", { source_id: "picnic-review", config_ref: box.configRef(extraConfig) }, { request_id: requestId }), {
    env: { FIRSTMATE_EXTENSION_STATE: box.state },
  });
}

export function resultOp(box, operation, content, requestId = rid("d"), sourceId = "picnic-review") {
  return run("invoke", invokeRequest(operation, { source_id: sourceId, sequence: 1, content }, { request_id: requestId }), {
    env: { FIRSTMATE_EXTENSION_STATE: box.state },
  });
}
