# How to install, bind, upgrade, and retire the comment-check adapter

These steps run from your Firstmate checkout unless they say otherwise.
For a home other than the default, set `FM_HOME=<that home>` on every command.
`bin/fm-extension.sh --help` and `bin/fm-procevent.sh --help` own the exact Firstmate command mechanics; this page only shows the sequence for this package.

## Install a version

1. Get the version you want: `git -C <this repository> checkout v<version>` (or a commit you trust).
2. Stage it into a new directory outside every Git project:

   ```sh
   <this repository>/scripts/stage-package.sh "$HOME/.local/share/firstmate-packages/claude-doc-comments-<version>"
   ```

   The script refuses an existing destination and any destination inside a Git work tree, and sets the modes Firstmate accepts.
   If `/tmp` or a parent of your chosen directory is itself a Git work tree, pick another parent.

## Bind it to a home

```sh
bin/fm-extension.sh bind "$HOME/.local/share/firstmate-packages/claude-doc-comments-<version>" \
  --adapter claude-doc-comments --trust-same-user-code \
  --consent network --consent credential-store --consent artifact-references
bin/fm-extension.sh verify io.github.ryannmicua.firstmate-claude-artifacts
```

Record the printed `binding-digest`.
Each check runs `claude -p` on the operator's Claude login, so the host must preserve `HOME`; that is what `credential-store` consents to.
Leave room in the binding timeout: one poll can wait up to `wait` seconds and then run a check for up to `timeout` seconds (defaults 50 and 120), within the default `--timeout-ms 300000`.

For a configured remote secondmate, keep the staged package on the controller and use `remote-bind` with the same `--adapter`, `--trust-same-user-code`, and `--consent` arguments; that home needs its own Claude login.

## Register a doc

```sh
bin/fm-procevent.sh register-extension claude-doc-comments <source-id> \
  --config-ref 'doc:<doc-id>[~<alias-id>][,<related-doc-id>...][?setting=value&...]'
```

Each doc id is the last path segment of its `https://claude.ai/code/artifact/<doc-id>` link. Use `~` to configure both IDs for the same doc; use commas to include several related docs in the source. The periodic check can read only the IDs configured for that source.
Check a reference offline before registering:

```sh
"$HOME/.local/share/firstmate-packages/claude-doc-comments-<version>/bin/claude-doc-comments" validate-config 'doc:<doc-id>?every=600'
```

See [the adapter reference](../reference/adapter.md) for every setting.
Record the printed `owner-token`.
The source is checked on Firstmate's ordinary reconcile cycle from then on.

## Upgrade to a new version

A binding pins one exact package, so an upgrade is retire-then-bind.
The per-source cursors live in the home's extension state, keyed by extension id, source id, and doc, so they carry over: re-registering the same source id for the same doc continues where it left off.

1. Stage the new version into a new directory (see "Install a version").
2. Handle and acknowledge every captured result of this adapter (`bin/fm-procevent.sh handled <source-id> <n>`); Firstmate refuses to retire a binding that unhandled results still depend on.
3. Retire each registration with its owner token: `bin/fm-procevent.sh retire <source-id> --if-owner <owner-token>`.
4. Retire the old binding: `bin/fm-extension.sh retire-binding io.github.ryannmicua.firstmate-claude-artifacts --if-binding-digest <old-binding-digest>`.
5. Bind the new staged directory (see "Bind it to a home") and record its new binding digest.
6. Register the same source ids and config references again and record the new owner tokens.

## Retire

1. Handle and acknowledge every captured result of the adapter.
2. Retire every registration: `bin/fm-procevent.sh retire <source-id> --if-owner <owner-token>`.
3. Retire the binding: `bin/fm-extension.sh retire-binding io.github.ryannmicua.firstmate-claude-artifacts --if-binding-digest <binding-digest>`.
   For a remote secondmate, use `fm-extension.sh retire-transfer` with both the transfer and binding digests that `remote-bind` printed.

Retirement leaves these in the home:

- the content-addressed installed copy;
- the extension state (cursors and structural check diagnostics) under `state/extensions/io.github.ryannmicua.firstmate-claude-artifacts/`; delete it yourself only if you never want that state back;
- each retired source's launch records, `state/procevent/<source-id>.*.last-launch`;
- each retired source's handled results, `state/procevent-inbox/<source-id>.<n>.*`.

Firstmate owns the launch records and handled results; leave them to Firstmate's own procevent tooling rather than deleting them by hand.

## Install the watcher skill

The watching worker's skill is separate from the adapter and installs per user:

```sh
mkdir -p ~/.claude/skills
cp -R <this repository>/skills/claude-artifact-watcher ~/.claude/skills/
```

Upgrade it by replacing that directory with the new version's copy.
Remove it by deleting the directory.
See [launch a watching worker](launch-a-watching-worker.md) for using it.
