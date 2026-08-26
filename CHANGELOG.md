# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.7-rc.6] - 2026-08-27

### Changed
- Consolidate the tested `0.3.7-rc.5` native-task reminder release with the
  Issue 8 collapsed streaming-process presentation in one release line.

## [0.3.7-rc.5] - 2026-08-26

### Added
- Project canonical `reminderMinutesBeforeDue` through Task v2's dedicated
  add/remove reminder APIs, then require an authoritative native readback before
  acknowledging create or update.
- Surface confirmed reminder offsets in projection receipts and reminder drift
  in reconciliation reports; explicit Feishu task intake now preserves the
  same reminder policy.

### Changed
- Require Core's `task-reminder >= 1` capability before install or upgrade, so
  reminder-aware Feishu cannot start against a Core that drops the policy.

### Fixed
- Route short-lived Agent replies through the canonical Task comment
  coordinator before projecting them to Feishu, so exact-parent human
  notification decisions are persisted and delivered idempotently instead of
  being bypassed by the C4 send path; retries also reuse the first Core comment
  timestamp (including concurrent first-delivery races) so notification and
  transport recovery remain valid after restart.
- Require exact configured-App authorship before adopting an ambiguous Task
  comment echo, and independently verify App author, parent, and content in the
  native closure gate so a human same-content comment cannot produce a false
  Agent-reply receipt.
- Add a live, read-only native completion gate that proves one exact Task v2
  completion event settled durably, produced the expected Core command receipt,
  left the linked Core Task in review, and did not auto-accept it.
- Preflight the production Task v2 status inbox through an explicit open/close
  before server-side subscription or WebSocket/webhook startup, so native
  binding, schema, migration, dual-writer, and permission failures stop reverse
  status intake before the component claims readiness.
- Gate install and upgrade on Core's native Task mapper protocol, and establish
  the Task v2 server-side subscription once through the shared WebSocket/webhook
  startup gate before either transport can receive events.
- Restore zero-visible Smart-group evaluation: passive authorization failures no longer emit permission replies or typing/card placeholders, and terminal runtime `[SKIP]` decisions are suppressed even when preceded by explanatory text.
- Treat an explicitly configured group's `allowFrom` policy as authoritative across tenant boundaries, while retaining the global member policy for direct messages and unconfigured open groups.
- Keep passive Smart-group messages out of both explicit task handling and natural-language WorkIntake unless the bot is exactly @mentioned.
- Persist response-card delivery intent before sending, retry ambiguous Feishu outcomes with the same UUID, and use a single idempotent plain fallback only after explicit card rejection.
- Derive proactive card identity from Core's stable `C4_DELIVERY_ID`; sends without a durable identity degrade safely instead of inventing a new UUID on every process invocation.
- Compact terminal response-stream state to a hash-only tombstone so full answers and public work summaries are not retained indefinitely.
- Remove the universal Task v2 and card-label defaults for a specific Agent; deployment identity now comes from `ZYLOS_AGENT_ID`, `FEISHU_TASK_V2_AGENT_APP_IDS`, and `ZYLOS_AGENT_LABELS`.

### Changed
- New deployments default ordinary assistant replies to the same completed-card format used by streaming replies.
- Use “正在回复…” for running response-card summaries in Feishu chat lists
  instead of exposing the internal platform name to end users.
- Require `c4.assistant-response-stream >= 2`, `c4.outbound-delivery-id >= 1`,
  `external-task-adapter >= 1`, and `task-reminder >= 1`, so install and upgrade reject a Core that
  cannot provide turn-safe streaming, stable proactive card identity, and the
  native completion mapper used at runtime.

## [0.3.7-rc.4.issue8.2] - 2026-08-27

### Changed
- Replace the repeated numbered streaming-process list with one collapsed
  current-status row whose public execution details can be expanded in place.
- Add `message.streamProcessDisplay: "answer_only"` as a safe fallback that
  streams only the answer body while keeping the completed-card behavior.
- Preserve the collapsed process row when CardKit conversion is unavailable
  and the same message must be updated through ordinary card patches.

## [0.3.7-rc.4] - 2026-08-26

### Fixed
- Run a bounded status watchdog at startup and every 60 seconds so a completely
  missed native completion callback still advances the linked Core task to
  `review`, never directly to `done`.
- Record an unregistered top-level comment from the exact current App for audit
  and follower notification without waking that same Agent or producing an
  undeliverable reply notification addressed to the App ID.
- Stop scheduled reconciliation cleanly on shutdown and propagate aborts
  between the bounded Core, Feishu listing, and status-repair steps.

