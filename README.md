# dsh-synapse

![version](https://img.shields.io/badge/version-0.3.0-3478f6?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)
![platform](https://img.shields.io/badge/platform-web-7c3aed?style=flat-square)
![node](https://img.shields.io/badge/node-%3E%3D22.19-334155?style=flat-square)

**A visual, non-linear conversation workspace plugin for DeepSeek Harness.**

把同一工作区中的会话、追问和分支组织成可浏览、可拖拽、可缩放的对话地图，同时保留 DSH 原生的会话能力。

[中文指南](docs/zh-CN/README.md) · [English guide](docs/en/README.md) · [Development](docs/development.md) · [Architecture](docs/architecture.md)

![Synapse workspace canvas](docs/images/synapse-ui.png)

## Overview

`dsh-synapse` adds a visual session map to the native DeepSeek Harness Web interface. It projects committed DSH conversations into connected cards, keeps forks attached to their real branching turns, and synchronizes the current session between the map and native chat.

Synapse is an interface layer, not a second conversation system. DSH continues to own sessions, model requests, tools, permissions, and the Web server.

## Features

| | Feature | 功能 |
|---|---|---|
| 🗺️ | Browse sessions and turns as a connected canvas | 将会话和追问显示为连线画布 |
| 🌿 | Preserve native DSH fork lineage | 按真实分叉点显示 DSH 分支 |
| 📁 | Group sessions by DSH workspace and directory | 按工作区和目录组织会话 |
| 📥 | Project committed and streaming replies into cards | 将已提交和流式回复投影到卡片 |
| 🔧 | Fold tool calls and results into assistant replies | 将工具调用和结果折叠到助手回答 |
| ⚡ | Synchronize the active session with native chat | 与 DSH 原生对话双向同步当前会话 |
| 🎨 | Pan, zoom, drag, focus, and persist card positions | 支持平移、缩放、拖动、定位和位置保存 |

![Native dialogue and Synapse toggle](docs/images/native-webui.png)

## Quick start

Requirements: DeepSeek Harness with the profile plugin mechanism, Node.js `>= 22.19.0`, and the `web` profile.

```powershell
corepack pnpm dsh plugin --profile web add github:liangmianya/dsh-synapse
corepack pnpm dsh web
```

Open `http://127.0.0.1:3080/` and select **Session Map / 会话地图** from the top switch.

> [!NOTE]
> Synapse extends the existing DSH Web profile. It does not start a second application server. If pnpm blocks the Git dependency's build script, follow the exact `allowBuilds` instructions in the installation guide.

## Documentation

| Document | Description |
|---|---|
| [中文指南](docs/zh-CN/README.md) | 安装、启动、配置、使用、卸载和已知限制 |
| [English guide](docs/en/README.md) | Installation, configuration, usage, cleanup, and limitations |
| [Development and releases](docs/development.md) | Local validation, GitHub Actions, version tags, and npm publishing |
| [Architecture and boundaries](docs/architecture.md) | Session ownership, projection, storage, model impact, and operational limits |

## Development

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm test
```

See the [development and release guide](docs/development.md) for CI/CD and npm publication details.

## Runtime boundaries

- DSH session logs remain the source of truth for conversation content.
- Synapse stores canvas metadata separately under `$DSH_HOME/synapse/`.
- The plugin does not modify prompts, model requests, tool schemas, provider routing, or reusable KV-cache prefixes.
- Only the DSH `web` profile is supported by the bundled patch.

See [Architecture and runtime boundaries](docs/architecture.md) for the complete model.

## License

[MIT](LICENSE)
