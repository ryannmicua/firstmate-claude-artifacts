// Durable per-source state under the host-provided extension state directory.
//
// One JSON file per (source id, doc id) holds the committed per-tab cursors,
// the check schedule, the failure count, and at most one pending result that
// has been returned to the host but not yet proved captured. Writes are
// atomic (temporary file, fsync, rename) and serialized by a directory lock,
// so a crash leaves either the old or the new state, never a torn one.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";

export const STATE_SCHEMA = "firstmate-claude-artifacts.source-state.v1";
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 5 * 60 * 1000;

export class StateError extends Error {}

export function stateRoot(env = process.env) {
  const root = env.FIRSTMATE_EXTENSION_STATE;
  if (!root || !path.isAbsolute(root)) throw new StateError("FIRSTMATE_EXTENSION_STATE is not set to an absolute directory");
  return root;
}

function sourcesDir(root) {
  const dir = path.join(root, "sources");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateKey(sourceId, doc) {
  return createHash("sha256").update(`${sourceId}\n${doc}`).digest("hex").slice(0, 32);
}

export function freshState(sourceId, doc) {
  return {
    schema: STATE_SCHEMA,
    source_id: sourceId,
    doc,
    initialized: false,
    cursors: {},
    last_check_at: 0,
    due_now: false,
    failures: 0,
    pending: null,
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new StateError("source state is locked by another invocation");
      sleepSync(50);
    }
  }
}

export class SourceStore {
  constructor(root, sourceId, doc) {
    this.dir = sourcesDir(root);
    this.sourceId = sourceId;
    this.doc = doc;
    const key = stateKey(sourceId, doc);
    this.file = path.join(this.dir, `${key}.json`);
    this.lock = path.join(this.dir, `${key}.lock`);
  }

  // Run fn(state) under the lock; when it returns a state object, persist it.
  update(fn) {
    acquire(this.lock);
    try {
      const state = this.read();
      const next = fn(state);
      if (next) this.write(next);
      return next ?? state;
    } finally {
      rmSync(this.lock, { recursive: true, force: true });
    }
  }

  read() {
    let text;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return freshState(this.sourceId, this.doc);
      throw error;
    }
    const state = JSON.parse(text);
    if (state?.schema !== STATE_SCHEMA || state.source_id !== this.sourceId || state.doc !== this.doc) {
      throw new StateError(`state file ${this.file} does not belong to this source`);
    }
    return state;
  }

  write(state) {
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
    const dirFd = openSync(this.dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}