### Changed
- Reconciliation now pages both open and completed managed Task partitions once
  and indexes them by Core task ID, replacing the previous per-Core-task remote
  rescan while retaining authoritative Task reads and duplicate detection.

## [0.3.7-3ai.5] - 2026-08-26

### Fixed
- All ordinary assistant replies now use the same completed response-card format as streamed replies, including proactive updates; text fallback remains available before any card part is delivered.
- Public progress and model-authored public work summaries remain visible only while a response is running and are removed from the completed or failed card.
- Group response cards reply to the triggering message only when a reply target is present; direct messages and proactive group updates use the base send path.
- Long completed cards no longer add a custom copy action.

### Changed
- The component upgrade route now targets the fork's `main` branch so general-purpose agents do not inherit a deployment-specific release branch.
- Release metadata and compatibility fixtures no longer name a particular hosted agent or runtime deployment.

## [0.3.7-3ai.4] - 2026-08-26

### Fixed
- Ordinary streamed replies now enter C4 with `--block-queue-until-idle`, keeping a second Feishu prompt durably queued until the active runtime turn settles instead of allowing two cards to compete for one runtime session.

## [0.3.7-3ai.3] - 2026-08-25

### Changed
- The fail-closed pre-install/pre-upgrade check now requires Core's `c4.reply.argv-compat` capability, preventing a paired rollout from proceeding against a Core version that can disconnect older endpoint-addressed reply callers.

## [0.3.7-3ai.2] - 2026-08-25

### Added
- A machine-readable capability manifest covering response streaming, WorkIntake, task projections, and task comments.
- A fail-closed Core protocol check in pre-install and pre-upgrade hooks.

### Changed
- The fork upgrade route now points to the paired `codex/mylos-capability-bundle-rc` branch.

## [0.3.7-3ai.1] - 2026-08-25

### Added
- Safe response streaming, durable WorkIntake confirmations, Task v2 projection and reverse events, reliable task-comment reconciliation, and CardKit replay idempotency from the task-management MVP integration branch.
- Fork-only `@mention` resolution module (`src/lib/mention.js`): outgoing
  `@name` references can be resolved from a paginated source-group member sync
  plus a config-driven override map. The cache is written atomically and has a
  configurable TTL (six hours by default).
- Unit coverage for mention matching, longest-prefix handling, snapshot
  isolation, override priority, and unknown/empty-ID fallbacks.

### Changed
- Release metadata and the component upgrade route now point to `HeXiaobo/zylos-feishu` branch `codex/mylos-compat-release` so fork deployments do not drift back to the canonical component.
- Explicit smart groups retain legacy no-mention conversation handling, while task and WorkIntake protocols remain exact-mention gated.
- Plain-text sends use Feishu rich-text `post` content when configured names
  resolve successfully; markdown-card sends use the verified interactive-card
  `<at id=ou_xxx></at>` form. Existing structured `<at user_id="...">` input
  still passes through the separate card-syntax converter.

## [0.3.6] - 2026-08-10

### Fixed
- **@-mentions in markdown messages now actually notify their target.** Feishu
  accepts two different @-mention syntaxes and which one is valid depends on the
  message type: text messages take `<at user_id="ou_xxx">Display Name</at>`,
  while interactive cards take `<at id=ou_xxx></at>` (bare id, no display name).
  `sendText` routes any message containing markdown through the card path, but
  `sendCardChunk` handed the chunk to the card builder verbatim, so a
  text-format mention reached a builder that does not understand `user_id` and
  rendered as literal text while notifying nobody. Messages without markdown
  were unaffected, which is why this looked intermittent — the same mention
  worked or silently failed depending on whether the body happened to contain
  any formatting. `sendCardChunk` now converts text-format mentions to card
  format first (new `src/lib/at-mention.js`).
  - Same defect and same fix as zylos-lark 0.3.11; the two senders share this
    code path. Found by auditing this repo after the bug was reported against
    zylos-lark, then verified here independently rather than assumed by analogy.
  - The conversion is deliberately broader than the double-quoted form: a
    single-quoted or bare id, and additional attributes beside `user_id`, are
    all handled, since matching only the narrow form leaves those mentions
    silently broken in exactly the same way.
  - Fenced and inline code spans are skipped, so a message documenting the
    mention syntax does not get its own code sample rewritten.
  - Already-card-format tags carry no `user_id` and are left untouched, making
    the conversion idempotent; an empty `user_id` is left as-is rather than
    emitting a broken `<at id=></at>`.
  - Verified live against a real Feishu client on both paths (no-markdown
    control and markdown/card).

