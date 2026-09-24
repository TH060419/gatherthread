window.__ModuleLoader__.load({ id: "@gatherthread/dsh-host", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

const React = require("react");
const STATUS_PATH = "/api/gatherthread.status";
const RPC_CHANNEL = "/gatherthread";
const POLL_INTERVAL_MS = 2000;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CONNECTION_STATES = new Set(["connecting", "connected", "offline", "error", "stopped"]);
const SESSION_STATES = new Set(["connecting", "idle", "running", "offline", "error"]);
const AUTHORIZATION_STATES = new Set(["unpaired", "pairing", "paired"]);

const inject = ["slots", "connection", "sessions"];

function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "gatherthread",
    order: 30,
    label: "GatherThread / 共序",
  }, () => GatherThreadStatusPanel({ connection: ctx.connection, sessions: ctx.sessions })));
}

function GatherThreadStatusPanel({ connection, sessions }) {
  const [snapshot, setSnapshot] = React.useState(undefined);
  const [nativeState, setNativeState] = React.useState(undefined);
  const [catalog, setCatalog] = React.useState(undefined);
  const [unavailable, setUnavailable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [serverUrl, setServerUrl] = React.useState("");
  const [deviceName, setDeviceName] = React.useState("DeepSeek Harness");
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const visibleSessionSignature = React.useRef("");

  React.useEffect(() => {
    let disposed = false;
    let timer;
    let activeRequest;
    let transientFailures = 0;

    const refresh = async () => {
      activeRequest = new AbortController();
      let terminalFailure = false;
      try {
        const result = await readHostState(connection, activeRequest.signal);
        terminalFailure = result.terminalFailure;
        if (!disposed) {
          transientFailures = 0;
          const nextSignature = result.nativeState?.runtime.sessions
            .map((session) => session.sessionId)
            .sort()
            .join("\n") ?? "";
          if (nextSignature !== visibleSessionSignature.current) {
            visibleSessionSignature.current = nextSignature;
            void Promise.resolve(sessions.refresh()).catch(() => undefined);
          }
          setSnapshot(result.snapshot);
          setNativeState(result.nativeState);
          setUnavailable(false);
          timer = setTimeout(refresh, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (disposed || activeRequest.signal.aborted) return;
        terminalFailure = error?.terminalFailure === true;
        setSnapshot(undefined);
        setNativeState(undefined);
        setCatalog(undefined);
        setUnavailable(true);
        if (!terminalFailure && transientFailures < MAX_TRANSIENT_RETRIES) {
          transientFailures += 1;
          timer = setTimeout(refresh, POLL_INTERVAL_MS * (2 ** (transientFailures - 1)));
        }
      }
    };

    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      activeRequest?.abort();
    };
  }, [connection, sessions]);

  const runAction = async (endpoint, payload, onSuccess) => {
    if (busy) return;
    const controller = new AbortController();
    setBusy(true);
    setNotice("");
    try {
      const value = await callNative(connection, endpoint, payload, controller.signal);
      const next = endpoint === "catalog/get" ? parseCatalog(value) : parseNativeState(value);
      if (endpoint === "catalog/get") {
        setCatalog(next);
        const firstProvider = next.providers[0];
        setProvider((current) => current || firstProvider?.id || "");
        setModel((current) => current || firstProvider?.models[0]?.id || "");
      } else {
        setNativeState(next);
        setSnapshot(next.runtime);
        if (endpoint === "connection/configure") await sessions.refresh();
      }
      onSuccess?.(next);
    } catch {
      setNotice(endpoint.startsWith("code/")
        ? "代码同步未完成。请检查本机授权、项目权限和云端版本；不会强制覆盖文件。"
        : endpoint.startsWith("sync/")
        ? "上传操作未完成。请检查连接和会话权限后重试。"
        : "操作未完成。请检查服务器地址、当前授权和模型配置。");
    } finally {
      setBusy(false);
    }
  };

  const connectionState = snapshot?.connection ?? "connecting";
  const project = snapshot?.projectName ?? "GatherThread";
  const sessionRows = snapshot?.sessions ?? [];
  return React.createElement("section", {
    "data-gatherthread-status": connectionState,
    style: styles.panel,
  },
  React.createElement("div", { style: styles.heading },
    React.createElement("div", null,
      React.createElement("h2", { style: styles.title }, "GatherThread / 共序"),
      React.createElement("p", { style: styles.subtitle }, project)),
    React.createElement("span", { style: badgeStyle(connectionState) }, statusLabel(connectionState))),
  unavailable
    ? React.createElement("p", { role: "status", style: styles.notice }, "状态暂不可用。请在 Host 恢复后刷新页面。")
    : null,
  React.createElement("p", { style: styles.summary },
    `活跃会话 ${String(snapshot?.activeSessionCount ?? 0)} / ${String(sessionRows.length)}`),
  React.createElement("div", { style: styles.list },
    ...sessionRows.map((session) => {
      const sync = nativeState?.localSync?.find((item) => item.sessionId === session.sessionId);
      return React.createElement("div", {
      key: session.sessionId,
      style: styles.row,
    },
    React.createElement("div", { style: styles.sessionText },
      React.createElement("strong", { style: styles.sessionTitle }, session.title),
      React.createElement("span", { style: styles.sessionMeta },
        session.lastSyncedAt === undefined ? "尚未同步" : `最近同步 ${formatTime(session.lastSyncedAt)}`)),
    sync === undefined ? React.createElement("span", { style: badgeStyle(session.state) }, statusLabel(session.state))
      : React.createElement("div", { style: styles.syncActions },
        React.createElement("label", { style: styles.syncToggle },
          React.createElement("input", {
            type: "checkbox",
            checked: sync.automaticUpload,
            disabled: busy,
            onChange: (event) => void runAction("sync/set-auto-upload", {
              projectId: sync.projectId,
              sessionId: sync.sessionId,
              enabled: event.target.checked,
            }),
          }),
          "自动上传"),
        React.createElement("button", {
          type: "button",
          disabled: busy || sync.uploadableLocalTurns < 1,
          style: styles.compactButton,
          onClick: () => void runAction("sync/upload", {
            projectId: sync.projectId,
            sessionId: sync.sessionId,
          }),
        }, sync.uploadableLocalTurns > 0 ? `手动上传 ${String(sync.uploadableLocalTurns)}` : "已上传")));
    })),
  nativeState === undefined || unavailable
    ? null
    : renderNativeControls({
      nativeState,
      catalog,
      busy,
      notice,
      serverUrl,
      deviceName,
      provider,
      model,
      setServerUrl,
      setDeviceName,
      setProvider,
      setModel,
      runAction,
    }),
  nativeState === undefined || unavailable ? null : renderCodeSyncControls(nativeState, busy, runAction));
}

function renderCodeSyncControls(state, busy, runAction) {
  if (!state.codeSync?.length) return null;
  const actions = [
    ["code_sync_status", "检查状态"],
    ["code_upload", "上传代码"],
    ["code_download", "下载更新"],
    ["code_recover", "恢复到新目录"],
  ];
  return React.createElement("section", { style: styles.connectionCard, "aria-label": "项目代码同步" },
    React.createElement("h3", { style: styles.sectionTitle }, "项目代码 · Git"),
    React.createElement("p", { style: styles.muted },
      "代码与会话上传独立。每位成员使用自己的云端分支；项目成员均可读取代码。上传前请检查源文件，不上传密钥或私人资料。"),
    ...state.codeSync.map((project) => {
      const invoke = (action) => void runAction("code/action", { projectId: project.projectId, action });
      const status = project.status;
      return React.createElement("details", { key: project.projectId, style: { ...styles.row, display: "block" } },
        React.createElement("summary", { style: styles.sessionTitle }, project.projectName),
        React.createElement("div", { style: styles.form },
          React.createElement("label", { style: styles.syncToggle },
            React.createElement("input", {
              type: "checkbox", checked: project.authorized, disabled: busy,
              onChange: (event) => void runAction("code/authorize", {
                projectId: project.projectId, enabled: event.target.checked,
              }),
            }), "允许此 DSH 同步该项目代码"),
          React.createElement("p", { style: styles.muted }, "仅访问此项目已经绑定的本地目录，不改动原 Git 分支或暂存区。下载要求本地没有未上传改动；恢复始终新建目录，不更换当前 Agent 工作目录。"),
          status ? React.createElement("p", { style: styles.sessionMeta },
            status.local_status_unknown ? "已恢复云端副本；原工作区状态未知，请单独检查。" : status.enabled
              ? `${status.file_count} 个源文件 · ${status.local_changes} 项待上传 · ${status.excluded_count} 项已排除 · 云端 ${status.cloud_commit?.slice(0, 8) ?? "尚无版本"}`
              : "请先由项目创建者在 GatherThread 的「项目代码」中启用 Git。") : null,
          status?.needs_download ? React.createElement("p", { style: styles.notice }, "云端有新版本。请先下载；本地有改动时请恢复到新目录比较，不会自动覆盖。") : null,
          project.authorized ? React.createElement("label", { style: styles.syncToggle },
            React.createElement("input", {
              type: "checkbox", checked: status?.automatic_upload === true,
              disabled: busy || !status?.enabled,
              onChange: (event) => invoke(event.target.checked ? "code_auto_upload_enable" : "code_auto_upload_disable"),
            }), "空闲时自动上传本地代码至云端") : null,
          React.createElement("div", { style: styles.syncActions }, ...actions.map(([action, label]) => (
            React.createElement("button", {
              key: action, type: "button", style: styles.compactButton,
              disabled: busy || !project.authorized || (action !== "code_sync_status" && !status?.enabled),
              onClick: () => {
                if (action === "code_recover" && !window.confirm("将云端代码恢复到当前项目旁的新目录，原目录和会话保持不变。继续？")) return;
                invoke(action);
              },
            }, label)
          ))),
          status?.recovery_directory ? React.createElement("p", { role: "status", style: styles.notice },
            `已恢复至项目同级目录：${status.recovery_directory}。在本地 Agent 中打开该目录继续工作；原会话保持不变。`) : null,
          project.error ? React.createElement("p", { role: "status", style: styles.notice }, codeSyncErrorLabel(project.error)) : null,
        ));
    }));
}

function codeSyncErrorLabel(code) {
  const labels = {
    code_sync_disabled: "请先允许此 DSH 同步项目代码。",
    code_sync_busy: "Agent 正在工作，请等待本轮结束后再同步。",
    code_workspace_busy: "Agent 正在工作，请等待本轮结束后再同步。",
    code_sync_dirty: "本地有未上传修改。先上传，或恢复云端版本到新目录比较。",
    code_sync_recovery_required: "本地目录缺失或上次下载中断，请先将云端副本恢复到新目录。",
    code_sync_forbidden: "代码访问被拒绝，请检查该设备的登录状态与项目权限。",
    code_sync_conflict: "云端版本已变化。请先安全下载或恢复到新目录比较，未覆盖任何云端版本。",
    code_conflict: "云端版本冲突。请检查最新分支，保留本地修改后重试。",
    code_stale_head: "云端已有新版本。请恢复到新目录比较，不要覆盖未上传的本地修改。",
    code_merge_conflict: "分支存在冲突。请保留本地修改，比较云端版本并处理冲突。",
    code_storage_quota_exceeded: "项目代码存储额度已满，请联系服务管理员。",
    code_storage_check_required: "代码写入因存储检查暂时停止，请联系服务管理员；会话同步仍可使用。",
    code_git_unavailable: "Git 不可用，请检查服务器与本机的 Git 安装。",
    code_secret_detected: "检测到可能的密钥，已阻止上传。请检查项目文件。",
    code_not_enabled: "请先由项目创建者在 GatherThread 启用项目 Git。",
    code_sync_secret: "检测到可能的密钥，已阻止上传。请检查项目文件。",
  };
  return labels[code] ?? "代码同步未完成。请检查授权、文件和云端状态后重试；会话同步不受影响。";
}

async function readHostState(connection, signal) {
  if (typeof connection?.rpc?.call === "function") {
    try {
      const value = await callNative(connection, "status/get", {}, signal);
      const nativeState = parseNativeState(value);
      return { snapshot: nativeState.runtime, nativeState, terminalFailure: false };
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = error instanceof Error ? error : new Error("native status unavailable");
      failure.terminalFailure = true;
      throw failure;
    }
  }
  const response = await fetch(STATUS_PATH, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const error = new Error("status unavailable");
    error.terminalFailure = response.status >= 400 && response.status < 500;
    throw error;
  }
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("status response too large");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("status response too large");
  return { snapshot: parseSnapshot(JSON.parse(text)), nativeState: undefined, terminalFailure: false };
}

async function callNative(connection, endpoint, payload, signal) {
  if (connection === undefined || connection === null || typeof connection.rpc?.call !== "function") {
    throw new Error("native status unavailable");
  }
  const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload, signal);
  exactObject(result, ["ok", "value", "error"]);
  if (result.ok !== true) throw new Error("native action failed");
  return result.value;
}

function renderNativeControls(input) {
  const state = input.nativeState;
  const controls = [];
  if (state.authorization === "unpaired") {
    controls.push(
      React.createElement("div", { key: "service-options", style: styles.choiceRow },
        React.createElement("button", {
          type: "button",
          disabled: input.busy || state.officialServerUrl === undefined,
          style: styles.secondaryButton,
          onClick: () => input.setServerUrl(state.officialServerUrl || ""),
        }, state.officialServerUrl === undefined ? "共序官方服务 · 尚未开放" : "使用共序官方服务"),
        React.createElement("span", { style: styles.muted }, "局域网、自托管与 Tailscale 请使用自定义地址。")),
      React.createElement("form", {
        key: "pairing-form",
        style: styles.form,
        onSubmit: (event) => {
          event.preventDefault();
          void input.runAction("pairing/start", {
            serverUrl: input.serverUrl,
            deviceName: input.deviceName,
          });
        },
      },
      field("GatherThread 服务器地址", React.createElement("input", {
        type: "url",
        required: true,
        maxLength: 2048,
        value: input.serverUrl,
        placeholder: "https://gatherthread.example",
        autoComplete: "url",
        style: styles.input,
        onChange: (event) => input.setServerUrl(event.target.value),
      })),
      field("DSH 设备名称", React.createElement("input", {
        type: "text",
        required: true,
        maxLength: 120,
        value: input.deviceName,
        autoComplete: "off",
        style: styles.input,
        onChange: (event) => input.setDeviceName(event.target.value),
      })),
      React.createElement("button", {
        type: "submit",
        disabled: input.busy,
        style: styles.primaryButton,
      }, input.busy ? "正在创建配对…" : "登录并配对")),
      React.createElement("p", { key: "account-note", style: styles.muted },
        "当前版本使用你已打开的 GatherThread 浏览器会话或邀请身份确认，不假设另有公共账户。长期凭据只保存在 DSH 本机凭据库。"),
    );
  } else if (state.authorization === "pairing") {
    controls.push(
      React.createElement("div", { key: "pairing", style: styles.pairing },
        React.createElement("p", { style: styles.summary }, "在浏览器中确认这次短时、单次配对："),
        React.createElement("code", { style: styles.code }, state.pairing.userCode),
        React.createElement("a", {
          href: state.pairing.verificationUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          style: styles.linkButton,
        }, "打开 GatherThread 确认"),
        React.createElement("button", {
          type: "button",
          disabled: input.busy,
          style: styles.secondaryButton,
          onClick: () => void input.runAction("pairing/cancel", {}),
        }, "取消配对")),
    );
  } else if (state.route === undefined) {
    const providers = input.catalog?.providers ?? [];
    const selectedProvider = providers.find((entry) => entry.id === input.provider) ?? providers[0];
    const models = selectedProvider?.models ?? [];
    controls.push(
      connectionSummary(state),
      // Reaching this branch means authorization is already "paired": the
      // "unpaired" and "pairing" states are handled by earlier branches. The
      // browser approval succeeded, but without a provider and model no runtime
      // is registered, so a bare stopped connection is indistinguishable from a
      // fresh install. State the remaining step explicitly.
      React.createElement("p", { key: "select-model-notice", style: styles.notice },
        "配对完成后，尚未选择 DSH Provider 与 Model。完成选择并点击下方按钮后，本机 DSH 运行时才会注册到 GatherThread；在此之前，GatherThread 网页无法发现这台 DSH。"),
      input.catalog === undefined
        ? React.createElement("button", {
          key: "load-catalog",
          type: "button",
          disabled: input.busy,
          style: styles.primaryButton,
          onClick: () => void input.runAction("catalog/get", {}),
        }, input.busy ? "正在读取…" : "选择 DSH 模型")
        : React.createElement("form", {
          key: "binding-form",
          style: styles.form,
          onSubmit: (event) => {
            event.preventDefault();
            void input.runAction("connection/configure", {
              provider: input.provider,
              model: input.model,
            }, () => input.setCatalog(undefined));
          },
        },
        React.createElement("p", { style: styles.muted },
          `将同步全部 ${String(input.catalog.projects.length)} 个可访问的 GatherThread 项目；项目权限分别生效。`),
        field("DSH Provider", selectControl(
          providers,
          input.provider,
          (value) => {
            input.setProvider(value);
            const next = providers.find((entry) => entry.id === value);
            input.setModel(next?.models[0]?.id || "");
          },
          (entry) => entry.id,
          (entry) => entry.name,
        )),
        field("DSH Model", selectControl(
          models,
          input.model,
          input.setModel,
          (entry) => entry.id,
          (entry) => entry.name,
        )),
        React.createElement("button", {
          type: "submit",
          disabled: input.busy || !input.provider || !input.model,
          style: styles.primaryButton,
        }, input.busy ? "正在连接…" : "连接全部可访问项目")),
      disconnectButton(input),
    );
  } else {
    controls.push(
      connectionSummary(state),
      React.createElement("dl", { key: "binding", style: styles.details },
        detail("项目", `${String(state.projectCount)} 个可访问项目`),
        detail("Provider", state.route.provider),
        detail("Model", state.route.model)),
      React.createElement("p", { key: "projects", style: styles.muted },
        state.bindings.map((binding) => binding.projectName).join(" · ") || "当前没有可访问的活跃项目。"),
      disconnectButton(input),
    );
  }
  return React.createElement("section", { style: styles.connectionCard },
    React.createElement("div", { style: styles.subheading },
      React.createElement("h3", { style: styles.sectionTitle }, "连接共序"),
      React.createElement("span", { style: styles.muted }, "插件主动出站连接，不需要公网访问本机 DSH。")),
    ...controls,
    React.createElement("p", { style: styles.muted },
      `已验证兼容：${state.compatibility.package}@${state.compatibility.version} · ${state.compatibility.profile}`),
    input.notice ? React.createElement("p", { role: "alert", style: styles.notice }, input.notice) : null);
}

function connectionSummary(state) {
  return React.createElement("dl", { key: "connection-summary", style: styles.details },
    detail("服务器", state.serverUrl),
    detail("设备", state.deviceName));
}

function disconnectButton(input) {
  return React.createElement("button", {
    key: "disconnect",
    type: "button",
    disabled: input.busy,
    style: styles.secondaryButton,
    onClick: () => void input.runAction("connection/disconnect", {}, () => input.setCatalog(undefined)),
  }, "断开此 DSH 的本地配对");
}

function field(label, control) {
  return React.createElement("label", { style: styles.field },
    React.createElement("span", { style: styles.fieldLabel }, label),
    control);
}

function selectControl(entries, value, setValue, keyOf, labelOf) {
  return React.createElement("select", {
    required: true,
    value,
    style: styles.input,
    onChange: (event) => setValue(event.target.value),
  }, ...entries.map((entry) => React.createElement("option", {
    key: keyOf(entry),
    value: keyOf(entry),
  }, labelOf(entry))));
}

function detail(label, value) {
  return React.createElement("div", { style: styles.detailRow },
    React.createElement("dt", { style: styles.muted }, label),
    React.createElement("dd", { style: styles.detailValue }, value));
}

function parseNativeState(value) {
  exactObject(value, [
    "schemaVersion", "integration", "authorization", "compatibility", "runtime",
    "officialServerUrl", "serverUrl", "deviceName", "route", "projectCount", "bindings", "localSync", "codeSync", "pairing", "recoverableError",
  ]);
  if (value.schemaVersion !== 2 || value.integration !== "gatherthread") throw new Error("invalid native status identity");
  if (!AUTHORIZATION_STATES.has(value.authorization)) throw new Error("invalid native authorization state");
  exactObject(value.compatibility, ["package", "version", "profile"]);
  if (value.compatibility.package !== "@deepseek-ai/dsh"
    || value.compatibility.version !== "0.1.2-rc.1"
    || value.compatibility.profile !== "web") throw new Error("incompatible native DSH Host");
  const runtime = parseSnapshot(value.runtime);
  const optionalUrl = (url) => {
    if (url === undefined) return undefined;
    boundedText(url, 2048);
    const parsed = new URL(url);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("invalid public server URL");
    }
    return parsed.toString().replace(/\/$/u, "");
  };
  const serverUrl = optionalUrl(value.serverUrl);
  const officialServerUrl = optionalUrl(value.officialServerUrl);
  if (value.deviceName !== undefined) boundedText(value.deviceName, 120);
  let route;
  let bindings;
  let localSync;
  let codeSync;
  if (value.route !== undefined || value.bindings !== undefined || value.projectCount !== undefined) {
    if (value.route === undefined || !Number.isSafeInteger(value.projectCount) || value.projectCount < 0
      || !Array.isArray(value.bindings) || value.bindings.length > 100
      || value.bindings.length > value.projectCount) {
      throw new Error("invalid native Project bindings");
    }
    exactObject(value.route, ["provider", "model"]);
    boundedText(value.route.provider, 80);
    boundedText(value.route.model, 160);
    route = { ...value.route };
    bindings = value.bindings.map((binding) => {
      exactObject(binding, ["projectId", "projectName", "provider", "model"]);
      boundedText(binding.projectId, 128);
      boundedText(binding.projectName, 160);
      boundedText(binding.provider, 80);
      boundedText(binding.model, 160);
      if (binding.provider !== route.provider || binding.model !== route.model) {
        throw new Error("inconsistent native Project route");
      }
      return { ...binding };
    });
    const localSyncValue = value.localSync ?? [];
    if (!Array.isArray(localSyncValue) || localSyncValue.length > 100) throw new Error("invalid local sync status");
    localSync = localSyncValue.map((sync) => {
      exactObject(sync, [
        "projectId", "projectName", "sessionId", "localSessionId", "title", "automaticUpload",
        "pendingLocalTurns", "uploadableLocalTurns",
      ]);
      boundedText(sync.projectId, 128);
      boundedText(sync.projectName, 160);
      boundedText(sync.sessionId, 128);
      boundedText(sync.localSessionId, 200);
      boundedText(sync.title, 160);
      if (typeof sync.automaticUpload !== "boolean"
        || !Number.isSafeInteger(sync.pendingLocalTurns) || sync.pendingLocalTurns < 0
        || !Number.isSafeInteger(sync.uploadableLocalTurns) || sync.uploadableLocalTurns < 0) {
        throw new Error("invalid local sync status");
      }
      return { ...sync };
    });
    const codeSyncValue = value.codeSync ?? [];
    if (!Array.isArray(codeSyncValue) || codeSyncValue.length > 100) throw new Error("invalid code sync status");
    codeSync = codeSyncValue.map((project) => {
      exactObject(project, ["projectId", "projectName", "authorized", "status", "error"]);
      boundedText(project.projectId, 128);
      boundedText(project.projectName, 160);
      if (typeof project.authorized !== "boolean") throw new Error("invalid code sync authorization");
      if (project.error !== undefined && !/^code_[a-z_]{1,60}$/u.test(project.error)) throw new Error("invalid code sync error");
      if (project.status !== undefined) {
        const status = project.status;
        exactObject(status, ["enabled", "automatic_upload", "local_changes", "file_count", "excluded_count", "base_commit", "cloud_commit", "branch_id", "needs_download", "recovery_directory", "local_status_unknown"]);
        if (status.local_status_unknown !== undefined && typeof status.local_status_unknown !== "boolean") throw new Error("invalid local status flag");
        for (const key of ["enabled", "automatic_upload", "needs_download"]) {
          if (typeof status[key] !== "boolean") throw new Error("invalid code sync flag");
        }
        for (const key of ["local_changes", "file_count", "excluded_count"]) {
          if (!Number.isSafeInteger(status[key]) || status[key] < 0) throw new Error("invalid code sync count");
        }
        for (const key of ["base_commit", "cloud_commit"]) {
          if (status[key] !== null && !/^[a-f0-9]{40}$/u.test(status[key])) throw new Error("invalid code commit");
        }
        if (status.branch_id !== null) boundedText(status.branch_id, 128);
        if (status.recovery_directory !== undefined) {
          boundedText(status.recovery_directory, 255);
          if (/[\\/\u0000-\u001f]/u.test(status.recovery_directory)) throw new Error("invalid recovery directory");
        }
      }
      return { ...project };
    });
  }
  let pairing;
  if (value.pairing !== undefined) {
    exactObject(value.pairing, ["schemaVersion", "status", "userCode", "verificationUrl", "expiresAt", "intervalSeconds"]);
    if (value.pairing.schemaVersion !== 1 || value.pairing.status !== "pending"
      || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(value.pairing.userCode)
      || !Number.isSafeInteger(value.pairing.intervalSeconds)
      || value.pairing.intervalSeconds < 1 || value.pairing.intervalSeconds > 30) {
      throw new Error("invalid native pairing state");
    }
    boundedText(value.pairing.expiresAt, 64);
    boundedText(value.pairing.verificationUrl, 2048);
    const verificationUrl = new URL(value.pairing.verificationUrl);
    if (!/^https?:$/u.test(verificationUrl.protocol) || verificationUrl.username || verificationUrl.password
      || verificationUrl.search || verificationUrl.hash !== `#dsh-pair=${value.pairing.userCode}`) {
      throw new Error("invalid native verification URL");
    }
    pairing = { ...value.pairing, verificationUrl: verificationUrl.toString() };
  }
  if (value.authorization === "pairing" && pairing === undefined) throw new Error("missing native pairing state");
  if (value.authorization === "paired" && (serverUrl === undefined || value.deviceName === undefined)) {
    throw new Error("missing native grant labels");
  }
  if (value.recoverableError !== undefined
    && value.recoverableError !== "pairing_failed"
    && value.recoverableError !== "connection_failed") throw new Error("invalid native recovery state");
  return {
    schemaVersion: 2,
    integration: "gatherthread",
    authorization: value.authorization,
    compatibility: { ...value.compatibility },
    runtime,
    ...(officialServerUrl === undefined ? {} : { officialServerUrl }),
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(value.deviceName === undefined ? {} : { deviceName: value.deviceName }),
    ...(route === undefined ? {} : { route, projectCount: value.projectCount, bindings, localSync, codeSync }),
    ...(pairing === undefined ? {} : { pairing }),
    ...(value.recoverableError === undefined ? {} : { recoverableError: value.recoverableError }),
  };
}

