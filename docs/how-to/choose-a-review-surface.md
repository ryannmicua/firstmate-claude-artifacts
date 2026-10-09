# How to choose Lavish or a Claude surface for a review

Lavish and this add-on coexist in one Firstmate home; pick per review.
Nothing here changes Lavish, and a Lavish board keeps its built-in `lavish` process-event adapter.

| The review needs | Use | How |
| --- | --- | --- |
| A local board, annotations batched and submitted together | Lavish | As today: open the board with `lavish-axi`, arm it with `bin/fm-procevent-lavish.sh arm`. |
| A document people edit and comment on in claude.ai, answered in batches | Claude Doc + periodic check | [Register a `claude-doc-comments` source](install-bind-upgrade-retire.md#register-a-doc) for the doc. |
| A Claude Doc whose comments need answers in the thread soon after they are made | Claude Doc + watching worker | [Launch a watching worker](launch-a-watching-worker.md) for the doc. |
| A published HTML or Markdown page (claude.ai artifact) with comments | Artifact page + watching worker | [Launch a watching worker](launch-a-watching-worker.md); the periodic check cannot read page comments. |

You can combine the two Claude modes on one doc: a periodic-check source announces comments to the owning agent while a watching worker answers them.
When you do, the worker's own replies are connector-written and are not announced, so the owner sees only people's comments.

To switch a review from Lavish to a Claude Doc, publish the same content as a doc, register or launch as above, and retire the Lavish source the usual way once its last round is handled.
To switch back, retire the doc's source (`bin/fm-procevent.sh retire <source-id> --if-owner <owner-token>`) or end the watching worker, then open and arm the Lavish board.
