# Assistant reply contract fixtures (v1)

These fixtures characterize the Feishu adapter at the Wave 0 seam. They are
test evidence only and do not change production behavior.

## Common contract and adapter projections

`common-contract-vectors.json` is the byte-identical copy of the frozen
cross-repository v1 contract. Its SHA-256 is fixed in `fixture-manifest.json`.
The split Feishu fixtures contain adapter-owned bindings and references to
that common file; they do not redefine Core fields or state semantics.

- `accept-message.json`: Feishu transport identity, dedupe, lane, and context
  bindings for the common `AcceptMessage` contract.
- `run-events.json`: best-effort CardKit projection bindings for progress and
  output deltas; execution terminal events and final intent remain independent.
- `reply-intents.json`: Feishu presentation bindings for answer, failure, and
task receipts; explicit silent completion creates no ReplyIntent.
- `delivery-receipts.json`: adapter receipt/settlement bindings. A receipt
records `outcome` and `externalRef`; retry exhaustion is an independent
DeliverySettlement and platform acceptance is not user-read evidence.
- `feishu-presentation.json`: reaction/presence, card projection, and final
adapter lifecycle owned by Feishu.
- `feishu-task-effects.json`: native-task projection and authorization seam.

`feishu-intake.json` is retained as a legacy fixture name for characterization
tests and only points at `accept-message.json`; the old duplicate public
schema is intentionally not maintained.

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
projection observation windows never emit retry instructions or claim that a
reply was not generated; only canonical Runtime events can terminate a run.

The common fixture hash is written to `fixture-manifest.json` so the parent
integration task can compare names and bytes across repositories.
