<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-feishu</h1>

> **Zylos** (/ˈzaɪ.lɒs/ 赛洛丝) — Give your AI a life

<p align="center">
  飞书 (Feishu) messaging component for <a href="https://github.com/zylos-ai/zylos-core">Zylos</a> agents.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

<p align="center">
  <a href="./README.zh-CN.md">中文</a>
</p>

---

- **Talk through Feishu** — your AI agent speaks Feishu, both private chats and group conversations
- **Smart group monitoring** — automatically follow designated group discussions, no @mention needed
- **Zero-config start** — first message auto-binds you as admin, no setup wizards
- **Rich Feishu integration** — documents, spreadsheets, calendar — not just messaging

## Getting Started

Tell your Zylos agent:

> "Install the feishu component"

Or use the CLI:

```bash
zylos add feishu
```

Zylos will guide you through the setup, including configuring your Feishu app credentials. Once installed, message your bot on Feishu — the first user to interact becomes the admin.

## Managing the Bot

Just tell your Zylos agent what you need:

| Task | Example |
|------|---------|
| Add user to whitelist | "Add user xxx to feishu whitelist" |
| Enable smart group | "Make this group a smart group" |
| Check status | "Show feishu bot status" |
| Restart bot | "Restart feishu bot" |
| Upgrade | "Upgrade feishu component" |
| Uninstall | "Uninstall feishu component" |

Or manage via CLI:

```bash
zylos upgrade feishu
zylos uninstall feishu
```

## Group Chat Behavior

| Scenario | Bot Response |
|----------|--------------|
| Private chat (owner/whitelisted) | Responds via Claude |
| Smart group message | Receives all messages |
| @mention in allowed group | Responds with recent context |
| Owner @mention in any group | Always responds |
| Unknown user | Ignored |

## Compatibility Switch `ZYLOS_ARCH2`

All of the behaviour in the next section is gated by one environment variable.

| `ZYLOS_ARCH2` | Behaviour |
|---|---|
| unset, `0`, or anything other than the literal `1` | Pre-arch2 behaviour (baseline `8c0a3e2`): allowlist-only groups, no automatic group registration, no automatic internal/external classification, markdown-only cards, sender attaches no `uuid` and prints no `C4_RESULT` line |
| `1` | New architecture; the individual settings below apply on top |

Only the literal string `1` enables it. A typo (`true`, `yes`, `" 1"`) stays on the old
path, because a mistake here must never widen who the bot answers in a group.

The switch is read from the process environment (put it in `~/zylos/.env`). The
policy reads it once at startup; the install/upgrade hooks and `scripts/send.js`
read it per process. Changing it requires a service restart.

With the switch off, nothing new is written to `config.json`: the upgrade hook does
not add `message.alwaysCard`, and the receiver does not register groups in
`config.groups`.

## Card Output

Outbound text defaults to interactive cards, including plain text. Set
`message.alwaysCard: false` for markdown-only cards, or
`message.useMarkdownCard: false` to disable cards. Explicit settings survive upgrades.
This section describes the switch-on behaviour; with `ZYLOS_ARCH2` off the component
sends cards only for markdown, exactly as before.

Received groups are registered automatically in smart mode unless an explicit
mode already exists. `groupPolicy: disabled`, group `enabled: false`, and
`allowFrom` restrictions still apply. On the first received message, the existing
Feishu client calls `im.chat.get` and reads `external`. Internal groups automatically
use `auto`; external groups use `observe`. The result is saved under
`groups[chat_id].autoClassification`, cached for 24 hours, and refreshed on the next
message after expiry. Failed queries retry on the next message; failure without
cached evidence defaults to external. A cached result survives a failed refresh.

The sender's `tenant_key` is also checked on every group message. A tenant outside
`internalTenants` immediately marks automatic evidence external and switches to
`observe`, including while a chat lookup is in flight. When `internalTenants` is
absent, it contains only the bot's own tenant. The component obtains that identity
from bot info or the authenticated tenant query and caches it as `bot.tenant_key`.
If identity lookup is unavailable, an unknown sender tenant is treated as external.
To add known internal tenants, configure `internalTenants: ["own_key", "other_key"]`.

Manual `groups[chat_id].internal` and `gateMode` settings take precedence over
automatic evidence. Leave `internal` absent to enable automatic classification;
remove it to return to automatic classification. `gateMode` supports `off`,
`observe`, `auto`. A group classified as external still requires a bot mention
(or reply to the bot) for delivery; other messages are retained as context.

### Re-judging on change (issue #162)

A cached verdict is not final. Three things void it and re-judge the group:

