<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-feishu</h1>

<p align="center">
  <a href="https://github.com/zylos-ai/zylos-core">Zylos</a> 智能体的飞书通讯组件。
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
  <a href="./README.md">English</a>
</p>

---

- **通过飞书对话** — 你的 AI 智能体接入飞书，支持私聊和群聊
- **群聊显式触发** — 只有 @机器人 的群消息才会被处理
- **可信 Owner 配置** — 管理员身份必须显式配置，入站消息不能抢占管理员身份
- **丰富的飞书集成** — 文档、表格、日历 — 不止是消息收发

## 快速开始

告诉你的 Zylos 智能体：

> "安装飞书组件"

或使用 CLI：

```bash
zylos add feishu
```

Zylos 会引导你完成设置，包括配置飞书应用凭证。安装完成后，在飞书上给机器人发消息 — 第一个交互的用户自动成为管理员。

## 管理机器人

直接告诉你的 Zylos 智能体：

| 操作 | 示例 |
|------|------|
| 添加白名单用户 | "把用户 xxx 加入飞书白名单" |
| 查看状态 | "看下飞书机器人状态" |
| 重启机器人 | "重启飞书机器人" |
| 升级组件 | "升级飞书组件" |
| 卸载组件 | "卸载飞书组件" |

或通过 CLI 管理：

```bash
zylos upgrade feishu
zylos uninstall feishu
```

## 群聊行为

| 场景 | 机器人响应 |
|------|-----------|
| 私聊（管理员/白名单） | 通过 Claude 回复 |
| 在允许的群里 @机器人 | 带上下文回复 |
| 管理员在任意群 @机器人 | 始终回复 |
| 未知用户 | 忽略 |

## 自然语言 WorkIntake

WorkIntake 默认关闭。请在 `~/zylos/components/feishu/config.json` 中开启，
配置成员访问策略，并在 `~/zylos/.env` 中设置至少 32 字节的
`FEISHU_WORK_INTAKE_CONTEXT_SECRET`：

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

`mode` 支持 `owner`、`tenant_members`、`departments`、`allowlist`。
非 Owner 策略必须精确匹配租户；每次放行或拒绝都会写入
`logs/member-access-audit.jsonl`。群聊始终要求 @机器人，本构建不启用旧的
smart/免 @ 监听行为。
稳定的确认数据会先写入本地 `0600` outbox；每次投递都重新签发确认卡，
临时故障或进程重启后会用同一个 Feishu UUID 自动重试。

## 文档

- [SKILL.md](./SKILL.md) — 组件规格说明
- [DESIGN.md](./DESIGN.md) — 架构与设计
- [CHANGELOG.md](./CHANGELOG.md) — 版本历史

## 参与贡献

请查看[贡献指南](https://github.com/zylos-ai/.github/blob/main/CONTRIBUTING.md)。

## 由 Coco 构建

Zylos 是 [Coco](https://coco.xyz/)（AI 员工平台）的开源核心基础设施。

我们构建 Zylos 是因为我们自己需要它：可靠的基础设施，让 AI 智能体 24/7 稳定运行。每个组件都在 Coco 生产环境中经过实战检验，服务于每天依赖 AI 员工的团队。

想要开箱即用？[Coco](https://coco.xyz/) 提供即开即用的 AI 员工——持久记忆、多渠道沟通、技能包——5 分钟完成部署。

## 许可证

[MIT](./LICENSE)
