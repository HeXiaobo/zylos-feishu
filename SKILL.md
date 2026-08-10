---
name: feishu
version: 0.3.6
description: >-
  Feishu (飞书, China) communication channel. WebSocket and webhook modes.
  Use when: (1) replying to Feishu messages (DM or group @mentions),
  (2) sending proactive messages or media (images, files) to Feishu users or groups,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom, smart/mention modes),
  (5) operating Feishu productivity surfaces via the bundled lark-cli — documents, sheets, slides,
  multidim Base, calendar, tasks, mail, drive, wiki, OKR, approval, attendance,
  video conferencing, minutes, Miaoda/Spark apps, native OpenAPI explorer
  (see "Bundled Capability Modules" in SKILL.md body — full module index under references/),
  (6) configuring the bot (admin CLI, markdown card settings, verification token),
  (7) troubleshooting Feishu WebSocket or webhook issues.
  Config at ~/zylos/components/feishu/config.json. Service: pm2 zylos-feishu.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-feishu
    entry: src/index.js
  data_dir: ~/zylos/components/feishu
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - .env
    - data/

upgrade:
  repo: zylos-ai/zylos-feishu
  branch: main

config:
  required:
    - name: FEISHU_APP_ID
      description: "App ID (open.feishu.cn/app -> Credentials)"
    - name: FEISHU_APP_SECRET
      description: "App Secret (same page as App ID)"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Ask user which connection mode to use: 'websocket' (Feishu SDK long connection, simpler setup) or 'webhook' (HTTP webhook, requires public URL). Write choice to connection_mode in ~/zylos/components/feishu/config.json. 2) If WEBHOOK mode: a) verification_token is REQUIRED — ask user to get it from open.feishu.cn/app Event Subscriptions page, write to config.bot.verification_token. b) encrypt_key is optional — if user provides it, write to config.bot.encrypt_key. c) Read domain from ~/zylos/.zylos/config.json and tell user to set Request URL: https://{domain}/feishu/webhook in Event Subscriptions. 3) If WEBSOCKET mode: tell user to go to open.feishu.cn/app Event Subscriptions and select long connection (长连接) mode. No webhook URL or verification token needed. 4) Both modes: user must enable Bot capability and subscribe to im.message.receive_v1 event. 5) Start the service (pm2 restart zylos-feishu)."

http_routes:
  - path: /feishu/webhook
    type: reverse_proxy
    target: localhost:3458
    strip_prefix: /feishu

dependencies:
  - comm-bridge
---

# Feishu

Feishu communication channel for zylos.

Depends on: comm-bridge (C4 message routing).

## Bundled Capability Modules (lark-cli)

This skill bundles **27 capability modules** under `references/`, each operating against Feishu via the `lark-cli` binary. **They are not auto-loaded as top-level skills** — Claude Code's skill discovery only scans top-level directories, and these sub-modules live inside this skill. The parent `SKILL.md` (this file) is the entry point.

**How to use a module**: when a user's request maps to one of the modules below, `Read` that module's `SKILL.md` first to learn its exact commands/flags, then invoke `lark-cli <module> ...`.

**Prerequisites** (installed automatically by `zylos add feishu` / `zylos upgrade feishu` — see `hooks/post-install-shared.js`):
- `lark-cli` binary on PATH (`npm install -g @larksuite/cli`).
- 27 sub-skill folders under `references/lark-*/` (`npx xc-skills add larksuite/cli`).
- App credentials in lark-cli's keychain (`~/.lark-cli/config.json` + AES-256-GCM encrypted file under `~/.local/share/lark-cli/`); pushed from `~/zylos/.env` automatically.

**Identity (`--as bot` vs `--as user`)**:

> ⚠️ **Prefer user identity for content operations.** When querying or editing documents, wiki / knowledge bases, drive files, sheets, or Base via lark-cli, default to `--as user` (OAuth-authorized; the refresh token rotates automatically, with expiry defined by the auth response). Rationale: user-owned content generally requires user identity — the bot identity only sees resources accessible to the bot or its app (bot scopes are granted in the developer console), so bot-identity queries against a user's content typically return empty results. This is a default, not a blanket rule: sub-skills define legitimate bot paths (e.g. Wiki app-owned spaces and bot node creation, Drive version operations, Base bot create/copy and single bot retry), and the target sub-skill's identity guidance takes precedence over this note. Bot identity remains appropriate for IM messaging operations.

- `--as bot` works out of the box for app/tenant-level operations (IM messaging, contacts, events). No extra login needed.
- `--as user` is the default for content operations (docs, wiki, drive, sheets, Base — see note above) and is required for surfaces tied to a real user's data (calendar, mail-write, tasks, attendance, OKR, minutes, VC-agent). The user runs `lark-cli --profile feishu auth login --domain <name>` once. On auth failure lark-cli exits with a `<domain>_user_login_required` error envelope; the agent should detect this and notify the owner of the login command.

