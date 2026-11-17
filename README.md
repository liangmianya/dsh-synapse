<h1 align="center">dsh-synapse</h1>

<p align="center">DeepSeek Harness 的可视化对话工作台</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-synapse"><img src="https://img.shields.io/npm/v/dsh-synapse?style=flat-square&logo=npm&label=npm" alt="npm version"></a>
  <a href="https://github.com/liangmianya/dsh-synapse/actions/workflows/main-tests.yml"><img src="https://github.com/liangmianya/dsh-synapse/actions/workflows/main-tests.yml/badge.svg?branch=main&style=flat-square" alt="Main branch tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/node/v/dsh-synapse?style=flat-square&logo=node.js&label=node" alt="Node.js version"></a>
</p>

<p align="center">
  <a href="docs/zh-CN/README.md">中文指南</a> ·
  <a href="docs/en/README.md">English guide</a> ·
  <a href="https://www.npmjs.com/package/dsh-synapse">npm</a> ·
  <a href="docs/development.md">开发与发布</a>
</p>

把同一工作区中的会话、追问和分支组织成一张可浏览、可拖拽、可缩放的地图，同时保留 DSH 原生会话作为唯一事实来源。

![Synapse 会话地图：链条、分支和右侧详情](docs/images/synapse-map.jpg)

## 快速安装

需要 DeepSeek Harness `>= 0.1.7-rc.2`（本插件依赖该版本的 Host 会话与 Client 服务接口）和 Node.js `>= 22.19.0`。

> **兼容性提示：** 本版本包含破坏性变更，仅支持 DeepSeek Harness `>= 0.1.7-rc.2`，不再兼容更早版本。

**先确认插件要装进哪一套 profile**。DSH 按 profile 分套安装插件，桌面 App 和命令行各用一套，互不影响：

| 你平时怎么用 DSH | 要装的 profile | 安装命令 |
|---|---|---|
| 桌面 App（DeepSeek Harness 客户端） | `desktop` | `dsh plugin --profile desktop add dsh-synapse` |
| 命令行 `dsh web` / 浏览器访问（如果你也维护了这套） | `web` | `dsh plugin --profile web add dsh-synapse` |

- 从 App 内的插件页面安装时，App 会自动装进它自己用的那套，不用管 profile。
- **自检口诀：装完顶部看不到「会话地图」开关，就是装到另一套去了**，把 `--profile` 换成另一套的名字再装一次即可。
- 桌面 App 装完需要**重启 App**（Host 侧插件在启动时加载）；命令行装的，重启 `dsh web` 并刷新页面。

`dsh` 是 DSH 运行时自带的 launcher，位于 App 安装目录的 `resources\runtime\cli\bin\dsh.cmd`。先确认它能调用：

```powershell
dsh --version
```

```powershell
# 装进桌面 App 那套 profile
dsh plugin --profile desktop add dsh-synapse

# 需要命令行形态时（装完重启 dsh web 并刷新页面）
dsh plugin --profile web add dsh-synapse
dsh web
```

启动后，在 DSH 顶部切换到 **会话地图**。Synapse 复用现有的 DSH Web Server，不会启动第二个应用或代理系统。

## 反向代理与子路径部署

支持部署在根目录或 `/dsh/` 等子路径下。入口、静态资源和 API 会保留 DSH 页面所在的对外目录；代理需剥掉子路径前缀，并将请求转发到 DSH 的根路由。例如：

```nginx
location /dsh/ {
    proxy_pass http://127.0.0.1:3080/;
}
```

`proxy_pass` 的尾斜杠用于剥掉 `/dsh/` 前缀。启动时使用 `dsh web --public-url https://example.com/dsh/`，浏览器也从这个带尾斜杠的地址进入。Synapse 配置中的 `trustedHosts` 需包含对外主机名（例如 `example.com`）。无需额外添加站点根目录的 `/synapse` 跳转规则；更新插件后重启 DSH。

