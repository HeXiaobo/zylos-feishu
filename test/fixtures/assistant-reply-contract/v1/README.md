# Assistant reply contract fixtures (v1)

These fixtures characterize the Feishu adapter at the Wave 0 seam. They are
test evidence only and do not change production behavior.

## Cross-repository contract names

The files `accept-message.json`, `run-events.json`, `reply-intents.json`, and
`delivery-receipts.json` use the Core v1 names and meanings. Feishu route and
`targetRef` values are deliberately opaque strings to Core. Execution,
delivery, projection, presence, and task effects remain separate state axes.

## Official control and fork attribution

The official control is the exact merge base
`zylos-ai/zylos-feishu@890a7fdcccb8b9bd083f177621a33709209d6bc6`.
Its narrow channel seam is:

- receive: authenticate/format in `src/index.js`, then invoke `c4-receive`;
- send: `c4-send` invokes Feishu `scripts/send.js`.

The durable Inbox, response stream/CardKit, WorkIntake, and Task v2 modules are
fork extensions. Their durable storage, recovery, fallback, and reconciliation
assets should remain behind deeper Feishu modules. The current global
one-row/awaited drain, ordinary idle coupling, projection timeout
terminalization, and reaction removal at card-open/120 seconds are accidental
couplings to replace after compatibility evidence exists.

## Current gaps represented without production fixes

`current-behavior.json` records the production seams that satisfy part of the
target contract and the missing behavior. Target-only behavior is represented
by passing fixture assertions plus `test.todo` cases. In particular, the local
strings `排队超时` and `本次回复未生成` are projection/observation output;
they are not evidence that the shared Runtime emitted `RunFailed`.

The common fixture file hashes are written to `fixture-manifest.json` so the
parent integration task can compare names and bytes across repositories.
