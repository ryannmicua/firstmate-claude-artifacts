// Source configuration reference parsing.
//
// A source configuration reference names one Claude Doc and optional settings:
//
//   doc:<doc-id>[?key=value[&key=value...]]
//
// It is stored in Firstmate's private registration and sent in every request,
// so it must stay non-secret and at most 512 bytes. Every value is validated
// here; nothing from it reaches a shell.

import path from "node:path";

export const DEFAULTS = Object.freeze({
  model: "claude-haiku-5-5",
  every: 300,
  wait: 50,
  timeout: 120,
  budget: 0.05,
  start: "all",
  authors: "people",
  failures: 3,
  claude: "",
});

const LIMITS = Object.freeze({
  every: [30, 86400],
  wait: [0, 240],
  timeout: [10, 900],
  failures: [1, 100],
});

const DOC_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9]{22})$/;
const MODEL = /^[a-z0-9][a-z0-9.\-]{1,63}$/;
const KEYS = new Set(Object.keys(DEFAULTS));

export class ConfigError extends Error {}

function integer(key, raw) {
  if (!/^[0-9]{1,6}$/.test(raw)) throw new ConfigError(`${key} must be a whole number of seconds`);
  const value = Number(raw);
  const [min, max] = LIMITS[key];
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}`);
  return value;
}

export function parseConfigRef(reference) {
  if (typeof reference !== "string" || reference.length === 0) throw new ConfigError("config_ref must be a non-empty string");
  if (Buffer.byteLength(reference, "utf8") > 512) throw new ConfigError("config_ref must be at most 512 bytes");
  if (!reference.startsWith("doc:")) throw new ConfigError("config_ref must start with doc:");
  const [docPart, query = "", ...extra] = reference.slice(4).split("?");
  if (extra.length > 0) throw new ConfigError("config_ref has more than one ?");
  if (!DOC_ID.test(docPart)) throw new ConfigError("doc id must be a Claude Doc UUID or 22-character artifact id");
  const config = { doc: docPart, ...DEFAULTS };
  const seen = new Set();
  if (query !== "") {
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new ConfigError(`setting "${pair}" must have the form key=value`);
      const key = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      if (!KEYS.has(key)) throw new ConfigError(`unknown setting ${key}`);
      if (seen.has(key)) throw new ConfigError(`setting ${key} appears twice`);
      seen.add(key);
      switch (key) {
        case "model":
          if (!MODEL.test(raw)) throw new ConfigError("model must be a model id such as claude-haiku-5-5");
          config.model = raw;
          break;
        case "every":
        case "wait":
        case "timeout":
        case "failures":
          config[key] = integer(key, raw);
          break;
        case "budget":
          if (!/^[0-9]{1,2}(?:\.[0-9]{1,4})?$/.test(raw) || Number(raw) <= 0 || Number(raw) > 5) {
            throw new ConfigError("budget must be a dollar amount above 0 and at most 5");
          }
          config.budget = Number(raw);
          break;
        case "start":
          if (raw !== "all" && raw !== "latest") throw new ConfigError("start must be all or latest");
          config.start = raw;
          break;
        case "authors":
          if (raw !== "people" && raw !== "all") throw new ConfigError("authors must be people or all");
          config.authors = raw;
          break;
        case "claude":
          if (!path.isAbsolute(raw) || path.normalize(raw) !== raw || /[\0\n\r]/.test(raw)) {
            throw new ConfigError("claude must be a normalized absolute path");
          }
          config.claude = raw;
          break;
        default:
          throw new ConfigError(`unknown setting ${key}`);
      }
    }
  }
  return config;
}