1. **Member joined or left.** Subscribe the app to `用户进群`
   (`im.chat.member.user.added_v1`), `用户出群` (`im.chat.member.user.deleted_v1`)
   and `撤销拉用户进群` (`im.chat.member.user.withdrawn_v1`) under 消息与群组. The
   verdict changes **synchronously**, before the handler awaits anything, so a
   message right behind the event is already treated conservatively: an outside
   tenant joining makes the group external at once, any other membership change
   voids the cache (`internal: false, retry: true`) until `im.chat.get` answers.
   A lookup that says `external: false` cannot cancel a newer outside-join event.
   Without the subscription nothing breaks; the group stays on the 24h cache.
2. **`internalTenants` or `bot.tenant_key` changed.** The next message (and the
   config watcher, on a hot reload) voids **every** group's verdict — not only
   the "external sender" evidence — and judges the group by the new list. No
   restart and no manual cache clear.
3. **A lookup failed.** The group is external, and the reason is recorded:
   `permission_denied` (the scope Feishu named) versus `refresh_failed` (network,
   timeout, anything ambiguous) are kept apart.

Every verdict, its source and the reason are written to
`~/zylos/components/feishu/status.json` together with the startup scope check
(`im:message.group_msg`, `tenant:tenant:readonly`): each scope is `granted`,
`missing` or `unknown`, and `unknown` is never reported as granted.

C4 supplies `C4_OUTBOUND_ID` (`C4_DELIVERY_ID` is an alias). The sender passes it
as the Feishu `uuid`; later chunks use `:<index>`. The last stdout line is
`C4_RESULT {"status":"sent","platform_msg_id":"om_…"}` on confirmed success.
Failures exit nonzero with `status: failed`; `uncertain: true` requires verification
before any retry. Chunked sends return the last confirmed platform message ID.

## Worker Sessions Cannot Send

`scripts/send.js` refuses to run when `ZYLOS_TICKET_ROLE=worker` and exits
non-zero, before argument parsing, so neither text, cards nor media reach the
Feishu API. A worker reports through `progress`/`report`/`ask`/`handback` and the
front desk sends the result. Any other value, or no value, behaves as before.

**This is a default guard, not a security boundary.** It stops a worker that
follows its instructions; it does not stop one that runs the Feishu API directly,
unsets `ZYLOS_TICKET_ROLE`, or writes the instance database — worker sessions run
under the same system user as the front desk. Real isolation (separate OS
identity, no channel credentials, read-only instance database, tool access
confined to one ticket) is next version, together with the key cabinet.

## Known Limitations

- **Multi-chunk replies only record the last platform message id.** Outbound rows
  keep one `platform_msg_id`; a long reply split into several Feishu messages
  stores only the final chunk's id (`wt-feishu/src/lib/c4-delivery.js`). Every
  chunk still carries a stable `uuid` (`<id>:<index>`), so a replay does not
  duplicate messages. What is missing is a per-chunk mapping: a person who quotes
  an *earlier* chunk cannot have that reply matched back to the ticket by platform
  message id. Accepted for v1 (review R1 optional item 1) — adding it needs a
  mapping table or several outbound rows per send, plus changes to the ticket
  reply matching and its tests.
- **Group classification is only as good as the Feishu fields.** The automatic
  internal/external decision trusts `chat.external` and the sender's
  `tenant_key`. 〔Unverified against the real Feishu API in this repository〕 Both
  fields need the corresponding permission scopes; when a lookup fails the group
  is treated as external until a lookup succeeds.
- **The membership events are built from the documented payload, not from a live
  push.** `im.chat.member.user.added_v1` / `.deleted_v1` / `.withdrawn_v1` and
  their `chat_id` + `users[].tenant_key` fields come from the SDK type
  definitions (`@larksuiteoapi/node-sdk` 1.58.0). The re-judge itself was only
  exercised with constructed events; nobody has yet pulled a real outside member
  into a real group while watching the bot. 〔未验证：真人拉外部成员入群〕
- **A membership event only re-judges groups the bot already knows.** A group the
  bot has never received a message from has no `groups[chat_id]` row, and an
  event must not create one (that would turn an event into an allowlist entry).
  The first message from that group classifies it as before.

## Documentation

- [SKILL.md](./SKILL.md) — Component specification
- [DESIGN.md](./DESIGN.md) — Architecture and design
- [CHANGELOG.md](./CHANGELOG.md) — Version history

## Contributing

See [Contributing Guide](https://github.com/zylos-ai/.github/blob/main/CONTRIBUTING.md).

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

We built Zylos because we needed it ourselves: reliable infrastructure to keep AI agents running 24/7 on real work. Every component is battle-tested in production at Coco, serving teams that depend on their AI employees every day.

Want a managed experience? [Coco](https://coco.xyz/) gives you a ready-to-work AI employee — persistent memory, multi-channel communication, and skill packages — deployed in 5 minutes.

## License

[MIT](./LICENSE)