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
      setNotice("操作未完成。请检查服务器地址、当前授权和模型配置。");
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
    ...sessionRows.map((session) => React.createElement("div", {
      key: session.sessionId,
      style: styles.row,
    },
    React.createElement("div", { style: styles.sessionText },
      React.createElement("strong", { style: styles.sessionTitle }, session.title),
      React.createElement("span", { style: styles.sessionMeta },
        session.lastSyncedAt === undefined ? "尚未同步" : `最近同步 ${formatTime(session.lastSyncedAt)}`)),
    React.createElement("span", { style: badgeStyle(session.state) }, statusLabel(session.state))))),
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
    }));
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
    "officialServerUrl", "serverUrl", "deviceName", "route", "projectCount", "bindings", "pairing", "recoverableError",
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
    ...(route === undefined ? {} : { route, projectCount: value.projectCount, bindings }),
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