## [0.3.5] - 2026-08-06

### Added
- **Merge-forward (合并转发 /「聊天记录」) content reading**: forwarded chat
  records were delivered as a bare `[merge_forward message]` placeholder.
  Feishu fixes such an event's content to the literal string
  `Merged and Forwarded Message` (「接收消息内容」§合并转发), so the child
  messages are now read back with `im.message.get` and rendered as a
  `[Forwarded conversation]` transcript.
  - `im.message.get` is called with `user_id_type: 'open_id'` — **not**
    `user_id` as the equivalent zylos-lark change uses. This app holds no
    user_id-class scope (`contact:user.employee_id:readonly`, which Feishu
    documents as the gate on that response field), inbound events carry
    `sender_id.user_id = null`, and `preloadGroupMembers` seeds the name cache
    with open_ids. Asking for `user_id` would resolve no sender names at all.
  - Nested forwards are handled adaptively: Feishu documents neither whether a
    forward-of-a-forward's children arrive flattened in the same `items[]` nor
    an example response. An inner forward whose children are already present is
    rendered inline; one whose children are absent gets its own fetch. Both API
    behaviours yield the same output, with no duplicated or dropped level, and
    both are bounded (depth 3, 12 nested fetches).
    Live testing on a real tenant established the actual behaviour, which the
    docs do not state: Feishu **does** create nested `merge_forward` levels
    (multi-selecting a forward together with another message produces one), but
    it returns **every descendant flattened into a single `items[]`**, using
    `upper_message_id` to encode the hierarchy. The inline branch is therefore
    the one that fires; the separate-fetch branch is retained as insurance,
    since nothing in the API contract guarantees this.
  - Resource files inside a forward are surfaced as inert text markers only.
    Feishu returns error `234043` for the wrapper's id, a child's id, or a card
    message id (「获取消息中的资源文件」§使用限制), so these keys must never
    enter the normal download path.
  - The remote fetch is deferred until after the DM/group access gate, so a
    message from a rejected sender or chat never triggers an API call.
- **Message types the parser previously dropped**: `audio`, `media`, `sticker`
  and `interactive` (cards) were all rendering as `[<type> message]`. Cards now
  read through a new `lib/card-text.js`, which walks Schema 2.0 `body.elements`,
  the original `user_dsl`, and legacy top-level `elements[]` including the `div`
  component's `fields[]`. Verified against real forwarded cards from the live
  API: all extracted real text, none fell back to a placeholder.

### Fixed
- A failed `im.message.get` read-back of a merge-forward no longer degrades
  into `[merge_forward message, no child messages]`. `itemsFromResponse`
  rejects a resolved response carrying a non-zero `code` so the caller emits
  `[merge_forward message, failed to fetch content]` instead — a fetch failure
  must not be reported as a genuinely empty forward, which would silently drop
  the transcript. (Feishu returns HTTP 400 for the error classes observed in
  practice — malformed id, nonexistent id, and `230002` bot-not-in-chat — which
  the SDK already surfaces as a throw; this guards the remaining shape.)

### Changed
- `fetchQuotedMessage` now shares the message-item parser instead of inlining
  its own text/post-only branches, so quoted cards, stickers, audio and media
  read correctly too, and it requests the original card JSON
  (`card_msg_content_type: 'user_card_content'`).

## [0.3.4] - 2026-08-03

### Changed
- **Bundled lark-cli install target**: `larkCli.version` bumped 1.0.69 → 1.0.81.
  Minimum-version semantics unchanged: machines already at or above the pin
  are untouched; machines below it (or without lark-cli) are brought to
  1.0.81. Checked upstream's v1.0.70–v1.0.81 changelog for new sub-skill
  categories — none added, so `EXPECTED_SUB_SKILLS` stays at the same 27
  entries (identical list to zylos-lark) and sub-skill docs are re-fetched
  to the matching v1.0.81 tag via the version marker.

## [0.3.3] - 2026-07-23

