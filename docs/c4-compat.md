# C4 Compatibility Options

Both options are off by default. Existing installations keep their current
behavior unless they explicitly enable an option in `config.json`:

```json
{
  "c4": {
    "replyReceipts": true,
    "smartNoMentionSilent": true
  }
}
```

`replyReceipts` writes `C4_RECEIPT` JSON lines to the send command's stdout
when C4 provides `ZYLOS_REPLY_RECEIPT_TOKEN`. Each line carries the token and
one actual platform message ID. Receipts are emitted only after the whole
message succeeds, including every text fallback chunk. Missing IDs, failed or
unknown sends do not produce complete reply evidence. Card, image and file
sends use the same rule. Receipts identify native messages; they do not prove
that a user read them.

`smartNoMentionSilent` passes `--silent-status` for smart group messages that
do not mention this bot. The installed Core must declare that option in its
`c4-receive-options.json`; otherwise the silent message is not forwarded.
Component rejection notices are also suppressed for those messages. Typing
indicators are cleared as usual, and cursors advance only on accepted or
confirmed-stored messages. Mentioned group messages and DMs keep their normal
notices. Message routing and session grouping are unchanged.
