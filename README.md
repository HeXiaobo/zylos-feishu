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
- **Explicit group activation** — group messages are processed only when the bot is @mentioned
- **Trusted owner setup** — owner identity is explicitly configured; inbound messages cannot claim admin
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
| @mention in allowed group | Responds with recent context |
| Owner @mention in any group | Always responds |
| Unknown user | Ignored |

## Natural-language WorkIntake

WorkIntake is opt-in. Set `workIntake.enabled` in
`~/zylos/components/feishu/config.json`, configure a member policy, and provide
`FEISHU_WORK_INTAKE_CONTEXT_SECRET` (at least 32 bytes) in `~/zylos/.env`:

```json
{
  "workIntake": {
    "enabled": true,
    "timeZone": "Asia/Shanghai",
    "confirmationTtlMs": 900000
  },
  "memberAccessPolicy": {
    "mode": "tenant_members",
    "tenantKey": "your-tenant-key",
    "memberIds": [],
    "departmentIds": []
  }
}
```

`mode` can be `owner`, `tenant_members`, `departments`, or `allowlist`.
Non-owner policies require an exact tenant match and every decision is appended
to `logs/member-access-audit.jsonl`. Group intake always requires @mention;
the old smart/no-mention behavior is not used by this build.
Stable confirmation data is persisted to a local `0600` outbox before delivery.
Each attempt signs a fresh card, and transient failures or process restarts retry
with the same Feishu UUID.

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