**Permission fallback strategy**:
When an operation fails due to missing scope (`missing_scope` / `unauthorized` error):
1. **Retry with `--as user`** — bot identity has limited scopes; user identity often has broader access. If the bot call fails, retry the same command with `--as user` before giving up.
2. **If user auth also lacks the scope**, initiate a re-authorization flow. Present the user with two options:
   - **Minimum permissions** — only the scope(s) required for the current operation: `lark-cli --profile feishu auth login --scope "<missing_scope_1> <missing_scope_2>"`
   - **Full permissions** — authorize all available scopes at once: `lark-cli --profile feishu auth login --domain all`
3. Use `--no-wait --json` to get the device flow URL, generate a QR code (`lark-cli auth qrcode`), and send both to the user. After the user confirms, complete with `lark-cli --profile feishu auth login --device-code <code>`.
4. Do NOT silently fail or tell the user "permission not available" — always offer the re-authorization path.
5. **All `auth login` invocations MUST include `--profile feishu`** to ensure credentials land in the correct named profile, especially when zylos-lark is also installed on the same machine.

### Module Index

Path prefix for all entries: `references/`

#### Messaging & people
| Module | Use when… |
|---|---|
| `lark-im/SKILL.md` | Send/search messages, manage groups and members, upload/download media (chunked for large files) |
| `lark-contact/SKILL.md` | Resolve names/emails ↔ open_ids; look up department / contact info |

#### Docs & drive
| Module | Use when… |
|---|---|
| `lark-doc/SKILL.md` | Lark Docs v2: create / fetch / update (DocxXML or Markdown); search Drive |
| `lark-sheets/SKILL.md` | Spreadsheets: create, read/write cells, append rows, find |
| `lark-slides/SKILL.md` | Presentations: create, read, page/element ops (XML protocol) |
| `lark-markdown/SKILL.md` | Markdown file create / read / upload / edit |
| `lark-drive/SKILL.md` | Drive files & folders: upload, download, copy, move, metadata |
| `lark-wiki/SKILL.md` | Wiki: spaces, members, node hierarchy |
| `lark-whiteboard/SKILL.md` | Whiteboards: query, export preview image, DSL edits |

#### Productivity
| Module | Use when… |
|---|---|
| `lark-base/SKILL.md` | Base (multi-dim tables): search base, tables, fields, records, views, dashboards, forms, roles |
| `lark-calendar/SKILL.md` | Calendar events: agenda, create, update, delete, attendees, reminders |
| `lark-task/SKILL.md` | Task lists, subtasks, collaborators, status |
| `lark-mail/SKILL.md` | Mail: draft / send / reply / forward / search; drafts, folders, labels, contacts, attachments, rules |

#### HR / workflow
| Module | Use when… |
|---|---|
| `lark-approval/SKILL.md` | Approval instances and tasks |
| `lark-attendance/SKILL.md` | Personal attendance / clock-in records |
| `lark-okr/SKILL.md` | OKR cycles, objectives, key results, alignment, metrics |

#### Meetings & A/V
| Module | Use when… |
|---|---|
| `lark-vc/SKILL.md` | Video conferencing history, meeting summaries (notes/todos/chapters/transcripts), participant snapshots |
| `lark-vc-agent/SKILL.md` | Have the bot join/leave a live meeting on the user's behalf; consume real-time events |
| `lark-minutes/SKILL.md` | Minutes: list, basic info, transcripts, AI summaries |
| `lark-note/SKILL.md` | Meeting notes (纪要): query note detail by note_id, get note_doc_token / verbatim_doc_token, read unified transcripts |

#### Apps & low-code
| Module | Use when… |
|---|---|
| `lark-apps/SKILL.md` | Miaoda/Spark apps: create, publish HTML sites, local full-stack dev, cloud-based generation, DB ops, release management |

#### Workflows & platform
| Module | Use when… |
|---|---|
| `lark-workflow-meeting-summary/SKILL.md` | Roll up meeting minutes over a time range |
| `lark-workflow-standup-report/SKILL.md` | Orchestrate calendar + task into a standup summary |
| `lark-event/SKILL.md` | Subscribe / consume real-time events as NDJSON streams |
| `lark-openapi-explorer/SKILL.md` | Discover native OpenAPI endpoints not yet wrapped by CLI shortcuts |
| `lark-skill-maker/SKILL.md` | Author new sub-skills wrapping lark-cli (atomic APIs or multi-step flows) |
| `lark-shared/SKILL.md` | Shared utilities / types referenced by other modules (rarely invoked directly) |

### Loading Convention

Before running `lark-cli <module> <subcmd>`:

