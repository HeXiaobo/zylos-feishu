# Inline source quotes for conversational replies

Group status and final-answer routing retains its existing parent/root selection. Direct messages use only the triggering message ID and explicitly pass `reply_in_thread: false`. Status, card answers (including each split segment), and plain answers use the same source. No source text fetching, copied quote text, new configuration or persistent state fields are introduced.

The ingress, durable route recovery, reply composition and standalone text/card delivery paths preserve the DM trigger. Existing persisted streams with a null target keep their original behavior; newly opened streams pick up the quote. Messages without a source still base-send. Legacy media and intake rejection routing retain their existing safety behavior.

The stream falls back to a normal send only after an explicit quote API rejection (for example a recalled/unavailable source). Unknown transport outcomes retain idempotent retry behavior rather than sending a possible duplicate. Group rejection behavior is unchanged.

## Acceptance

The July fix `3f5d200fdb4da14d59a2c8a4f9fc814be72bd32a` documented invisible DM replies when inheriting root/parent routing. This change never inherits those fields for DMs. Do not equate successful API delivery with visible mobile delivery: check both the status and answer in the main DM view, including a trigger that itself quotes another message. Check that group/topic routing is unchanged before deployment.

The owner-authorized local SDK smoke test on 2026-09-05 sent a status and final answer in the owner–玥然 DM, without installing this branch or changing services. Both returned the same source parent/root ID and no thread ID. Mobile visibility is pending owner confirmation. No messages were recalled. This is not a deployment or a release canary.
