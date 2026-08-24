# zylos-feishu Design Document

**Version**: v1.0
**Date**: 2026-02-14
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-feishu
**Status**: Implemented

---

## 1. Overview

### 1.1 Component Overview

zylos-feishu is a Zylos communication component that enables bidirectional messaging between users and the Claude Agent via the Feishu (飞书) WebSocket API.

| Property | Value |
|----------|-------|
| Type | Communication |
| Priority | P0 |
| Dependency | C4 Communication Bridge |
| Base Code | Forked from zylos-feishu, adapted for Feishu |

### 1.2 Core Features

| Feature | Description | Priority |
|---------|-------------|----------|
| Direct message receiving | Receive direct messages from authorized users | P0 |
| Message sending | Send messages to specified users/groups via C4 | P0 |
| Auto owner binding | First direct message user automatically becomes admin | P0 |
| User whitelist | Restrict usage to authorized users only | P0 |
| Group @mention | Receive @bot messages in group chats | P1 |
| Smart Groups | Receive all messages from designated groups | P1 |
| Image receiving | Download and pass image paths to Claude | P1 |
| File receiving | Download and pass file paths to Claude | P2 |
| Group context | Include recent group messages with @mentions | P1 |

### 1.3 Out of Scope

- Voice message handling
- Video processing
- Feishu approval/calendar creation (handled via CLI)
- General-purpose interactive forms beyond Commitment Core task review cards

---

## 2. Directory Structure

### 2.1 Skills Directory (Code)

```
~/zylos/.claude/skills/feishu/
├── SKILL.md              # Component metadata (v2 format with lifecycle)
├── package.json          # Dependency definitions
├── ecosystem.config.cjs  # PM2 configuration
├── scripts/
│   └── send.js           # C4 standard send interface
├── hooks/
│   ├── post-install.js   # Post-install hook (create dirs, configure PM2)
│   ├── pre-upgrade.js    # Pre-upgrade hook (backup config)
│   └── post-upgrade.js   # Post-upgrade hook (config migration)
└── src/
    ├── index.js          # Main entry point (Webhook server)
    ├── cli.js            # Feishu API CLI tool
    ├── admin.js          # Admin CLI
    └── lib/
        ├── config.js     # Configuration loader
        ├── client.js     # API auth client
        ├── message.js    # Message send/receive
        ├── document.js   # Document/spreadsheet operations
        ├── calendar.js   # Calendar queries
        ├── chat.js       # Group management
        └── contact.js    # Contact lookup
```

### 2.2 Data Directory (Runtime Data)

```
~/zylos/components/feishu/
├── config.json           # Runtime configuration
├── group-cursors.json    # Group message cursors (tracks processed messages)
├── user-cache.json       # User name cache
├── media/                # Media file storage (images, files, etc.)
└── logs/                 # Log directory (managed by PM2)
    ├── out.log
    ├── error.log
    └── <chat_id>.log     # Per-conversation message logs
```

---

## 3. Architecture

### 3.1 Component Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     zylos-feishu                           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  index.js    │───▶│  config.js   │                   │
│  │  (Express)   │    │  Whitelist+Owner                 │
│  └──────┬───────┘    └──────────────┘                   │
│         │                                                │
│         │ Webhook receive                                │
│         ▼                                                │
│  ┌──────────────┐                                       │
│  │  message.js  │  Download media locally                │
│  └──────┬───────┘                                       │
│         │                                                │
│         ▼                                                │
│  ┌──────────────────────────────────┐                   │
│  │ c4-receive (comm-bridge)         │ → C4 Bridge       │
│  └──────────────────────────────────┘                   │
│                                                          │
│  ┌──────────────┐                                       │
│  │  send.js     │  ← Called by C4 to send messages      │
│  └──────────────┘                                       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Module Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| Main | index.js | Express Webhook server, event handling, message formatting, calling c4-receive |
| Config | lib/config.js | Load .env + config.json, hot-reload configuration |
| Client | lib/client.js | Feishu API authentication (app_id + app_secret -> tenant_access_token) |
| Message | lib/message.js | Send/receive messages, file upload/download |
| Document | lib/document.js | Document reading, spreadsheet read/write |
| Calendar | lib/calendar.js | Calendar event queries |
| Chat | lib/chat.js | Group listing, search, member queries |
| Contact | lib/contact.js | User information lookup |
| Send | scripts/send.js | C4 standard interface for sending text and media |
| Admin | src/admin.js | CLI for managing config (groups, whitelist, owner) |
| CLI | src/cli.js | Feishu API command-line tool |