### Fixed
- **p2p DM silent message drop**: outbound replies in a 1:1 DM were reported
  as sent but never appeared for the recipient. The send routing in
  `scripts/send.js` called the reply APIs (`replyToMessage` /
  `replyMarkdownCard`, backed by Feishu `im.message.reply`) whenever the
  reply-via endpoint carried a `root:`/`parent:` — which also happens in p2p
  DMs when the incoming message is itself a quote/reply. Feishu returned
  `code:0` (success), but a threaded/quoted reply is not surfaced in the 1:1
  main DM view, so the message was invisible. Because the API reported
  success, the existing `sendMessage` fallback (which only fires on failure)
  never triggered → a silent drop. Reply-to (threaded/quoted) sends are only
  meaningful in **groups**; p2p DMs now ALWAYS use the base `sendMessage` /
  `sendImage` / `sendFile` to the chat id. Applied consistently across all
  four send paths (text, card, image, file). Group reply-to behavior
  (@mention / thread continuation) is unchanged. The reply-target decision is
  now a pure helper (`src/lib/reply-target.js`) with unit tests. Ports the
  zylos-lark PR #95 fix to the Feishu channel.
- **p2p reject/error reply silent drop** (follow-up): the message handler's
  reject/error reply helper `sendThreadAwareMessage` had its own reply routing
  that ignored chat type, so a p2p DM that was itself a quote/reply still had
  its access-denied / download-failed / C4-error replies sent via
  `im.message.reply` and silently dropped. It now derives its reply target from
  the same `chooseReplyTarget` helper (extracted to `src/lib/reply-send.js`,
  unit-tested), forcing p2p (and unknown chat types) down the base `sendMessage`
  path while groups keep thread/@mention reply-to.

## [0.3.2] - 2026-07-14

### Changed
- Bundled lark-cli install target bumped from 1.0.63 to 1.0.69. Minimum-version
  semantics unchanged: installs at or above the target are left untouched,
  below-target or missing installs are brought to 1.0.69, and sub-skill docs are
  re-fetched to the matching v1.0.69 tag via the version marker.
- SKILL.md: added a prominent note to prefer `--as user` identity for lark-cli
  content operations (docs, wiki/knowledge bases, drive, sheets, Base) — user-owned
  content generally requires user identity, while bot identity only sees resources
  accessible to the bot or its app. The target sub-skill's identity rules take
  precedence (Wiki/Drive/Base define legitimate bot paths); bot identity remains
  appropriate for IM messaging operations.

## [0.3.1] - 2026-07-04

### Fixed
- File upload: use `createReadStream` + `inferFileType()` instead of `readFileSync` with
  hardcoded type — fixes "undefined" error for .pptx and other file types
- User name resolution: fall back to open_id when user_id is absent (cross-tenant users)
- SDK response parsing: handle both `{file_key}` and `{data: {file_key}}` shapes

### Changed
- SKILL.md description trimmed under 1024 chars
- Added `[MEDIA:...]` must-be-only-content constraint to SKILL.md

## [0.3.0] - 2026-07-02

### Added
- Integrate lark-cli binary with 27 sub-skill modules (documents, sheets, slides,
  calendar, tasks, mail, wiki, approval, attendance, OKR, and more)
- Shared post-install hook (`post-install-shared.js`) for lark-cli download,
  profile initialization, and credential configuration
- Post-upgrade hook to re-run lark-cli setup on component upgrade
- `lark-cli-bridge.js` — helper to invoke lark-cli with auto-injected `--profile feishu`
- Unit tests for lark-cli-bridge

### Changed
- SKILL.md expanded with lark-cli capability modules and usage guidance
- Named profile support: lark-cli configured with `--name feishu` profile

## [0.2.7] - 2026-05-18