1. Read `references/<module>/SKILL.md` to confirm exact subcommands, flags, and required vs. optional args.
2. If that module's `SKILL.md` references additional docs under its own `references/` subdirectory, read those as well.
3. Run the command with `--profile feishu`: `lark-cli --profile feishu <module> <subcmd> ...`

The `--profile feishu` flag selects this component's credentials. Always include it — without it, lark-cli uses whichever profile is active, which may belong to zylos-lark if both are installed. The `runLarkCli()` bridge in `src/lib/lark-cli-bridge.js` injects this flag automatically.

Skipping step 1 risks calling wrong subcommand names or missing required flags — `lark-cli` is feature-rich and each module covers dozens of subcommands.

## Sending Messages

```bash
# Via C4 bridge (standard path — always use stdin form)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "feishu" "<chat_id>"
Hello!
EOF

# Send image
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "feishu" "<chat_id>"
[MEDIA:image]/path/to/image.png
EOF

# Send file
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "feishu" "<chat_id>"
[MEDIA:file]/path/to/file.pdf
EOF
```

> ⚠️ `[MEDIA:...]` must be the only content in the message. Send text and media as separate calls.

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/feishu/scripts/send.js <chat_id> "Hello!"
```

### CLI Commands

```bash
# Test authentication
npm run cli test

# Send messages
npm run cli send-group oc_xxx "Hello"

# Documents
npm run cli doc <doc_id>
npm run cli sheet-read <token> <range>

# Calendar
npm run cli calendar --days 7

# Groups
npm run cli chats
```

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
ADM="node ~/zylos/.claude/skills/feishu/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>     # Set DM policy
$ADM list-dm-allow                            # Show DM policy + allowFrom list
$ADM add-dm-allow <user_id_or_open_id>        # Add user to dmAllowFrom
$ADM remove-dm-allow <user_id_or_open_id>     # Remove user from dmAllowFrom

# Group Management
$ADM list-groups                              # List all configured groups
$ADM add-group <chat_id> <name> [mode]        # Add group (mode: mention|smart)
$ADM remove-group <chat_id>                   # Remove a group
$ADM set-group-policy <disabled|allowlist|open>  # Set group policy
$ADM set-group-allowfrom <chat_id> <id1,id2>  # Set per-group allowed senders
$ADM set-group-history-limit <chat_id> <n>    # Set per-group context message limit
$ADM migrate-groups                           # Migrate legacy group config to new format

# Legacy aliases (backward-compatible, map to commands above)
# list-allowed-groups, add-allowed-group, remove-allowed-group → list-groups, add-group, remove-group
# list-smart-groups, add-smart-group, remove-smart-group → list-groups, add-group, remove-group
# enable-group-whitelist, disable-group-whitelist → set-group-policy allowlist|open
# list-whitelist, add-whitelist, remove-whitelist → list-dm-allow, add-dm-allow, remove-dm-allow
# enable-whitelist, disable-whitelist → set-dm-policy allowlist|open
```

After changes, restart: `pm2 restart zylos-feishu`

## Downloading Media by Resource Key

In smart group mode, images and files sent without @mention are logged with
metadata only (image_key/file_key). Use `download.js` to fetch them on demand:

```bash
# Download image
node ~/zylos/.claude/skills/feishu/scripts/download.js image <message_id> <image_key>

# Download file
node ~/zylos/.claude/skills/feishu/scripts/download.js file <message_id> <file_key> [filename]

# Examples:
node ~/zylos/.claude/skills/feishu/scripts/download.js image om_xxx img_v3_xxx
node ~/zylos/.claude/skills/feishu/scripts/download.js file om_xxx file_v3_xxx report.pdf
```

The keys come from context messages like `[image, image_key: xxx, msg_id: xxx]`
or `[file: name.pdf, file_key: xxx, msg_id: xxx]`.

Output: local file path on success, error message on failure.

## Config Location

- Config: `~/zylos/components/feishu/config.json`
- Logs: `~/zylos/components/feishu/logs/`
- Media: `~/zylos/components/feishu/media/`

## Feishu Setup

### 1. Credentials

Add to `~/zylos/.env`:

```bash
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
```

