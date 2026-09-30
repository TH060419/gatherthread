import AppKit
import Foundation

private let serverOrigin = "https://gatherthread.cn"
private let scheme = "gatherthread-connect"

private struct ConnectionLink: Equatable {
    let project: String
    let model: String
    let contextTokens: Int
    let historySync: String

    static func parse(_ raw: String) throws -> ConnectionLink {
        guard raw.utf8.count <= 2048,
              let url = URLComponents(string: raw),
              url.scheme == scheme, url.host == "connect", url.port == nil,
              url.user == nil, url.password == nil,
              url.path.isEmpty || url.path == "/",
              url.fragment == nil,
              let query = url.percentEncodedQuery else {
            throw LinkError.invalid("无效的 GatherThread 连接链接")
        }
        let allowed: Set<String> = ["v", "origin", "project", "model", "context_window_tokens", "visible_history_sync"]
        var values: [String: String] = [:]
        for part in query.split(separator: "&", omittingEmptySubsequences: false) {
            guard let separator = part.firstIndex(of: "="),
                  let name = String(part[..<separator]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = String(part[part.index(after: separator)...]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  allowed.contains(name), !value.isEmpty, values[name] == nil else {
                throw LinkError.invalid("连接链接包含缺失、重复或不支持的参数")
            }
            values[name] = value
        }
        guard Set(values.keys) == allowed, values["v"] == "1", values["origin"] == serverOrigin,
              let project = values["project"], validProject(project),
              let model = values["model"], validModel(model),
              let tokenText = values["context_window_tokens"],
              !tokenText.isEmpty, tokenText.utf8.allSatisfy({ (48...57).contains($0) }),
              let tokens = Int(tokenText), (4096...2_000_000).contains(tokens),
              let mode = values["visible_history_sync"], ["first-connect", "never"].contains(mode) else {
            throw LinkError.invalid("连接链接的版本、服务地址或连接设置无效")
        }
        return ConnectionLink(project: project, model: model, contextTokens: tokens, historySync: mode)
    }
}

private enum LinkError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        if case .invalid(let message) = self { return message }
        return nil
    }
}

private func validProject(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...128).contains(bytes.count),
          let first = bytes.first,
          (48...57).contains(first) || (65...90).contains(first) || (97...122).contains(first) else { return false }
    return bytes.allSatisfy { byte in
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || [46, 95, 58, 45].contains(byte)
    }
}

private func validModel(_ value: String) -> Bool {
    !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
    value.unicodeScalars.count <= 120 && !value.hasPrefix("-") &&
    !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}

private func workspaceArguments(_ path: String) throws -> [String] {
    if path.isEmpty { return ["--create-workspace"] }
    var isDirectory: ObjCBool = false
    guard path.hasPrefix("/"),
          FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
          isDirectory.boolValue else {
        throw LinkError.invalid("工作目录必须是已存在的本地绝对路径目录")
    }
    return ["--workspace", URL(fileURLWithPath: path).standardizedFileURL.path]
}

private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
}

private func bundled(_ path: String) -> URL {
    Bundle.main.resourceURL!.appendingPathComponent(path)
}

private func executableCodex() -> String {
    let manager = FileManager.default
    let pathCandidates = (ProcessInfo.processInfo.environment["PATH"] ?? "")
        .split(separator: ":").map { String($0) + "/codex" }
    let home = manager.homeDirectoryForCurrentUser.path
    let candidates = pathCandidates + ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", home + "/.npm-global/bin/codex", home + "/.local/bin/codex"]
    return candidates.first(where: { manager.isExecutableFile(atPath: $0) }) ?? ""
}

