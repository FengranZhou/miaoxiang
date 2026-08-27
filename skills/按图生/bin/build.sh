#!/bin/bash
# 编译 Picker（SwiftUI 双图挑 winner 浮窗）
# 用法: bash build.sh
# 产出: bin/picker（命令行包装，转发参数到 Picker.app/Contents/MacOS/Picker）
#       bin/Picker.app（macOS bundle，含 Info.plist，能跨 Space 显示）
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/PickerSrc/Picker.swift"
APP="$DIR/Picker.app"
BIN_IN_APP="$APP/Contents/MacOS/Picker"
PLIST="$APP/Contents/Info.plist"
SHIM="$DIR/picker"

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
    <string>Picker</string>
    <key>CFBundleIdentifier</key>
    <string>com.anhtu.picker</string>
    <key>CFBundleName</key>
    <string>按图生 Picker</string>
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
cat > "$SHIM" <<EOF
#!/bin/bash
# 命令行 shim：通过 \`open -n -a\` 启动 Picker.app（macOS 会认成 GUI app）
# 必须走 open，否则直接 exec bundle 内 binary 会被 macOS 当成命令行进程，
# 无法跨 Space 显示窗口
exec /usr/bin/open -n -a "$APP" --args "\$@"
EOF
chmod +x "$SHIM"

echo "done:"
echo "  bundle: $APP"
echo "  shim:   $SHIM"
"$SHIM" --help 2>&1 | head -3 || true
