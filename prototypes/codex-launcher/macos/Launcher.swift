import AppKit
import Foundation
import Darwin

private let serverOrigin = "https://gatherthread.cn"
private let testOrigin = "https://test.gatherthread.cn"
private let scheme = "gatherthread-connect"

private struct ConnectionLink: Equatable {
    let version: String
    let origin: String
    let project: String
    let model: String
    let contextTokens: Int
    let historySync: String
    let email: String?
    let authorizationID: String?
    let harness: String

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
        let baseFields: Set<String> = ["v", "origin", "project", "model", "context_window_tokens", "visible_history_sync"]
        let accountFields: Set<String> = ["email", "authorization_id"]
        let harnessFields: Set<String> = ["harness"]
        let allowed = baseFields.union(accountFields).union(harnessFields)
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
        guard let version = values["v"], ["1", "2", "3"].contains(version),
              Set(values.keys) == (version == "1" ? baseFields : version == "2" ? baseFields.union(accountFields) : allowed),
              let origin = values["origin"],
              (version == "1" ? origin == serverOrigin : [serverOrigin, testOrigin].contains(origin)),
              let project = values["project"], validProject(project),
              let model = values["model"], validModel(model),
              let tokenText = values["context_window_tokens"],
              !tokenText.isEmpty, tokenText.utf8.allSatisfy({ (48...57).contains($0) }),
              let tokens = Int(tokenText), (4096...2_000_000).contains(tokens),
              let mode = values["visible_history_sync"], ["first-connect", "never"].contains(mode) else {
            throw LinkError.invalid("连接链接的版本、服务地址或连接设置无效")
        }
        let email: String?
        let authorizationID: String?
        if version != "1" {
            guard let mailbox = values["email"], let normalized = normalizedEmail(mailbox),
                  let rawID = values["authorization_id"],
                  matches(rawID, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$") else {
                throw LinkError.invalid("邮箱账号或授权编号无效；请从网页重新打开启动器")
            }
            email = normalized
            authorizationID = rawID.lowercased()
        } else {
            email = nil
            authorizationID = nil
        }
        let harness = version == "3" ? values["harness"]! : "codex"
        guard ["codex", "claude-code"].contains(harness) else { throw LinkError.invalid("不支持的 Agent 类型") }
        guard harness != "claude-code" || validClaudeModel(model) else { throw LinkError.invalid("请输入完整的 Claude 模型 ID，不能使用 sonnet/opus 等别名") }
        return ConnectionLink(version: version, origin: origin, project: project, model: model,
                              contextTokens: tokens, historySync: mode, email: email, authorizationID: authorizationID,
                              harness: harness)
    }
}

private enum LinkError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        if case .invalid(let message) = self { return message }
        return nil
    }
}

private func matches(_ value: String, _ pattern: String) -> Bool {
    let range = NSRange(location: 0, length: value.utf16.count)
    return (try? NSRegularExpression(pattern: pattern).rangeOfFirstMatch(in: value, range: range)) == range
}

private func normalizedEmail(_ value: String) -> String? {
    guard value.utf16.count <= 254 else { return nil }
    let email = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard email.utf8.allSatisfy({ $0 < 128 }),
          matches(email, "^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$") else { return nil }
    let pieces = email.split(separator: "@")
    guard pieces.count == 2, pieces[0].count <= 64,
          pieces[1].split(separator: ".").allSatisfy({ $0.count <= 63 }) else { return nil }
    return email
}

private func makeClaimRequest(link: ConnectionLink, password: String, deviceName: String) throws -> URLRequest {
    guard ["2", "3"].contains(link.version), [serverOrigin, testOrigin].contains(link.origin),
          let email = link.email, let authorizationID = link.authorizationID,
          (8...128).contains(password.utf16.count), password.utf8.count <= 512,
          (1...120).contains(deviceName.utf16.count),
          !deviceName.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) }) else {
        throw LinkError.invalid("请检查邮箱和密码（8 至 128 个字符），并从网页重新打开启动器")
    }
    var request = URLRequest(url: URL(string: link.origin + "/v1/codex-launcher-authorizations/claim")!,
                             cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
        "authorization_id": authorizationID, "project_id": link.project, "email": email,
        "password": password, "device_name": deviceName,
    ])
    return request
}

private func parseClaimResponse(_ bytes: Data, expected link: ConnectionLink) throws -> String {
    guard bytes.count <= 16_384,
          let envelope = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let data = envelope["data"] as? [String: Any],
          let actor = data["actor"] as? [String: Any],
          let device = data["device"] as? [String: Any],
          let authorization = data["authorization"] as? [String: Any],
          let userID = actor["user_id"] as? String, !userID.isEmpty, userID.utf8.count <= 128,
          let deviceID = actor["device_id"] as? String, !deviceID.isEmpty, deviceID.utf8.count <= 128,
          device["id"] as? String == deviceID, device["user_id"] as? String == userID,
          let displayName = actor["display_name"] as? String, (1...120).contains(displayName.utf16.count),
          let deviceName = device["name"] as? String, (1...120).contains(deviceName.utf16.count),
          validTimestamp(device["created_at"]), validTimestamp(device["token_created_at"]),
          ["last_used_at", "expires_at", "revoked_at", "rotated_at"].allSatisfy({ validTimestamp(device[$0], nullable: true) }),
          let tokenVersion = device["token_version"] as? NSNumber,
          CFGetTypeID(tokenVersion) != CFBooleanGetTypeID(), tokenVersion.doubleValue.isFinite,
          tokenVersion.doubleValue.rounded() == tokenVersion.doubleValue, tokenVersion.intValue > 0,
          authorization["id"] as? String == link.authorizationID,
          authorization["user_id"] as? String == userID,
          let authorizerID = authorization["authorizer_device_id"] as? String,
          !authorizerID.isEmpty, authorizerID.utf8.count <= 128,
          validTimestamp(authorization["created_at"]), validTimestamp(authorization["expires_at"]),
          validTimestamp(authorization["claimed_at"]),
          authorization["revoked_at"] is NSNull, authorization["expired_at"] is NSNull,
          device["revoked_at"] is NSNull,
          authorization["claimed_by_device_id"] as? String == deviceID,
          let token = data["token"] as? String, matches(token, "^gta_[A-Za-z0-9_-]{43}$") else {
        throw LinkError.invalid("授权响应无效；请返回网页重新打开启动器，不要重复提交本次授权")
    }
    return token
}