### 3.3 Commitment Core Adapter Seam

`src/lib/commitment-mapper.js` is a pure Adapter between normalized Feishu
events and Commitment Core. It accepts only events that have already passed
permission checks and intent classification; it performs no LLM inference,
configuration lookup, or network I/O.

- Task intents become Core `SourceEnvelope` values with a stable idempotency
  key derived from the Feishu message ID.
- Task interactions become `{ command, expectedVersion }`, ready for
  `core.command(command, expectedVersion)`. The task ID and version must come
  from card context signed by us. The actor ID must come from the verified
  Feishu event, never from actor data embedded in a button payload.
- `submit` means `SubmitForReview`. `accept` means `AcceptTask` only after an
  explicit, authorized acceptance action. An ordinary Feishu "complete"
  signal is only an external projection signal and must never directly make a
  Core task done or map to `AcceptTask`.

`src/lib/task-action-context.js` owns the signed card-context seam. Its
`createTaskActionContextSigner({ secret, clock })` Interface issues and verifies
versioned `v1` HMAC-SHA256 tokens. The dedicated secret must contain at least
32 bytes, `expiresAt` is an exclusive Unix epoch millisecond, and encoded
tokens are capped at 4096 characters. Verified claims contain exactly `taskId`,
`expectedVersion`, and `expiresAt`, so they can be spread into
`mapFeishuTaskAction`. They never contain `actorId`: the caller must add the
actor from the verified Feishu event. Any malformed, forged, expired, or
unsupported-version token fails closed before reaching Core.

### 3.4 Explicit Task Production Entry

`src/lib/task-entry.js` owns the transport-neutral production seam used by
`src/index.js`. Task routing happens only after the existing DM owner/allowlist
gate or all group policy, sender, and mention/smart-group gates have passed.
The only recognized inputs are text messages using one of these exact forms:

```text
/zylos-task create {"title":"...","description":"...","acceptorId":"...","assigneeId":"..."}
/zylos-task action {"action":"...","context":"<signed v1 token>"}
```

A create input is normalized to a Core `SourceEnvelope` and passed to C4 with
the original channel, endpoint, and content plus `--task-envelope-json`.
Ordinary chat remains on the existing C4 path. A recognized but malformed
task input fails closed and is never treated as ordinary chat.

A signed action is verified locally and dispatched through the narrow
`zylos task` CLI Interface with its task ID, optimistic version, actor, and
stable Feishu-message idempotency key. The actor is always bound from the
authorized Feishu event; neither the JSON payload nor the signed token may
supply it. `complete` maps to `SubmitForReview`, never `AcceptTask`. Explicit
`accept` remains a separate Core command whose authorization is enforced by
Commitment Core. Set `FEISHU_TASK_CONTEXT_SECRET` to a dedicated secret of at
least 32 bytes to enable signed actions; missing or invalid configuration
disables actions without affecting task creation or ordinary chat. The CLI
path defaults to `~/.local/bin/zylos` and may be overridden with
`ZYLOS_CLI_PATH`.

### 3.5 Task Review Card Runtime

`src/lib/task-card-runtime.js` connects the strict task-card renderer/parser to
the existing Feishu runtime seams without creating another SDK client:

- `createTaskCardSender(...)` accepts a Feishu `receiveId`, `receiveIdType`, and
  an exact Commitment Core task snapshot. It renders signed controls and calls
  the injected existing `sendMessage(..., 'interactive')` Interface.
- `scripts/send-task-card.js <receive_id> <receive_id_type> <task_json>` is the
  callable local production seam. It loads the dedicated context secret,
  constructs the sender with the existing Feishu client, and returns a JSON
  result. External Adapters must invoke it with `execFile`-style arguments, not
  a shell-interpolated command.
