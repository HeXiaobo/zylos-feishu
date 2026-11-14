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

## Card Output

Outbound text defaults to interactive cards, including plain text. Set
`message.alwaysCard: false` for markdown-only cards, or
`message.useMarkdownCard: false` to disable cards. Explicit settings survive upgrades.

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
(or reply to the bot) for delivery; other messages are retained as context. No new
Feishu event subscription is required.

C4 supplies `C4_OUTBOUND_ID` (`C4_DELIVERY_ID` is an alias). The sender passes it
as the Feishu `uuid`; later chunks use `:<index>`. The last stdout line is
`C4_RESULT {"status":"sent","platform_msg_id":"om_…"}` on confirmed success.
Failures exit nonzero with `status: failed`; `uncertain: true` requires verification
before any retry. Chunked sends return the last confirmed platform message ID.

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