private func validTimestamp(_ value: Any?, nullable: Bool = false) -> Bool {
    if nullable && value is NSNull { return true }
    guard let text = value as? String, text.utf8.count <= 40,
          matches(text, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$") else { return false }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = text.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
    return formatter.date(from: text) != nil
}

// Uses a private, cookie-free session; redirects and oversized responses fail closed.
private final class LauncherClaimClient: NSObject, URLSessionDataDelegate {
    private var bytes = Data()
    private var response: HTTPURLResponse?
    private var failed = false
    private var transportError = false
    private let done = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var runningTask: URLSessionDataTask?
    private var cancelled = false
    private var used = false

    func cancel() {
        let task = lock.withLock { cancelled = true; return runningTask }
        task?.cancel()
    }

    func claim(link: ConnectionLink, password: String, deviceName: String,
               configuration: URLSessionConfiguration = .ephemeral) throws -> String {
        guard lock.withLock({
            guard !used, !cancelled else { return false }
            used = true
            return true
        }) else { throw LinkError.invalid("授权已停止；请返回网页重新打开启动器") }
        var request = try makeClaimRequest(link: link, password: password, deviceName: deviceName)
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 15
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        let task = session.dataTask(with: request)
        let wasCancelled = lock.withLock { runningTask = task; return cancelled }
        request.httpBody = nil
        defer {
            session.invalidateAndCancel()
            lock.withLock { runningTask = nil; bytes.removeAll(keepingCapacity: false) }
        }
        if wasCancelled { task.cancel(); throw LinkError.invalid("授权已停止；请返回网页重新打开启动器") }
        task.resume()
        guard done.wait(timeout: .now() + 15) == .success else {
            task.cancel()
            throw LinkError.invalid("授权超时，状态未确认；请返回网页重新打开启动器，不要重试本次授权")
        }
        let (receivedBytes, receivedResponse, responseFailed, networkFailed, wasStopped) = lock.withLock { (bytes, response, failed, transportError, cancelled) }
        guard !wasStopped, !responseFailed, !networkFailed, let receivedResponse,
              receivedResponse.url?.absoluteString == link.origin + "/v1/codex-launcher-authorizations/claim" else {
            throw LinkError.invalid("无法确认授权结果；请返回网页重新打开启动器，不要重试本次授权")
        }
        guard receivedResponse.statusCode == 201 else {
            // Never display raw server messages, which could contain sensitive input.
            if receivedResponse.statusCode == 401 {
                throw LinkError.invalid("邮箱或密码验证失败；请检查后返回网页重新打开启动器")
            }
            if receivedResponse.statusCode == 429 {
                throw LinkError.invalid("尝试过于频繁，请稍后返回网页重新打开启动器")
            }
            if receivedResponse.statusCode == 503 {
                throw LinkError.invalid("账号验证服务暂时忙碌，请稍后返回网页重新打开启动器")
            }
            throw LinkError.invalid("本次授权已失效或不可用；请返回网页重新打开启动器")
        }
        return try parseClaimResponse(receivedBytes, expected: link)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        lock.withLock { failed = true }
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else {
            // Do not look up stored credentials or answer HTTP authentication prompts.
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse,
              http.expectedContentLength <= 16_384 else {
            lock.withLock { failed = true }
            completionHandler(.cancel)
            return
        }
        lock.withLock { self.response = http }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let accepted = lock.withLock {
            guard data.count <= 16_384 - bytes.count else { failed = true; return false }
            bytes.append(data)
            return true
        }
        if !accepted { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.withLock { transportError = error != nil }
        done.signal()
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

private func validClaudeModel(_ value: String) -> Bool {
    matches(value, "^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$")
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

private func executableAgent(_ harness: String = "codex") -> String {
    if harness == "claude-code" { return claudeCommandCandidates().first ?? "" }
    let manager = FileManager.default
    let name = harness == "claude-code" ? "claude" : "codex"
    let pathCandidates = (ProcessInfo.processInfo.environment["PATH"] ?? "")
        .split(separator: ":").map { String($0) + "/" + name }
    let home = manager.homeDirectoryForCurrentUser.path
    let candidates = pathCandidates + ["/opt/homebrew/bin/" + name, "/usr/local/bin/" + name,
                                       home + "/.npm-global/bin/" + name, home + "/.local/bin/" + name]
    return candidates.first(where: { manager.isExecutableFile(atPath: $0) }) ?? ""
}

private func claudeCommandCandidates(path: String = ProcessInfo.processInfo.environment["PATH"] ?? "",
                                     home: String = FileManager.default.homeDirectoryForCurrentUser.path) -> [String] {
    let paths = path.split(separator: ":").filter { $0.hasPrefix("/") }.map { String($0) + "/claude" }
        + ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", home + "/.npm-global/bin/claude", home + "/.local/bin/claude"]
    var seen = Set<String>()
    return Array(paths.filter { candidate in
        let identity = URL(fileURLWithPath: candidate).resolvingSymlinksInPath().standardizedFileURL.path
        return FileManager.default.isExecutableFile(atPath: candidate) && seen.insert(identity).inserted
    }.prefix(12))
}

private func compatibleClaudeVersion(_ value: String) -> Bool {
    guard let expression = try? NSRegularExpression(pattern: "^(\\d{1,6})\\.(\\d{1,6})\\.(\\d{1,6})(?:\\s|$)"),
          let match = expression.firstMatch(in: value.trimmingCharacters(in: .whitespacesAndNewlines),
                                           range: NSRange(location: 0, length: (value.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).length)) else { return false }
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines) as NSString
    let version = (1...3).compactMap { Int(text.substring(with: match.range(at: $0))) }
    return version.count == 3 && !version.lexicographicallyPrecedes([2, 1, 259])
}

private final class ClaudeVersionOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    func append(_ value: Data) { lock.lock(); defer { lock.unlock() }; bytes.append(value.prefix(max(0, 4096 - bytes.count))) }
    func text() -> String { lock.lock(); defer { lock.unlock() }; return String(decoding: bytes, as: UTF8.self) }
}

/** A bounded metadata-only probe. Full flags/authentication checks remain in connector preflight. */
private func probeClaudeVersion(_ executable: String) -> String {
    let process = Process(), output = Pipe(), captured = ClaudeVersionOutput()
    let done = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = ["--version"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    var environment = ProcessInfo.processInfo.environment
    for key in ["GATHERTHREAD_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"] {
        environment.removeValue(forKey: key)
    }
    let runtime = bundled("runtime")
    if FileManager.default.isExecutableFile(atPath: runtime.appendingPathComponent("node").path) {
        environment["PATH"] = runtime.path + ":" + (environment["PATH"] ?? "")
    }
    process.environment = environment
    output.fileHandleForReading.readabilityHandler = { handle in
        let bytes = handle.availableData
        captured.append(bytes)
        if bytes.isEmpty { handle.readabilityHandler = nil; drained.signal() }
    }
    process.terminationHandler = { _ in done.signal() }
    defer { output.fileHandleForReading.readabilityHandler = nil; try? output.fileHandleForReading.close() }
    do { try process.run() } catch { return "" }
    if done.wait(timeout: .now() + 0.8) == .timedOut {
        process.terminate()
        if done.wait(timeout: .now() + 0.1) == .timedOut { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
        return ""
    }
    _ = drained.wait(timeout: .now() + 0.1)
    return process.terminationStatus == 0 ? captured.text() : ""
}

private func preferredClaudeCommand(_ candidates: [String], probe: (String) -> String = probeClaudeVersion) -> (path: String, compatible: Bool) {
    for candidate in candidates where compatibleClaudeVersion(probe(candidate)) { return (candidate, true) }
    return (candidates.first ?? "", false)
}

private func canApplyClaudeDiscovery(harness: String, generation: Int, currentGeneration: Int,
                                    selected: String, original: String, manual: Bool, busy: Bool) -> Bool {
    harness == "claude-code" && generation == currentGeneration && selected == original && !manual && !busy
}

private func connectorArguments(link: ConnectionLink, connector: String, workspace: [String],
                                cli: String, model: String, contextTokens: Int, history: String,
                                codeSync: Bool = false) -> [String] {
    var arguments = [connector, "--url", link.origin, "--project", link.project] + workspace
    arguments += ["--plugin-hooks", "--model", model]
    if link.harness == "claude-code" {
        arguments += ["--claude-command", cli]
        if codeSync { arguments.append("--code-sync") }
    } else {
        arguments += ["--visible-history-sync", history, "--context-window-tokens", String(contextTokens), "--codex-command", cli]
    }
    return arguments
}

private final class Launcher: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate {
    private var window: NSWindow!
    private let project = NSTextField()
    private let workspace = NSTextField()
    private let codex = NSTextField()
    private let cliLabel = NSTextField(labelWithString: "Codex CLI 完整路径")
    private let heading = NSTextField(labelWithString: "连接本机 Agent")
    private let model = NSTextField()
    private let tokens = NSTextField()
    private let history = NSPopUpButton()
    private let codeSyncConsent = NSButton(checkboxWithTitle: "允许此设备同步项目文件（GT Cloud；上传仍需在项目中开启）", target: nil, action: nil)
    private let email = NSTextField()
    private let password = NSSecureTextField()
    private let passwordLabel = NSTextField(labelWithString: "密码")
    private let environmentLabel = NSTextField(labelWithString: "正式环境 · https://gatherthread.cn")
    private let advancedSettings = NSStackView()
    private let formScroll = NSScrollView()
    private var codexOnlySettings: [NSView] = []
    private let startButton = NSButton()
    private let installButton = NSButton()
    private let status = NSTextField(labelWithString: "请登录 GatherThread 网页，选择项目后点击‘打开启动器’。")
    private let log = NSTextView()
    private var connector: Process?
    private var pendingLink: URL?
    private var activeLink: ConnectionLink?
    private var connectionOrigin = serverOrigin
    private var connectionHarness = "codex"
    private var busy = false
    private var connectionAttempt: UUID?
    private var authorizationClient: LauncherClaimClient?
    private var claudeManualPath: String?
    private var claudeDiscoveryGeneration = 0
    private var claudeDiscoveryPending = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let icon = NSImage(contentsOf: bundled("GatherThread.icns")) { NSApp.applicationIconImage = icon }
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 GatherThread Launcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        menu.addItem(appItem)
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 700),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "GatherThread · Connect Agent"
        window.minSize = NSSize(width: 600, height: 650)
        window.center()
        window.delegate = self
        let outer = NSStackView()
        outer.orientation = .vertical
        outer.alignment = .leading
        outer.spacing = 8
        outer.translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(outer)
        NSLayoutConstraint.activate([
            outer.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20),
            outer.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -20),
            outer.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20),
            outer.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -20),
        ])
        formScroll.hasVerticalScroller = true
        formScroll.autohidesScrollers = true
        formScroll.drawsBackground = false
        formScroll.documentView = stack
        outer.addArrangedSubview(formScroll)
        formScroll.widthAnchor.constraint(equalTo: outer.widthAnchor).isActive = true
        formScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 250).isActive = true
        stack.widthAnchor.constraint(equalTo: formScroll.contentView.widthAnchor).isActive = true
        heading.font = .boldSystemFont(ofSize: 21)
        stack.addArrangedSubview(heading)
        addNote("网页带入邮箱和项目，只需输入账号密码，授权此 Mac 独立连接。", to: stack)
        addNote("安装：将 DMG 中的应用拖入‘应用程序’，从那里首次打开。\nInstall: drag the app from the DMG to Applications; open it there once.", to: stack)
        stack.addArrangedSubview(environmentLabel)
        stack.addArrangedSubview(NSButton(title: "打开 GatherThread 网页", target: self, action: #selector(openWebsite)))
        codex.stringValue = executableAgent()
        codex.delegate = self
        model.stringValue = "gpt-5.6-sol"
        tokens.stringValue = "128000"
        addField("邮箱账号（由网页填入）", email, to: stack)
        email.isEditable = false
        email.isSelectable = true
        stack.addArrangedSubview(passwordLabel)
        stack.addArrangedSubview(password)
        password.isEnabled = false
        password.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.addArrangedSubview(NSButton(title: "更多连接设置", target: self, action: #selector(toggleSettings)))
        advancedSettings.orientation = .vertical
        advancedSettings.alignment = .leading
        advancedSettings.spacing = 6
        stack.addArrangedSubview(advancedSettings)
        advancedSettings.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        advancedSettings.isHidden = true
        addField("项目 ID（由网页填入）", project, to: advancedSettings)
        advancedSettings.addArrangedSubview(cliLabel)
        advancedSettings.addArrangedSubview(codex)
        codex.widthAnchor.constraint(equalTo: advancedSettings.widthAnchor).isActive = true
        advancedSettings.addArrangedSubview(NSTextField(labelWithString: "本地工作目录（可选；留空使用默认项目目录）"))
        let workspaceRow = NSStackView()
        workspaceRow.orientation = .horizontal
        workspaceRow.spacing = 8
        workspaceRow.addArrangedSubview(workspace)
        workspaceRow.addArrangedSubview(NSButton(title: "浏览…", target: self, action: #selector(chooseWorkspace)))
        workspaceRow.addArrangedSubview(NSButton(title: "默认目录", target: self, action: #selector(clearWorkspace)))
        advancedSettings.addArrangedSubview(workspaceRow)
        workspaceRow.widthAnchor.constraint(equalTo: advancedSettings.widthAnchor).isActive = true
        stack.addArrangedSubview(codeSyncConsent)
        codeSyncConsent.state = .off
        codeSyncConsent.isHidden = true
        addField("模型", model, to: advancedSettings)
        let contextLabel = NSTextField(labelWithString: "上下文 Token 上限")
        advancedSettings.addArrangedSubview(contextLabel)
        advancedSettings.addArrangedSubview(tokens)
        tokens.widthAnchor.constraint(equalTo: advancedSettings.widthAnchor).isActive = true
        let historyLabel = NSTextField(labelWithString: "首次历史导入")
        advancedSettings.addArrangedSubview(historyLabel)
        history.addItems(withTitles: ["first-connect", "never"])
        advancedSettings.addArrangedSubview(history)
        codexOnlySettings = [contextLabel, tokens, historyLabel, history]
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 10
        installButton.title = "可选：安装随包插件"
        installButton.target = self
        installButton.action = #selector(installPlugin)
        actions.addArrangedSubview(installButton)
        startButton.title = "授权并连接"
        startButton.target = self
        startButton.action = #selector(startConnection)
        startButton.isEnabled = false
        actions.addArrangedSubview(startButton)
        actions.addArrangedSubview(NSButton(title: "停止连接", target: self, action: #selector(stopConnection)))
        outer.addArrangedSubview(actions)
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 2
        outer.addArrangedSubview(status)
        status.widthAnchor.constraint(equalTo: outer.widthAnchor).isActive = true
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        log.isEditable = false
        log.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        scroll.documentView = log
        scroll.translatesAutoresizingMaskIntoConstraints = false
        outer.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: outer.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
        addNote("若 macOS 阻止打开：核对官方包后前往 系统设置 → 隐私与安全性 → 仍要打开。尚未通过 Apple 公证。\nIf blocked: verify the official package, then use System Settings → Privacy & Security → Open Anyway. Not Apple-notarized.", to: stack, emphasized: true)
        addNote("审查、信任并允许共序 Hooks，才能同步所选 Agent 的本机直接回合。\nReview, trust and allow the selected Agent's GatherThread Hooks before syncing native turns.", to: outer, emphasized: true)
        addNote("关闭窗口不会停止连接；从 Dock 恢复后可停止。\nClosing the window keeps the connection running; restore it from the Dock to stop.", to: outer)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let pendingLink { self.pendingLink = nil; application(NSApp, open: [pendingLink]) }
    }

    private func addNote(_ value: String, to stack: NSStackView, emphasized: Bool = false) {
        let label = NSTextField(wrappingLabelWithString: value)
        label.textColor = emphasized ? .labelColor : .secondaryLabelColor
        if emphasized { label.font = .boldSystemFont(ofSize: 13) }
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
        password.stringValue = ""
        guard !busy, connector?.isRunning != true else {
            showError("请先停止当前连接或等待操作结束，再从网页打开新连接。")
            return
        }
        activeLink = nil
        startButton.isEnabled = false
        do {
            let link = try ConnectionLink.parse(urls[0].absoluteString)
            activeLink = link
            claudeDiscoveryGeneration += 1
            claudeDiscoveryPending = false
            if connectionHarness != link.harness {
                codex.stringValue = link.harness == "claude-code" ? claudeManualPath ?? executableAgent(link.harness) : executableAgent()
            }
            connectionHarness = link.harness
            let agentName = link.harness == "claude-code" ? "Claude Code" : "Codex"
            window.title = "GatherThread · Connect " + agentName
            heading.stringValue = "连接本机 " + agentName
            cliLabel.stringValue = agentName + " CLI 完整路径"
            for view in codexOnlySettings { view.isHidden = link.harness == "claude-code" }
            codeSyncConsent.isHidden = link.harness != "claude-code"
            codeSyncConsent.state = .off
            connectionOrigin = link.origin
            project.stringValue = link.project
            project.isEditable = false
            model.stringValue = link.model
            tokens.stringValue = String(link.contextTokens)
            history.selectItem(withTitle: link.historySync)
            email.stringValue = link.email ?? "旧版连接链接"
            passwordLabel.stringValue = link.version != "1" ? "账号密码（仅在本机输入，不保存）" : "旧版一次性设备授权（建议返回网页使用新版连接）"
            startButton.title = link.version != "1" ? "授权并连接" : "启动旧版连接"
            startButton.isEnabled = true
            password.isEnabled = true
            environmentLabel.stringValue = (link.origin == testOrigin ? "测试环境 · " : "正式环境 · ") + link.origin
            status.stringValue = link.version != "1" ? "输入密码后连接；其他已登录设备不受影响。" : "旧链接兼容模式。新版网页仅需输入邮箱账号密码。"
            if link.harness == "claude-code", claudeManualPath == nil { discoverClaudeCommand() }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } catch { showError(error.localizedDescription) }
    }

    @objc private func openWebsite() {
        NSWorkspace.shared.open(URL(string: connectionOrigin + "/app/")!)
    }

    @objc private func toggleSettings() {
        advancedSettings.isHidden.toggle()
        window.contentView?.layoutSubtreeIfNeeded()
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField, field === codex, connectionHarness == "claude-code" else { return }
        claudeManualPath = codex.stringValue
        claudeDiscoveryGeneration += 1
        claudeDiscoveryPending = false
        setBusy(busy)
    }

    private func discoverClaudeCommand() {
        let candidates = claudeCommandCandidates(), original = codex.stringValue, generation = claudeDiscoveryGeneration
        claudeDiscoveryPending = true
        setBusy(busy)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let preferred = preferredClaudeCommand(candidates)
            DispatchQueue.main.async { [weak self] in
                guard let self, canApplyClaudeDiscovery(harness: self.connectionHarness, generation: generation,
                    currentGeneration: self.claudeDiscoveryGeneration, selected: self.codex.stringValue, original: original,
                    manual: self.claudeManualPath != nil, busy: self.busy || self.connector?.isRunning == true) else { return }
                self.claudeDiscoveryPending = false
                if preferred.compatible { self.codex.stringValue = preferred.path }
                else { self.status.stringValue = "未发现兼容的 Claude Code CLI（需要 2.1.259 或更新版本）。请更新后重新打开；已保留当前路径。" }
                self.setBusy(self.busy)
            }
        }
    }

    private func setBusy(_ value: Bool) {
        busy = value
        installButton.isEnabled = !value && !claudeDiscoveryPending && connector?.isRunning != true
        startButton.isEnabled = !value && !claudeDiscoveryPending && connector?.isRunning != true && activeLink != nil
        password.isEnabled = !value && connector?.isRunning != true && activeLink != nil
        codeSyncConsent.isEnabled = !value && connector?.isRunning != true
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
        if claudeDiscoveryPending { status.stringValue = "正在检查本机 Claude Code 版本，请稍候。"; return }
        if busy || connector?.isRunning == true { showError("请先等待操作完成并停止连接，再安装插件。"); return }
        let codexPath = codex.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard FileManager.default.isExecutableFile(atPath: codexPath),
              FileManager.default.isExecutableFile(atPath: bundled("runtime/node").path) else {
            showError("请先选择已登录的所选 Agent CLI，并检查随包 Node。")
            return
        }
        let alert = NSAlert()
        alert.messageText = "安装 GatherThread 插件？"
        let selectedHarness = connectionHarness
        let agentName = selectedHarness == "claude-code" ? "Claude Code" : "Codex"
        alert.informativeText = "将为当前系统用户安装 " + agentName + " 的随包插件，并通过该 Agent 的官方命令注册。请审查 MCP 与 /hooks；此操作不会替你批准 Agent 的工具操作。"
        alert.addButton(withTitle: "安装")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        setBusy(true)
        status.stringValue = "正在安装插件…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let root = try selectedHarness == "claude-code" ? Self.prepareClaudePlugin() : Self.preparePlugin()
                try Self.runCodex(codexPath, ["plugin", "marketplace", "add", root.path])
                try Self.runCodex(codexPath, selectedHarness == "claude-code"
                                 ? ["plugin", "install", "gatherthread@gatherthread-launcher-claude", "--scope", "user"]
                                 : ["plugin", "add", "gatherthread@gatherthread-launcher"])
                DispatchQueue.main.async {
                    self?.setBusy(false)
                    self?.status.stringValue = "插件已安装。请重启所选 Agent 会话并在 /hooks 审查 Hooks。"
                }
            } catch {
                DispatchQueue.main.async {
                    self?.setBusy(false)
                    self?.status.stringValue = "插件安装失败：\(error.localizedDescription)"
                }
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

    private static func prepareClaudePlugin() throws -> URL {
        let manager = FileManager.default
        let parent = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("GatherThread Launcher", isDirectory: true)
        try manager.createDirectory(at: parent, withIntermediateDirectories: true)
        let destination = parent.appendingPathComponent("claude-marketplace", isDirectory: true)
        let stage = parent.appendingPathComponent(".claude-stage-\(UUID().uuidString)", isDirectory: true)
        let backup = parent.appendingPathComponent(".claude-previous-\(UUID().uuidString)", isDirectory: true)
        defer { try? manager.removeItem(at: stage) }
        try manager.copyItem(at: bundled("claude-marketplace"), to: stage)
        let plugin = stage.appendingPathComponent("plugins/gatherthread", isDirectory: true)
        let node = bundled("runtime/node").path
        let mcp: [String: Any] = ["mcpServers": ["gatherthread": ["command": node,
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launcher.mjs"]]]]
        try JSONSerialization.data(withJSONObject: mcp, options: [.prettyPrinted, .sortedKeys])
            .write(to: plugin.appendingPathComponent(".mcp.json"))
        let hooksFile = plugin.appendingPathComponent("hooks/hooks.json")
        guard var hooks = try JSONSerialization.jsonObject(with: Data(contentsOf: hooksFile)) as? [String: Any],
              var events = hooks["hooks"] as? [String: [[String: Any]]] else {
            throw LinkError.invalid("Claude Code 插件 Hooks 格式无效")
        }
        for event in events.keys {
            var entries = events[event]!
            for index in entries.indices {
                guard var items = entries[index]["hooks"] as? [[String: Any]] else { throw LinkError.invalid("Claude Code Hook 缺失") }
                for inner in items.indices {
                    guard items[inner]["type"] as? String == "command" else { throw LinkError.invalid("不支持的 Claude Code Hook") }
                    items[inner]["command"] = "\(shellQuote(node)) \"${CLAUDE_PLUGIN_ROOT}/scripts/hook-forwarder.mjs\""
                }
                entries[index]["hooks"] = items
            }
            events[event] = entries
        }
        hooks["hooks"] = events
        try JSONSerialization.data(withJSONObject: hooks, options: [.prettyPrinted, .sortedKeys]).write(to: hooksFile)
        let hadPrevious = manager.fileExists(atPath: destination.path)
        if hadPrevious {
            let manifest = destination.appendingPathComponent(".claude-plugin/marketplace.json")
            guard let existing = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any],
                  existing["name"] as? String == "gatherthread-launcher-claude" else {
                throw LinkError.invalid("已有目录不属于 GatherThread Claude Code 插件，未覆盖")
            }
            try manager.moveItem(at: destination, to: backup)
        }
        do { try manager.moveItem(at: stage, to: destination) }
        catch {
            if hadPrevious { try? manager.moveItem(at: backup, to: destination) }
            throw error
        }
        if hadPrevious { try? manager.removeItem(at: backup) }
        return destination
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
            throw LinkError.invalid("Agent 插件安装超时")
        }
        if process.terminationStatus != 0 { throw LinkError.invalid("Agent 插件命令失败（退出码 \(process.terminationStatus)）") }
    }

    @objc private func startConnection() {
        if claudeDiscoveryPending { status.stringValue = "正在检查本机 Claude Code 版本，请稍候。"; return }
        if busy || connector?.isRunning == true { status.stringValue = "连接或授权正在进行。"; return }
        guard let link = activeLink else { showError("请先登录网页，再选择项目并打开启动器。"); return }
        let node = bundled("runtime/node")
        let connectorFile = bundled(link.harness == "claude-code" ? "connector/claude-connect.js" : "connector/codex-connect.js")
        let codexPath = codex.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let enteredPassword = password.stringValue
        let projectId = project.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelName = model.stringValue
        let tokenCount = tokens.stringValue
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: connectorFile.path),
              FileManager.default.isExecutableFile(atPath: codexPath),
              validProject(projectId), projectId == link.project, validModel(modelName),
              link.harness != "claude-code" || validClaudeModel(modelName),
              !tokenCount.isEmpty, tokenCount.utf8.allSatisfy({ (48...57).contains($0) }),
              let count = Int(tokenCount), (4096...2_000_000).contains(count),
              let mode = history.selectedItem?.title, ["first-connect", "never"].contains(mode) else {
            showError("请检查包内 Node/连接器、所选 Agent CLI 路径、项目和连接设置。")
            return
        }
        if link.version != "1" {
            guard (8...128).contains(enteredPassword.utf16.count), enteredPassword.utf8.count <= 512 else {
                showError("请输入 8 至 128 个字符的账号密码。"); return
            }
        } else if !matches(enteredPassword, "^gtd_[A-Za-z0-9_-]{43}$") {
            showError("旧版链接需要有效的一次性设备授权；建议返回网页使用新版邮箱连接。"); return
        }
        let workspaceArgs: [String]
        do { workspaceArgs = try workspaceArguments(workspace.stringValue) }
        catch { showError(error.localizedDescription); return }
        let process = Process()
        process.executableURL = node
        process.arguments = connectorArguments(link: link, connector: connectorFile.path, workspace: workspaceArgs,
                                               cli: codexPath, model: modelName, contextTokens: count, history: mode,
                                               codeSync: codeSyncConsent.state == .on)
        password.stringValue = ""
        // A submitted handoff cannot be reused after an uncertain network result.
        activeLink = nil
        let attempt = UUID()
        let client = LauncherClaimClient()
        connectionAttempt = attempt
        authorizationClient = client
        setBusy(true)
        status.stringValue = link.version != "1" ? "正在验证账号并授权此 Mac…" : "正在启动旧版连接…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let credential: String
                if link.version != "1" {
                    credential = try client.claim(link: link, password: enteredPassword,
                                                  deviceName: "macOS · GatherThread Launcher")
                } else { credential = enteredPassword }
                DispatchQueue.main.async {
                    self?.completeAuthorization(attempt: attempt, process: process, node: node, credential: credential)
                }
            } catch {
                DispatchQueue.main.async {
                    guard self?.connectionAttempt == attempt else { return }
                    self?.connectionAttempt = nil
                    self?.authorizationClient = nil
                    self?.setBusy(false)
                    self?.status.stringValue = error.localizedDescription
                }
            }
        }
    }

    private func completeAuthorization(attempt: UUID, process: Process, node: URL, credential: String) {
        guard connectionAttempt == attempt, busy else { return }
        connectionAttempt = nil
        authorizationClient = nil
        launchConnector(process, node: node, credential: credential)
    }

    private func launchConnector(_ process: Process, node: URL, credential: String) {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = node.deletingLastPathComponent().path + ":" + (environment["PATH"] ?? "")
        environment.removeValue(forKey: "GATHERTHREAD_TOKEN")
        environment["GATHERTHREAD_TOKEN"] = credential
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard self?.connector === finished else { return }
                self?.connector = nil
                self?.setBusy(false)
                self?.status.stringValue = "连接器已退出（代码 \(finished.terminationStatus)）。可检查日志后重试。"
            }
        }
        do {
            try process.run()
            connector = process
            setBusy(false)
            status.stringValue = "连接器正在启动；请在所选 Agent 中审查并启用已安装的 Hooks。"
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
                                    .replacingOccurrences(of: credential, with: "[REDACTED]")
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
                        .replacingOccurrences(of: credential, with: "[REDACTED]")
                    DispatchQueue.main.async { self?.appendLog(line + "\n") }
                }
            }
        } catch {
            setBusy(false)
            status.stringValue = "连接器启动失败；请检查本机安装，并从网页重新授权。"
        }
    }

    private func appendLog(_ value: String) {
        log.textStorage?.append(NSAttributedString(string: value))
        if let storage = log.textStorage, storage.length > 100_000 {
            storage.replaceCharacters(in: NSRange(location: 0, length: storage.length - 100_000), with: "")
        }
        log.scrollToEndOfDocument(nil)
    }

    @objc private func stopConnection() {
        if connectionAttempt != nil {
            connectionAttempt = nil
            authorizationClient?.cancel()
            authorizationClient = nil
            password.stringValue = ""
            setBusy(false)
            status.stringValue = "授权已停止。请返回网页重新打开启动器，之前的结果不会启动连接。"
        }
        if connector?.isRunning == true { connector?.terminate(); status.stringValue = "正在停止连接器…" }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        password.stringValue = ""
        if busy || connector?.isRunning == true { sender.orderOut(nil); return false }
        return true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        authorizationClient?.cancel()
        authorizationClient = nil
        connectionAttempt = nil
        if connector?.isRunning == true { connector?.terminate() }
    }

    func verifyPasswordForm() throws {
        let uri = "gatherthread-connect://connect?v=2&origin=https%3A%2F%2Ftest.gatherthread.cn&project=project-example&model=gpt-6-sol&context_window_tokens=65536&visible_history_sync=never&email=person%40example.com&authorization_id=abcd1234-1234-4234-8234-123456789abc"
        application(NSApp, open: [URL(string: uri)!])
        window.contentView!.layoutSubtreeIfNeeded()
        let content = window.contentView!
        func labels(in view: NSView) -> [NSTextField] {
            (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap { labels(in: $0) }
        }
        let notices = labels(in: content)
        let security = notices.first { $0.stringValue.contains("系统设置 → 隐私与安全性 → 仍要打开") }
        let hooks = notices.first { $0.stringValue.contains("审查、信任并允许共序 Hooks") }
        guard let securityFont = security?.font, let hooksFont = hooks?.font,
              NSFontManager.shared.traits(of: securityFont).contains(.boldFontMask),
              NSFontManager.shared.traits(of: hooksFont).contains(.boldFontMask) else {
            throw LinkError.invalid("安装安全路径和 Hooks 信任说明未以醒目粗体显示")
        }
        guard advancedSettings.isHidden, email.stringValue == "person@example.com", !email.isEditable,
              password.stringValue.isEmpty, password.isEnabled, startButton.isEnabled,
              connectionOrigin == testOrigin,
              content.bounds.contains(password.convert(password.bounds, to: content)),
              content.bounds.contains(startButton.convert(startButton.bounds, to: content)) else {
            throw LinkError.invalid("邮箱密码表单布局不完整或按钮不可见")
        }
        let claude = uri.replacingOccurrences(of: "v=2", with: "v=3")
            .replacingOccurrences(of: "model=gpt-6-sol", with: "model=claude-sonnet-4-6") + "&harness=claude-code"
        application(NSApp, open: [URL(string: claude)!])
        guard connectionHarness == "claude-code", codeSyncConsent.state == .off, !codeSyncConsent.isHidden,
              codexOnlySettings.allSatisfy({ $0.isHidden }) else {
            throw LinkError.invalid("Claude Code 不应默认授权文件同步或显示 Codex 专用设置")
        }
        codeSyncConsent.state = .on
        application(NSApp, open: [URL(string: claude)!])
        guard codeSyncConsent.state == .off else { throw LinkError.invalid("新连接不得沿用旧的本地文件授权") }
        codex.stringValue = "/fixture/manually-selected-claude"
        controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: codex))
        application(NSApp, open: [URL(string: claude)!])
        guard codex.stringValue == "/fixture/manually-selected-claude", !claudeDiscoveryPending else {
            throw LinkError.invalid("Claude 自动发现不得覆盖用户手动选择的路径")
        }
        window.orderOut(nil)
        print("macOS Launcher form: prefilled email, masked password, compact settings, reachable connect button, bold installation/Hook guidance")
    }

    func verifyCancelledAuthorization() throws {
        let uri = "gatherthread-connect://connect?v=2&origin=https%3A%2F%2Ftest.gatherthread.cn&project=project-example&model=gpt-6-sol&context_window_tokens=65536&visible_history_sync=never&email=person%40example.com&authorization_id=abcd1234-1234-4234-8234-123456789abc"
        let link = try ConnectionLink.parse(uri)
        let attempt = UUID()
        connectionAttempt = attempt
        let client = LauncherClaimClient()
        authorizationClient = client
        setBusy(true)
        // Simulate a result already accepted by the server but delivered after Stop.
        stopConnection()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/false")
        completeAuthorization(attempt: attempt, process: process,
                              node: URL(fileURLWithPath: "/usr/bin/false"),
                              credential: "gta_" + String(repeating: "x", count: 43))
        guard connector == nil, !busy, connectionAttempt == nil else {
            throw LinkError.invalid("停止后仍启动了连接器")
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ClaimFixtureProtocol.self]
        guard (try? client.claim(link: link, password: "fixture-password-only", deviceName: "Fixture Mac", configuration: config)) == nil else {
            throw LinkError.invalid("停止后仍进行了邮箱授权")
        }
        print("macOS Launcher cancellation: Stop prevents stale authorization from starting a connector")
    }
}

private func runContractTests(at path: String) throws {
    try runAccountAuthorizationTests()
    let fixtureVersions = ["/old/claude": "2.1.150 (Claude Code)", "/new/claude": "2.1.306 (Claude Code)"]
    let discovered = preferredClaudeCommand(["/old/claude", "/new/claude"], probe: { fixtureVersions[$0] ?? "" })
    let unsupported = preferredClaudeCommand(["/old/claude"], probe: { fixtureVersions[$0] ?? "" })
    guard discovered.path == "/new/claude", discovered.compatible,
          unsupported.path == "/old/claude", !unsupported.compatible,
          compatibleClaudeVersion("2.1.259 (Claude Code)"), !compatibleClaudeVersion("2.1.258 (Claude Code)"),
          !compatibleClaudeVersion("debug 2.1.306"),
          !canApplyClaudeDiscovery(harness: "claude-code", generation: 1, currentGeneration: 1,
                                  selected: "/old/claude", original: "/old/claude", manual: true, busy: false),
          canApplyClaudeDiscovery(harness: "claude-code", generation: 1, currentGeneration: 1,
                                 selected: "/old/claude", original: "/old/claude", manual: false, busy: false) else {
        throw LinkError.invalid("Claude CLI 发现必须跳过旧版本，且不得覆盖手动路径")
    }
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
        if actual.harness == "claude-code" {
            let args = connectorArguments(link: actual, connector: "claude-connect.js", workspace: ["--create-workspace"],
                                          cli: "/fixture/claude", model: actual.model, contextTokens: actual.contextTokens, history: actual.historySync)
            let approved = connectorArguments(link: actual, connector: "claude-connect.js", workspace: ["--create-workspace"],
                                              cli: "/fixture/claude", model: actual.model, contextTokens: actual.contextTokens,
                                              history: actual.historySync, codeSync: true)
            guard !args.contains("--code-sync"), approved.contains("--code-sync"),
                  args.contains("--claude-command"), !args.contains("--codex-command"),
                  !args.contains("--context-window-tokens"), !args.contains("--visible-history-sync") else {
                throw LinkError.invalid("Claude Code 参数或本地文件授权边界不正确")
            }
        }
        guard [5, 7, 8].contains(expected.count),
              expected[0] as? String == actual.origin,
              expected[1] as? String == actual.project,
              expected[2] as? String == actual.model,
              expected[3] as? Int == actual.contextTokens,
              expected[4] as? String == actual.historySync else { throw LinkError.invalid("测试向量不匹配") }
        if expected.count >= 7 {
            guard expected[5] as? String == actual.email,
                  expected[6] as? String == actual.authorizationID else { throw LinkError.invalid("邮箱授权链接测试向量不匹配") }
            if expected.count == 8 && expected[7] as? String != actual.harness { throw LinkError.invalid("Agent 类型不匹配") }
        } else if actual.version != "1" { throw LinkError.invalid("新版链接缺少邮箱测试字段") }
    }
    for uri in rejected {
        if (try? ConnectionLink.parse(uri)) != nil { throw LinkError.invalid("不安全的链接被接受") }
    }
    print("macOS Launcher URI contract: \(accepted.count) accepted, \(rejected.count) rejected")
}

private func runAccountAuthorizationTests() throws {
    let raw = "gatherthread-connect://connect?v=2&origin=https%3A%2F%2Ftest.gatherthread.cn&project=project-example&model=gpt-6-sol&context_window_tokens=65536&visible_history_sync=never&email=person%40example.com&authorization_id=abcd1234-1234-4234-8234-123456789abc"
    let link = try ConnectionLink.parse(raw)
    let request = try makeClaimRequest(link: link, password: "fixture-password-only", deviceName: "Fixture Mac")
    guard request.url?.absoluteString == "https://test.gatherthread.cn/v1/codex-launcher-authorizations/claim",
          request.httpMethod == "POST", request.timeoutInterval == 15,
          request.value(forHTTPHeaderField: "Cookie") == nil,
          request.value(forHTTPHeaderField: "Origin") == nil,
          request.value(forHTTPHeaderField: "Authorization") == nil,
          request.httpShouldHandleCookies == false,
          let body = request.httpBody,
          let json = try JSONSerialization.jsonObject(with: body) as? [String: String],
          Set(json.keys) == Set(["authorization_id", "project_id", "email", "password", "device_name"]),
          json["email"] == "person@example.com", json["password"] == "fixture-password-only" else {
        throw LinkError.invalid("邮箱授权请求的环境或私密数据隔离验证失败")
    }
    guard (try? makeClaimRequest(link: link, password: "short", deviceName: "Fixture Mac")) == nil,
          (try? makeClaimRequest(link: link, password: String(repeating: "a", count: 129), deviceName: "Fixture Mac")) == nil else {
        throw LinkError.invalid("密码长度验证失败")
    }
    let credential = "gta_" + String(repeating: "x", count: 43)
    let fixture: [String: Any] = ["data": [
        "actor": ["user_id": "user-fixture", "display_name": "Fixture", "device_id": "device-fixture"],
        "device": ["id": "device-fixture", "user_id": "user-fixture", "name": "Fixture Mac",
                   "created_at": "2026-10-12T01:00:00.000Z", "token_created_at": "2026-10-12T01:00:00.000Z",
                   "last_used_at": NSNull(), "expires_at": NSNull(), "revoked_at": NSNull(),
                   "rotated_at": NSNull(), "token_version": 1],
        "token": credential,
        "authorization": ["id": "abcd1234-1234-4234-8234-123456789abc", "user_id": "user-fixture", "claimed_by_device_id": "device-fixture",
                          "authorizer_device_id": "browser-fixture", "created_at": "2026-10-12T01:00:00.000Z",
                          "expires_at": "2026-10-12T01:10:00.000Z", "claimed_at": "2026-10-12T01:00:01.000Z",
                          "revoked_at": NSNull(), "expired_at": NSNull()]
    ]]
    let data = try JSONSerialization.data(withJSONObject: fixture)
    guard try parseClaimResponse(data, expected: link) == credential,
          (try? parseClaimResponse(Data(repeating: 32, count: 16_385), expected: link)) == nil,
          (try? parseClaimResponse(Data("{}".utf8), expected: link)) == nil else {
        throw LinkError.invalid("邮箱授权响应结构或大小验证失败")
    }
    var invalid = fixture["data"] as! [String: Any]
    invalid["actor"] = ["user_id": "user-other", "display_name": "Fixture", "device_id": "device-fixture"]
    let crossed = try JSONSerialization.data(withJSONObject: ["data": invalid])
    guard (try? parseClaimResponse(crossed, expected: link)) == nil else {
        throw LinkError.invalid("跨账号的设备授权被接受")
    }
    invalid = fixture["data"] as! [String: Any]
    invalid["device"] = ["id": "device-fixture", "user_id": "user-fixture", "name": "Fixture Mac"]
    let incomplete = try JSONSerialization.data(withJSONObject: ["data": invalid])
    guard (try? parseClaimResponse(incomplete, expected: link)) == nil else {
        throw LinkError.invalid("不完整的设备授权响应被接受")
    }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ClaimFixtureProtocol.self]
    ClaimFixtureProtocol.responseBody = data
    ClaimFixtureProtocol.statusCode = 201
    ClaimFixtureProtocol.requestCount = 0
    let received = try LauncherClaimClient().claim(link: link, password: "fixture-password-only", deviceName: "Fixture Mac", configuration: config)
    guard received == credential, ClaimFixtureProtocol.requestCount == 1 else {
        throw LinkError.invalid("邮箱授权发生了不安全的自动重试")
    }
    let delayedConfig = URLSessionConfiguration.ephemeral
    delayedConfig.protocolClasses = [DelayedClaimFixtureProtocol.self]
    DelayedClaimFixtureProtocol.body = data
    DelayedClaimFixtureProtocol.started = DispatchSemaphore(value: 0)
    let delayedClient = LauncherClaimClient()
    let cancellationObserved = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
        if (try? delayedClient.claim(link: link, password: "fixture-password-only", deviceName: "Fixture Mac", configuration: delayedConfig)) == nil {
            cancellationObserved.signal()
        }
    }
    guard DelayedClaimFixtureProtocol.started.wait(timeout: .now() + 2) == .success else {
        throw LinkError.invalid("延迟授权测试未启动")
    }
    delayedClient.cancel()
    guard cancellationObserved.wait(timeout: .now() + 2) == .success else {
        throw LinkError.invalid("停止未取消正在执行的邮箱授权")
    }
    ClaimFixtureProtocol.responseBody = Data(repeating: 32, count: 16_385)
    guard (try? LauncherClaimClient().claim(link: link, password: "fixture-password-only", deviceName: "Fixture Mac", configuration: config)) == nil else {
        throw LinkError.invalid("过大的网络授权响应被接受")
    }
    ClaimFixtureProtocol.statusCode = 401
    ClaimFixtureProtocol.responseBody = Data("upstream should never echo fixture-password-only".utf8)
    var passwordRejected = false
    do {
        _ = try LauncherClaimClient().claim(link: link, password: "fixture-password-only", deviceName: "Fixture Mac", configuration: config)
    } catch {
        passwordRejected = true
        guard !error.localizedDescription.contains("fixture-password-only") else {
            throw LinkError.invalid("原始服务错误泄露了私密输入")
        }
    }
    guard passwordRejected else { throw LinkError.invalid("错误的密码响应被接受") }
    let client = LauncherClaimClient()
    let session = URLSession(configuration: config)
    let task = session.dataTask(with: request)
    let redirect = HTTPURLResponse(url: request.url!, statusCode: 307, httpVersion: "HTTP/1.1", headerFields: nil)!
    var redirectRejected = false
    client.urlSession(session, task: task, willPerformHTTPRedirection: redirect, newRequest: request) { redirectRejected = $0 == nil }
    session.invalidateAndCancel()
    guard redirectRejected else { throw LinkError.invalid("邮箱密码授权允许了 HTTP 重定向") }
    print("macOS Launcher email authorization: request isolation and bounded response passed")
}

