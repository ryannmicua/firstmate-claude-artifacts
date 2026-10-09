#!/usr/bin/env node
// watch-claim: advisory per-page watch claims for Claude artifact watchers.
// Run with --help for usage.

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

const SCHEMA = "firstmate-claude-artifacts.watch-claim.v1";
const DIR_NAME = "fca-watch-claims";
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PAGE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9]{22})$/;
const LOCK_WAIT_MS = 10000;
const EXIT_REFUSED = 3;

const HELP = `watch-claim: advisory per-page watch claims for Claude artifact watchers

Usage:
  watch-claim.mjs claim <page>... [--task <id>] [--home <dir>]
  watch-claim.mjs release <page>... [--task <id>] [--home <dir>]
  watch-claim.mjs release-task [--task <id>] [--home <dir>]
  watch-claim.mjs check <page> [--task <id>] [--home <dir>]
  watch-claim.mjs list [--home <dir>]
  watch-claim.mjs sweep [--home <dir>]

<page> is a claude.ai artifact or doc link (claude.ai/artifact/<id>,
claude.ai/code/artifact/[<title>-]<id>) or the bare id. A page can be known
by two ids (a doc's UUID and its 22-character watch id); pass every id you
know in one claim so they are taken together or not at all.

claim         Take the page(s) for the task. Same task again: kept (a relaunch
              keeps its claim). Another live task holds it: refused, exit 3,
              and the caller must not publish or watch that page. A holder
              whose task no longer exists in the home is stale: taken over.
release       Drop the task's claim on the page(s). A claim held by another
              task is not touched (exit 3).
release-task  Drop every claim the task holds (run at task cleanup).
check         Report the holder; exit 3 when another live task holds it.
list          Show every claim: page, holder, live or stale, since.
sweep         Remove claims whose task no longer exists.

Task: --task, else FM_TASK_ID. Home: --home, else FM_HOME, else the home that
contains FM_TASK_INBOX (<home>/state/<task>.inbox). State directory:
FM_STATE_OVERRIDE when set, else <home>/state. A task is live while
<state>/<task>.meta exists. Claims live in <state>/${DIR_NAME}/.

Claims are advisory. They bind only sessions that run this check before they
publish or watch: the captain's own sessions, other tools, and other Firstmate
homes do not see or honor them.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--task" || arg === "--home") {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

export function pageKey(input) {
  let value = String(input || "").trim();
  const url = value.match(/^https:\/\/(?:preview\.)?claude\.ai\/(?:code\/)?artifact\/([^/?#]+)\/?(?:[?#].*)?$/);
  if (url) value = url[1];
  const tail = value.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9]{22})$/);
  if (tail && (tail[1] === value || value.endsWith(`-${tail[1]}`))) value = tail[1];
  if (!PAGE_ID.test(value)) throw new UsageError(`not a claude.ai artifact or doc link or id: ${input}`);
  return value;
}

function resolveTask(options, env) {
  const task = options.task || env.FM_TASK_ID || "";
  if (!TASK_ID.test(task)) throw new UsageError("no task id: pass --task or set FM_TASK_ID");
  return task;
}

function resolveState(options, env) {
  if (env.FM_STATE_OVERRIDE && !options.home) return path.resolve(env.FM_STATE_OVERRIDE);
  let home = options.home || env.FM_HOME || "";
  if (!home && env.FM_TASK_INBOX) home = path.dirname(path.dirname(path.resolve(env.FM_TASK_INBOX)));
  if (!home) throw new UsageError("no Firstmate home: pass --home, or set FM_HOME or FM_TASK_INBOX");
  const state = path.join(path.resolve(home), "state");
  if (!existsSync(state) || !statSync(state).isDirectory()) throw new UsageError(`not a Firstmate home (no state directory): ${home}`);
  return state;
}

function taskLive(state, task) {
  return existsSync(path.join(state, `${task}.meta`));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// One home-local lock serializes every claim mutation. A lock whose recorded
// process is gone is stale and removed.
function withLock(dir, fn) {
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const fd = openSync(path.join(lock, "pid"), "w", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = 0;
      try {
        holder = Number(readFileSync(path.join(lock, "pid"), "utf8"));
      } catch {}
      const age = (() => {
        try {
          return Date.now() - lstatSync(lock).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if ((holder > 0 && !pidAlive(holder)) || (holder === 0 && age > 5000)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`claims are locked by process ${holder || "unknown"}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function claimsDir(state) {
  const dir = path.join(state, DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function claimFile(dir, key) {
  return path.join(dir, `${key}.json`);
}

function readClaim(file) {
  try {
    const claim = JSON.parse(readFileSync(file, "utf8"));
    if (claim?.schema === SCHEMA && typeof claim.page === "string" && typeof claim.task === "string") return claim;
  } catch (error) {
    if (error.code === "ENOENT") return null;
  }
  return { schema: SCHEMA, page: path.basename(file, ".json"), task: "", claimed_at: "", corrupt: true };
}

function writeClaim(file, claim) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(claim)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function allClaims(dir) {
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => readClaim(path.join(dir, name))).filter(Boolean);
}

export function run(argv, env = process.env, out = (line) => process.stdout.write(`${line}\n`)) {
  const command = argv[0] || "";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const { positional, options } = parseArgs(argv.slice(1));
  const state = resolveState(options, env);
  const dir = claimsDir(state);
  const now = new Date().toISOString();

  switch (command) {
    case "claim": {
      if (positional.length === 0) throw new UsageError("claim needs at least one page");
      const task = resolveTask(options, env);
      const keys = [...new Set(positional.map(pageKey))];
      return withLock(dir, () => {
        const plans = keys.map((key) => ({ key, file: claimFile(dir, key), current: readClaim(claimFile(dir, key)) }));
        const blocked = plans.filter((plan) => plan.current && plan.current.task !== task && !plan.current.corrupt && taskLive(state, plan.current.task));
        if (blocked.length > 0) {
          for (const plan of blocked) out(`refused: ${plan.key} is held by live task ${plan.current.task} since ${plan.current.claimed_at}; do not publish or watch it`);
          return EXIT_REFUSED;
        }
        for (const plan of plans) {
          if (plan.current && plan.current.task === task) {
            out(`kept: ${plan.key} by ${task} since ${plan.current.claimed_at}`);
            continue;
          }
          writeClaim(plan.file, { schema: SCHEMA, page: plan.key, task, claimed_at: now });
          if (plan.current) out(`taken-over: ${plan.key} by ${task} from stale holder ${plan.current.task || "(unreadable claim)"}`);
          else out(`claimed: ${plan.key} by ${task}`);
        }
        return 0;
      });
    }
    case "release": {
      if (positional.length === 0) throw new UsageError("release needs at least one page");
      const task = resolveTask(options, env);
      return withLock(dir, () => {
        let status = 0;
        for (const key of new Set(positional.map(pageKey))) {
          const file = claimFile(dir, key);
          const current = readClaim(file);
          if (!current) out(`not-held: ${key}`);
          else if (current.task === task) {
            unlinkSync(file);
            out(`released: ${key} by ${task}`);
          } else {
            out(`refused: ${key} is held by ${current.task || "(unreadable claim)"}, not ${task}`);
            status = EXIT_REFUSED;
          }
        }
        return status;
      });
    }
    case "release-task": {
      const task = resolveTask(options, env);
      return withLock(dir, () => {
        let count = 0;
        for (const claim of allClaims(dir)) {
          if (claim.task !== task) continue;
          unlinkSync(claimFile(dir, claim.page));
          out(`released: ${claim.page} by ${task}`);
          count += 1;
        }
        if (count === 0) out(`none: ${task} holds no claims`);
        return 0;
      });
    }
    case "check": {
      if (positional.length !== 1) throw new UsageError("check needs exactly one page");
      const task = resolveTask(options, env);
      const key = pageKey(positional[0]);
      const current = readClaim(claimFile(dir, key));
      if (!current) {
        out(`free: ${key}`);
        return 0;
      }
      if (current.task === task) {
        out(`held-by-you: ${key} by ${task} since ${current.claimed_at}`);
        return 0;
      }
      if (!current.corrupt && taskLive(state, current.task)) {
        out(`held: ${key} by live task ${current.task} since ${current.claimed_at}`);
        return EXIT_REFUSED;
      }
      out(`stale: ${key} held by ${current.task || "(unreadable claim)"}, which no longer exists; claim takes it over`);
      return 0;
    }
    case "list": {
      const claims = allClaims(dir);
      if (claims.length === 0) {
        out("no claims");
        return 0;
      }
      out("page\tholder\tstate\tsince");
      for (const claim of claims) {
        const live = !claim.corrupt && taskLive(state, claim.task);
        out(`${claim.page}\t${claim.task || "(unreadable)"}\t${live ? "live" : "stale"}\t${claim.claimed_at || "-"}`);
      }
      return 0;
    }
    case "sweep": {
      return withLock(dir, () => {
        let count = 0;
        for (const claim of allClaims(dir)) {
          if (!claim.corrupt && taskLive(state, claim.task)) continue;
          unlinkSync(claimFile(dir, claim.page));
          out(`swept: ${claim.page} from ${claim.task || "(unreadable claim)"}`);
          count += 1;
        }
        if (count === 0) out("none: no stale claims");
        return 0;
      });
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}; run with --help`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`watch-claim: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
