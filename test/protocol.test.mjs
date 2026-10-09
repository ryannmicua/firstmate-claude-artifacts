// Handshake, envelope, and malformed-input behavior of the entrypoint.

import assert from "node:assert/strict";
import { test } from "node:test";
import { handshakeRequest, invokeRequest, rid, run, sandbox } from "./helpers.mjs";

test("handshake echoes the request id and the enabled adapter subset", () => {
  const out = run("handshake", handshakeRequest());
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(Object.keys(out.json).sort(), ["adapter_names", "capability", "capability_version", "extension_id", "extension_version", "host_protocol", "request_id", "schema"]);
  assert.equal(out.json.schema, "firstmate.extension-handshake-response.v1");
  assert.equal(out.json.request_id, rid("a"));
  assert.equal(out.json.host_protocol, 1);
  assert.equal(out.json.capability, "process-event-adapter");
  assert.equal(out.json.capability_version, 1);
  assert.deepEqual(out.json.adapter_names, ["claude-doc-comments"]);
});

test("handshake accepts a host that also offers later protocol versions", () => {
  const out = run("handshake", handshakeRequest({ host_protocols: [2, 1], capability: { name: "process-event-adapter", versions: [2, 1], adapter_names: ["claude-doc-comments"] } }));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.host_protocol, 1);
});

for (const [name, overrides] of [
  ["a different extension id", { extension_id: "org.example.other" }],
  ["a different version", { extension_version: "9.9.9" }],
  ["no host protocol 1", { host_protocols: [2] }],
  ["an unknown adapter", { capability: { name: "process-event-adapter", versions: [1], adapter_names: ["other"] } }],
  ["an unknown capability", { capability: { name: "lifecycle-sink", versions: [1], adapter_names: ["claude-doc-comments"] } }],
  ["an extra field", { extra: true }],
  ["a malformed request id", { request_id: "abc" }],
]) {
  test(`handshake refuses ${name}`, () => {
    const out = run("handshake", handshakeRequest(overrides));
    assert.equal(out.status, 1);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /handshake refused/);
  });
}

for (const [name, raw] of [
  ["a byte-order mark", `﻿${JSON.stringify(handshakeRequest())}`],
  ["trailing bytes", `${JSON.stringify(handshakeRequest())} {}`],
  ["two documents", `${JSON.stringify(handshakeRequest())}\n${JSON.stringify(handshakeRequest())}`],
  ["a duplicate key", JSON.stringify(handshakeRequest()).replace("{", `{"schema":"x",`)],
  ["non-JSON", "hello"],
  ["an oversized body", JSON.stringify({ ...handshakeRequest(), pad: "x".repeat(70000) })],
]) {
  test(`malformed input with ${name} is refused without a response`, () => {
    const out = run("handshake", raw, { raw: true });
    assert.equal(out.status, 1);
    assert.equal(out.stdout, "");
  });
}

test("invalid UTF-8 is refused", () => {
  const out = run("handshake", Buffer.from([0x7b, 0xff, 0x7d]), { raw: true });
  assert.equal(out.status, 1);
  assert.equal(out.stdout, "");
});

test("an invocation without a usable request id gets no envelope", () => {
  const request = invokeRequest("source.poll", { source_id: "s", config_ref: "doc:x" });
  delete request.request_id;
  const out = run("invoke", request);
  assert.equal(out.status, 1);
  assert.equal(out.stdout, "");
});

test("envelope errors are typed failures that echo the request id", () => {
  const cases = [
    [invokeRequest("source.poll", { source_id: "s", config_ref: "doc:x" }, { capability_version: 2 }), "incompatible"],
    [invokeRequest("source.poll", { source_id: "s", config_ref: "doc:x" }, { adapter: "other" }), "incompatible"],
    [invokeRequest("source.delete", { source_id: "s" }), "invalid-request"],
    [invokeRequest("source.poll", { source_id: "s" }), "invalid-request"],
    [invokeRequest("source.poll", { source_id: "s", config_ref: "doc:x", extra: 1 }), "invalid-request"],
    [invokeRequest("source.poll", { source_id: "bad id with spaces", config_ref: "doc:x" }), "invalid-request"],
    [invokeRequest("result.silent", { source_id: "s", sequence: -1, content: "x" }), "invalid-request"],
    [{ ...invokeRequest("source.poll", { source_id: "s", config_ref: "doc:x" }), extra: 1 }, "invalid-request"],
  ];
  for (const [request, code] of cases) {
    const out = run("invoke", request);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(Object.keys(out.json).sort(), ["error", "ok", "request_id", "result", "schema"]);
    assert.equal(out.json.schema, "firstmate.extension-response.v1");
    assert.equal(out.json.request_id, request.request_id);
    assert.equal(out.json.ok, false);
    assert.equal(out.json.result, null);
    assert.equal(out.json.error.code, code, JSON.stringify(out.json));
    assert.deepEqual(Object.keys(out.json.error).sort(), ["code", "diagnostic", "retryable"]);
  }
});

test("a bad config_ref is a non-retryable invalid request", () => {
  const box = sandbox();
  const out = run("invoke", invokeRequest("source.poll", { source_id: "s", config_ref: "doc:not-a-doc" }), { env: { FIRSTMATE_EXTENSION_STATE: box.state } });
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error.code, "invalid-request");
  assert.equal(out.json.error.retryable, false);
});

test("a poll without the host's state directory is unavailable", () => {
  const box = sandbox();
  const out = run("invoke", invokeRequest("source.poll", { source_id: "s", config_ref: box.configRef() }));
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error.code, "unavailable");
});

test("--help, --version, and validate-config work without a request", () => {
  const help = run("--help", "", { raw: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /doc:<doc-id>/);
  assert.match(help.stdout, /credential-store/);
  const version = run("--version", "", { raw: true });
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  const bad = run("validate-config", "", { raw: true });
  assert.equal(bad.status, 2);
});
