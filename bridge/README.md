# UX 自检桥（liaison 扩展「自检」tab 的本地后端）

浏览器扩展「放着我来」新增了一个 **「自检」tab**：在真实页面上选中一个元素 → 点「帮我检测」→ 结合页面上下文对该元素做 UX 审查 → 问题清单直接显示在扩展面板里。

审查由本机的 Claude Code 完成，本目录是连接扩展和 Claude 的**本地桥接服务**。

## 架构

```
扩展「自检」tab 点「帮我检测」
  → panel(bundle.min.js) postMessage {action:"selfAudit", 选中元素HTML}
  → inject.js 转发 → liaison.js(background) fetch POST http://127.0.0.1:8765/audit
  → server.mjs 收到 → 调 `claude -p` 跑 UX 审查（用你当前的 CC 源）
  → 返回结构化 JSON → 逐层回传 → panel 渲染成问题清单
```

- 只有真的点「帮我检测」时才调一次 claude，**空闲不烧 token、不占性能**（事件驱动，非轮询、非 /loop）。
- 审查耗时约 30~90 秒（调一次完整 Claude Code）。
- 全程走本机 + 你的 CC 源，选中元素的 HTML 不出本机。

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 本地 HTTP 服务（零依赖纯 node），收请求→调 claude→返回 JSON |
| `audit-prompt.md` | 审查指令（浓缩 ux-interaction-audit skill 规则，强制结构化 JSON 输出） |
| `start.sh` | 一键启动（已在跑则跳过） |
| `com.uxaudit.bridge.plist` | 开机自启配置（可选，见下） |
| `log/` | 每次审查的请求+结果留档，便于排查 |
| `server.log` | 服务运行日志 |

## 使用

### 1. 启动本地服务（用扩展前必须开着）
```bash
bash ~/ux-audit-bridge/start.sh
```
探活：`curl --noproxy '*' http://127.0.0.1:8765/ping` → 返回 `{"ok":true,...}` 即正常。

### 2. 在浏览器里用
1. 打开扩展的开发者页面 `chrome://extensions`，**重新加载**「放着我来」扩展（改过代码，必须 reload 一次）。
2. 在任意页面按 `Alt+Shift+D` 启动 liaison 面板。
3. 用它选中一个元素。
4. 切到 **「自检」** tab → 点 **「帮我检测」** → 等 30~90 秒 → 问题清单出现。

### 3.（可选）开机自启，不用每次手动开服务
```bash
cp ~/ux-audit-bridge/com.uxaudit.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.uxaudit.bridge.plist
```
关闭自启：`launchctl unload ~/Library/LaunchAgents/com.uxaudit.bridge.plist`

## 排查

- 扩展点检测报「无法连接本地自检服务」→ 服务没开，跑 `start.sh`。
- 报「检测超时」→ claude 响应太慢或 CC 源异常，看 `server.log`。
- 结果解析失败 → claude 输出没按 JSON，看 `log/` 里最新那条的 `_raw`。
- 改了 `audit-prompt.md` 后即时生效（server 每次读取），不用重启服务。

## 关于依赖：只依赖 `claude` CLI 能用，不依赖终端窗口

审查是服务每次 spawn 一个 **`claude -p`（headless 单次调用）** 完成的，它是独立进程：

- **不需要开着终端的 Claude Code 交互窗口** —— 开不开都行，互不影响。
- **服务已 launchd 开机自启** —— 日常无需手动开服务，开机→浏览器→选元素点检测即可。
- **唯一前提**：`claude` CLI 能正常连上某个可用的 CC 源（你手动 `claude` 能用，自检就能用）。

### 切换 CC 源后的确认（改 ~/.claude/settings.json 之后）

`claude -p` 读的是 `~/.claude/settings.json`，你切哪个源，自检就跟着用哪个源。切完源后确认自检仍可用：

1. 终端跑一句：`claude -p "说你好"` —— 能秒回「你好」即 CC 源正常，自检就能用。
2. 若切到「讯飞中转」这类**标准 API 方式**（`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`）：纯环境变量、改完立即生效、**无需重新登录**，对自检最友好、最稳。
3. 若用「代理 + OAuth 登录」方式：需按手册重新认证一次 `claude`，认证通过后自检照常可用。
4. `claude -p` 卡住或报错 → 自检会显示「检测超时」；先用第 1 步排查 CC 源，`server.log` 有详细记录。

> 服务是常驻的，切源改 settings.json 后 **不用重启服务**——它 spawn 的 `claude -p` 每次都读当时最新的 settings.json。

## 与 ux-interaction-audit skill 的关系

`audit-prompt.md` 是那个 skill 审查方法论的**浓缩版**（用于无状态的 `claude -p` 单轮调用）。skill 本体不受影响；改 skill 后如需同步审查口径，手动更新 `audit-prompt.md` 即可。