Get App ID and App Secret from your app's Credentials page:
- Feishu: [open.feishu.cn/app](https://open.feishu.cn/app)

### 2. Connection Mode

Choose a connection mode in `~/zylos/components/feishu/config.json`:

```json
{
  "connection_mode": "websocket"
}
```

| Mode | How it works | Pros | Cons |
|------|-------------|------|------|
| `websocket` | SDK WSClient long connection to Feishu servers | No public URL needed, simpler setup | Requires SDK support |
| `webhook` | HTTP server receives POST events from Feishu | Standard HTTP, works everywhere | Requires public URL + Caddy route |

### 3. Console Configuration

In the Feishu developer console ([open.feishu.cn/app](https://open.feishu.cn/app)):

**Both modes:**
1. Enable **Bot** capability (添加应用能力 -> 机器人)
2. Subscribe to event: `im.message.receive_v1`

**WebSocket mode:**
3. In Event Subscriptions, select **长连接** (long connection) mode
4. No Request URL or verification token needed

**Webhook mode:**
3. In Event Subscriptions, select **webhook** mode
4. Set Request URL: `https://<your-domain>/feishu/webhook`
5. Copy the **Verification Token** (required) and save to config:
   ```json
   {
     "bot": {
       "verification_token": "your_token_from_console"
     }
   }
   ```
6. Optionally copy the **Encrypt Key** for payload encryption:
   ```json
   {
     "bot": {
       "verification_token": "your_token",
       "encrypt_key": "your_encrypt_key"
     }
   }
   ```

### Cloudflare Users (Webhook mode)

If your domain is behind Cloudflare proxy with Flexible SSL mode, Caddy's automatic HTTPS will cause a redirect loop. Options:

1. **Change Cloudflare SSL to Full**: In Cloudflare dashboard -> SSL/TLS -> set mode to "Full" (recommended)
2. **Use HTTP mode**: Run `zylos config set protocol http` (automatically updates Caddyfile and reloads Caddy)

## Owner

First user to send a private message becomes the owner (primary partner).
Owner always bypasses all access checks (DM and group) regardless of policy settings.

Owner info stored in config.json:
```json
{
  "owner": {
    "bound": true,
    "user_id": "xxx",
    "open_id": "ou_xxx",
    "name": "Howard"
  }
}
```

## Access Control

### Permission Flow

DM and group access are controlled by **independent** top-level policies:

```json
{
  "dmPolicy": "owner",        // "open" | "allowlist" | "owner"
  "dmAllowFrom": ["ou_xxx"],  // used when dmPolicy = "allowlist"
  "groupPolicy": "allowlist", // "open" | "allowlist" | "disabled"
  "groups": { ... }           // per-group config (used when groupPolicy = "allowlist")
}
```

**Private DM (dmPolicy):**
1. Owner? → always allowed
2. `dmPolicy` = `open`? → anyone can DM
3. `dmPolicy` = `owner`? → only owner can DM
4. `dmPolicy` = `allowlist`? → check `dmAllowFrom` list; not in list → dropped

**Group message (groupPolicy):**
1. `groupPolicy` = `disabled`? → all group messages dropped
2. `groupPolicy` = `open`? → respond to @mentions from any group
3. `groupPolicy` = `allowlist`? → only configured groups; unlisted groups → only owner passes, others dropped silently
4. Per-group `allowFrom` set? → only listed senders pass (owner always bypasses)
5. Smart group (mode: `smart`)? → receive all messages, no @mention needed
6. Not smart? → only @mentions are processed, other messages are logged only

**Key points:**
- Owner always bypasses all access checks
- `dmPolicy` and `groupPolicy` are fully independent — changing one never affects the other
- Group access is controlled by `groupPolicy` + `groups` config + per-group `allowFrom`
- No user-level whitelist for groups; use per-group `allowFrom` if you need to restrict specific senders

### Groups Config Format

Groups are stored in a map keyed by `chat_id`:

```json
{
  "groupPolicy": "allowlist",
  "groups": {
    "oc_xxx": {
      "name": "研发群",
      "mode": "mention",
      "requireMention": true,
      "allowFrom": [],
      "historyLimit": 10,
      "added_at": "2026-01-01T00:00:00Z"
    },
    "oc_zzz": {
      "name": "核心群",
      "mode": "smart",
      "requireMention": false
    }
  }
}
```

- `mode`: `"mention"` (respond to @mentions only) or `"smart"` (receive all messages)
- `allowFrom`: Optional list of user_id/open_id. Empty = all group members allowed. `"*"` = wildcard.
- `historyLimit`: Optional per-group context message limit (overrides `message.context_messages`)

### Markdown Card

Outgoing messages can be rendered as interactive cards with proper markdown formatting (code blocks, tables, headers, etc.):

```json
{
  "message": {
    "useMarkdownCard": true
  }
}
```

On by default. Note mobile display limitation: cards cannot be long-pressed to copy on mobile. Can be disabled via `node admin.js set-markdown-card off`. When enabled (cards cannot be long-pressed to copy on mobile). When enabled, messages containing markdown are auto-detected and sent as cards; plain text messages are sent normally. Falls back to plain text if card sending fails.

## Group Context

When responding to @mentions in groups, the bot includes recent message context
so Claude understands the conversation. Context is retrieved from logged messages
since the last response.

Configuration in `config.json`:
```json
{
  "message": {
    "context_messages": 10
  }
}
```

Message logs are stored in `~/zylos/components/feishu/logs/<chat_id>.log`.

## Service Management

```bash
pm2 status zylos-feishu
pm2 logs zylos-feishu
pm2 restart zylos-feishu
```