- `createTaskCardActionRuntime(...)` accepts only an authenticated
  `card.action.trigger` body. The actor comes from Feishu's trusted
  `operator.open_id` (or the SDK's verified legacy `open_id`), while task ID and
  expected version come from the signed context. Button values cannot supply
  an actor.
- Re-delivered clicks derive the same Core idempotency key from the message,
  trusted actor, and canonical action value. Webhook mode waits for the local
  idempotent Core command before acknowledging a card callback; failures return
  a non-success response so Feishu can retry. Ordinary message callbacks keep
  their existing immediate-ack behavior.

WebSocket mode registers `card.action.trigger` on the existing
`EventDispatcher`. Webhook mode recognizes the same event only after the
existing token check and optional decrypt step. If
`FEISHU_TASK_CONTEXT_SECRET` is absent or invalid, task-card actions fail closed
without affecting ordinary messages.

This is a runtime seam, not a complete external projection. A Commitment Core
Outbox Adapter plus durable Feishu `ExternalLink`/target mapping is still needed
to invoke the sender with the correct chat, decide which task snapshot is sent,
and determine whether a later event creates or updates a card. This batch wires
the callback into the running transport and provides the callable sender; it
does not auto-publish Core Outbox events.

---

## 4. C4 Integration

### 4.1 Receive Flow (Feishu -> Claude)

```
User sends message
     │
     ▼
┌─────────────┐
│  index.js   │  Listens for Feishu WebSockets
└─────┬───────┘
      │ 1. Decrypt (if encrypt_key is set)
      │ 2. Owner / whitelist validation
      │ 3. Group permission check
      ▼
┌─────────────┐
│ Format msg  │
└─────┬───────┘
      │ Format: "[Feishu DM] username said: message content"
      │         "[Feishu GROUP] username said: [context] message content"
      ▼
┌─────────────┐
│ c4-receive  │  C4 Bridge interface
└─────┬───────┘
      │ --channel feishu
      │ --endpoint <chat_id>
      │ --content "..."
      ▼
┌─────────────┐
│   Claude    │  Processes message
└─────────────┘
```

### 4.2 Send Flow (Claude -> Feishu)

```
Claude needs to reply
      │
      ▼
┌─────────────┐
│  c4-send    │  C4 Bridge
└─────┬───────┘
      │ c4-send feishu <chat_id> "message content"
      ▼
┌──────────────────────────────────────┐
│ ~/zylos/.claude/skills/feishu/scripts/send.js │
└─────┬────────────────────────────────┘
      │ 1. Parse arguments
      │ 2. Check for media prefix [MEDIA:type]
      │ 3. Call Feishu API
      ▼
┌─────────────┐
│ Feishu      │  User receives message
└─────────────┘
```

### 4.3 send.js Interface Specification

```bash
# Location: ~/zylos/.claude/skills/feishu/scripts/send.js
# Usage: node send.js <chat_id> <message>
# Returns: 0 on success, non-zero on failure

# Plain text
node send.js "oc_xxx" "Hello!"

# Send image
node send.js "oc_xxx" "[MEDIA:image]/path/to/photo.jpg"

# Send file
node send.js "oc_xxx" "[MEDIA:file]/path/to/document.pdf"
```

### 4.4 Message Format Specification

**Incoming message format:**

```
# Direct message
[Feishu DM] Howard said: Hello

# Group @mention (with context)
[Feishu GROUP] Howard said: [Group context - recent messages before this @mention:]
[Alice]: Do we need to deploy today?
[Bob]: Let me confirm first

[Current message:] @Zylos Can you take a look

# With image
[Feishu DM] Howard said: [image] What is this ---- file: ~/zylos/components/feishu/media/feishu-xxx.png
```

---

## 5. Configuration

### 5.1 config.json Structure

```json
{
  "enabled": true,
  "webhook_port": 3457,

  "bot": {
    "encrypt_key": ""
  },

  "owner": {
    "bound": false,
    "user_id": "",
    "open_id": "",
    "name": ""
  },

  "whitelist": {
    "enabled": false,
    "private_users": [],
    "group_users": []
  },

  "allowed_groups": [],
  "smart_groups": [],

  "proxy": {
    "enabled": false,
    "host": "",
    "port": 0
  },

  "message": {
    "context_messages": 10
  }
}
```

### 5.2 Configuration Reference

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | Component enable/disable toggle |
| webhook_port | number | Webhook listening port |
| bot.encrypt_key | string | Feishu event encryption key (optional) |
| owner.bound | boolean | Whether an owner has been bound |
| owner.user_id | string | Owner's user_id |
| owner.open_id | string | Owner's open_id |
| owner.name | string | Owner's display name |
| whitelist.enabled | boolean | Whitelist enable/disable toggle |
| whitelist.private_users | string[] | Whitelisted users for direct messages |
| whitelist.group_users | string[] | Whitelisted users for group chats |
| allowed_groups | object[] | Groups where @mention is allowed |
| smart_groups | object[] | Groups where all messages are monitored |
| proxy.enabled | boolean | Proxy enable/disable toggle |
| message.context_messages | number | Number of group context messages to include |

### 5.3 Environment Variables (~/zylos/.env)

```bash
# Feishu App credentials (required)
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

---

## 6. Security

### 6.1 Auto Owner Binding

**Design principle**: The first user to send a direct message automatically becomes the owner (admin).

```
User sends direct message
      │
      ▼
┌─────────────────┐
│ Check owner     │
│ bound == false? │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
  Unbound    Bound
    │         │
    ▼         ▼
Bind as owner  Proceed with normal validation
Save config
```

**Recorded on binding**: user_id, open_id, name

### 6.2 User Validation Flow

```
User sends message
      │
      ▼
┌─────────────────┐
│ Is owner?       │ → Yes → Allow
└────────┬────────┘
         │ No
         ▼
┌─────────────────┐
│ Whitelist off?  │ → Yes → Allow
└────────┬────────┘
         │ No (whitelist enabled)
         ▼
┌─────────────────┐
│ On whitelist?   │ → Yes → Allow
└────────┬────────┘
         │ No
         ▼
       Ignore message
```

### 6.3 Group Permissions

| Group Type | @mention response | Receive all messages | Permission required |
|------------|:-----------------:|:--------------------:|---------------------|
| smart_groups | Y | Y | None |
| allowed_groups | Y | N | Whitelist or Owner |
| Other groups | Owner only | N | Owner only |

---

## 7. Differences from Telegram Component

| Aspect | zylos-telegram | zylos-feishu |
|--------|---------------|------------|
| Protocol | Telegram Bot API (long polling) | Feishu WebSocket (HTTP POST) |
| Entry point | bot.js (Telegraf) | index.js (Express) |
| Authentication | Bot Token | App ID + Secret -> tenant_access_token |
| Message encryption | None | AES-256-CBC (optional) |
| Owner identifier | chat_id + username | user_id + open_id |
| Whitelist structure | chat_ids[] + usernames[] | private_users[] + group_users[] |
| CLI tool | None | cli.js (documents/spreadsheets/calendar/groups) |
| Additional features | None | Spreadsheet read/write, document access, calendar queries |

---

## 8. Service Management

### 8.1 PM2 Configuration

```javascript
// ecosystem.config.cjs
const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-feishu',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/feishu'),
    env: { NODE_ENV: 'production' }
  }]
};
```

### 8.2 Service Commands

```bash
pm2 start ~/zylos/.claude/skills/feishu/ecosystem.config.cjs
pm2 stop zylos-feishu
pm2 restart zylos-feishu
pm2 logs zylos-feishu
```

---

## 9. Lifecycle Management (v2 Hooks)

### 9.1 Install/Uninstall Flow

```bash
# Install
zylos install feishu
# 1. git clone to ~/zylos/.claude/skills/feishu
# 2. npm install
# 3. Create data_dir
# 4. Register PM2 service
# 5. Execute post-install hook