private final class Launcher: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let project = NSTextField()
    private let workspace = NSTextField()
    private let codex = NSTextField()
    private let model = NSTextField()
    private let tokens = NSTextField()
    private let history = NSPopUpButton()
    private let token = NSSecureTextField()
    private let status = NSTextField(labelWithString: "填写连接信息后启动连接。")
    private let log = NSTextView()
    private var connector: Process?
    private var pendingLink: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 GatherThread Launcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        menu.addItem(appItem)
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 670),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "GatherThread · Connect Codex"
        window.minSize = NSSize(width: 600, height: 620)
        window.center()
        window.delegate = self
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -20),
        ])
        let heading = NSTextField(labelWithString: "连接本机 Codex")
        heading.font = .boldSystemFont(ofSize: 21)
        stack.addArrangedSubview(heading)
        addNote("网页负责项目与会话，此窗口启动并保持本机连接。仅连接 \(serverOrigin)。", to: stack)
        codex.stringValue = executableCodex()
        model.stringValue = "gpt-5.6-sol"
        tokens.stringValue = "128000"
        addField("项目 ID（网页打开时自动填入；project-***）", project, to: stack)
        addField("Codex CLI 完整路径", codex, to: stack)
        stack.addArrangedSubview(NSTextField(labelWithString: "本地工作目录（可选；留空使用默认项目目录）"))
        let workspaceRow = NSStackView()
        workspaceRow.orientation = .horizontal
        workspaceRow.spacing = 8
        workspaceRow.addArrangedSubview(workspace)
        workspaceRow.addArrangedSubview(NSButton(title: "浏览…", target: self, action: #selector(chooseWorkspace)))
        workspaceRow.addArrangedSubview(NSButton(title: "默认目录", target: self, action: #selector(clearWorkspace)))
        stack.addArrangedSubview(workspaceRow)
        workspaceRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        addField("模型", model, to: stack)
        addField("上下文 Token 上限", tokens, to: stack)
        stack.addArrangedSubview(NSTextField(labelWithString: "首次历史导入"))
        history.addItems(withTitles: ["first-connect", "never"])
        stack.addArrangedSubview(history)
        addField("设备 Token（仅传给本机连接器）", token, to: stack)
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 10
        for (title, action) in [("可选：安装随包插件", #selector(installPlugin)),
                                ("启动连接", #selector(startConnection)), ("停止连接", #selector(stopConnection))] {
            let button = NSButton(title: title, target: self, action: action)
            actions.addArrangedSubview(button)
        }
        stack.addArrangedSubview(actions)
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 2
        stack.addArrangedSubview(status)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        log.isEditable = false
        log.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        scroll.documentView = log
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
        addNote("关闭窗口会保留正在运行的连接；从 Dock 恢复后可停止连接。插件需在 Codex 中单独安装与审查 Hooks。", to: stack)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let pendingLink { self.pendingLink = nil; application(NSApp, open: [pendingLink]) }
    }

    private func addNote(_ value: String, to stack: NSStackView) {
        let label = NSTextField(wrappingLabelWithString: value)
        label.textColor = .secondaryLabelColor
        stack.addArrangedSubview(label)
        label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func addField(_ title: String, _ field: NSTextField, to stack: NSStackView) {
        stack.addArrangedSubview(NSTextField(labelWithString: title))
        stack.addArrangedSubview(field)
        field.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.count == 1 else { showError("只接受一个连接链接"); return }
        if window == nil { pendingLink = urls[0]; return }
        do {
            let link = try ConnectionLink.parse(urls[0].absoluteString)
            project.stringValue = link.project
            model.stringValue = link.model
            tokens.stringValue = String(link.contextTokens)
            history.selectItem(withTitle: link.historySync)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } catch { showError(error.localizedDescription) }
    }

    private func showError(_ value: String) {
        let alert = NSAlert()
        alert.messageText = "连接链接无效"
        alert.informativeText = value
        alert.runModal()
    }

    @objc private func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "选择目录"
        if panel.runModal() == .OK, let url = panel.url { workspace.stringValue = url.path }
    }

    @objc private func clearWorkspace() { workspace.stringValue = "" }

    @objc private func installPlugin() {
        if connector?.isRunning == true { showError("请先停止连接，再安装插件。"); return }
        let codexPath = codex.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard FileManager.default.isExecutableFile(atPath: codexPath),
              FileManager.default.isExecutableFile(atPath: bundled("runtime/node").path) else {
            showError("请先选择已登录的 Codex CLI，并检查随包 Node。")
            return
        }
        let alert = NSAlert()
        alert.messageText = "安装 GatherThread 插件？"
        alert.informativeText = "会将随包插件复制到本机用户目录并注册到 Codex。请重启 Codex，并在 /hooks 审查 Hooks。"
        alert.addButton(withTitle: "安装")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        status.stringValue = "正在安装插件…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let root = try Self.preparePlugin()
                try Self.runCodex(codexPath, ["plugin", "marketplace", "add", root.path])
                try Self.runCodex(codexPath, ["plugin", "add", "gatherthread@gatherthread-launcher"])
                DispatchQueue.main.async { self?.status.stringValue = "插件已安装。请重启 Codex 并在 /hooks 审查 Hooks。" }
            } catch {
                DispatchQueue.main.async { self?.status.stringValue = "插件安装失败：\(error.localizedDescription)" }
            }
        }
    }

    private static func preparePlugin() throws -> URL {
        let manager = FileManager.default
        let root = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("GatherThread Launcher", isDirectory: true)
        let plugin = root.appendingPathComponent("plugins/gatherthread", isDirectory: true)
        let source = bundled("plugins/gatherthread")
        guard manager.fileExists(atPath: source.path) else { throw LinkError.invalid("安装包缺少插件源码") }
        let marketplace = root.appendingPathComponent(".agents/plugins/marketplace.json")
        let stage = root.appendingPathComponent(".install-stage-\(UUID().uuidString)", isDirectory: true)
        let stagedPlugin = stage.appendingPathComponent("gatherthread", isDirectory: true)
        let stagedMarketplace = stage.appendingPathComponent("marketplace.json")
        let oldPlugin = stage.appendingPathComponent("previous-gatherthread", isDirectory: true)
        let oldMarketplace = stage.appendingPathComponent("previous-marketplace.json")
        try manager.createDirectory(at: stage, withIntermediateDirectories: true)
        var preserveStage = false
        defer { if !preserveStage { try? manager.removeItem(at: stage) } }
        try manager.copyItem(at: source, to: stagedPlugin)
        guard var listing = try JSONSerialization.jsonObject(with: Data(contentsOf: bundled("marketplace.json"))) as? [String: Any] else {
            throw LinkError.invalid("插件市场清单格式无效")
        }
        listing["name"] = "gatherthread-launcher"
        try JSONSerialization.data(withJSONObject: listing, options: [.prettyPrinted, .sortedKeys]).write(to: stagedMarketplace)
        let mcpFile = stagedPlugin.appendingPathComponent(".mcp.json")
        let node = bundled("runtime/node").path
        let connector = bundled("connector/codex-connect.js").path
        let mcp: [String: Any] = ["mcpServers": ["gatherthread": ["command": node, "args": [connector, "mcp"]]]]
        try JSONSerialization.data(withJSONObject: mcp, options: [.prettyPrinted, .sortedKeys]).write(to: mcpFile)
        let hooksFile = stagedPlugin.appendingPathComponent("hooks/hooks.json")
        guard var hooks = try JSONSerialization.jsonObject(with: Data(contentsOf: hooksFile)) as? [String: Any] else {
            throw LinkError.invalid("插件 Hooks 格式无效")
        }
        guard var events = hooks["hooks"] as? [String: Any] else { throw LinkError.invalid("插件 Hooks 格式无效") }
        for event in ["UserPromptSubmit", "Stop"] {
            guard var entries = events[event] as? [[String: Any]], !entries.isEmpty,
                  var inner = entries[0]["hooks"] as? [[String: Any]], !inner.isEmpty else {
                throw LinkError.invalid("插件 Hooks 格式无效")
            }
            inner[0]["command"] = "\(shellQuote(node)) \"${PLUGIN_ROOT}/scripts/hook-forwarder.mjs\""
            entries[0]["hooks"] = inner
            events[event] = entries
        }
        hooks["hooks"] = events
        try JSONSerialization.data(withJSONObject: hooks, options: [.prettyPrinted, .sortedKeys]).write(to: hooksFile)
        try manager.createDirectory(at: plugin.deletingLastPathComponent(), withIntermediateDirectories: true)
        try manager.createDirectory(at: marketplace.deletingLastPathComponent(), withIntermediateDirectories: true)
        let hadPlugin = manager.fileExists(atPath: plugin.path)
        let hadMarketplace = manager.fileExists(atPath: marketplace.path)
        var installedPlugin = false
        do {
            if hadPlugin { try manager.moveItem(at: plugin, to: oldPlugin) }
            try manager.moveItem(at: stagedPlugin, to: plugin)
            installedPlugin = true
            if hadMarketplace { try manager.moveItem(at: marketplace, to: oldMarketplace) }
            try manager.moveItem(at: stagedMarketplace, to: marketplace)
        } catch {
            do {
                if hadMarketplace && manager.fileExists(atPath: oldMarketplace.path) {
                    try manager.moveItem(at: oldMarketplace, to: marketplace)
                }
                if installedPlugin { try manager.removeItem(at: plugin) }
                if hadPlugin && manager.fileExists(atPath: oldPlugin.path) {
                    try manager.moveItem(at: oldPlugin, to: plugin)
                }
            } catch {
                preserveStage = true
                throw LinkError.invalid("插件安装失败，旧版备份保留在 \(stage.path)：\(error.localizedDescription)")
            }
            throw error
        }
        return root
    }

    private static func runCodex(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "GATHERTHREAD_TOKEN")
        environment["PATH"] = bundled("runtime").path + ":" + (environment["PATH"] ?? "")
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        try process.run()
        DispatchQueue.global().async { _ = output.fileHandleForReading.readDataToEndOfFile() }
        if done.wait(timeout: .now() + 180) == .timedOut {
            process.terminate()
            throw LinkError.invalid("Codex 插件安装超时")
        }
        if process.terminationStatus != 0 { throw LinkError.invalid("Codex 插件命令失败（退出码 \(process.terminationStatus)）") }
    }

    @objc private func startConnection() {
        if connector?.isRunning == true { status.stringValue = "连接器已在运行。"; return }
        let node = bundled("runtime/node")
        let connectorFile = bundled("connector/codex-connect.js")
        let codexPath = codex.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let enteredToken = token.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectId = project.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelName = model.stringValue
        let tokenCount = tokens.stringValue
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: connectorFile.path),
              FileManager.default.isExecutableFile(atPath: codexPath),
              validProject(projectId), validModel(modelName),
              !tokenCount.isEmpty, tokenCount.utf8.allSatisfy({ (48...57).contains($0) }),
              let count = Int(tokenCount), (4096...2_000_000).contains(count),
              !enteredToken.isEmpty, !enteredToken.contains("\n"), !enteredToken.contains("\r"),
              let mode = history.selectedItem?.title, ["first-connect", "never"].contains(mode) else {
            showError("请检查包内 Node/连接器、Codex CLI 路径、项目 ID、Token 和连接设置。")
            return
        }
        let workspaceArgs: [String]
        do { workspaceArgs = try workspaceArguments(workspace.stringValue) }
        catch { showError(error.localizedDescription); return }
        let process = Process()
        process.executableURL = node
        process.arguments = [connectorFile.path, "--url", serverOrigin, "--project", projectId]
            + workspaceArgs + ["--plugin-hooks", "--visible-history-sync", mode,
                             "--model", modelName, "--context-window-tokens", String(count),
                             "--codex-command", codexPath]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = node.deletingLastPathComponent().path + ":" + (environment["PATH"] ?? "")
        environment["GATHERTHREAD_TOKEN"] = enteredToken
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard self?.connector === finished else { return }
                self?.connector = nil
                self?.status.stringValue = "连接器已退出（代码 \(finished.terminationStatus)）。可检查日志后重试。"
            }
        }
        do {
            try process.run()
            connector = process
            token.stringValue = ""
            status.stringValue = "连接器正在启动；请在 Codex 中审查并启用已安装的 Hooks。"
            DispatchQueue.global(qos: .utility).async { [weak self] in
                var pending = Data()
                var discardingLongLine = false
                while true {
                    let chunk = output.fileHandleForReading.readData(ofLength: 4096)
                    if chunk.isEmpty { break }
                    for byte in chunk {
                        if byte == 10 {
                            if !discardingLongLine {
                                let line = String(decoding: pending, as: UTF8.self)
                                    .replacingOccurrences(of: enteredToken, with: "[REDACTED]")
                                DispatchQueue.main.async { self?.appendLog(line + "\n") }
                            }
                            pending.removeAll(keepingCapacity: true)
                            discardingLongLine = false
                        } else if !discardingLongLine {
                            pending.append(byte)
                            if pending.count > 16_384 {
                                pending.removeAll(keepingCapacity: true)
                                discardingLongLine = true
                                DispatchQueue.main.async { self?.appendLog("[过长输出已省略]\n") }
                            }
                        }
                    }
                }
                if !pending.isEmpty && !discardingLongLine {
                    let line = String(decoding: pending, as: UTF8.self)
                        .replacingOccurrences(of: enteredToken, with: "[REDACTED]")
                    DispatchQueue.main.async { self?.appendLog(line + "\n") }
                }
            }
        } catch { status.stringValue = "启动失败：\(error.localizedDescription)" }
    }

    private func appendLog(_ value: String) {
        log.textStorage?.append(NSAttributedString(string: value))
        if let storage = log.textStorage, storage.length > 100_000 {
            storage.replaceCharacters(in: NSRange(location: 0, length: storage.length - 100_000), with: "")
        }
        log.scrollToEndOfDocument(nil)
    }

    @objc private func stopConnection() {
        if connector?.isRunning == true { connector?.terminate(); status.stringValue = "正在停止连接器…" }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if connector?.isRunning == true { sender.orderOut(nil); return false }
        return true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if connector?.isRunning == true { connector?.terminate() }
    }
}

