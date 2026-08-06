# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
