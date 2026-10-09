// Firstmate trusted external process-event adapter protocol, host protocol 1,
// capability process-event-adapter/1. docs/reference/adapter-protocol.md in
// the source repository restates the parts this package relies on; the
// Firstmate repository's docs/extension-bindings.md owns the contract.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST = JSON.parse(readFileSync(path.join(here, "..", "firstmate-extension.json"), "utf8"));
export const EXTENSION_ID = MANIFEST.id;
export const EXTENSION_VERSION = MANIFEST.version;
export const ADAPTER = MANIFEST.capabilities[0].adapter_names[0];
export const CAPABILITY = "process-event-adapter";
export const MAX_REQUEST_BYTES = 65536;
const REQUEST_ID = /^sha256:[0-9a-f]{64}$/;
const SOURCE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const OPERATIONS = new Set(["source.poll", "result.classify", "result.terminal", "result.silent"]);

export class ProtocolError extends Error {
  constructor(message, code = "invalid-request") {
    super(message);
    this.code = code;
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new ProtocolError(`${label} must have exactly the fields ${expected.join(", ")}`);
  }
}

// Strict JSON: one document, no byte-order mark, no duplicate object keys.
export function parseStrictJson(bytes) {
  if (bytes.length > MAX_REQUEST_BYTES) throw new ProtocolError("request is larger than 65536 bytes");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new ProtocolError("request starts with a byte-order mark");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError("request is not valid UTF-8");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("request is not one JSON document");
  }
  rejectDuplicateKeys(text);
  return value;
}

// JSON.parse keeps the last duplicate silently; walk the text to refuse them.
function rejectDuplicateKeys(text) {
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      let k = j + 1;
      while (/\s/.test(text[k] || "")) k += 1;
      const top = stack[stack.length - 1];
      if (text[k] === ":" && top instanceof Set) {
        const key = JSON.parse(raw);
        if (top.has(key)) throw new ProtocolError(`request has a duplicate key ${JSON.stringify(key)}`);
        top.add(key);
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") stack.push(new Set());
    else if (ch === "[") stack.push(null);
    else if (ch === "}" || ch === "]") stack.pop();
    i += 1;
  }
}

export function validateHandshake(request) {
  exactKeys(request, ["schema", "request_id", "host_protocols", "extension_id", "extension_version", "package_digest", "capability"], "handshake request");
  if (request.schema !== "firstmate.extension-handshake-request.v1") throw new ProtocolError("unexpected handshake schema", "incompatible");
  if (typeof request.request_id !== "string" || !REQUEST_ID.test(request.request_id)) throw new ProtocolError("bad request_id");
  if (!Array.isArray(request.host_protocols) || !request.host_protocols.includes(1)) throw new ProtocolError("host protocol 1 is not offered", "incompatible");
  if (request.extension_id !== EXTENSION_ID || request.extension_version !== EXTENSION_VERSION) throw new ProtocolError("extension identity mismatch", "incompatible");
  if (typeof request.package_digest !== "string" || !REQUEST_ID.test(request.package_digest)) throw new ProtocolError("bad package_digest");
  exactKeys(request.capability, ["name", "versions", "adapter_names"], "capability");
  if (request.capability.name !== CAPABILITY) throw new ProtocolError("unsupported capability", "incompatible");
  if (!Array.isArray(request.capability.versions) || !request.capability.versions.includes(1)) throw new ProtocolError("capability version 1 is not offered", "incompatible");
  const names = request.capability.adapter_names;
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => name !== ADAPTER) || new Set(names).size !== names.length) {
    throw new ProtocolError("unknown adapter name", "incompatible");
  }
  return {
    schema: "firstmate.extension-handshake-response.v1",
    request_id: request.request_id,
    extension_id: EXTENSION_ID,
    extension_version: EXTENSION_VERSION,
    host_protocol: 1,
    capability: CAPABILITY,
    capability_version: 1,
    adapter_names: [...names],
  };
}

export function validateInvoke(request) {
  exactKeys(request, ["schema", "request_id", "host_protocol", "extension_id", "extension_version", "package_digest", "capability", "capability_version", "adapter", "operation", "input"], "invocation request");
  if (request.schema !== "firstmate.extension-request.v1") throw new ProtocolError("unexpected request schema", "incompatible");
  if (typeof request.request_id !== "string" || !REQUEST_ID.test(request.request_id)) throw new ProtocolError("bad request_id");
  if (request.host_protocol !== 1) throw new ProtocolError("unsupported host protocol", "incompatible");
  if (request.extension_id !== EXTENSION_ID || request.extension_version !== EXTENSION_VERSION) throw new ProtocolError("extension identity mismatch", "incompatible");
  if (typeof request.package_digest !== "string" || !REQUEST_ID.test(request.package_digest)) throw new ProtocolError("bad package_digest");
  if (request.capability !== CAPABILITY || request.capability_version !== 1) throw new ProtocolError("unsupported capability", "incompatible");
  if (request.adapter !== ADAPTER) throw new ProtocolError("unknown adapter", "incompatible");
  if (!OPERATIONS.has(request.operation)) throw new ProtocolError("unknown operation");
  const input = request.input;
  if (request.operation === "source.poll") {
    exactKeys(input, ["source_id", "config_ref"], "source.poll input");
    if (typeof input.config_ref !== "string") throw new ProtocolError("config_ref must be a string");
  } else {
    exactKeys(input, ["source_id", "sequence", "content"], `${request.operation} input`);
    if (typeof input.content !== "string") throw new ProtocolError("content must be a string");
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new ProtocolError("sequence must be a non-negative integer");
  }
  if (typeof input.source_id !== "string" || !SOURCE_ID.test(input.source_id)) throw new ProtocolError("bad source_id");
  return request;
}

export function success(requestId, result) {
  return { schema: "firstmate.extension-response.v1", request_id: requestId, ok: true, result, error: null };
}

export function failure(requestId, code, retryable, diagnostic) {
  return {
    schema: "firstmate.extension-response.v1",
    request_id: requestId,
    ok: false,
    result: null,
    error: { code, retryable, diagnostic: String(diagnostic).slice(0, 500) },
  };
}