private final class ClaimFixtureProtocol: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 201
    static var requestCount = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requestCount += 1
        guard request.httpMethod == "POST", request.value(forHTTPHeaderField: "Cookie") == nil,
              request.value(forHTTPHeaderField: "Origin") == nil,
              request.value(forHTTPHeaderField: "Authorization") == nil else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class DelayedClaimFixtureProtocol: URLProtocol {
    static var body = Data()
    static var started = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.started.signal()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [self] in
            guard !lock.withLock({ stopped }) else { return }
            let response = HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Self.body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { lock.withLock { stopped = true } }
}

private func runIconTests(at path: String) throws {
    guard let icon = NSImage(contentsOfFile: path), icon.isValid,
          icon.representations.contains(where: { $0.pixelsWide >= 512 && $0.pixelsHigh >= 512 }) else {
        throw LinkError.invalid("GatherThread 应用图标无法读取或缺少高清尺寸")
    }
    print("macOS Launcher icon: native AppKit decoded the high-resolution ICNS")
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--icon-self-test" {
    do { try runIconTests(at: CommandLine.arguments[2]) }
    catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
} else if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--claude-discovery-self-test" {
    let selected = preferredClaudeCommand(claudeCommandCandidates())
    print("Claude CLI discovery (metadata only): compatible=\(selected.compatible), path=\(selected.path)")
    if !selected.compatible { exit(1) }
} else if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--form-self-test" {
    let app = NSApplication.shared
    let delegate = Launcher()
    app.delegate = delegate
    delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
    do { try delegate.verifyPasswordForm(); try delegate.verifyCancelledAuthorization() }
    catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
} else if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--self-test" {
    do { try runContractTests(at: CommandLine.arguments[2]) }
    catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
} else {
    let app = NSApplication.shared
    let delegate = Launcher()
    app.delegate = delegate
    app.run()
}