# Upgrade
zylos upgrade feishu
# 1. pre-upgrade hook (backup config)
# 2. git pull
# 3. npm install
# 4. post-upgrade hook (config migration)
# 5. PM2 restart service

# Uninstall
zylos uninstall feishu [--purge]
# 1. Remove PM2 service
# 2. Delete skill directory
# 3. --purge: delete data directory
```

---

## 10. Acceptance Criteria

- [ ] `zylos install feishu` completes installation on a fresh environment
- [ ] `node send.js <chat_id> <message>` sends messages correctly
- [ ] Direct messages are correctly forwarded to c4-receive
- [ ] Group @mentions include context and are forwarded to c4-receive
- [ ] Images are downloaded and their paths are passed through
- [ ] Auto owner binding flow works correctly
- [ ] Owner can @bot in any group to trigger a response
- [ ] admin.js correctly manages configuration
- [ ] `zylos upgrade feishu` preserves user config and performs migration
- [ ] `zylos uninstall feishu` cleans up correctly

---

## Appendix

### A. Dependencies

```json
{
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.0.0",
    "axios": "^1.6.0",
    "dotenv": "^16.4.5",
    "express": "^4.18.2",
    "form-data": "^4.0.0"
  }
}
```

### B. References

- [Feishu Open Platform Documentation](https://open.feishu.cn/document/)
- [Feishu/Lark Node SDK](https://github.com/larksuite/node-sdk)
- [zylos-telegram DESIGN.md](../zylos-telegram/DESIGN.md)

---

*End of document*
