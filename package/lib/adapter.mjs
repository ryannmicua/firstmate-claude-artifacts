// The claude-doc-comments process-event adapter operations.
//
// Delivery is at least once. A poll that finds new comments stores the exact
// output as a pending result keyed by the host's request id and returns it;
// a retry with the same request id replays it without another check. The
// per-tab cursors advance only when a later result.classify, result.terminal,
// or result.silent call presents that exact output back, which the host does
// only for a captured result. A pending result that never comes back is
// discarded on the next poll and its comments are read again.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, parseConfigRef } from "./config.mjs";
import { buildPrompt, CheckError, claudeArgs, findClaude, parseTranscript, runClaude } from "./check.mjs";
import { failure, success } from "./protocol.mjs";
import { buildResult, CLASSIFICATION, parseResult } from "./render.mjs";
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
async function checkOnce(config, cursorsBefore, env, clock) {
  const binary = findClaude(config, env);
  const runDir = path.join(stateRoot(env), "run");
  const budgetMs = config.timeout * 1000;
  const started = clock.now();
  for (let attempt = 1; ; attempt += 1) {
    const transcript = await runClaude({
      binary,
      args: claudeArgs(config),
      prompt: buildPrompt(config.doc, cursorsBefore, FALLBACK_CURSOR),
      cwd: runDir,
      env,
      timeoutMs: Math.max(1000, budgetMs - (clock.now() - started)),
    });
    try {
      return parseTranscript(transcript, config.doc, cursorsBefore, FALLBACK_CURSOR);
    } catch (error) {
      // Keep the failed session's transcript privately for diagnosis.
      writeFileSync(path.join(runDir, "last-failed-transcript.jsonl"), transcript, { mode: 0o600 });
      const elapsed = clock.now() - started;
      if (error.permanent || attempt >= 2 || elapsed * 2 > budgetMs) throw error;
      log(`check attempt ${attempt} failed (${error.message}); retrying once`);
    }
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
  let store;
  try {
    store = new SourceStore(stateRoot(env), sourceId, config.doc);
  } catch (error) {
    if (error instanceof StateError) return failure(requestId, "unavailable", false, error.message);
    throw error;
  }

  // A retry of the request that produced the pending result replays it.
  let replay = null;
  let state = store.update((current) => {
    if (current.pending && current.pending.request_id === requestId) {
      replay = current.pending.output;
      return null;
    }
    if (current.pending) {
      log("discarding a pending result the host never confirmed; its comments will be read again");
      return { ...current, pending: null, due_now: true };
    }
    return null;
  });
  if (replay !== null) return success(requestId, { status: "result", output: replay });

  // Wait inside the bounded poll for the next scheduled check, then give up
  // quietly so the host's next reconcile starts another bounded wait.
  let due = dueAt(state, config);
  if (clock.now() < due) {
    const pause = Math.min(due - clock.now(), config.wait * 1000);
    if (pause > 0) await clock.sleep(pause);
    state = store.read();
    due = dueAt(state, config);
    if (clock.now() < due) return success(requestId, NO_RESULT);
  }

  const cursorsBefore = { ...state.cursors };
  const checkedAt = new Date(clock.now()).toISOString();
  let parsed;
  try {
    parsed = await checkOnce(config, cursorsBefore, env, clock);
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    const after = store.update((current) => ({ ...current, failures: current.failures + 1, last_check_at: clock.now(), due_now: false }));
    log(`check failed (${after.failures} in a row): ${error.message}`);
    if (error.permanent || after.failures % config.failures === 0) {
      return failure(requestId, "unavailable", !error.permanent, `${after.failures} failed check(s) in a row; last: ${error.message}`);
    }
    return success(requestId, NO_RESULT);
  }

  const built = buildResult({
    sourceId,
    requestId,
    doc: config.doc,
    parsed,
    cursorsBefore,
    fallback: FALLBACK_CURSOR,
    authors: config.authors,
    checkedAt,
    recordOnly: !state.initialized && config.start === "latest",
  });
  store.update((current) => {
    const next = { ...current, initialized: true, failures: 0, last_check_at: clock.now(), due_now: built.more };
    if (built.announced) {
      next.pending = { request_id: requestId, output: built.output, cursors_after: built.cursorsAfter, created_at: checkedAt };
    } else {
      next.cursors = built.cursorsAfter;
    }
    return next;
  });
  if (parsed.uncheckedTabs.length > 0) log(`tabs not checked this round: ${parsed.uncheckedTabs.join(", ")}`);
  return success(requestId, built.announced ? { status: "result", output: built.output } : NO_RESULT);
}

// Advance the cursors when the host presents back the exact pending output.
export function commitCaptured(input, env = process.env) {
  const result = parseResult(input.content);
  if (!result || result.source_id !== input.source_id || typeof result.doc?.id !== "string") return result;
  try {
    const store = new SourceStore(stateRoot(env), input.source_id, result.doc.id);
    store.update((state) => {
      const pending = state.pending;
      if (!pending || pending.request_id !== result.request_id || pending.output !== input.content) return null;
      return { ...state, cursors: { ...state.cursors, ...pending.cursors_after }, pending: null };
    });
  } catch (error) {
    log(`could not record the captured result: ${error.message}`);
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
  return success(request.request_id, { value: Boolean(result && Array.isArray(result.rows) && result.rows.length === 0) });
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
