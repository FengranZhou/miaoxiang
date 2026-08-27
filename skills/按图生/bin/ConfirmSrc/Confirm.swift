import SwiftUI
import AppKit

// 用法:
//   Confirm <final_path> <result_path>
// 终稿确认浮窗：交付前给用户看一眼终稿，确认是否 OK。
// 写入 result_path（多行格式）：
//   第 1 行: OK | REVISE
//   第 2 行（仅 REVISE 可能有）: 用户输入的迭代建议 suggestion
//
// 交互：
//   - 「✅ 没问题」主按钮 → 写 OK → 主流程 cp 到落点、交付收尾
//   - 「✋ 不行，重做」按钮 → 点击原地变输入框（暗提示「说说要怎么改，回车提交」，
//      焦点自动落入）→ 回车提交（可空）→ 写 REVISE + 建议 → 主流程当 user_complaint 走修订迭代
//   快捷键: O = 直接没问题；R = 切到「重做」输入框态（回车才真正提交，Esc 取消）

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: Confirm <final> <result_path>\n".data(using: .utf8)!)
    exit(2)
}
let finalPath = args[1]
let resultPath = args[2]

func loadImage(_ path: String) -> NSImage? {
    NSImage(contentsOfFile: path)
}

func writeResult(_ value: String, suggestion: String = "") {
    var content = value
    if value == "REVISE" {
        let trimmed = suggestion.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            content += "\n" + trimmed
        }
    }
    try? content.write(toFile: resultPath, atomically: true, encoding: .utf8)
}

// 容器描边色 #12151a / α 0.08（沿用 Picker 视觉）
let containerStroke = Color(red: 0x12 / 255.0, green: 0x15 / 255.0, blue: 0x1a / 255.0).opacity(0.08)

struct ConfirmView: View {
    let finalImage: NSImage?
    let onDone: (String, String) -> Void

    // 是否切到「重做」输入框态
    @State private var revising = false
    @State private var suggestion: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 16) {
            Text("终稿确认").font(.headline).foregroundColor(.primary)

            imageContainer(finalImage)

            // 底部动作区：没问题 主按钮 + 重看是否同风格 + 重做（二态）
            VStack(spacing: 10) {
                // ✅ 没问题：绿色主按钮，永远在位
                Button(action: { onDone("OK", "") }) {
                    Text("✅ 没问题").frame(maxWidth: .infinity).padding(.vertical, 8)
                }
                .keyboardShortcut("o", modifiers: [])
                .buttonStyle(PrimaryButtonStyle())

                // ✋ 重做：按钮 ⇄ 输入框 二态
                if revising {
                    TextField("说说要怎么改，回车提交", text: $suggestion)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .padding(.vertical, 8)
                        .padding(.horizontal, 12)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color(nsColor: .systemGray).opacity(0.25))
                        )
                        .focused($focused)
                        .onSubmit { onDone("REVISE", suggestion) }
                        .onExitCommand { revising = false }   // Esc 退回按钮态
                        .onAppear { focused = true }
                } else {
                    Button(action: { revising = true }) {
                        Text("✋ 不行，重做").frame(maxWidth: .infinity).padding(.vertical, 8)
                    }
                    .keyboardShortcut("r", modifiers: [])
                    .buttonStyle(GrayButtonStyle())
                }
            }
            .frame(width: 460)

            Text("快捷键: O = 没问题 · R = 重做（输入建议，回车提交，可空，Esc 取消）")
                .font(.caption).foregroundColor(.secondary)
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 640)
    }

    @ViewBuilder
    func imageContainer(_ image: NSImage?) -> some View {
        Group {
            if let img = image {
                Image(nsImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 460, height: 460)
                    .background(Color.black.opacity(0.04))
            } else {
                Rectangle()
                    .fill(Color.red.opacity(0.15))
                    .frame(width: 460, height: 460)
                    .overlay(Text("读图失败").foregroundColor(.red))
            }
        }
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(containerStroke, lineWidth: 1)
        )
    }
}

// 绿色主按钮（OK）
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(.white)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(configuration.isPressed
                          ? Color(red: 0.18, green: 0.55, blue: 0.30)
                          : Color(red: 0.22, green: 0.65, blue: 0.36))
            )
    }
}

// 灰底黑字按钮（重做）
struct GrayButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(.black)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(configuration.isPressed
                          ? Color(nsColor: .systemGray).opacity(0.45)
                          : Color(nsColor: .systemGray).opacity(0.25))
            )
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!

    // 弹 macOS 系统通知：右上角横幅 + 提示音，跨 Space 可见（沿用 Picker 的感知通道）
    func postReadyNotification() {
        let candidates = [
            "/opt/homebrew/bin/terminal-notifier",
            "/usr/local/bin/terminal-notifier"
        ]
        if let tn = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            let proc = Process()
            proc.launchPath = tn
            proc.arguments = [
                "-title", "按图生：终稿待确认",
                "-message", "终稿已就绪，请确认是否 OK（请 Cmd+Tab 切换到 Confirm）",
                "-sound", "Glass",
                "-sender", "com.anhtu.confirm"
            ]
            try? proc.run()
            return
        }
        let script = "display notification \"终稿已就绪，请确认 OK 或提建议重做。请切到主桌面（不要点通知）\" with title \"按图生：终稿待确认\" sound name \"Glass\""
        let proc = Process()
        proc.launchPath = "/usr/bin/osascript"
        proc.arguments = ["-e", script]
        try? proc.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let finalImage = loadImage(finalPath)

        let contentView = ConfirmView(
            finalImage: finalImage,
            onDone: { [weak self] result, suggestion in
                writeResult(result, suggestion: suggestion)
                self?.window.close()
                NSApp.terminate(nil)
            }
        )

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 660),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "按图生 — 终稿确认"
        window.contentView = NSHostingView(rootView: contentView)
        window.center()
        window.level = .floating
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        postReadyNotification()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