### Fixed
- Post-upgrade hook now backs up `config.json` to
  `config.json.backup.<ISO-timestamp>` before mutation and uses atomic
  write (temp + rename) for the new config (#29)

### Removed
- Reverted in-config `_legacy_*` field injection
  (`_legacy_whitelist`, `_legacy_group_whitelist`,
  `_legacy_message_max_length`) in favor of whole-file backups; the
  original config schema is preserved (#29)
## [0.2.6] - 2026-03-02

### Security
- Bump axios 1.13.4 → 1.13.6 (high: DoS via `__proto__` in mergeConfig) (#21)
- Bump qs 6.14.1 → 6.14.2 (low: arrayLimit bypass in comma parsing) (#21)

### Changed
- Add release process guidelines to CLAUDE.md (#22)

### Fixed
- Fix package.json version mismatch (was 0.2.4, should have been 0.2.5)

## [0.2.5] - 2026-03-02

### Changed
- Use stdin form for c4-send examples in SKILL.md (#19)

## [0.2.4] - 2026-02-26

### Added
- DM policy model: `dmPolicy` (open/allowlist/owner) with `dmAllowFrom` list, replacing legacy whitelist
- On-demand media download script (`scripts/download.js`) for image/file retrieval by resource key
- Markdown card rendering for outgoing messages (`message.useMarkdownCard` in config.json, default: true)
- DM rejection message for non-allowed users
- Group rejection messages for unauthorized @mentions and disabled group policy

### Fixed
- bindOwner rollback on saveConfig failure (align with Lark)

### Changed
- Legacy whitelist config auto-migrated to dmPolicy on upgrade (post-upgrade hook)
- Legacy admin commands (`list-whitelist`, `add-whitelist`, etc.) aliased to new dmPolicy commands
- `useMarkdownCard` defaults to true on install and upgrade

## [0.2.3] - 2026-02-21

### Fixed
- Post-upgrade hook was deleting `bot.verification_token` from config, breaking webhook mode on upgrade

## [0.2.2] - 2026-02-20

### Added
- Split log files by thread for audit trail isolation

### Fixed
- Bind webhook server to 127.0.0.1 (security: prevent direct port exposure)
- Path traversal protection in log paths and media downloads
- Config watcher: null filename handling, strict parseInt validation, reload timer cleanup
- Admin CLI: complete validation and policy enum alignment
- Guard against malformed webhook event payloads
- Sanitize image key in download path and guard JSON.parse
- Sanitize typing marker paths and wrap log writes in try/catch
- Ensure DATA_DIR exists before token write
- Persist internal token to file for cross-process-tree access
- Webhook server must bind to 0.0.0.0 reverted to 127.0.0.1 for Caddy proxy setup
- readSheetData delegates to values API with proper URL encoding
- Chat pagination and URL encoding fixes

### Security
- Standards audit: 19 fixes covering input validation, bot self-loop prevention, internal auth

## [0.2.1] - 2026-02-17

### Added
- Unified message dedup across WebSocket and webhook modes (#6)
- Structured endpoint routing with metadata (type, root, parent, msg, thread) (#6)
- Reply quoting: fetch quoted message content for context (#6)
- Multiple image support with lazy download (#6)
- Markdown Card auto-detection: code blocks and tables rendered as interactive cards (#6)
- Markdown-aware message chunking (preserves code blocks) (#6)
- In-memory group chat history with configurable limits per group (#6)
- User name cache with TTL (10 min in-memory, file for cold start) (#6)
- Group policy system with per-group config and auto-migration from legacy format (#6)
- Permission error detection with grant URL notification (#6)
- Typing indicator with emoji reaction and 120s auto-timeout (#6)
- Thread context isolation: thread messages stored separately (#6)
- Lazy load fallback: fetch message history from API on first access after restart (#6)
- Bot reply recording via `/internal/record-outgoing` endpoint with auth (#6)

### Security
- parseEndpoint key whitelist to prevent prototype pollution (#6)
- FEISHU_APP_ID missing warning in send.js (#6)

### Changed
- Message dedup map now cleaned periodically via timer (#6)
- Typing indicator retry with deferred cleanup on failure (#6)
- Admin CLI: new group management commands (list-groups, add-group, set-group-policy, etc.) (#6)

## [0.2.0] - 2026-02-15

### Added
- Dual connection mode: WebSocket (default) and Webhook, configurable via `connection_mode` in config.json
- Interactive mode selection in post-install hook
- SKILL.md `http_routes` declaration for Caddy integration (webhook mode)
- Startup gate: service refuses to start without `verification_token` in webhook mode
- Runtime guard: webhook rejects requests when `verification_token` is missing

### Changed
- `verification_token` is now **required** for webhook mode (previously optional)
- post-install hook prompts for verification token directly (no optional gate)

## [0.1.0] - 2026-02-14

Initial release. Forked from zylos-lark and adapted for Feishu (飞书) Chinese platform.

### Added
- Feishu webhook integration with event subscription (WebSocket mode)
- Owner auto-binding (first private chat user becomes owner)
- Group support: allowed groups, smart groups, @mention detection
- Group context — include recent messages when responding to @mentions
- Mention resolution (@_user_N placeholders to real names)
- Media support: images, files with lazy download and on-demand retrieval
- C4 protocol integration with rejection response and retry
- Hooks-based lifecycle (post-install, post-upgrade, pre-upgrade)
- Admin CLI for managing groups, whitelist, and owner
- PM2 service management via ecosystem.config.cjs

### Changed (vs zylos-lark)
- API domain: open.feishu.cn (Domain.Feishu) instead of open.larksuite.com
- Env vars: FEISHU_APP_ID / FEISHU_APP_SECRET
- Config path: ~/zylos/components/feishu/
- Default webhook port: 3458
