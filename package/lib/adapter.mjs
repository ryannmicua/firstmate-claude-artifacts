// The claude-doc-comments process-event adapter operations.
//
// Delivery is at least once. A poll that finds new comments stores the exact
// output as a pending result keyed by the host's request id and returns it;
// a retry with the same request id replays it without another check. The
// per-tab cursors advance only when a later result.classify, result.terminal,
// or result.silent call presents that exact output back, which the host does
// only for a captured result. A pending result that never comes back is
// discarded on the next poll and its comments are read again.

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, parseConfigRef } from "./config.mjs";
import { buildPrompt, CheckError, claudeArgs, findClaude, parseTranscript, runClaude } from "./check.mjs";
import { failure, success } from "./protocol.mjs";
import { buildResult, CLASSIFICATION, combineResults, parseResult, resultHasRows } from "./render.mjs";
import { SourceStore, StateError, stateRoot } from "./state.mjs";

const FALLBACK_CURSOR = 0;
const NO_RESULT = Object.freeze({ status: "no-result", output: "" });

function log(message) {
  process.stderr.write(`claude-doc-comments: ${message}\n`);
}

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function dueAt(state, config) {
  if (state.due_now || !state.last_check_at) return 0;
  return state.last_check_at + config.every * 1000;
}

// Run one check session, retrying once within the same time budget when the
// model did not make the expected calls (an occasional low-cost-model slip).
async function checkOnce(config, cursorsByDoc, env, clock) {
  const runDir = path.join(stateRoot(env), "run");
  rmSync(path.join(runDir, "last-failed-transcript.jsonl"), { force: true });
  const binary = findClaude(config, env);
  const budgetMs = config.timeout * 1000;
  const started = clock.now();
  for (let attempt = 1; ; attempt += 1) {
    const transcript = await runClaude({
      binary,
      args: claudeArgs(config),
      prompt: buildPrompt(config.docs, cursorsByDoc, FALLBACK_CURSOR),
      cwd: runDir,
      env,
      timeoutMs: Math.max(1000, budgetMs - (clock.now() - started)),
    });
    const parsed = new Map();
    const errors = new Map();
    for (const doc of config.docs) {
      try {
        parsed.set(doc.id, parseTranscript(transcript, doc, cursorsByDoc[doc.id] || {}, FALLBACK_CURSOR));
      } catch (error) {
        if (!(error instanceof CheckError)) throw error;
        errors.set(doc.id, error);
      }
    }
    const retryable = [...errors.values()].find((error) => !error.permanent);
    if (errors.size > 0) {
      const parseError = errors.values().next().value;
      const separators = transcript.match(/\r\n|\r|\n/g) || [];
      const lineCount = transcript.length === 0 ? 0 : separators.length + (/(?:\r\n|\r|\n)$/.test(transcript) ? 0 : 1);
      writeFileSync(path.join(runDir, "last-failed-check.json"), `${JSON.stringify({
        exit_status: 0,
        error_class: parseError?.constructor?.name || "Error",
        byte_count: Buffer.byteLength(transcript, "utf8"),
        line_count: lineCount,
        timestamp: new Date(clock.now()).toISOString(),
      })}\n`, { mode: 0o600 });
    }
    if (retryable) {
      const elapsed = clock.now() - started;
      if (attempt >= 2 || elapsed * 2 > budgetMs) return { parsed, errors };
      log(`check attempt ${attempt} failed (${retryable.message}); retrying once`);
      continue;
    }
    return { parsed, errors };
  }
}