## 它解决什么问题

| 能力 | 说明 |
|---|---|
| 对话地图 | 把连续追问、分支和不同会话放到同一张可操作的画布上。 |
| 保留真实分支 | 按 DSH 原生 fork 关系连接卡片，不制造另一套会话历史。 |
| 追问更顺手 | 选中回答中的文字可直接带入新的追问；常用补充词可编辑。 |
| 双向同步 | 在地图或 DSH 原生对话中切换会话，当前上下文保持一致。 |
| 过程不挡路 | 工具调用与结果按 `callId` 折叠进对应回答，只显示「工具 N」。 |
| 可移动入口 | 顶部「对话 / 会话地图」开关可拖动、记忆位置、双击复位。 |
| 详情侧栏 | 点卡片在右侧展开整轮详情：完整回答、工具过程、追问 / 分支 / 打开 DSH。 |
| 归档一致 | 归档在地图与 DSH 侧栏之间共用同一份集合，不会各记一套。 |

## 最近更新

当前开发分支修正了真实对话的轮次识别：一张卡片对应用户的一次真实提问及其回复，系统注入和工具步骤不会增加轮次。缺少来源字段的历史及导入消息继续兼容。

升级后重启 DSH，会按原始会话日志的事件编号修复旧地图索引，并在首次修复前保留 `workspaces.json.projection-v2-backup`。真实消息标识、线程关系、颜色和手动位置保留；日志缺失、损坏或超出读取上限时保留旧记录，之后可在日志恢复后重启重试。

**0.5.6**

- 顶部开关可拖动、记忆位置（按浏览器）、双击复位、方向键微调，并保证不会被拖到屏幕外。
- 交互与渲染一致性修正：切会话会把该会话带入视野；折叠卡片不再移动画布；正文里有选区时侧栏与详情仍能更新；卡片右侧折叠 / 分支按钮不再被相邻卡片遮住。
- 工作区加载竞态修正：切换工作区不再被后台轮询顶掉；画布只在数据真变化时重建（此前每秒重建数次）。
- `workspaces.json` 读不出来时改为**明确报错并保持只读**，不再用旧备份覆盖原文件。

历史版本见[提交记录](https://github.com/liangmianya/dsh-synapse/commits/main)。

## 从原生对话进入

在 DSH 原生对话中，通过顶部的 **会话地图** 进入 Synapse；返回 **对话** 后，仍是同一个 DSH 会话。

这个开关挡着内容时可以挪走：**按住左侧六点手柄拖动**，位置按浏览器记住；**双击手柄**复位；手柄聚焦后可用方向键微调。

![DSH 原生对话与会话地图入口](docs/images/native-webui.jpg)

## 文档

| 文档 | 内容 |
|---|---|
| [中文指南](docs/zh-CN/README.md) | 安装、启动、配置、使用、卸载和限制。 |
| [English guide](docs/en/README.md) | Installation, configuration, usage, cleanup, and limitations. |
| [开发与发布](docs/development.md) | 本地验证、GitHub Actions、版本标签和 npm 发布。 |
| [架构与边界](docs/architecture.md) | 会话归属、投影、数据存储和模型影响。 |

## 与 DSH 的边界

- DSH session log 保存真实会话内容；Synapse 只投影已提交的事件。
- Synapse 只保存画布布局和每轮对话的短预览，消息正文始终从 DSH 会话记录按需读取；`$DSH_HOME/synapse/` 删除后不会丢会话，只会丢布局。
- 插件不修改 prompt、模型请求、工具 schema、provider 路由或可复用 KV-cache 前缀。
- 内置 patch 由 profile 的 bundle 列表引入，桌面 App（`desktop`）与命令行（`web`）都适用。

## 开发

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm test
```

完整的贡献、CI/CD 和发布流程见[开发与发布指南](docs/development.md)。

## 许可证

[MIT](LICENSE)
