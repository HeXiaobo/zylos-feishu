# Conversation status lifecycle

A conversation stream uses a temporary receipt for live progress and sends its final answer as new message(s), preserving completion notification behavior.

After a successful final delivery, the adapter recalls only that request’s temporary receipt. This covers CardKit status cards, ordinary-card fallback, and plain-text receipts. Every answer segment must be acknowledged first; rejected or ambiguous answer delivery leaves the status in place. Failure/interruption status remains visible. Native task records/cards and existing historical conversation messages are not cleaned up.

Recall is best effort. Cleanup state is persisted alongside the stream, retried by the existing timeout sweep or event replay at least 30 seconds apart, and abandoned after five attempts. Replays do not resend the answer. An already-recalled response counts as success, including after a lost HTTP response. No new permission scope or release version is introduced.

Feishu exposes [message recall](https://open.feishu.cn/document/server-docs/im-v1/message/delete), not guaranteed invisible deletion. Tenant recall limits and permissions apply; client recall notices may remain. Verify the mobile/desktop appearance in an authorized runtime acceptance test before claiming a completely clean transcript. If all attempts fail, the completed receipt remains and the failure is logged. The final answer remains delivered.

Short-task delayed receipt display is outside this change. This change does not bulk-recall old completed cards.
