#!/bin/bash
# UX 自检桥 · 一键安装（macOS）
# 作用：把本目录的 server.mjs 装成 launchd 开机自启服务，供扩展「自检」tab 调用。
# 用法：bash install.sh    （在本目录下跑，或 bash /path/to/ux-audit-bridge/install.sh）
set -e

# 本脚本所在目录 = 后端目录
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.uxaudit.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-8765}"

echo "== UX 自检桥安装 =="
echo "后端目录: $DIR"

# 1. 找 node
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.volta/bin/node" "$HOME/.miaoxiang/runtime/node/bin/node"; do
    [ -x "$p" ] && NODE="$p" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "✗ 找不到 node，请先安装 Node.js（https://nodejs.org）后重试。"; exit 1
fi
echo "node: $NODE"

# 2. 检查 claude CLI（服务运行时需要）
CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ]; then
  echo "⚠ 未在 PATH 里找到 claude CLI。服务能装，但审查时需要 claude 能用。"
  echo "  请确认已安装 Claude Code 且能连上你的源（终端跑 'claude -p 你好' 应有回应）。"
else
  echo "claude: $CLAUDE"
fi

# 3. 生成 launchd plist（用本机真实路径，不硬编码用户名）
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/server.log</string>
  <key>WorkingDirectory</key><string>$DIR</string>
</dict>
</plist>
EOF
echo "已写入自启配置: $PLIST"

# 4. 加载（先卸后装，幂等）
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "已加载 launchd 服务，等待启动…"
sleep 3

# 5. 探活
if curl -s --noproxy '*' "http://127.0.0.1:$PORT/ping" | grep -q '"ok":true'; then
  echo ""
  echo "✓ 安装成功！服务已运行 (http://127.0.0.1:$PORT)，已设开机自启。"
  echo "  接下来：在 chrome://extensions 重新加载扩展，选中元素 → 「自检」tab → 「帮我检测」。"
else
  echo ""
  echo "✗ 服务未探活成功。请看日志：cat \"$DIR/server.log\""
  echo "  常见原因：端口 $PORT 被占用（可用 PORT=8766 bash install.sh 换端口）。"
  exit 1
fi
