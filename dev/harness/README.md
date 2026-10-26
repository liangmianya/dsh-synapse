# 点击级冒烟测试

`pnpm test` 覆盖 Host 半部和 `app.js` 的片段，但**从不渲染画布**：`test/morph-render.test.js` 只是用正则核对源码，所以 DOM 补丁层的回归（控件被合并、渲染被冻结、视图切换丢卡片）在那边永远是全绿。

这个脚本补上那一段：它会

1. 用真实的 `index.js`（`apply()`）在一个真实 HTTP 服务器上启动 Host 半部；
2. 用 `WorkspaceStore` 造一个工作区，写入几条消息，作为画布数据；
3. 用 jsdom 加载真实的 `/synapse/` 页面（真实的 `app.js`、真实的 `/synapse/api/*`）；
4. **像人一样点击**：点卡片、点「新会话」再取消、进详情再返回画布、点整理；
5. 每步核对 DOM，失败时以非 0 退出。

整个过程中不需要安装 DSH，也不碰你的 `$DSH_HOME`。

## 用法

```powershell
cd dev/harness
npm install
npm test                 # 测当前仓库
node click.mjs ../..     # 测另一份检出
```

输出示例：

```
ok   card footer keeps 详情 / DSH / 归档 — show-thread,open-dsh,archive-thread
ok   card click opens the inspector with a selection on the page
ok   新会话 opens a draft
ok   取消 closes the draft
ok   详情 opens the conversation
ok   返回画布 restores the cards — 2 cards
ok   整理 keeps the cards mounted

all checks passed
```

## 它盯住的四件事

| 检查 | 对应的真实故障 |
|---|---|
| 卡片 footer 三个按钮都在 | morph 把 `data-thread` 当唯一键，同一 thread 的兄弟按钮互相覆盖 |
| 页面上有文字选区时点卡片仍能开检查器 | `morphHoldsCaret` 用 `contains` 判断，把 `<main>` 当成光标宿主，整棵跳过 → 之后所有 render 变空操作 |
| 「新会话」→「取消」能回到原状 | 草稿卡消失不掉，`canReplaceView()` 一直为 false，界面卡死 |
| 详情 → 返回画布 之后卡片还在 | `canvas-view` / `detail-view` 都是无 key 的 `<section>`，被按位置配成一对互相打补丁 |

## 边界

- jsdom 没有布局：`getBoundingClientRect()` 全是 0，`Range.getBoundingClientRect` 由本脚本补空实现。凡依赖真实尺寸的行为（虚拟化挂载哪些卡片、相机居中）在这里只验证“不报错”，不验证像素。
- 它不替代 `pnpm test`，是补充。零依赖的 `test/` 仍然必须能在干净环境里跑。
- `node_modules/` 已被根 `.gitignore` 忽略，`dev/` 也不在 `package.json` 的 `files` 白名单里，所以不会进 npm 包。