export async function poll(request, { env = process.env, clock = realClock } = {}) {
  const requestId = request.request_id;
  const { source_id: sourceId, config_ref: configRef } = request.input;
  let config;
  try {
    config = parseConfigRef(configRef);
  } catch (error) {
    if (error instanceof ConfigError) return failure(requestId, "invalid-request", false, error.message);
    throw error;
  }
  let stores;
  try {
    stores = config.docs.map((doc) => ({ doc, store: new SourceStore(stateRoot(env), sourceId, doc.id) }));
  } catch (error) {
    if (error instanceof StateError) return failure(requestId, "unavailable", false, error.message);
    throw error;
  }

  // A retry of the request that produced the pending result replays it.
  let states = stores.map(({ store }) => store.read());
  const replay = states.find((state) => state.pending?.request_id === requestId)?.pending?.output;
  if (replay !== undefined) return success(requestId, { status: "result", output: replay });
  for (const { store } of stores) {
    store.update((current) => {
      if (!current.pending) return null;
      log("discarding a pending result the host never confirmed; its comments will be read again");
      return { ...current, pending: null, due_now: true };
    });
  }
  states = stores.map(({ store }) => store.read());

  // Wait inside the bounded poll for the next scheduled check, then give up
  // quietly so the host's next reconcile starts another bounded wait.
  let due = Math.min(...states.map((state) => dueAt(state, config)));
  if (clock.now() < due) {
    const pause = Math.min(due - clock.now(), config.wait * 1000);
    if (pause > 0) await clock.sleep(pause);
    states = stores.map(({ store }) => store.read());
    due = Math.min(...states.map((state) => dueAt(state, config)));
    if (clock.now() < due) return success(requestId, NO_RESULT);
  }

  if (due > clock.now()) return success(requestId, NO_RESULT);
  const dueDocs = stores.map((entry, index) => ({ ...entry, state: states[index] }));
  const cursorsByDoc = Object.fromEntries(stores.map(({ doc }, index) => [doc.id, { ...states[index].cursors }]));
  const checkedAt = new Date(clock.now()).toISOString();
  let checked;
  try {
    checked = await checkOnce(config, cursorsByDoc, env, clock);
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    checked = { parsed: new Map(), errors: new Map(dueDocs.map(({ doc }) => [doc.id, error])) };
  }

  const builtByDoc = new Map();
  let thresholdFailure = null;
  for (const { doc, store, state } of dueDocs) {
    const error = checked.errors.get(doc.id);
    if (error) {
      const after = store.update((current) => ({ ...current, failures: current.failures + 1, last_check_at: clock.now(), due_now: false }));
      log(`check for ${doc.id} failed (${after.failures} in a row): ${error.message}`);
      if (error.permanent || after.failures % config.failures === 0) thresholdFailure = { count: after.failures, error };
      continue;
    }
    const parsed = checked.parsed.get(doc.id);
    if (!parsed) continue;
    const cursorsBefore = { ...state.cursors };
    const built = buildResult({ sourceId, requestId, doc: doc.id, parsed, cursorsBefore, fallback: FALLBACK_CURSOR, checkedAt });
    builtByDoc.set(doc.id, { built, parsed });
    store.update((current) => {
      const next = { ...current, failures: 0, last_check_at: clock.now(), due_now: built.more };
      if (!built.announced) next.cursors = built.cursorsAfter;
      return next;
    });
    if (parsed.uncheckedTabs.length > 0) log(`tabs not checked for ${doc.id}: ${parsed.uncheckedTabs.join(", ")}`);
  }

  const announced = [...builtByDoc].filter(([, value]) => value.built.announced)
    .map(([docId, value]) => ({ docId, built: value.built }));
  if (announced.length > 0) {
    const failures = [...checked.errors].map(([docId, error]) => ({ docId, error }));
    const combined = combineResults(announced, failures);
    for (const { docId, built } of announced) {
      if (!combined.included.includes(docId)) {
        const store = stores.find((entry) => entry.doc.id === docId).store;
        store.update((current) => ({ ...current, due_now: true }));
        continue;
      }
      const store = stores.find((entry) => entry.doc.id === docId).store;
      store.update((current) => ({
        ...current,
        pending: { request_id: requestId, output: combined.output, cursors_after: built.cursorsAfter, created_at: checkedAt },
      }));
    }
    return success(requestId, { status: "result", output: combined.output });
  }
  if (thresholdFailure) {
    return failure(requestId, "unavailable", !thresholdFailure.error.permanent,
      `${thresholdFailure.count} failed check(s) in a row; last: ${thresholdFailure.error.message}`);
  }
  return success(requestId, NO_RESULT);
}

// Advance the cursors when the host presents back the exact pending output.
export function commitCaptured(input, env = process.env) {
  const result = parseResult(input.content);
  if (!result || result.source_id !== input.source_id) return result;
  const documents = Array.isArray(result.documents) ? result.documents : [{ doc: result.doc }];
  for (const item of documents) {
    if (typeof item?.doc?.id !== "string") continue;
    try {
      const store = new SourceStore(stateRoot(env), input.source_id, item.doc.id);
      store.update((state) => {
        const pending = state.pending;
        if (!pending || pending.request_id !== result.request_id || pending.output !== input.content) return null;
        return { ...state, cursors: { ...state.cursors, ...pending.cursors_after }, pending: null };
      });
    } catch (error) {
      log(`could not record the captured result: ${error.message}`);
    }
  }
  return result;
}

export function classify(request, options = {}) {
  const result = commitCaptured(request.input, options.env);
  return success(request.request_id, { classification: result ? CLASSIFICATION : "unrecognized" });
}

export function terminal(request, options = {}) {
  commitCaptured(request.input, options.env);
  return success(request.request_id, { value: false });
}

export function silent(request, options = {}) {
  const result = commitCaptured(request.input, options.env);
  return success(request.request_id, { value: Boolean(result && !resultHasRows(result)) });
}

export async function invoke(request, options = {}) {
  switch (request.operation) {
    case "source.poll": return poll(request, options);
    case "result.classify": return classify(request, options);
    case "result.terminal": return terminal(request, options);
    case "result.silent": return silent(request, options);
    default: return failure(request.request_id, "invalid-request", false, "unknown operation");
  }
}