function parseCatalog(value) {
  exactObject(value, ["schemaVersion", "projects", "providers"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.length > 100
    || !Array.isArray(value.providers) || value.providers.length > 64) throw new Error("invalid native catalog");
  const projects = value.projects.map((project) => {
    exactObject(project, ["id", "name", "role", "state", "sessionCount"]);
    boundedText(project.id, 128);
    boundedText(project.name, 160);
    if (!new Set(["owner", "participant", "viewer"]).has(project.role) || project.state !== "active"
      || !Number.isSafeInteger(project.sessionCount) || project.sessionCount < 0) throw new Error("invalid native Project");
    return { ...project };
  });
  let modelCount = 0;
  const providers = value.providers.map((provider) => {
    exactObject(provider, ["id", "name", "models"]);
    boundedText(provider.id, 80);
    boundedText(provider.name, 160);
    if (!Array.isArray(provider.models)) throw new Error("invalid native models");
    const models = provider.models.map((model) => {
      modelCount += 1;
      if (modelCount > 256) throw new Error("native catalog too large");
      exactObject(model, ["id", "name"]);
      boundedText(model.id, 160);
      boundedText(model.name, 160);
      return { ...model };
    });
    return { id: provider.id, name: provider.name, models };
  });
  return { schemaVersion: 1, projects, providers };
}

function parseSnapshot(value) {
  exactObject(value, [
    "schemaVersion", "integration", "connection", "bindingMode", "projectName",
    "activeSessionCount", "sessions", "updatedAt",
  ]);
  if (value.schemaVersion !== 1 || value.integration !== "gatherthread") throw new Error("invalid status identity");
  if (!CONNECTION_STATES.has(value.connection)) throw new Error("invalid connection state");
  if (value.bindingMode !== "single" && value.bindingMode !== "project") throw new Error("invalid binding mode");
  boundedText(value.projectName, 160);
  boundedText(value.updatedAt, 32);
  if (!Number.isSafeInteger(value.activeSessionCount) || value.activeSessionCount < 0) {
    throw new Error("invalid active Session count");
  }
  if (!Array.isArray(value.sessions) || value.sessions.length > 100) throw new Error("invalid Sessions");
  const sessions = value.sessions.map((session) => {
    exactObject(session, ["sessionId", "title", "state", "lastSyncedAt"]);
    boundedText(session.sessionId, 128);
    boundedText(session.title, 160);
    if (!SESSION_STATES.has(session.state)) throw new Error("invalid Session state");
    if (session.lastSyncedAt !== undefined) boundedText(session.lastSyncedAt, 32);
    return {
      sessionId: session.sessionId,
      title: session.title,
      state: session.state,
      ...(session.lastSyncedAt === undefined ? {} : { lastSyncedAt: session.lastSyncedAt }),
    };
  });
  if (value.activeSessionCount > sessions.length) throw new Error("invalid active Session count");
  return {
    schemaVersion: 1,
    integration: "gatherthread",
    connection: value.connection,
    bindingMode: value.bindingMode,
    projectName: value.projectName,
    activeSessionCount: value.activeSessionCount,
    sessions,
    updatedAt: value.updatedAt,
  };
}

function exactObject(value, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid status object");
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("unexpected status field");
}

function boundedText(value, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error("invalid status text");
  for (const character of value) {
    const code = character.codePointAt(0) || 0;
    if (code < 32 || (code >= 127 && code <= 159)) throw new Error("invalid status text");
  }
}

function statusLabel(state) {
  return ({
    connecting: "连接中",
    connected: "已连接",
    idle: "空闲",
    running: "运行中",
    offline: "离线",
    error: "错误",
    stopped: "已停止",
  })[state] || "未知";
}

function badgeStyle(state) {
  const emphasis = state === "connected" || state === "idle"
    ? 0.92
    : state === "running" || state === "connecting" ? 0.78 : 0.62;
  return { ...styles.badge, opacity: emphasis };
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "未知";
}

const styles = {
  panel: { display: "grid", gap: 16, padding: 8, color: "inherit" },
  heading: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" },
  title: { margin: 0, fontSize: 20, lineHeight: 1.3 },
  subtitle: { margin: "4px 0 0", opacity: 0.68, fontSize: 13 },
  summary: { margin: 0, fontSize: 13, opacity: 0.72 },
  notice: { margin: 0, padding: "10px 12px", borderRadius: 10, background: "rgba(127,127,127,.12)", color: "inherit", border: "1px solid rgba(127,127,127,.2)" },
  list: { display: "grid", gap: 8 },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid rgba(127,127,127,.2)", borderRadius: 12 },
  sessionText: { minWidth: 0, display: "grid", gap: 3 },
  sessionTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14 },
  sessionMeta: { opacity: 0.62, fontSize: 12 },
  syncActions: { flex: "none", display: "grid", justifyItems: "end", gap: 6 },
  syncToggle: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" },
  compactButton: { minHeight: 28, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12, cursor: "pointer" },
  badge: { flex: "none", padding: "4px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: "rgba(127,127,127,.12)", color: "inherit", border: "1px solid rgba(127,127,127,.2)" },
  connectionCard: { display: "grid", gap: 12, padding: "14px", border: "1px solid rgba(127,127,127,.2)", borderRadius: 14, background: "rgba(127,127,127,.06)" },
  subheading: { display: "grid", gap: 4 },
  sectionTitle: { margin: 0, fontSize: 16, lineHeight: 1.35 },
  form: { display: "grid", gap: 12 },
  field: { display: "grid", gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: 600, opacity: 0.76 },
  input: { width: "100%", minHeight: 36, boxSizing: "border-box", padding: "7px 10px", borderRadius: 9, border: "1px solid rgba(127,127,127,.28)", background: "transparent", color: "inherit", font: "inherit" },
  primaryButton: { minHeight: 36, padding: "8px 12px", borderRadius: 9, border: "1px solid Highlight", background: "Highlight", color: "HighlightText", WebkitTextFillColor: "HighlightText", font: "inherit", fontWeight: 600, cursor: "pointer" },
  secondaryButton: { minHeight: 36, padding: "8px 12px", borderRadius: 9, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" },
  linkButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 36, padding: "0 12px", borderRadius: 9, border: "1px solid rgba(127,127,127,.3)", color: "inherit", textDecoration: "none", fontWeight: 600 },
  muted: { margin: 0, fontSize: 12, lineHeight: 1.55, opacity: 0.68 },
  choiceRow: { display: "grid", gap: 6 },
  pairing: { display: "grid", gap: 10 },
  code: { justifySelf: "start", padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(127,127,127,.24)", background: "rgba(127,127,127,.1)", fontSize: 18, letterSpacing: ".08em" },
  details: { display: "grid", gap: 7, margin: 0 },
  detailRow: { display: "grid", gridTemplateColumns: "88px minmax(0,1fr)", gap: 10, alignItems: "baseline" },
  detailValue: { margin: 0, overflowWrap: "anywhere", fontSize: 13 },
};

module.exports = { inject, apply };
return module.exports; } });