private func runContractTests(at path: String) throws {
    let defaultWorkspaceArgs = try workspaceArguments("")
    let selectedWorkspaceArgs = try workspaceArguments(FileManager.default.temporaryDirectory.path)
    guard defaultWorkspaceArgs == ["--create-workspace"],
          selectedWorkspaceArgs.first == "--workspace",
          (try? workspaceArguments("relative-directory")) == nil else {
        throw LinkError.invalid("本地工作目录参数验证失败")
    }
    let hostilePath = "/tmp/app'$(printf UNSAFE)`printf UNSAFE`/node"
    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: "/bin/sh")
    shell.arguments = ["-c", "printf %s \(shellQuote(hostilePath))"]
    let quotedOutput = Pipe()
    shell.standardOutput = quotedOutput
    try shell.run()
    let shellResult = quotedOutput.fileHandleForReading.readDataToEndOfFile()
    shell.waitUntilExit()
    guard shell.terminationStatus == 0,
          String(data: shellResult, encoding: .utf8) == hostilePath else {
        throw LinkError.invalid("Hook 执行路径转义不安全")
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let vectors = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let accepted = vectors["accepted"] as? [[String: Any]],
          let rejected = vectors["rejected_uris"] as? [String] else { throw LinkError.invalid("测试向量格式无效") }
    for item in accepted {
        guard let uri = item["uri"] as? String, let expected = item["parsed"] as? [Any] else { throw LinkError.invalid("测试向量缺失") }
        let actual = try ConnectionLink.parse(uri)
        guard expected.count == 5,
              expected[0] as? String == serverOrigin,
              expected[1] as? String == actual.project,
              expected[2] as? String == actual.model,
              expected[3] as? Int == actual.contextTokens,
              expected[4] as? String == actual.historySync else { throw LinkError.invalid("测试向量不匹配") }
    }
    for uri in rejected {
        if (try? ConnectionLink.parse(uri)) != nil { throw LinkError.invalid("不安全的链接被接受") }
    }
    print("macOS Launcher URI contract: \(accepted.count) accepted, \(rejected.count) rejected")
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--self-test" {
    do { try runContractTests(at: CommandLine.arguments[2]) }
    catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
} else {
    let app = NSApplication.shared
    let delegate = Launcher()
    app.delegate = delegate
    app.run()
}
