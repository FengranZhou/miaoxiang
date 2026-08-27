#!/bin/bash
# 编译 Confirm（SwiftUI 单图终稿确认浮窗）
# 用法: bash build-confirm.sh
# 产出: bin/confirm（命令行包装，转发参数到 Confirm.app/Contents/MacOS/Confirm）
#       bin/Confirm.app（macOS bundle，含 Info.plist，能跨 Space 显示）
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/ConfirmSrc/Confirm.swift"
APP="$DIR/Confirm.app"
BIN_IN_APP="$APP/Contents/MacOS/Confirm"
PLIST="$APP/Contents/Info.plist"
SHIM="$DIR/confirm"

echo "preparing bundle at $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

echo "writing Info.plist"
cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Confirm</string>
    <key>CFBundleIdentifier</key>
    <string>com.anhtu.confirm</string>
    <key>CFBundleName</key>
    <string>按图生 Confirm</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSUIElement</key>
    <false/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

echo "compiling $SRC -> $BIN_IN_APP"
swiftc -O -o "$BIN_IN_APP" "$SRC" \
    -framework SwiftUI \
    -framework AppKit
chmod +x "$BIN_IN_APP"

# 注册到 LaunchServices，避免首次 open 时 macOS 找不到 bundle
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
    -f "$APP" 2>/dev/null || true

echo "writing shim $SHIM"
# 说明：本 heredoc 用 <<'EOF'（带引号），shim 内容原样落盘、build 时不做任何变量展开。
# 所有路径都在 shim **运行时**用 \$(dirname "\$0") 从自身位置动态推导——
# 这样 skill 装在任何路径都能正确定位身边的 app/源码/builder，不依赖硬编码绝对路径。
cat > "$SHIM" <<'EOF'
#!/bin/bash
# 命令行 shim：通过 `open -n -a` 启动 Confirm.app（macOS 会认成 GUI app）
# 必须走 open，否则直接 exec bundle 内 binary 会被 macOS 当成命令行进程，无法跨 Space 显示窗口。
#
# 【自愈自动建构（防呆）】别人拿到 skill 后往往不知道要先 build Confirm.app。
# 每次启动弹窗前，先检查 Confirm.app 是否缺失 / 比源码 Confirm.swift 旧——
# 是则自动跑 build-confirm.sh 重新编译，别人零感知、弹窗永远是最新的。
# 路径全部相对 shim 自身位置动态推导，skill 换目录也不失效。
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Confirm.app"
SRC="$DIR/ConfirmSrc/Confirm.swift"
BUILDER="$DIR/build-confirm.sh"
BIN_IN_APP="$APP/Contents/MacOS/Confirm"
if [ ! -x "$BIN_IN_APP" ] || { [ -f "$SRC" ] && [ "$SRC" -nt "$BIN_IN_APP" ]; }; then
  echo "[confirm] Confirm.app 缺失或源码已更新，自动重新编译…" >&2
  bash "$BUILDER" >&2 || { echo "[confirm] build 失败，请手动运行: bash $BUILDER" >&2; exit 1; }
fi
exec /usr/bin/open -n -a "$APP" --args "$@"
EOF
chmod +x "$SHIM"

echo "done:"
echo "  bundle: $APP"
echo "  shim:   $SHIM"
