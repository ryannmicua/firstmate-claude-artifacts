# Reference: `watch-claim.mjs`

Advisory per-page watch claims, shipped with the watcher skill at `skills/claude-artifact-watcher/scripts/watch-claim.mjs`.
`node watch-claim.mjs --help` prints the same usage.

## Commands

| Command | Effect | Exit |
| --- | --- | --- |
| `claim <page>... [--task T] [--home H]` | Takes every named page for task T, all or nothing. Prints `claimed:`, `kept:` (T already held it), or `taken-over:` (the holder's task no longer exists) per page. | 0; 3 with `refused:` lines when another live task holds any of them |
| `release-task [--task T] [--home H]` | Drops every claim T holds. Run at task cleanup. | 0 |
| `list [--home H]` | Tab-separated `page`, `holder`, `state` (`live` or `stale`), `since`. | 0 |

Usage errors exit 2; other errors exit 1.

## Inputs

| Input | Resolution |
| --- | --- |
| `<page>` | `https://claude.ai/artifact/<id>`, `https://claude.ai/code/artifact/[<title>-]<id>` (also `preview.claude.ai`), or the bare id; the key is the UUID or 22-character id. |
| Task | `--task`, else `FM_TASK_ID`. |
| Home | `--home`, else `FM_HOME`, else the home containing `FM_TASK_INBOX` (`<home>/state/<task>.inbox`). |
| State directory | `FM_STATE_OVERRIDE` when set and `--home` is not, else `<home>/state`. |

## Rules

- A task is live while `<state>/<task>.meta` exists; Firstmate removes that record at task teardown.
- One claim file per page identifier: `<state>/fca-watch-claims/<key>.json`, mode 0600, holding `schema`, `page`, `task`, `claimed_at`. A page known by two identifiers needs both identifiers claimed; one `claim` invocation takes all of them atomically.
- If a watch result exposes an identifier after activation, claim it together with all already claimed IDs before handling comments; if another live task holds any identifier, stop the watch and release this task's claims.
- For the watcher-specific Claude Doc paired-ID timing and claim sequence, see the [watcher startup procedure](../../skills/claude-artifact-watcher/SKILL.md#start-and-again-after-every-relaunch).
- Mutations are serialized by `<state>/fca-watch-claims/.lock`, a directory holding the locking process id; a lock whose process is gone is removed.
- An unreadable claim file counts as stale.
- Claims are local to one home and advisory: only sessions that run this tool honor them.
