# blacksailflow 安装 / 校验 / 卸载

三步完成：安装 → 校验 → （需要时）卸载/回退。安装与卸载都是幂等的、不覆盖用户已有配置。

## 0. 前置

- 已安装 DSH（本仓库按 DSH `0.2.1-rc.5` 开发）。
- node：用运行安装器的那个 node（安装器注册的 hook 命令也指向它）。
- 本仓库已 clone 到本机，命令都在仓库根目录执行。

## 1. 安装

```
node release/install.mjs
```

默认值：`--dsh-home=$DSH_HOME 或 ~/.dsh`、`--profile=desktop`、`--repo=<本仓库>`。
其它环境显式传参：

```
node release/install.mjs --dsh-home=/home/me/.dsh --profile=desktop --repo=/opt/blacksailflow
```

写入内容（每项都先比对，内容相同就不动文件；被改写的文件先备份到 `<profile>/bsf-install-backup/<时间戳>/`）：

| 步骤 | 位置 | 内容 |
|---|---|---|
| 任务表 | `<dsh-home>/blacksailflow/manifest.json` | 不存在时建空表 `{rev:0,tasks:[],archived:[]}` |
| 技能 | `<dsh-home>/skills/bsf-*/SKILL.md` | 从仓库 `skills/bsf-*/SKILL.md` 逐字节复制 8 个 |
| 依赖 | `<profile>/package.json` | `dependencies['@local/blacksailflow']=link:<repo>/runtime-plugin`；`dsh.profile.bundles` 追加一项（空数组时先补 base/web-app） |
| 链接 | `<profile>/node_modules/@local/blacksailflow` | 直接建 junction/symlink，免跑包管理器 |
| 装配块 | `<profile>/cordis.patch.yml` | 缺 `hooks-claude-code` 行时补一行指向本 profile 的 hooks.json（已在则不动） |
| hooks | `<profile>/hooks.json` | 合并 `SessionStart` / `UserPromptSubmit` / `Stop` 三个事件（已存在同类条目跳过） |
| 可选 | `<profile>/cordis.patch.yml` | `--with-probe-preset` 时额外写探针 preset（`bsf-probe-filter` + 影子行） |

环境变量覆盖（插件配置优先级最高，其次环境变量，最后相对安装位置，见 `runtime-plugin/paths.mjs`）：

```
DSH_HOME           DSH 主目录
BSF_MANIFEST       任务表路径
BSF_HOOK_DIR       身份/规则 markdown 目录
BSF_SESSIONS_ROOT  会话日志根
BSF_PROJECT_ROOT   bf_brief 进度查询的项目根
BSF_ROLE_PROBE     角色探针输出文件
BSF_STATE_DIR      钩子状态目录
```

先看会改什么（不落盘）：`node release/install.mjs --dry-run`。
安装后重启 DSH 才装载新插件；preset 改动同样在重启后由新会话生效。

## 2. 校验

```
node release/verify-install.mjs
```

逐项打印 PASS/FAIL，任一失败 exit 1。检查：插件入口与 bundle patch、profile 依赖/链接/bundles、装配块与 hooks-claude-code 行、三个 hook 事件的脚本真实存在、任务表可读、8 个技能与源文件逐字节一致、安装状态文件（以及可选探针 preset）。

## 3. 卸载 / 回退

```
node release/uninstall.mjs            # 只删安装器写入的内容，用户自己的配置保留
node release/uninstall.mjs --restore  # 额外把安装前备份覆盖回去
```

卸载删除：装配块（含可选探针 preset 块）、命令里指向本仓库插件 hooks 的 hook 条目、profile 依赖与 bundles 项、node_modules 链接、安装器创建的技能文件与（仍为空的）任务表、安装状态文件。用户自己写的 patch 行与 hook 条目不动。

回退后 `node release/verify-install.mjs` 应当 exit 1（安装已不存在），这是预期结果。

## 4. 安装器自测

```
node release/test-install.mjs   # 临时 DSH home 里跑 安装→再安装（幂等）→校验→卸载(--restore)→校验失败
```

## 5. 发布包

```
node release/pack.mjs
```

按白名单生成 `release/out/blacksailflow-<version>/`，写 `MANIFEST.json` 与 `SHA256SUMS`；打包时自检包内只有产品文件（dev-only 零泄漏）。`release/out/` 是构建产物，不入库。
