# AGENT.md — agent 安装与配置指南

给「照着做就能把环境配好、验好、退好」的 agent 看。人看的介绍在 `README.md`，逐项写入说明在 `release/README.md`。

## 0. 前置

- 系统：Windows（安装器建 junction、hooks.json 命令使用 Windows 绝对路径）。
- DSH（DeepSeek Harness）：`0.2.1-rc.5`。本仓库依赖它的 hooks 桥接协议、`tool-subagent` preset 选择、agent preset 挂载时机、会话日志布局、skills 分层合并；其它版本先复验再用。
- Node：用**运行安装器的那个 node 的绝对路径**（安装器把 `process.execPath` 写进 hooks.json 命令），路径随机器不同，不要手写。
- 仓库已 clone/解压到本机，命令都在仓库根执行。

## 1. 需要配置什么

| 位置 | 内容 | 谁写 |
|---|---|---|
| `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`） | 宿主主目录；下面所有路径的根 | 系统/用户 |
| `$DSH_HOME/profiles/<profile>/`（默认 profile=`desktop`） | profile 目录，安装目标 | 安装器 |
| `<profile>/package.json` | `dependencies["@local/blacksailflow"]="link:<repo>/runtime-plugin"`；`dsh.profile.bundles` 追加 `@local/blacksailflow`（空数组时先补 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`） | 安装器 |
| `<profile>/node_modules/@local/blacksailflow` | 指向 `<repo>/runtime-plugin` 的 junction | 安装器 |
| `<profile>/cordis.patch.yml` | **只**在缺 `hooks-claude-code` 行时插入带起止标记的装配块；插件行由 `runtime-plugin/cordis.patch.yml` 这个 bundle patch 自己 insert，**不要**再手写同 id 的 `blacksailflow` insert（会重复 id） | 安装器 |
| `<profile>/hooks.json` | 三个事件：`SessionStart`、`UserPromptSubmit` → `task-discipline-hook.mjs`（带 `--event=…`）；`Stop` → `stop-autoloop.mjs`；命令形如 `"<node 绝对路径>" "<repo>/runtime-plugin/hooks/xxx.mjs"` | 安装器 |
| `$DSH_HOME/skills/<name>/SKILL.md` | 8 个 `bsf-*` 技能，从 `<repo>/skills/bsf-*/SKILL.md` 逐字节复制 | 安装器 |
| `$DSH_HOME/blacksailflow/manifest.json` | 任务表（唯一任务状态源）；不存在时建 `{rev:0,tasks:[],archived:[]}` | 安装器 |
| `<profile>/bsf-install-state.json` | 安装状态（adopt 判断用，卸载时删除） | 安装器 |

环境变量（插件 config 优先级最高，其次环境变量，最后相对插件目录/`DSH_HOME` 的默认值；解析在 `runtime-plugin/paths.mjs`）：

```
DSH_HOME          宿主主目录
BSF_MANIFEST      任务表路径（默认 $DSH_HOME/blacksailflow/manifest.json）
BSF_HOOK_DIR      注入正文目录（默认 <repo>/hooks）
BSF_SESSIONS_ROOT 会话日志根（默认 $DSH_HOME/sessions）
BSF_PROJECT_ROOT  bf_brief 读进度文件的项目根（默认 <repo> 的上级项目根）
BSF_ROLE_PROBE    角色探针输出路径
BSF_STATE_DIR     钩子状态目录（默认 $DSH_HOME/blacksailflow）
```

## 2. 安装

```bash
node release/install.mjs --dry-run                          # 只看会改什么，不落盘
node release/install.mjs                                    # 默认 --dsh-home=$DSH_HOME|~/.dsh --profile=desktop --repo=<repo>
node release/install.mjs --dsh-home=D:\dsh --profile=desktop --repo=D:\blacksailflow
node release/install.mjs --with-probe-preset                # 额外写探针 preset（验证技能可见性用）
```

幂等：内容相同不碰文件；被改写的文件先备份到 `<profile>/bsf-install-backup/<时间戳>/`；只增补缺项，不删用户已有配置。

## 3. 校验

```bash
node release/verify-install.mjs
```

逐项 PASS/FAIL，任一失败 `exit 1`。检查：插件入口与 bundle patch、profile 依赖/链接/bundles、装配块与 `hooks-claude-code` 行、三个 hook 事件脚本真实存在、任务表可读、8 个技能与源文件逐字节一致、安装状态文件、（可选）探针 preset。

## 4. 验收（脚本之外必须做一次手工）

1. 重启 DSH 或开一个**新会话**（旧会话不加载新插件与 preset）。
2. 在新会话里 spawn 一个 teammate（agent team 工具）。
3. 让它跑一个任务：`bf_manifest_list` → `bf_manifest_add` → `bf_manifest_claim` → `bf_manifest_update`（`status=done` 会跑 acceptance 里的 `verify.command`）。
4. 该 teammate 回合结束后，用 `send_message` 再发一句话——应能唤醒并继续（这是最容易坏的一环：消息事件缺 `id` 会让会话判 corrupt、从侧栏消失）。
5. 结论：`bf_brief kind=progress` 能读到 `docs/STATE.md`、`docs/PROGRESS.md` 与两个 `index.json`（项目里有 docs 时）。

## 5. 回滚

```bash
node release/uninstall.mjs             # 只删安装器写入的内容，用户自己的配置保留
node release/uninstall.mjs --restore   # 再把安装前备份覆盖回去
```

回滚后 `node release/verify-install.mjs` 应 `exit 1`（安装已不存在），这是预期结果。

硬约束：

- **改 `runtime-plugin/` 里的模块必须重启宿主**（已 import 的模块不会热替换）。
- **改 `<profile>/cordis.patch.yml` 等 profile patch 必须重启**（文件改了不会热应用，已实测）。
- 改 `hooks/*.md` 注入正文、改 `skills/bsf-*/SKILL.md` 后要重跑 `install.mjs`（它是逐字节复制），技能清单在新会话才刷新。

## 6. 文件地图（仓库内每个产品文件干什么）

```
AGENT.md                         本文件：agent 安装/配置/验收/回滚/排障
README.md / README.en.md         产品介绍（中文/英文）
LICENSE                          MIT
.gitignore                       只允许产品文件入仓；docs/ 与内部材料全部忽略

