# zylos-feishu 路线图

本文档描述 zylos-feishu 当前的演进方向，取代 2026-02-15 的 `PLAN.md`
（已归档到 `docs/archive/plan-2026-02-15.md`）。`PLAN.md` 中 14 项早期改进
已全部落地，但仓库重心已转向 native Task 治理、CardKit 稳定性与
Smart-mode 响应策略；本路线图只覆盖这个新方向。

## 当前位置（0.3.7-rc.12）

最近四个 RC（rc.9 → rc.12）累积的能力与稳定性：

- native Task 闭环：`task-v2` envelope 持久化规范化、状态事件 inbox 去重
  + lease + 死信、projection 与 status 收据分离、Task v2 订阅 adapter。
- 提醒一致性：补提醒的 readback、失败即 fail closed、丢失响应可幂等重试。
- 状态调和：dry-run 走只读 SQLite 快照，`--repair-status` 才是唯一写路径。
- CardKit 稳定性：嵌套 image/file/table 失败回退到普通 patch；响应流 15
  分钟上限；启动时回收停滞 stream；所有续写卡必须 terminalize。
- 交互卡抽取：改用公开 Feishu message API + `user_card_content`，让
  Schema 2.0 markdown 走原通道。
- Smart 模式响应：默认沉默、必答 @mention、只在「别人不太可能补齐、沉默
  会导致错误动作或空等」时才补被动流量；已被回答的不再补。
- SDK 日志收口：Lark SDK 启动日志不再污染 stdout，机器可读脚本只输出
  一份 JSON。
- 治理门禁：发版/部署走 `zylos.release-manifest/v1` 与 40 字符 SHA 校验，
  feature 分支禁止 bump 版本。

## 候选 0.3.7 正式版

目标：从 rc.12 拉一条 0.3.7 stable，重点是「把 RC 期的修复沉淀为正式版」
而非引入新功能。

- 复核 rc.9 → rc.12 的 fixed 项是否需要 backport 到旧 release。
- 移除 `## [Unreleased]` 段，落地 0.3.7 正式 changelog（release manager
  负责 bump 三个标识 + manifest）。
- 跑一遍 `task-conservation:gate`、`task-status:gate`、`task-comments:gate`
  以及完整 `npm test`、治理 check，作为正式发布的硬条件。

## 候选 0.3.8 方向

新功能仅在以下三类情况下接受：

### 1. native Task 治理的下一档

- 当前 rc.12 已实现 conservation gate、status inbox、SDK adapter 的读回
  验证。下一步可考虑：把 conservation gate 接入发布流水线（在
  `governance:release` 前自动跑一次），让 conservation 失败阻断发版。
- 历史 marker 的一次性 bootstrap 已经落地，可考虑把 `task-v2-legacy-
  adoption-bootstrap` 改成幂等、可重复跑的安全模式。

### 2. CardKit / 响应流的稳定性

- 15 分钟超时是当前的硬上限，缺少运行时配置。如果出现长任务场景，可
  考虑把上限放到 `config.json` 可调，并保留文档说明。
- CardKit 嵌套回退目前是「遇错即降级」，可以考虑累积嵌套失败的指标，
  在达到阈值时主动告警（避免在用户群里静默降级）。

### 3. Smart 模式响应

- 当前策略是「默认沉默 + 显式 @mention 必答 + 少数被动补齐场景」。
  后续可考虑为 Smart 群加 per-group 覆盖，让 owner 可临时打开
  「被动必答」开关；这需要在 policy 层做严格审计，避免静默回退到噪音
  模式。

## 不在路线图上的事项

- Streaming Card 回复：仍按 2026-02-15 计划推迟（涉及 C4 重大改动，
  Claude Code 侧支持待确认）。
- 动态 Agent 创建：推迟。
- Bot 入群自动加白：Howard 已确认不做。

## 治理约束

- feature 分支（`feat/*`、`fix/*`、`chore/*` 等）不得 bump
  `package.json` / `package-lock.json` / `capabilities.json` / SKILL
  frontmatter 中的版本号。
- 发版/部署命令只能接受 40 字符完整 SHA + 外部 manifest，禁止解析
  `latest`、短 SHA、tag 或可变 label。
- 任何写到员工 runtime 或停止服务前必须做 identity probe，比对 Agent
  名 / `profileId` / hostname 与目标 runtime。
- PR 需保持三方版本一致；治理门禁 `npm run governance:check -- --base
  origin/main` 必须绿。

## 相关文件

- `CHANGELOG.md`：变更记录。
- `capabilities.json`：协议契约（requires / provides）。
- `SKILL.md`：组件对外能力说明。
- `docs/archive/plan-2026-02-15.md`：历史改进计划归档。
- `scripts/agent-governance-check.js`：发版/部署门禁。
