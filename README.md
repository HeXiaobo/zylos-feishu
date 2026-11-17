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

Outbound text is sent as an interactive card when it contains markdown, provided
`message.useMarkdownCard` is enabled. Set `message.alwaysCard: true` to send
**every** message as a card, including plain text (default: `false`, i.e. only
markdown-bearing messages become cards).

## C4 Compatibility Options

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
