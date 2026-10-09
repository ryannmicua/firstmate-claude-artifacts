# Reference: `watch-claim.mjs`

Advisory per-page watch claims, shipped with the watcher skill at `skills/claude-artifact-watcher/scripts/watch-claim.mjs`.
`node watch-claim.mjs --help` prints the same usage.

## Commands

| Command | Effect | Exit |
| --- | --- | --- |
| `claim <page>... [--task T] [--home H]` | Takes every named page for task T, all or nothing. Prints `claimed:`, `kept:` (T already held it), or `taken-over:` (the holder's task no longer exists) per page. | 0; 3 with `refused:` lines when another live task holds any of them |
| `release <page>... [--task T] [--home H]` | Drops T's claim on each page. Prints `released:` or `not-held:`. | 0; 3 when a page is held by another task (left untouched) |
| `release-task [--task T] [--home H]` | Drops every claim T holds. Run at task cleanup. | 0 |
| `check <page> [--task T] [--home H]` | Prints `free:`, `held-by-you:`, `held:` (another live task), or `stale:`. | 0; 3 for `held:` |
| `list [--home H]` | Tab-separated `page`, `holder`, `state` (`live` or `stale`), `since`. | 0 |
| `sweep [--home H]` | Removes every stale claim. | 0 |

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
- One claim file per page key: `<state>/fca-watch-claims/<key>.json`, mode 0600, holding `schema`, `page`, `task`, `claimed_at`.
- Mutations are serialized by `<state>/fca-watch-claims/.lock`, a directory holding the locking process id; a lock whose process is gone is removed.
- An unreadable claim file counts as stale.
- Claims are local to one home and advisory: only sessions that run this tool honor them.