runtime-plugin/
  index.js                       插件入口：bf_* 任务表工具、bf_brief 进度查询、hand 权限拦截
  roles.mjs                      角色钩子：身份注入、按档命令面、tool-subagent 包装、直写拦截
  hook-forms.mjs                 三种 hook 形态的解析与拼装
  fold-titles.mjs                已完成 hand 折叠
  goal-rearm.mjs                 会话重启后重新装配 goal
  paths.mjs                      唯一路径解析点（config > 环境变量 > 相对位置）
  cordis.patch.yml               bundle patch：插入 id=blacksailflow 一行（不含机器绝对路径）
  package.json                   插件清单（version 给 pack.mjs 用）
  icon.svg / locale/{en,zh}.json 插件图标与文案
  hooks/task-discipline-hook.mjs 会话启动/每轮提示的身份与纪律注入 + hook 状态节流
  hooks/stop-autoloop.mjs        回合结束后决定是否继续自主循环

hooks/
  captain-charter.md               captain 身份与群边界条款（运行时注入）
  mate-duties.md / hand-duties.md   mate / hand 职责正文
  mode-single-task.md              hand 档工作方式（单任务）
  mode-single-group.md             mate 档工作方式（单群）
  resident-rules.md                三档共用常驻规则（每轮注入 + 压缩后重锚）
  untiered-guide.md                未定档会话的引导语

skills/bsf-*/SKILL.md             8 个 bsf-* 技能正文（安装器逐字节复制到 $DSH_HOME/skills/）
preset-probe/
  skill-shadow.mjs                可选探针 preset 的影子脚本
  _bsf-preset-block.patch.yml     探针 preset 的 patch 模板

release/
  install.mjs                     安装器（幂等、备份、dry-run）
  uninstall.mjs                   卸载器（--restore 还原备份）
  verify-install.mjs              安装校验
  test-install.mjs                安装器自测（临时 DSH home，不碰本机安装）
  pack.mjs                        生成发布包 + 必需文件/泄漏自检
  lib.mjs                         安装器公共函数
  README.md                       安装细则（写入位置、环境变量、自测）
```

## 7. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 装载报 `duplicate id: blacksailflow` 或插件行重复 | 手写过插件的 `insert`，与 bundle patch 自带的那行撞了 | 删掉 profile patch 里手写的 `id: blacksailflow` insert 行，重跑 `install.mjs` |
| 改了 `runtime-plugin/*.mjs` 但行为没变 | 模块已被宿主 import，文件改动不热替换 | 重启 DSH；只切插件开关也可能不重载模块 |
| 改了 `<profile>/cordis.patch.yml` 没生效 | profile patch 不热应用（已实测） | 重启 DSH / 开新会话 |
| 新增或改了 `SKILL.md`，模型目录里看不到 | 技能清单在会话启动时读入 | 开新会话（必要时重启） |
| 会话从侧栏消失，`send_message` 报 `subagent "<id>" is unavailable` | 会话日志里的消息事件缺 `id`，冷读被判 corrupt | 备份并移出该死会话目录后重启；或从备份恢复（本仓库不带修复脚本） |
| `verify-install.mjs` 报「FAIL 安装状态文件存在」 | 之前装过但状态文件缺失 | 直接重跑 `install.mjs`（会补写状态文件，配置不动） |
| `pack.mjs` 报「发布包缺必需文件：X」或「白名单路径不存在：X」 | 文件被删/被 gitignore 误伤 | 确认文件在仓库且未被 `.gitignore` 命中，再重跑 |
| `hooks.json` 命令路径错 / 带空格不生效 | 手改过命令、没加引号 | 删掉该事件条目，让 `install.mjs` 重新生成（它写入带引号的 node 绝对路径） |
| 环境变量改了没效果 | 插件 config 优先级高于环境变量 | 查插件配置里的显式路径，或删掉该项后再用环境变量 |
