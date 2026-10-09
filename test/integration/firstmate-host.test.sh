#!/usr/bin/env bash
# Opt-in integration test against a real Firstmate checkout's extension host.
# It binds the staged package into a throwaway FM_HOME, registers a source
# whose config points at the fake claude, and drives the generic runner:
# capture and wake of new comments, cursor commit after capture, silence on an
# empty check, and retirement. No network or Claude login is used.
#
# Usage: FIRSTMATE_ROOT=/path/to/firstmate test/integration/firstmate-host.test.sh
set -eu
umask 077

if [ -z "${FIRSTMATE_ROOT:-}" ]; then
  echo "skip: set FIRSTMATE_ROOT to a Firstmate checkout to run this test"
  exit 0
fi
REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
HOST="$FIRSTMATE_ROOT/bin/fm-extension.sh"
PROCEVENT="$FIRSTMATE_ROOT/bin/fm-procevent.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fca-host.XXXXXX")
if git -C "$TMP" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  rm -rf "$TMP"
  echo "FAIL: $TMP is inside a Git work tree, where Firstmate refuses to bind; set TMPDIR to a directory outside any Git work tree" >&2
  exit 1
fi
cleanup() {
  FM_HOME="$TMP/home" "$PROCEVENT" sweep-home >/dev/null 2>&1 || true
  chmod -R u+w "$TMP" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
export FM_HOME="$TMP/home" FM_PROCEVENT_CLAIM_ROOT="$TMP/claims"
mkdir -p "$FM_HOME"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

DOC=123e4567-e89b-42d3-a456-426614174000
"$REPO/scripts/stage-package.sh" "$TMP/pkg/claude-doc-comments" >/dev/null
mkdir -p "$TMP/fake"
cp "$REPO/test/fixtures/fake-claude.mjs" "$TMP/fake/claude"
chmod 0755 "$TMP/fake/claude"
write_scenario() {  # <rows-json>
  cat > "$TMP/fake/scenario.json" <<JSON
{"doc":"$DOC","title":"Invented picnic plan","tabs":[{"id":"aaaa1111-0001","name":"Plan"}],"rows":$1,"mode":"ok"}
JSON
}
row() {  # <seq> <id> <body>
  printf '{"tab":"aaaa1111-0001","seq":%s,"at":"2026-01-02T03:04:05.000Z","verb":"create","id":"%s","actor":{"principal":"u_invented","via":"web","self":true,"name":"Pat Example"},"payload":{"value":{"body":"%s","parent":{"object":"node","id":"aaaa1111-0001-body"}}}}' "$1" "$2" "$3"
}

bind_out=$("$HOST" bind "$TMP/pkg/claude-doc-comments" --adapter claude-doc-comments --trust-same-user-code \
  --consent network --consent credential-store --consent artifact-references)
binding_digest=$(printf '%s\n' "$bind_out" | sed -n 's/^binding-digest: //p')
case "$binding_digest" in sha256:*) ;; *) fail "bind printed no binding digest: $bind_out" ;; esac
"$HOST" verify io.github.ryannmicua.firstmate-claude-artifacts | grep -q "verified" || fail "verify did not pass"
pass "the staged package binds with network, credential-store, and artifact-references consents"

write_scenario "[$(row 5 c0000001-0001 'Invented comment one')]"
reg=$("$PROCEVENT" register-extension claude-doc-comments picnic-review --config-ref "doc:$DOC?wait=0&every=30&claude=$TMP/fake/claude")
token=$(printf '%s\n' "$reg" | sed -n 's/^owner-token: //p')
[ -n "$token" ] || fail "register-extension printed no owner token"
"$PROCEVENT" start picnic-review >/dev/null
result=$(ls "$FM_HOME/state/procevent-inbox/"picnic-review.*.result 2>/dev/null | head -1)
[ -n "$result" ] || fail "new comments were not captured"
grep -q '"Invented comment one"' "$result" || fail "captured result lacks the comment body"
grep -q 'UNTRUSTED CONTENT' "$result" || fail "captured result lacks the untrusted-content notice"
awk -F '\t' '{print $5}' "$FM_HOME/state/.wake-queue" | grep -q "procevent claude-doc-comments picnic-review" || fail "no wake was queued"
pass "new comments are captured as one announced result and queue a wake"

classification=$("$PROCEVENT" classify "$result")
printf '%s\n' "$classification" | grep -q "claude-doc-comments" || fail "classify did not return claude-doc-comments: $classification"
state_file=$(ls "$FM_HOME/state/extensions/io.github.ryannmicua.firstmate-claude-artifacts/sources/"*.json)
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (s.pending!==null || s.cursors["aaaa1111-0001"]!==5) process.exit(1)' "$state_file" \
  || fail "the cursor did not advance after the host confirmed capture"
[ -e "$FM_HOME/state/procevent/picnic-review.source" ] || fail "a nonterminal source was retired"
pass "capture confirmation commits the cursor and the source stays registered"

seq_no=$(basename "$result" | sed 's/^picnic-review\.\([0-9]*\)\.result$/\1/')
"$PROCEVENT" handled picnic-review "$seq_no" >/dev/null
node -e 'const f=process.argv[1],fs=require("fs"); const s=JSON.parse(fs.readFileSync(f,"utf8")); s.last_check_at=0; fs.writeFileSync(f, JSON.stringify(s))' "$state_file"
before=$(ls "$FM_HOME/state/procevent-inbox/" | grep -c '\.result$')
"$PROCEVENT" start picnic-review >/dev/null
after=$(ls "$FM_HOME/state/procevent-inbox/" | grep -c '\.result$')
[ "$before" = "$after" ] || fail "an empty check captured a result"
pass "a check with no newer comments captures nothing and stays silent"

write_scenario "[$(row 5 c0000001-0001 'Invented comment one'),$(row 9 c0000002-0002 'Invented comment two')]"
node -e 'const f=process.argv[1],fs=require("fs"); const s=JSON.parse(fs.readFileSync(f,"utf8")); s.last_check_at=0; fs.writeFileSync(f, JSON.stringify(s))' "$state_file"
"$PROCEVENT" start picnic-review >/dev/null
second=$(ls -t "$FM_HOME/state/procevent-inbox/"picnic-review.*.result | head -1)
grep -q '"Invented comment two"' "$second" || fail "the second round lacks the new comment"
if grep -q '"Invented comment one"' "$second"; then fail "the second round repeated an already-captured comment"; fi
pass "only comments newer than the durable cursor are announced"

"$PROCEVENT" handled picnic-review "$(basename "$second" | sed 's/^picnic-review\.\([0-9]*\)\.result$/\1/')" >/dev/null
"$PROCEVENT" retire picnic-review --if-owner "$token" >/dev/null
"$HOST" retire-binding io.github.ryannmicua.firstmate-claude-artifacts --if-binding-digest "$binding_digest" >/dev/null
"$HOST" list | grep -q "io.github.ryannmicua" && fail "the binding is still listed after retirement"
pass "the source and binding retire cleanly"
shopt -s nullglob
launch_records=("$FM_HOME/state/procevent/picnic-review."*.last-launch)
handled_records=("$FM_HOME/state/procevent-inbox/picnic-review."*.handled)
[ "${#launch_records[@]}" -gt 0 ] || fail "source retirement removed its launch records"
[ "${#handled_records[@]}" -gt 0 ] || fail "source retirement removed its handled inbox state"
pass "retirement preserves ${#launch_records[@]} launch record(s) and ${#handled_records[@]} handled result(s)"
