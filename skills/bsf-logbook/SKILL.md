---
name: bsf-logbook
description: 文档维护：按 myworkflow 文档体系记录目标、进度、状态与结论。触发：更新文档、同步进度、记录结论、文档维护。
---

## 体系识别

| 现象 | 处理 |
|---|---|
| `CLAUDE.md` + `docs/{GOAL,STATE,PROGRESS}.md` + `docs/design/index.json` | 新体系，按下文做 |
| 根目录 `CLAUDE.md` + `PROGRESS.md` + `PROGRESS-LITE.md` + `STRUCTURE.md`（无 GOAL/STATE） | 旧四文件体系，走迁移三选一 |
| 两者并存 | 半迁移，走三选一，缺什么补什么 |

旧体系/半迁移先问用户三选一：**现在迁移 / 暂不迁移 / 永久不改**。迁移只做复制+归档，不移动、不删除：`PROGRESS-LITE.md` 条目 → `docs/PROGRESS.md` 条目区，`PROGRESS.md` → 版本记录区，`STRUCTURE.md` 原地保留。暂不迁移按旧体系写，每次会话只提示一次。永久不改在 `CLAUDE.md` 末尾追加「本项目不迁移文档体系（用户决定 YYYY-MM-DD）」，之后直接跳过。

## 开工前必读

- 必读：`CLAUDE.md`（规则）、`docs/STATE.md`（现在在哪）、`docs/PROGRESS.md` 条目区（最近做了什么）。
- 按需：`docs/GOAL.md`（是否偏航）、`docs/design/index.json`（做什么、做到哪）、`docs/information/index.json`（踩过的坑、用户偏好）、`STRUCTURE.md`（找文件）。
- 大文件先 Grep 定位再读命中段。

## 开工门禁

- 先回答一句话：本次改动对应 `docs/design/index.json` 里的哪个点号？记下点号，收尾更新它的状态。
- 新增功能 / 行为变更 / 新模块 → 先补 design 再动手；bug 修复 / 重构 / 配置 / 文档 / 格式化 → 豁免，但条目末尾标「本次无 design，小场景豁免」。
- 补 design：`design-NN-<主题>.md` 取现有最大编号 +1，含背景 / 需求 / 验收标准 / 点清单四节；点号 `design-01-P1` 全局唯一；只写要什么，不写函数签名、数据结构、算法步骤、目录布局。写完回望 GOAL，冲突就停下让用户在改 GOAL 与改 design 之间选。
- 两个 `index.json` 由本技能独家写入。

## 收尾同步

- `docs/PROGRESS.md` 条目区：新条目插在最上，一行一条 `- [标签][vX.Y.Z] 一句话做了什么`，标签 `[New Feature]` / `[Debug]` / `[Change]` / `[Build]`；只写做了什么，根因留给版本记录区。
- `docs/PROGRESS.md` 版本记录区：本版本一段，按 问题/动机 → 根因（仅 bug 修复）→ 修改（文件清单 + 点号）→ 验证（命令 + exitCode）写全。
- 版本号：只有项目有明确版本策略或用户要求时才递增；有 `package.json` 等清单时以其 `version` 为准，与 PROGRESS 头部不同就显式记一行。
- `docs/design/index.json`：四态封闭枚举 未开发 / 阻塞 / 待验收 / 完成（「开发中」由 STATE 承载，不进 index）；`evidence` 为空的点不得置待验收；只有用户本轮明确说「确认没问题 / 可以了 / 通过了」才置完成；置阻塞要写卡在哪、缺什么；流转后更新 `points[].updated`。
- `docs/STATE.md`：只写现在——最后刷新、当前版本、正在做、卡住的、下一步、等验收；历史内容移入 PROGRESS。
- `docs/information/`：本次确实学到的东西按主题追加 `info-NNN` 并写 index。
- `STRUCTURE.md`：仅在新增 / 删除 / 重命名文件或目录时更新。

## 校验

- 悬空：`designs[].file` 与 `points[].file` 每项都要能在 `docs/design/` 下定位到，定位不到就修。
- 孤儿：`docs/design/` 实际 `.md` 集合与 index 的 `file` 集合必须相等。
- 状态抽查 ≥3 个 design 文件：逐点比对文件点清单表的点号 / 状态 / evidence 与 index，按 index 修正文件。
- 变更覆盖：`git diff --name-only HEAD~1` 或 `git status --short`；无 git 用本会话写记录 + 文件 mtime。每个变更文件都要在版本记录区有记录。

## 新项目

目标文件夹没有 `CLAUDE.md` / `docs/` 时，按原体系建八个位置：`CLAUDE.md`、`STRUCTURE.md`、`docs/GOAL.md`、`docs/PROGRESS.md`、`docs/STATE.md`、`docs/design/`、`docs/information/`、`docs/research/`；再建两个 `index.json` 初始文件（四态枚举 + 空 designs/points/entries）并指派单写者。

## 什么时候会用到别的 skill

- 需求复述需要落盘 → **bsf-parrot** 的落盘动作。
