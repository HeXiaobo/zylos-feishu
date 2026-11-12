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
- **群聊显式触发** — 默认只有 @机器人 才处理；可信群可显式启用兼容 smart 模式
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
| 显式配置为 smart 的群消息 | 免 @ 评估；无关或未授权的被动消息保持静默，且不触发结构化任务摄取 |
| 管理员在任意群 @机器人 | 除非群聊被全局禁用，否则回复 |
| 放行租户 / 跨租户同事 | 按群成员处理 |
| 未知用户 | 默认静默忽略（`groupRejectMode: "silent"`） |

群发送者策略支持按租户放行：`groupAllowTenants` 放行整个飞书租户，群的
`allowTenants` 覆盖全局名单，`internalCrossTenantUsers` 单独放行跨租户同事
（open_id/user_id）。三种授权是并集：群的 `allowFrom`、跨租户名单、租户名单
任一条命中即放行，所以保留旧 `allowFrom` 名单的群在打开租户放行后不会失效。
这套限制同样作用于 `groupPolicy: "open"` 放行的未登记群。被拒绝的发送者默认
静默忽略；设为 `groupRejectMode: "reply"` 时，只在被精确 @机器人 时用
`groupRejectText` 回复一次。群聊里的所有拒绝（禁用群、未登记群、发送者不允许）
都按这个设置处理；owner 不会收到拒绝消息，私聊拒绝不受影响。以上字段都不配置
时，群聊行为与旧版本一致。所有名单只写在 `config.json`，代码里不写死任何租户
或人员。

已知限制：历史消息回填不按发言人过滤（飞书历史接口不返回可信的
`tenant_key`），实时入口已拒绝的消息仍可能作为上下文出现在后续允许的消息里。

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
`logs/member-access-audit.jsonl`。群聊中的任务与 WorkIntake 始终要求精确
@机器人；smart 模式只兼容普通对话，免 @ 消息不会映射进结构化任务协议。
显式配置的群以自身 `allowFrom` 作为发送者策略（包括外部成员）；全局成员
策略继续保护私聊，以及由 `groupPolicy: "open"` 放行但未显式配置的群。
WorkIntake 仍要求精确 @机器人，并且必须配置专用 capability。

群发送者策略同时支持按租户放行：`groupAllowTenants` 放行整个飞书租户，
群的 `allowTenants` 覆盖全局名单，`internalCrossTenantUsers` 单独放行跨租户
同事（open_id/user_id）。被拒绝的发送者默认静默忽略
（`groupRejectMode: "silent"`）；设为 `"reply"` 时，只在被精确 @机器人时
用 `groupRejectText` 回复一次。以上字段都不配置时，群聊行为与旧版本一致。
所有名单只写在 `config.json`，代码里不写死任何租户或人员。
稳定的确认数据会先写入本地 `0600` outbox；每次投递都重新签发确认卡，
临时故障或进程重启后会用同一个 Feishu UUID 自动重试。

## 既有 Task v2 纳管（一次性）

`scripts/task-v2-legacy-adoption-bootstrap.js` 用于把已经存在、且已经有
Commitment Core `feishu-task-v2` ExternalLink 的 Task v2 卡补上 Core marker。
默认命令是只读 stable double-read plan；只有显式提供 `--commit` 才会逐项调用
`task-v2-legacy-adoption` 深模块。它不会创建、完成、取消或删除任务，且首个
失败会停止并在 JSON 回执中标出已完成和未执行项目。

manifest 只允许精确的 `appId`、`taskGuid`、`coreTaskId` 和可选的
`coreTaskVersion`：

```json
{
  "schema": "zylos.feishu-task-v2-legacy-adoption/v1",
  "appId": "cli_example",
  "entries": [
    { "taskGuid": "<existing-task-guid>", "coreTaskId": "<core-task-id>", "coreTaskVersion": 1 }
  ]
}
```

从临时源码目录运行时，只需让该目录拥有自身依赖，并将凭证放在指定的
`--env-file`（或 `ZYLOS_DIR/.env`）中：

```bash
node scripts/task-v2-legacy-adoption-bootstrap.js --manifest /tmp/manifest.json
node scripts/task-v2-legacy-adoption-bootstrap.js --manifest /tmp/manifest.json --commit
node scripts/task-v2-legacy-adoption-bootstrap.js --manifest /tmp/manifest.json --commit \
  --gate-core-inventory /tmp/core-inventory.json
```

最后一个命令会在全部 marker 纳管成功后调用现有 native-task conservation gate；
gate 失败仍返回 `HOLD`，不会回避门禁。

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

## 升级此 fork

给 Agent 本仓库链接，并说明最新版或目标版本即可。按 [UPGRADE.md](UPGRADE.md)
只升级 Feishu，保留 Core/HXA；共享工具由 Agent 自行获取，不需要另发升级包。
