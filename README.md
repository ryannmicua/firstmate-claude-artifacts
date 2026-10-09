# firstmate-claude-artifacts

A [Firstmate](https://github.com/kunchenguid/firstmate) add-on that lets Claude artifacts and Claude Docs serve as a review surface beside Lavish.

Planned contents:

- **Comment check** - a trusted external process-event adapter that periodically runs a one-off Claude session on a low-cost model to read new Claude Doc comments and hand them to Firstmate's durable notification queue.
- **Watcher worker** - a Claude skill a Firstmate Claude worker loads to hold a live watch on an artifact, catch up on missed comments, and relay decisions back to Firstmate.

The add-on is installed and updated separately from any Firstmate home.
This repository holds mechanism only; fixtures use invented data, and no real work content is committed.

Status: early development.
