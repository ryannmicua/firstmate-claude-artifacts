#!/usr/bin/env bash
# Opt-in live check: one real poll of a Claude Doc through the adapter
# entrypoint, using the real `claude` and the operator's Claude login. It costs
# one short model session (about a cent or less) and prints only counts and
# cursors, never comment text.
#
# Usage: FCA_LIVE_DOC=<doc-id> [FCA_LIVE_MODEL=<model>] [FCA_LIVE_CLAUDE=/abs/claude] test/live/live-check.sh
set -eu

if [ -z "${FCA_LIVE_DOC:-}" ]; then
  echo "skip: set FCA_LIVE_DOC to the id of a Claude Doc you own (use invented content) to run the live check"
  exit 0
fi
REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
STATE=$(mktemp -d "${TMPDIR:-/tmp}/fca-live.XXXXXX")
trap 'rm -rf "$STATE"' EXIT
chmod 0700 "$STATE"
config="doc:$FCA_LIVE_DOC?wait=0&authors=all"
[ -z "${FCA_LIVE_MODEL:-}" ] || config="$config&model=$FCA_LIVE_MODEL"
[ -z "${FCA_LIVE_CLAUDE:-}" ] || config="$config&claude=$FCA_LIVE_CLAUDE"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO/package/firstmate-extension.json")
hex=$(printf 'f%.0s' $(seq 1 64))
request=$(printf '{"schema":"firstmate.extension-request.v1","request_id":"sha256:%s","host_protocol":1,"extension_id":"io.github.ryannmicua.firstmate-claude-artifacts","extension_version":"%s","package_digest":"sha256:%s","capability":"process-event-adapter","capability_version":1,"adapter":"claude-doc-comments","operation":"source.poll","input":{"source_id":"live-check","config_ref":"%s"}}' "$hex" "$version" "$hex" "$config")

started=$(date +%s)
response=$(printf '%s' "$request" | env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" LANG=C LC_ALL=C HOME="$HOME" \
  FIRSTMATE_EXTENSION_STATE="$STATE" "$REPO/package/bin/claude-doc-comments" invoke)
elapsed=$(( $(date +%s) - started ))
printf '%s' "$response" | node -e '
  let text = "";
  process.stdin.on("data", (c) => { text += c; }).on("end", () => {
    const r = JSON.parse(text);
    if (!r.ok) { console.error(`FAIL: ${r.error.code}: ${r.error.diagnostic}`); process.exit(1); }
    if (r.result.status === "no-result") {
      console.log(`ok - live poll completed with no new comments in ${process.argv[1]}s`);
      return;
    }
    const out = JSON.parse(r.result.output);
    if (!out.notice.startsWith("UNTRUSTED CONTENT")) { console.error("FAIL: result lacks the untrusted notice"); process.exit(1); }
    console.log(`ok - live poll returned ${out.rows.length} row(s) across ${out.doc.tabs.length} tab(s) in ${process.argv[1]}s; cursors ${JSON.stringify(out.cursors.after)}`);
  });
' "$elapsed"
if [ -s "$STATE/run/last-failed-transcript.jsonl" ]; then
  echo "note: one session attempt failed and was retried"
fi
