# Tutorial: your first Claude Doc review with Firstmate

In this tutorial you bind the comment-check adapter to a Firstmate home, point it at a Claude Doc you create, leave a comment, and watch the comment arrive in Firstmate as a wake.
It takes about fifteen minutes.

You need:

- A Firstmate checkout and home you operate (the commands below run from the Firstmate checkout).
- Claude Code 2.1.295 or later, signed in to a claude.ai account with Claude Docs (`claude` then `/mcp` lists `claude.ai Claude Docs`).
- Node.js 20 or later.
- A clone of this repository.

Every value in angle brackets is yours to fill in.

## 1. Stage the package

Firstmate binds a package only from a directory outside every Git project, so copy it out first:

```sh
cd <this repository>
scripts/stage-package.sh "$HOME/.local/share/firstmate-packages/claude-doc-comments-0.1.0"
```

You should see `staged claude-doc-comments 0.1.0 at ...`.

## 2. Bind it to your home

From your Firstmate checkout:

```sh
bin/fm-extension.sh bind "$HOME/.local/share/firstmate-packages/claude-doc-comments-0.1.0" \
  --adapter claude-doc-comments --trust-same-user-code \
  --consent network --consent credential-store --consent artifact-references
```

The output ends with a `binding-digest: sha256:...` line.
Keep it; you need it to retire the binding later.
Check the binding:

```sh
bin/fm-extension.sh verify io.github.ryannmicua.firstmate-claude-artifacts
```

## 3. Make a doc to review

In Claude Code, ask: `Create a Claude Doc titled "Tutorial review" with one paragraph: "The team picnic is on Saturday at the lake."`
Open the link it gives you.
The doc id is the last part of the link: `https://claude.ai/code/artifact/<doc-id>`.

## 4. Register a source for the doc

```sh
bin/fm-procevent.sh register-extension claude-doc-comments tutorial-review \
  --config-ref 'doc:<doc-id>?every=60'
bin/fm-procevent.sh reconcile
```

`register-extension` prints an `owner-token:` line and the exact `retire` command; keep them.
`every=60` checks once a minute so the tutorial is quick; the default is every five minutes.

## 5. Leave a comment

In the doc, select "Saturday", add the comment `Can we move it to Sunday?`, and post it (Send to Claude is not needed).

## 6. See it arrive

Within about a minute, plus Firstmate's own supervision cycle, the check runs a short Claude session on the latest Haiku model, finds your comment, and Firstmate announces a `procevent claude-doc-comments tutorial-review` wake.
Find the captured result:

```sh
ls state/procevent-inbox/tutorial-review.*.result
bin/fm-procevent.sh classify state/procevent-inbox/tutorial-review.<n>.result
```

`classify` prints `claude-doc-comments`.
Open the result file: it is JSON that starts with an `UNTRUSTED CONTENT` notice, then lists your comment under `rows` with its author, the anchored text (`Saturday`), and the body.

## 7. Handle it

Answer the comment in the doc (or let the agent that owns the review do it), then acknowledge the round:

```sh
bin/fm-procevent.sh handled tutorial-review <n>
```

Comments you or an agent post through the Claude Docs connector do not trigger another wake; only people's comments do.

## 8. Clean up

```sh
bin/fm-procevent.sh retire tutorial-review --if-owner <owner-token>
bin/fm-extension.sh retire-binding io.github.ryannmicua.firstmate-claude-artifacts --if-binding-digest <binding-digest>
```

You have bound the adapter, watched a Claude Doc through it, and retired it.
Next, [launch a watching worker](../how-to/launch-a-watching-worker.md) for a page that needs live replies, or read [how the two watching modes differ](../explanation/design.md).
