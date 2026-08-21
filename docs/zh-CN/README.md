# dsh-synapse 中文指南

`dsh-synapse` 是 DeepSeek Harness（DSH）的 Web 插件。它在 DSH 原生对话界面上增加会话地图，把同一工作区中的会话、追问和分支组织成可浏览、可拖拽和可缩放的画布。

插件不替代 DSH 的模型、工具、会话、权限或 Web 服务；所有对话操作仍由 DSH 完成。

## 前提条件

- 支持 `dsh plugin` profile 插件机制的 DeepSeek Harness（2026-08 或之后版本）。
- Node.js `>= 22.19.0`。
- 使用 `web` profile；其他 profile 暂不支持。

## 安装

### 从 GitHub 安装

```powershell
corepack pnpm dsh plugin --profile web add github:liangmianya/dsh-synapse
```

GitHub 安装会运行本包的 `prepare` 脚本，通过 `node --check` 验证 JavaScript 语法。

### pnpm 10+ 的 allowBuilds

pnpm 10 及之后版本默认可能阻止 Git 依赖执行构建脚本。如果安装被拦截，请将 pnpm 输出的**完整键**复制到 DSH Web profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  "dsh-synapse@https://codeload.github.com/liangmianya/dsh-synapse/tar.gz/<commit>": true
```

必须使用包含 tarball URL 和 commit 的完整键，不能只填写裸包名 `dsh-synapse`。上游 commit 变化后，键也会变化；届时使用 pnpm 新输出的值。

### 本地开发安装

```powershell
corepack pnpm dsh plugin --profile web add link:E:\path\to\dsh-synapse
```

`link:` 会直接引用本地 checkout，适合开发和调试。普通运行模式下修改代码后，建议重启 `dsh web` 并刷新页面。

## 启动

```powershell
corepack pnpm dsh web
```

默认地址：

```text
http://127.0.0.1:3080/
```

如果 3080 被占用，可以让 DSH 自动选择端口：

```powershell
corepack pnpm dsh web --port 0
```

启动后点击顶部“会话地图”进入 Synapse。不要同时运行两个共享同一 profile 的 `dsh web` 实例。

## 使用方式

1. 在 DSH 中选择工作目录，或打开已有会话。
2. 发送至少一条消息，使会话进入工作区历史。
3. 点击顶部“会话地图”。
4. 点击卡片或侧边栏会话，在地图与原生对话之间同步当前会话。
5. 使用“分支”从已完成的回答创建替代路径。
6. 点击卡片底部“详情”查看完整会话记录。
7. 使用“打开 DSH”或顶部“对话”返回原生对话界面。

画布支持：

- 拖动画布和缩放视图（最高 4×）。
- 拖动卡片并自动保存位置。
- 一键定位当前会话。
- 卡片内部平滑滚动和 Markdown 表格渲染。
- 将工具调用和结果按 `callId` 折叠到对应助手回答中。

## 配置

插件通过 profile 的 `cordis.patch.yml` 注入。可以在自己的 patch 中通过行 id `synapse` 覆盖配置。

> DSH patch 会整体替换该行的 `config`，覆盖时需要重述所有需要保留的键。

| 键 | 默认值 | 说明 |
|---|---|---|
| `dataFile` | `$DSH_HOME/synapse/workspaces.json` | 画布元数据持久化文件 |
| `autoProjection` | `true` | 自动将已提交的 DSH 会话事件投影为卡片 |
| `projectionWorkspaceTitle` | `DSH 任务` | 自动投影工作区的标题 |
| `trustedHosts` | `[]` | `/synapse` Host 检查额外允许的主机名或 `主机:端口`；`localhost` 和 `127.0.0.1` 始终允许 |

配置示例：

```yaml
- id: synapse
  config:
    dataFile: !!js dshHomePath('synapse/my-workspaces.json')
    autoProjection: true
    projectionWorkspaceTitle: 我的任务
    trustedHosts: []
```

局域网访问时，需要将实际访问主机加入 `trustedHosts`。

## 卸载与数据清理

卸载插件：

```powershell
corepack pnpm dsh plugin --profile web remove dsh-synapse
```

`remove` 只移除插件依赖和 profile 激活层，不会删除画布数据。重新安装后，旧数据会继续使用并按需迁移。

彻底清理时，手动删除：

```text
$DSH_HOME/synapse/
```

`pnpm-workspace.yaml` 中遗留的 `allowBuilds` 键没有副作用，也可以一并移除。

## 数据与运行边界

- DSH session log 保存真实对话内容。
- Synapse 的 `workspaces.json` 只保存画布元数据、布局和分支锚点。
- 删除 `workspaces.json` 会丢失画布布局，但不会删除 DSH 会话。
- 插件不启动第二个 Web 服务，也不创建第二套 Agent。
- 插件只读取已经提交的会话事件，不修改模型请求、系统提示、工具 schema 或 KV cache 前缀。

更详细的内部说明见[架构与运行边界](../architecture.md)。

## 已知限制

- 仅支持 `web` profile。
- 两个 DSH Web 实例共享同一个 profile 时会写入同一个 `workspaces.json`。虽然存在跨进程写锁和外部修改警告，仍可能出现最后写入覆盖，请只运行一个实例。
- v3 数据迁移时，旧工具卡片按顺序将每次调用与下一条结果配对；实时事件使用 `callId`。

## 开发与发布

贡献者命令、GitHub Actions 和 npm 发布流程见[开发与发布指南](../development.md)。

返回[项目主页](../../README.md)。
