# How to launch a worker that watches a page for comments

Use a watching worker when a review page needs live answers: a plain claude.ai artifact page (which the periodic check cannot read), or a Claude Doc whose reviewers expect replies rather than a periodic digest.
The worker is always a Claude Code worker, dedicated to one page.

## Before you start

- The [watcher skill](../../skills/claude-artifact-watcher/SKILL.md) is installed for the user the worker runs as (`~/.claude/skills/claude-artifact-watcher`).
- You know the page: a local HTML or Markdown file the worker publishes, an existing artifact link, or a Claude Doc link.

## Steps

Claim every ID the page is known by. A new artifact has no ID until publish returns its URL, so the worker claims that ID as soon as it is available and before requesting the watch.
A Claude Doc is known by its UUID and a paired 22-character artifact ID, but the Docs read returns only the UUID: the paired ID first appears in the watch result.
So the worker claims the UUID before the watch, then claims the UUID plus the paired ID in one command immediately after activation, before reading comments.
Those few seconds are a known overlap window; no read-only route to the paired ID before activation is known.
If that claim collides, the worker stops the watch, releases its claims, and reports `blocked`.

1. **Launch the worker with automatic replies off.**
   Its environment must contain `CLAUDE_CODE_ARTIFACT_COMMENTS_AUTOREACT=0`.
   Firstmate's `bin/fm-spawn.sh` has no per-task environment values; a worker inherits the launching environment, filtered by `config/launch-env-allowlist` when that file exists.
   Choose one route:
   - **Home-wide:** export the variable in the environment of the Firstmate session that launches workers, and if the home has `config/launch-env-allowlist`, add the line `CLAUDE_CODE_ARTIFACT_COMMENTS_AUTOREACT` to it.
     This turns automatic artifact comment replies off for every Claude worker of that home, which matches "no automatic replies unless asked".
   - **One worker:** before launching, write an untracked `<worktree>/.claude/settings.json` in the worker's worktree containing:

     ```json
     {"env":{"CLAUDE_CODE_ARTIFACT_COMMENTS_AUTOREACT":"0"}}
     ```

     If the project already tracks a `.claude/settings.json`, merge the `env` entry into the worktree's copy instead and do not commit it.
     Do not use `<worktree>/.claude/settings.local.json`: Firstmate rewrites that file at every launch, so an `env` entry there does not survive.

   The skill checks the variable on start and reports `blocked` if it is missing.
2. **Write the brief.**
   Name the page, what the worker may change on it, which decisions it may make, the re-read interval if not five minutes, and the status file and line format it reports with.
   Tell it to use the `claude-artifact-watcher` skill.
3. **Dispatch it** as a Claude worker. Do not give a watching task to another harness or to Firstmate itself.
4. **Wait for its first status line.**
   `working` with "watch confirmed" means all known page IDs are claimed, the page is published, watched, caught up, and on a timed re-read.
   `blocked` names the reason: another task holds an ID claim, the launch setting is missing, or the watch would not connect.
5. **Answer what it relays.**
   Decisions and out-of-scope asks arrive as `needs-decision [key=comment-<thread id>]` lines; reply in the worker's inbox as for any other task.
6. **End the review** by telling the worker it is over; it deletes its timer, releases its claim, and reports `done`.

## Tell the worker's replies apart

A watching worker replies through the account owner's Claude login, so its replies show the owner's name, and a doc reply's author has the owner's `principal` and `self: true`.
A reviewer who is the owner sees the worker's replies under their own name.
Two things tell them apart:

- Every reply the worker writes begins with the visible marker `Mate: `.
- On a Claude Doc, the author field `via` is `"mcp"` for a reply written through the connector and `"frame"` for a comment written in the editor. `via` is the only reliable machine signal; the name, principal, and `self` are the same for both.

## Check who watches which page

```sh
node ~/.claude/skills/claude-artifact-watcher/scripts/watch-claim.mjs list --home <firstmate home>
```

A `stale` row means its task no longer exists in that home; the next watcher takes it over when it claims the page.
At task cleanup, release a finished task's claims with `watch-claim.mjs release-task --task <task-id> --home <firstmate home>`.

## If the worker restarts

Relaunch the same task.
The skill re-claims the page (the same task keeps its claim), republishes, confirms the watch, re-reads every thread to catch comments made while it was down, and recreates its timer.
