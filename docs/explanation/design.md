# Explanation: how Claude review surfaces fit Firstmate

## The problem

Lavish works with Firstmate because a script can read it: the Lavish server holds a submitted batch of comments, a Firstmate process-event source holds a blocking poll, saves the result durably, and queues a wake, and the owning agent reads the saved batch.
Comments on claude.ai artifacts and Claude Docs can be read only through a Claude session's own tools, so no plain script can play the poll's part.
This add-on replaces the script with a Claude session in the one place that needs it, and keeps everything else in Firstmate's existing machinery.

## Two ways to watch

**The periodic check** is a Firstmate process-event adapter.
Firstmate supervises it exactly like a built-in source: it runs the poll outside any conversation, captures a non-empty result durably, wakes the owning agent, and keeps re-announcing it until it is handled.
Only the comment read itself is a model call: a short `claude -p` session on the cheapest model, about five to ten seconds and a fraction of a cent per check.
It covers Claude Docs, because print-mode sessions have the Claude Docs connector but not the artifact comments tool.

**The watching worker** is a dedicated Claude Code worker that owns one page.
It is the only way to cover plain artifact pages, and the way to answer reviewers in the thread soon after they comment.
It runs the [watcher skill](../../skills/claude-artifact-watcher/SKILL.md), which tells it to claim the page, publish it, confirm the watch, catch up, re-read on a timer, answer within its brief, and relay everything else to Firstmate as status lines, because status lines survive the worker.

## Why a process-event adapter

Firstmate's only add-on mechanism is the trusted external process-event adapter: a separately installed package that Firstmate binds per home, content-addresses, and invokes with a strict JSON envelope.
Building to it means the add-on installs and upgrades independently of any Firstmate instance, and Firstmate keeps source ownership, durable capture, announcement, handling, and retirement.
The package uses Node.js because the host itself runs on Node.js and puts the Node binary on the adapter's otherwise minimal `PATH`; the package has no dependencies beyond the standard library.

## Trusting the model as little as possible

The check session is a transport, not a judge.
It runs with no built-in tools, user settings, user hooks, or skills, and only the read-only Claude Docs `read` and `query` tools; the write tools are explicitly denied. Its own per-run settings add the scope hook described below.
A per-run settings hook checks every tool call before execution, explicitly allowing only those two tools and configured document or query container IDs. Both ID forms are allowed only when explicitly grouped in that list. The Docs tools have no broad preapproval, and `dontAsk` denies calls when the hook fails or times out without a decision.
The adapter then reads the raw tool results from the session's stream-json transcript and builds every row itself.
A query result counts only when its recorded input names a configured doc and one of its tabs, uses project container kind, sets `afterSeq` exactly to that tab's committed cursor (0 for a new tab), and uses the prescribed limit of 100. A mismatch leaves the tab unchecked, so a confused model can at worst fail the check; it cannot silently skip rows, invent, hide, or reorder them.
These checks apply to the periodic comment-check session only; a watching worker may read or combine docs according to its own task.

Comment text is untrusted twice over: the session's prompt says so, and the result presents it as JSON string data under a fixed notice, with control characters replaced and invisible or direction-changing characters made visible.

## At least once, never silently lost

Each configured doc has its own durable state file, and each tab has a durable cursor: the highest comment sequence number already delivered.
A poll that finds new rows stores its exact output as pending, keyed by Firstmate's request id, and returns it.
Firstmate retries a poll that it could not capture with the same request id, and the adapter replays the pending output without another check.
After capture, Firstmate asks the adapter whether the result is silent and whether it ends the source, presenting the captured output back; only that exact output advances the cursor.
If that confirmation never arrives, the next poll discards the pending output and reads the same comments again.
So a comment can be announced twice after a crash, but is never skipped.

An empty check returns no result, so nothing is captured and no one is woken, the same contract the Lavish source follows when no batch is waiting.
Comments written through the Claude Docs connector, which is how agents and watching workers reply, are skipped by default, so a reply never wakes its own author.
Comments written in the claude.ai editor carry `via: "frame"` and are always kept.

## Cadence inside a bounded poll

Firstmate restarts an ended poll on its ordinary reconcile cycle, and a poll must finish within the binding's timeout.
So each poll waits at most `wait` seconds for its source's next scheduled check (`every`), and returns no result if the check is not due by then.
A check that fails stays quiet until `failures` checks in a row have failed, then becomes an error result the owner sees; a doc that refuses the read is reported at once. If another configured doc has comments to announce in that poll, the result also includes an error for every failed doc. Only successful docs receive pending cursors, so failed docs retain their prior cursors.

## Automatic replies, tested

Claude Code arms automatic replies on a page that a session publishes: when a reviewer sends a comment to Claude, Claude Code's own replier answers it and resolves the thread, and the session sees only a notification afterwards.
The captain asked how to turn that off so the watching worker writes every reply.

Tested on Claude Code 2.1.295 with invented-content pages and a human "Send to Claude":

| Session setup | Automatic reply | Comment arrives as a turn | Other effects |
| --- | --- | --- | --- |
| Default (earlier probe) | Yes, and the thread is resolved | No; a notification after the fact | |
| `CLAUDE_CODE_ARTIFACT_COMMENTS_AUTOREACT=0` | No | No | Watch shows "connected, armed by a publish" without "auto-replies armed"; the thread stays "awaiting reply" |
| Permission rule `ask: ["ArtifactComments"]` (documented control) | No | No | Every ArtifactComments call, including the worker's own reads and replies, stops at a Yes/No dialog, even in bypass mode |

The binary reads the variable as a three-state switch over a server-side flag, so `0` or `false` forces automatic replies off.
It is undocumented and could change in any release.
Because it also stops delivery, the watcher re-reads threads on a timer (every five minutes by default) instead of waiting for a turn; the permission rule is unusable for an unattended worker.

One more observation bounds what any launch setting can promise: when a comment on a Claude Doc was sent to Claude, a reply that also edited the doc was posted through the Docs connector within a minute, while the only probe session watching that doc had automatic replies off.
Its origin was not determined.
Turning off Claude Code's replier in Firstmate's workers therefore does not guarantee that no Claude surface answers a doc comment sent to Claude.

## Claims are advisory

Claude Code has no lock on watching a page, so two workers could both answer the same comments.
The watch claim gives one Firstmate home a simple rule: before a worker publishes or watches a page it claims the page for its task; a second live task is refused; a relaunch keeps its claim; a claim whose task is gone may be taken over.
It binds only sessions that check it: the captain's own sessions, other tools, and other homes do not see it.
A claim stored on the page itself would bind more parties and is a follow-up.

## Known limits and follow-ups

- Plain artifact pages are not covered by the periodic check; print-mode sessions lack the artifact comments tool.
- `CLAUDE_CODE_ARTIFACT_COMMENTS_AUTOREACT` is undocumented; if a release drops it, the skill's start check still verifies the watch listing shows no "auto-replies armed".
- Firstmate cannot set an environment variable for one task; the variable is set for every worker of a home.
- Firstmate does not call `watch-claim.mjs release-task` at teardown; stale-claim takeover covers it, and an explicit cleanup hook would need a Firstmate change.
- The origin of the observed automatic doc reply is unknown.
