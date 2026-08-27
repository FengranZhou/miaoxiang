# 妙想 · 设计师的页面调优工作台

在任何网页上直接选中元素：调样式、采参考、攒资产库、AI 审查交互、生成设计变体、按参考图生成新图。Chrome 扩展 + 本地 AI 工作台，内部分发。

## 安装（Mac，约 10 分钟，只需做一次）

1. 下载本仓库：绿色 **Code** 按钮 → **Download ZIP**，解压
2. **右键点击 `install.command` → 打开 → 再点「打开」**
   （必须右键打开而不是双击：macOS 会拦截来自网络的脚本，右键打开是官方放行方式）
3. 脚本跑完会自动弹出 Chrome 扩展页和图文指引，照做最后一步：
   开发者模式 → 加载已解压的扩展程序 → `Cmd+Shift+G` 粘贴路径（已复制好）→ 选择
4. 点浏览器工具栏的妙想图标（或 `Alt+Shift+D`）开始使用

安装器会自动完成：本地桥服务（开机自启）、skills 安装、运行环境（npm / Python）、
抠图模型下载（约 1GB，一次性）、每日自动更新。中途失败随时**再右键打开一次**即可续装。

## 各功能需要什么

| 功能 | 额外前提 |
|---|---|
| 采集 / 资产库、调整、组件、分析、清单 | 无，装完即用 |
| 分析里的「AI 深度分析」 | 自己的 Claude Code（终端跑 `claude -p 你好` 有回应即可） |
| 灵感面板「发散」 | 自己的 Variant 账号（首次使用在弹出的窗口登录一次） |
| 灵感面板「线上库」找参考 | Claude Code（把生成的 prompt 粘进去执行） |
| 按图生 / 按图生-评审 / 去水印 | Claude Code + 自己的豆包账号（首次使用登录一次） |
| 抠图 | 无需配置；装了 Eagle +「AI 自动抠图」插件会自动提速数倍（推荐） |

## 更新

全自动：每天 11:30 后台静默检查，skills 类更新立即生效，扩展本体更新在下次重启
Chrome 后生效（有系统通知提示）。扩展图标出现红色 NEW 角标或弹窗时，说明后台
还没拉到最新——双击 `~/.miaoxiang/update.command` 手动更新一次即可。

## 常见问题

**install.command 双击提示「无法打开」**：右键 → 打开 → 再点「打开」。

**按图生的确认浮窗（Confirm.app）打不开**：终端执行
`bash ~/.claude/skills/按图生/bin/build-confirm.sh` 现场重编一个（首次可能提示安装
「命令行开发者工具」，装完重跑）。

**抠图模型下载失败**：网络原因，双击 `~/.miaoxiang/update.command` 重试；仍不行时到
本仓库 Releases 页手动下载 `birefnet-general.onnx` 和 `u2net.onnx`，放进 `~/.u2net/`。

**AI 深度分析报「本地服务未就绪」**：确认 `claude -p 你好` 能跑通，然后
`bash ~/.miaoxiang/bridge/install.sh` 重装桥服务，日志在 `~/.miaoxiang/bridge/server.log`。

**想彻底卸载**：
```bash
launchctl unload ~/Library/LaunchAgents/com.miaoxiang.updater.plist
launchctl unload ~/Library/LaunchAgents/com.uxaudit.bridge.plist
rm -rf ~/.miaoxiang ~/Library/LaunchAgents/com.miaoxiang.updater.plist ~/Library/LaunchAgents/com.uxaudit.bridge.plist
```
再到 `chrome://extensions` 移除扩展。skills 与采集数据如需一并清理：
`rm -rf ~/.claude/skills/按图生 ~/.claude/skills/按图生-评审 ~/.claude/skills/去水印`（采集库存在 Chrome 里，移除扩展即清）。

## 隐私说明

工具不上传任何数据：采集库存在你自己的 Chrome 里；AI 深度分析走你本机的 Claude Code；
按图生 / 发散用你自己的豆包 / Variant 账号。更新只从本仓库拉取。
