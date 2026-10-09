# firstmate-claude-artifacts

A [Firstmate](https://github.com/kunchenguid/firstmate) add-on that lets Claude artifacts and Claude Docs serve as a review surface beside Lavish.
It installs and upgrades separately from any Firstmate home.

- **Comment check** (`package/`): a trusted external process-event adapter, `claude-doc-comments`.
  On a configurable cadence it runs one short, read-only `claude -p` session on a low-cost model (default `claude-haiku-5-5`) that reads a Claude Doc's comments newer than a durable cursor.
  New comments from people become one announced result for the owning agent; an empty check wakes no one.
- **Watcher skill** (`skills/claude-artifact-watcher/`): a Claude Code skill for a Firstmate worker that watches one page or doc, claims it, catches up on start, re-reads on a timer, answers within its brief, and relays decisions to Firstmate.
  It ships `watch-claim.mjs`, advisory per-page watch claims for one Firstmate home.

Start with the [tutorial](docs/tutorials/first-doc-review.md); all documentation is indexed in [docs/](docs/README.md).

## Requirements

- Firstmate with trusted external process-event adapters (`bin/fm-extension.sh`).
- Claude Code 2.1.295 or later, signed in to a claude.ai account with Claude Docs.
- Node.js 20 or later. No other dependencies.

## Tests

```sh
npm test                                                   # offline: protocol, adapter, config, claims (fake claude)
FIRSTMATE_ROOT=/path/to/firstmate npm run test:host        # opt-in: bind and drive the real Firstmate host, still offline
FCA_LIVE_DOC=<doc-id> npm run test:live                    # opt-in: one real poll of a doc you own
```

The host test needs a temporary directory with no Git work tree above it; set `TMPDIR` if `/tmp` is inside one.

This repository holds mechanism only; fixtures use invented data, and no real work content is committed.
