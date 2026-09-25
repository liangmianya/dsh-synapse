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

需要 DeepSeek Harness `>= 0.1.7-rc.2`（本插件依赖该版本的 Host 会话与 Client 服务接口）、Node.js `>= 22.19.0`，以及 `web` profile。

```powershell
corepack pnpm dsh plugin --profile web add dsh-synapse
corepack pnpm dsh web
```

启动后，在 DSH 顶部切换到 **会话地图**。Synapse 复用现有的 DSH Web Server，不会启动第二个应用或代理系统。

## 它解决什么问题

| 能力 | 说明 |
|---|---|
| 对话地图 | 把连续追问、分支和不同会话放到同一张可操作的画布上。 |
| 保留真实分支 | 按 DSH 原生 fork 关系连接卡片，不制造另一套会话历史。 |
| 追问更顺手 | 选中回答中的文字可直接带入新的追问；常用补充词可编辑。 |
| 双向同步 | 在地图或 DSH 原生对话中切换会话，当前上下文保持一致。 |

## 从原生对话进入

在 DSH 原生对话中，通过顶部的 **会话地图** 进入 Synapse；返回 **对话** 后，仍是同一个 DSH 会话。

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
- Synapse 的画布布局数据保存在 `$DSH_HOME/synapse/`，删除它不会删除 DSH 会话。
- 插件不修改 prompt、模型请求、工具 schema、provider 路由或可复用 KV-cache 前缀。
- 内置 patch 仅支持 DSH 的 `web` profile。

## 开发

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm test
```

完整的贡献、CI/CD 和发布流程见[开发与发布指南](docs/development.md)。

## 许可证

[MIT](LICENSE)
