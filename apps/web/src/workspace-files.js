import {
  buildFileTree, flattenFileTree, normalizeFilePath, validateFileDestination, fileContextKey,
  canEditFileBranch, fileParent, fileBasename, pathContains, textToBase64, bytesToBase64,
  decodeFileContent, describeFileContent, validateFileImport, validateFileWriteOperations, FILE_TEXT_LIMIT,
} from "./workspace-files-model.js";

export const WORKSPACE_FILES_ZH_CN = {
  "Files": "文件", "Members": "成员", "File workspace": "文件工作区", "Close workspace": "关闭工作区",
  "Storage": "存储位置", "GatherThread cloud": "GatherThread 云端", "GT Cloud": "GT Cloud", "Branch": "分支", "Read only": "只读",
  "Your branch": "我的分支", "Search files": "搜索文件", "Refresh files": "刷新文件", "File actions": "文件操作",
  "New file": "新建文件", "New folder": "新建文件夹", "Import files": "导入文件", "Rename": "重命名",
  "Copy": "复制", "Cut": "剪切", "Paste": "粘贴", "Move": "移动", "Delete": "删除", "Download": "下载",
  "Save": "保存", "Saving…": "正在保存…", "Saved": "已保存", "Unsaved changes": "有未保存的修改",
  "Preview": "预览", "Code": "代码", "Changes": "更改", "History": "历史", "Current version": "当前版本",
  "Back to files": "返回文件", "Loading files…": "正在加载文件…", "Loading file…": "正在加载文件…",
  "Loading history…": "正在加载历史…", "Loading changes…": "正在加载更改…", "No files yet": "暂无文件",
  "No matching files": "没有匹配的文件", "Select a project to browse its files.": "选择一个项目以浏览文件。",
  "Open a file from the explorer.": "从文件列表打开文件。", "No history yet": "暂无历史记录", "Load more": "加载更多",
  "Compare with parent": "与上一版本比较", "View version": "查看此版本", "No changes": "没有更改",
  "This file is available as a download.": "此文件可供下载。", "Editor unavailable": "编辑器暂不可用",
  "PDF preview unavailable": "PDF 预览暂不可用", "File preview": "文件预览", "Close file": "关闭文件",
  "PDF preview is not included in the isolated example.": "独立示例不提供 PDF 预览。",
  "Save or discard your example edits before switching branches.": "请先保存或放弃自己的示例编辑，再切换分支。",
  "Discard unsaved changes?": "放弃尚未保存的修改？", "Delete the selected file or folder?": "删除选中的文件或文件夹？",
  "File path": "文件路径", "Folder path": "文件夹路径", "Destination path": "目标路径", "Rename path": "重命名路径",
  "Enter a safe relative file path.": "请输入安全的相对文件路径。", "A file or folder already exists at this path.": "此路径已有文件或文件夹。",
  "A folder cannot be moved or copied into itself.": "文件夹不能移动或复制到自身内部。",
  "The file response is invalid or too large.": "文件响应无效或过大。", "Could not load files.": "无法加载文件。",
  "Could not load this file.": "无法加载此文件。", "Could not load history.": "无法加载历史记录。",
  "Could not save changes.": "无法保存更改。", "This branch changed. Your edits are kept. Refresh and review before saving again.": "此分支已更改。你的编辑已保留，请刷新并检查后再保存。",
  "The result is unknown. Retry the same operation to check its outcome.": "操作结果尚未确认。请重试同一操作以确认结果。",
  "Retry operation": "重试操作", "Reload server version": "重新加载服务器版本", "Download your edits": "下载我的编辑",
  "Only your current branch can be edited.": "仅可编辑自己的当前分支。", "Select a file or folder first.": "请先选择文件或文件夹。",
  "Select a branch first.": "请先选择一个分支。", "Files imported": "文件已导入", "File operation completed": "文件操作已完成",
  "Copied": "已复制", "Cut selected": "已选中待剪切内容", "Nothing to paste": "没有可粘贴的内容",
  "Import exceeds the file preview limit.": "导入文件超过大小限制。", "Historical version": "历史版本",
  "Added": "新增", "Modified": "修改", "Deleted": "删除", "Refresh to retry": "刷新以重试", "File explorer": "文件列表",
  "Expand workspace": "展开工作区", "Restore workspace": "还原工作区", "Configure file sharing": "设置文件共享",
  "Connect GitHub": "连接 GitHub", "Reload file": "重新加载文件",
  "Import at most 100 files at a time.": "每次最多导入 100 个文件。",
  "GT Cloud files must be 2 MiB or smaller.": "GT Cloud 单个文件不能超过 2 MiB。",
  "GitHub browser files must be 8 MiB or smaller.": "GitHub 网页读写的单个文件不能超过 8 MiB。",
  "Import or save at most 8 MiB of content at a time.": "每次导入或保存的内容合计不能超过 8 MiB。",
  "Text editing is limited to 2 MiB. Download this draft or reduce its size.": "文本编辑上限为 2 MiB。请下载此草稿或减少内容。",
  "Empty tree": "空文件树", "View changes": "查看更改",
  "Latest saved changes": "最近一次保存的更改", "Branch history": "分支历史", "File views": "文件视图",
  "New tab": "新建标签", "Open tabs": "已打开的标签", "No open tabs": "暂无打开的标签",
  "Workspace menu": "工作区菜单", "Collapse workspace": "收起工作区",
  "Open a workspace tab": "打开一个工作区标签", "Close tab": "关闭标签", "Close other tabs": "关闭其他标签",
  "Close tabs to the right": "关闭右侧标签", "Close all tabs": "关闭所有标签",
  "Move tab left": "向左移动标签", "Move tab right": "向右移动标签",
  "Tabs changed while confirmation was open. Review them before closing.": "确认期间标签内容发生了变化，请检查后再关闭。",
};

const modelErrors = {
  "files.pathInvalid": "Enter a safe relative file path.", "files.pathExists": "A file or folder already exists at this path.",
  "files.pathInsideSource": "A folder cannot be moved or copied into itself.", "files.contentInvalid": "The file response is invalid or too large.",
  "files.operationLimit": "Import at most 100 files at a time.", "files.cloudFileLimit": "GT Cloud files must be 2 MiB or smaller.",
  "files.githubFileLimit": "GitHub browser files must be 8 MiB or smaller.", "files.writeBatchLimit": "Import or save at most 8 MiB of content at a time.",
};

/** A project-scoped workspace. No source buffer is persisted to browser storage. */
export function mountFileWorkspace({
  document, window, api, host, membersHost, t = (value) => value, getContext,
  editorFactory, pdfFactory, diffFactory, renderMarkdown,
  onOpen = () => {}, onClose = () => {},
  onExpand, isExpanded = () => false, onConfigure,
  exampleMode = false,
  confirm = (message) => window.confirm(message), prompt = (message, value) => window.prompt(message, value),
  makeKey = () => window.crypto.randomUUID(),
}) {
  let context = getContext() ?? {};
  let scope = fileContextKey(context);
  let generation = 0; let viewGeneration = 0; let branchGeneration = 0; let explorerGeneration = 0;
  let exampleNavigationRevision = 0;
  let sequence = 0; let disposed = false; let visible = false; let visibilityRevision = 0;
  let provider = "gt-cloud"; let branches = []; let branchId = ""; let tree = null;
  let loading = false; let treeError = ""; let active = "files"; let selectedPath = "";
  let expanded = new Set(); let search = ""; let clipboard = null; let mutation = null; let mutationBusy = false;
  let notice = ""; let noticeKind = ""; let pendingConflict = false;
  let explorerView = "files";
  const tabs = new Map(); const controllers = new Set(); const urls = new Set();
  // One ordered registry owns function and file tabs; source buffers stay in tabs.
  const tabRegistry = new Map([["files", { id: "files", kind: "files", title: "Files" }]]);
  let tabMenu = null; let menuTarget = null; let draggedTab = null;
  let mountedView = null;
  const el = (tag, className, text) => {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  };
  const button = (label, action, { className = "", disabled = false, title = label } = {}) => {
    const node = el("button", `fw-button ${className}`, t(label)); node.type = "button";
    node.disabled = disabled; node.title = t(title); node.addEventListener("click", action); return node;
  };
  const root = el("section", "file-workspace"); root.setAttribute("aria-label", t("File workspace"));
  const top = el("div", "fw-topbar"); const tablist = el("div", "fw-tabs");
  tablist.setAttribute("role", "tablist"); tablist.setAttribute("aria-label", t("File workspace"));
  let expandMenuItem = null;
  function refreshExpandMenuItem() {
    if (!expandMenuItem) return;
    const label = t(isExpanded() ? "Restore workspace" : "Expand workspace");
    expandMenuItem.textContent = label; expandMenuItem.title = label; expandMenuItem.setAttribute("aria-label", label);
    expandMenuItem.setAttribute("aria-expanded", String(Boolean(isExpanded())));
  }
  const newTabPicker = el("details", "fw-new-tab-picker");
  const newTabSummary = el("summary", "fw-button fw-new-tab", "+"); newTabSummary.setAttribute("aria-label", t("New tab")); newTabSummary.title = t("New tab");
  const newTabChoices = el("div", "fw-picker-menu"); newTabChoices.setAttribute("role", "menu"); newTabPicker.append(newTabSummary, newTabChoices);
  const openTabsPicker = el("details", "fw-tabs-picker");
  const openTabsSummary = el("summary", "fw-button fw-tabs-list", "…"); openTabsSummary.setAttribute("aria-label", t("Workspace menu")); openTabsSummary.title = t("Workspace menu");
  const openTabsChoices = el("div", "fw-picker-menu fw-open-tabs-list"); openTabsPicker.append(openTabsSummary, openTabsChoices);
  for (const [picker, summary, choices] of [[newTabPicker, newTabSummary, newTabChoices], [openTabsPicker, openTabsSummary, openTabsChoices]]) {
    summary.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); picker.open = true; choices.querySelector("button:not(:disabled)")?.focus(); }
    });
    choices.addEventListener("keydown", (event) => {
      const available = [...choices.querySelectorAll("button")].filter((item) => !item.disabled); const index = available.indexOf(document.activeElement); let next;
      if (event.key === "ArrowDown") next = available[(index + 1) % available.length];
      if (event.key === "ArrowUp") next = available[(index + available.length - 1) % available.length];
      if (event.key === "Home") next = available[0]; if (event.key === "End") next = available.at(-1);
      if (next) { event.preventDefault(); next.focus(); }
    });
  }
  newTabPicker.addEventListener("toggle", () => { if (newTabPicker.open) { openTabsPicker.open = false; closeTabMenu(); } });
  openTabsPicker.addEventListener("toggle", () => { if (openTabsPicker.open) { newTabPicker.open = false; closeTabMenu(); refreshExpandMenuItem(); } });
  top.append(tablist, newTabPicker, openTabsPicker);
  const status = el("div", "fw-notice"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.hidden = true;
  const statusText = el("span"); const statusActions = el("div", "fw-notice-actions"); status.append(statusText, statusActions);
  const filesPane = el("div", "fw-files-pane"); const membersPane = el("div", "fw-members-pane");
  const filePane = el("div", "fw-file-pane"); filePane.setAttribute("role", "tabpanel");
  const emptyPane = el("div", "fw-new-tab-view"); emptyPane.setAttribute("role", "region");
  const originalMemberParent = membersHost?.parentNode; const memberMarker = document.createComment("workspace members location");
  if (membersHost) { membersHost.before(memberMarker); membersPane.append(membersHost); }
  root.append(top, status, filesPane, membersPane, filePane, emptyPane); host.append(root);

  function currentBranch() { return branches.find((branch) => branch.id === branchId); }
  function writable() { return Boolean(tree?.commit) && tree.can_write !== false && !pendingConflict && !mutation && !mutationBusy && canEditFileBranch(context, currentBranch()); }
  function hasDirty() { return [...tabs.values()].some((tab) => tab.draft !== undefined && tab.draft !== tab.original); }
  async function confirmLeave() { return !hasDirty() || Boolean(await confirm(t("Discard unsaved changes?"))); }
  function invalidate() { generation += 1; branchGeneration += 1; draggedTab = null; closeTabMenu(); newTabPicker.open = false; openTabsPicker.open = false; for (const controller of controllers) controller.abort(); controllers.clear(); }
  function destroyView() { viewGeneration += 1; mountedView?.destroy?.(); mountedView = null; }
  function setNotice(message = "", kind = "") { notice = message; noticeKind = kind; renderNotice(); }
  function errorMessage(error, fallback) { return t(modelErrors[error?.message] ?? fallback); }
  function renderNotice() {
    status.hidden = !notice; status.dataset.kind = noticeKind; statusText.textContent = notice;
    statusActions.replaceChildren();
    if (mutation && !mutationBusy) statusActions.append(button("Retry operation", () => dispatchMutation()));
    if (pendingConflict) statusActions.append(button("Reload server version", () => reloadConflict()));
    if (hasDirty() && (pendingConflict || mutation)) statusActions.append(button("Download your edits", () => downloadDirty()));
  }
  async function read(method, options = {}) {
    const epoch = generation; const key = scope; const projectId = context.projectId;
    const controller = new AbortController(); controllers.add(controller);
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const result = await api[method](projectId, { ...options, signal: controller.signal });
      if (epoch !== generation || key !== scope || disposed || controller.signal.aborted) return null;
      return result;
    } finally { window.clearTimeout(timer); controllers.delete(controller); }
  }

  function renderTabs({ reveal = false } = {}) {
    const previousFocus = document.activeElement?.dataset?.tab;
    for (const [id, entry] of tabRegistry) if (entry.kind === "file" && !tabs.has(id)) tabRegistry.delete(id);
    tablist.replaceChildren();
    for (const entry of tabRegistry.values()) addTab(entry);
    renderTabPickers();
    if (previousFocus) tablist.querySelector(`[data-tab="${previousFocus}"]`)?.focus();
    if (reveal) revealActiveTab();
    function addTab(entry) {
      const { id } = entry; const tab = tabs.get(id); const title = tabTitle(entry);
      const wrap = el("div", "fw-tab-wrap"); wrap.classList.toggle("is-active", active === id);
      wrap.dataset.tabId = id; wrap.dataset.tabKind = entry.kind; wrap.draggable = true;
      const node = button(title, () => entry.kind === "file" ? activate(id) : open(id), { className: "fw-tab", title: tab?.path ?? entry.title });
      node.textContent = title; node.dataset.tab = id; node.id = `fw-tab-${id}`; node.setAttribute("role", "tab");
      if (tab) node.dataset.i18nSkip = "";
      if (tab) { node.title = tabSubtitle(entry); node.dataset.path = tab.path; }
      node.setAttribute("aria-selected", String(active === id)); node.setAttribute("aria-controls", `fw-pane-${id}`);
      node.tabIndex = active === id ? 0 : -1;
      node.addEventListener("keydown", async (event) => {
        const available = [...tablist.querySelectorAll('[role="tab"]')]; const index = available.indexOf(node);
        let next;
        if (event.key === "ArrowRight") next = available[(index + 1) % available.length];
        if (event.key === "ArrowLeft") next = available[(index + available.length - 1) % available.length];
        if (event.key === "Home") next = available[0]; if (event.key === "End") next = available.at(-1);
        if (next) { event.preventDefault(); const nextId = next.dataset.tab; await open(nextId); tablist.querySelector(`[data-tab="${nextId}"]`)?.focus(); }
        if (event.key === "Delete") { event.preventDefault(); await closeTabs([id]); }
        if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); showTabMenu(id, event); }
      });
      wrap.append(node);
      const dismiss = button("×", (event) => { event.stopPropagation(); return closeTabs([id]); }, { className: "fw-tab-dismiss", title: tab ? "Close file" : "Close tab" });
      dismiss.setAttribute("aria-label", `${t(tab ? "Close file" : "Close tab")}: ${tab?.path ?? t(entry.title)}`); wrap.append(dismiss);
      wrap.addEventListener("contextmenu", (event) => { event.preventDefault(); showTabMenu(id, event); });
      wrap.addEventListener("dragstart", (event) => {
        if (event.target === dismiss) { event.preventDefault(); return; }
        draggedTab = { id, epoch: generation, scope }; wrap.classList.toggle("is-dragging", true);
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }
      });
      wrap.addEventListener("dragover", (event) => {
        if (!validDraggedTab() || draggedTab.id === id) return;
        event.preventDefault(); wrap.classList.toggle("is-drop-target", true); if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      });
      wrap.addEventListener("dragleave", () => wrap.classList.toggle("is-drop-target", false));
      wrap.addEventListener("drop", (event) => {
        if (!validDraggedTab()) return; event.preventDefault();
        const bounds = wrap.getBoundingClientRect?.(); const after = bounds && event.clientX > bounds.left + bounds.width / 2;
        reorderTab(draggedTab.id, id, Boolean(after)); draggedTab = null;
      });
      wrap.addEventListener("dragend", () => { draggedTab = null; renderTabs(); });
      tablist.append(wrap);
    }
  }
  function tabTitle(entry) {
    const tab = tabs.get(entry.id);
    return tab ? `${tab.draft !== undefined && tab.draft !== tab.original ? "• " : ""}${fileBasename(tab.path)}` : t(entry.title);
  }
  function tabSubtitle(entry) {
    const tab = tabs.get(entry.id);
    return tab ? `${tab.path}${tab.commit ? ` · ${tab.commit.slice(0, 8)}` : ""}` : t(entry.title);
  }
  function renderTabPickers() {
    newTabChoices.replaceChildren(); openTabsChoices.replaceChildren();
    openTabsChoices.append(el("p", "fw-picker-heading", t("Open tabs")));
    for (const [id, title] of [["files", "Files"], ["members", "Members"]]) {
      const choice = button(title, () => { newTabPicker.open = false; return openFromPicker(id); }, { className: "fw-picker-item" });
      choice.classList.toggle("is-open", tabRegistry.has(id)); choice.setAttribute("role", "menuitem"); choice.dataset.openTab = id;
      newTabChoices.append(choice);
    }
    if (!tabRegistry.size) openTabsChoices.append(el("p", "fw-picker-empty", t("No open tabs")));
    for (const entry of tabRegistry.values()) {
      const row = el("div", "fw-open-tab-row"); row.dataset.tabId = entry.id; row.classList.toggle("is-active", active === entry.id);
      const choice = button(tabTitle(entry), () => { openTabsPicker.open = false; return openFromPicker(entry.id); }, { className: "fw-open-tab-choice" });
      choice.textContent = tabTitle(entry); choice.title = tabSubtitle(entry); choice.dataset.selectTab = entry.id;
      if (entry.kind === "file") { choice.dataset.i18nSkip = ""; choice.append(el("small", "fw-open-tab-subtitle", tabSubtitle(entry))); }
      const dismiss = button("×", () => closeTabs([entry.id]), { className: "fw-open-tab-dismiss", title: "Close tab" });
      dismiss.setAttribute("aria-label", `${t("Close tab")}: ${tabSubtitle(entry)}`); row.append(choice, dismiss); openTabsChoices.append(row);
    }
    openTabsChoices.append(button("Close all tabs", () => { openTabsPicker.open = false; return closeTabs([...tabRegistry.keys()]); }, { className: "fw-picker-item", disabled: !tabRegistry.size }));
    const workspaceActions = el("div", "fw-workspace-menu-actions");
    expandMenuItem = null;
    if (typeof onExpand === "function") {
      expandMenuItem = button("Expand workspace", async () => {
        const epoch = generation; openTabsPicker.open = false; await onExpand();
        if (disposed || epoch !== generation) return; refreshExpandMenuItem(); openTabsSummary.focus();
      }, { className: "fw-picker-item fw-expand-command" });
      refreshExpandMenuItem(); workspaceActions.append(expandMenuItem);
    }
    const collapse = button("Collapse workspace", () => close(), { className: "fw-picker-item fw-collapse-command" });
    collapse.setAttribute("aria-label", t("Collapse workspace")); workspaceActions.append(collapse); openTabsChoices.append(workspaceActions);
  }
  function activate(id) {
    if (!visible) { visible = true; onOpen(); }
    closeTabMenu(); newTabPicker.open = false; openTabsPicker.open = false;
    if (["files", "members"].includes(id) && !tabRegistry.has(id)) tabRegistry.set(id, { id, kind: id, title: id === "files" ? "Files" : "Members" });
    if (tabs.has(id) && !tabRegistry.has(id)) tabRegistry.set(id, { id, kind: "file", path: tabs.get(id).path });
    active = tabRegistry.has(id) ? id : tabRegistry.keys().next().value ?? null;
    renderTabs({ reveal: true }); renderActive();
  }
  async function closeTabs(ids) {
    const epoch = generation; const key = scope;
    const targets = [...new Set(ids)].filter((id) => tabRegistry.has(id));
    const snapshots = targets.map((id) => ({ id, entry: tabRegistry.get(id), buffer: tabs.get(id), draft: tabs.get(id)?.draft, original: tabs.get(id)?.original }));
    const dirty = snapshots.some(({ buffer, draft, original }) => buffer && draft !== undefined && draft !== original);
    if (dirty && !await confirm(t("Discard unsaved changes?"))) return false;
    if (disposed || epoch !== generation || key !== scope) return false;
    if (snapshots.some(({ id, entry, buffer, draft, original }) => tabRegistry.get(id) !== entry || tabs.get(id) !== buffer || buffer && (buffer.draft !== draft || buffer.original !== original))) {
      if (dirty) setNotice(t("Tabs changed while confirmation was open. Review them before closing.")); return false;
    }
    removeTabs(targets); return true;
  }
  function removeTabs(ids) {
    const removed = new Set(ids); const order = [...tabRegistry.keys()]; const oldIndex = order.indexOf(active); const activeRemoved = removed.has(active);
    const hadTabFocus = tablist.contains(document.activeElement) || openTabsChoices.contains(document.activeElement) || tabMenu?.contains(document.activeElement);
    for (const id of removed) { tabs.delete(id); tabRegistry.delete(id); }
    if (activeRemoved) {
      // Nearest survivor wins, preferring the right-hand tab on an equal distance.
      active = order.map((id, index) => ({ id, index })).filter(({ id }) => !removed.has(id))
        .sort((left, right) => Math.abs(left.index - oldIndex) - Math.abs(right.index - oldIndex) || right.index - left.index)[0]?.id ?? null;
    }
    closeTabMenu(); renderTabs({ reveal: true }); if (activeRemoved) renderActive();
    if (activeRemoved || hadTabFocus) focusActiveTab();
    if (active === "files" && visible && !tree && !loading) void loadBranches();
    renderNotice();
  }
  function focusActiveTab() { if (active) tablist.querySelector(`[data-tab="${active}"]`)?.focus(); else newTabSummary.focus(); }
  function revealActiveTab() {
    if (!active) return;
    const wrap = [...tablist.querySelectorAll(".fw-tab-wrap")].find((node) => node.dataset.tabId === active);
    const bounds = wrap?.getBoundingClientRect?.(); const viewport = tablist.getBoundingClientRect?.();
    if (!bounds || !viewport?.width) return;
    const delta = bounds.left < viewport.left ? bounds.left - viewport.left : bounds.right > viewport.right ? bounds.right - viewport.right : 0;
    if (delta) tablist.scrollLeft = Math.max(0, (tablist.scrollLeft ?? 0) + delta);
  }
  async function openFromPicker(id) {
    const epoch = generation; await open(id);
    if (epoch === generation && tabRegistry.has(id) && active === id) focusActiveTab();
  }
  function validDraggedTab() { return draggedTab && draggedTab.epoch === generation && draggedTab.scope === scope && tabRegistry.has(draggedTab.id); }
  function reorderTab(id, target, after = false) {
    if (id === target || !tabRegistry.has(id) || !tabRegistry.has(target)) return;
    const entry = tabRegistry.get(id); const rest = [...tabRegistry.values()].filter((item) => item.id !== id);
    rest.splice(rest.findIndex((item) => item.id === target) + Number(after), 0, entry);
    tabRegistry.clear(); rest.forEach((item) => tabRegistry.set(item.id, item)); closeTabMenu(); renderTabs({ reveal: true }); focusActiveTab();
  }
  function closeTabMenu({ restoreFocus = false } = {}) {
    const target = menuTarget; tabMenu?.remove(); tabMenu = null; menuTarget = null;
    if (restoreFocus && target) tablist.querySelector(`[data-tab="${target}"]`)?.focus();
  }
  function showTabMenu(id, event = {}) {
    if (!tabRegistry.has(id)) return; closeTabMenu(); newTabPicker.open = false; openTabsPicker.open = false;
    menuTarget = id; const epoch = generation; const entry = tabRegistry.get(id); const order = [...tabRegistry.keys()]; const index = order.indexOf(id);
    tabMenu = el("div", "fw-tab-menu"); tabMenu.dataset.i18nSkip = ""; tabMenu.setAttribute("role", "menu"); tabMenu.setAttribute("aria-label", tabSubtitle(entry));
    const rootBounds = root.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 480, height: 600 };
    const tabBounds = tablist.querySelector(`[data-tab="${id}"]`)?.getBoundingClientRect?.();
    const x = Number.isFinite(event.clientX) ? event.clientX - rootBounds.left : (tabBounds?.left ?? rootBounds.left) - rootBounds.left;
    const y = Number.isFinite(event.clientY) ? event.clientY - rootBounds.top : (tabBounds?.bottom ?? rootBounds.top + 40) - rootBounds.top;
    tabMenu.style.setProperty("--fw-menu-x", `${Math.max(8, Math.min(x, rootBounds.width - 205))}px`);
    tabMenu.style.setProperty("--fw-menu-y", `${Math.max(8, Math.min(y, rootBounds.height - 270))}px`);
    const choices = [
      ["Close tab", () => closeTabs([id]), false],
      ["Close other tabs", () => closeTabs(order.filter((item) => item !== id)), order.length < 2],
      ["Close tabs to the right", () => closeTabs(order.slice(index + 1)), index === order.length - 1],
      ["Close all tabs", () => closeTabs(order), !order.length],
      ["Move tab left", () => reorderTab(id, order[index - 1]), index === 0],
      ["Move tab right", () => reorderTab(id, order[index + 1], true), index === order.length - 1],
    ];
    for (const [label, action, disabled] of choices) {
      const choice = button(label, async () => {
        if (epoch !== generation || tabRegistry.get(id) !== entry) { closeTabMenu(); return; }
        const hadMenuFocus = tabMenu?.contains(document.activeElement); closeTabMenu();
        const result = await action(); if (epoch === generation && hadMenuFocus) focusActiveTab(); return result;
      }, { className: "fw-tab-menu-item", disabled });
      choice.setAttribute("role", "menuitem"); tabMenu.append(choice);
    }
    tabMenu.addEventListener("keydown", (keyEvent) => {
      const available = [...tabMenu.querySelectorAll("button")].filter((item) => !item.disabled); const current = available.indexOf(document.activeElement); let next;
      if (keyEvent.key === "ArrowDown") next = available[(current + 1) % available.length];
      if (keyEvent.key === "ArrowUp") next = available[(current + available.length - 1) % available.length];
      if (keyEvent.key === "Home") next = available[0]; if (keyEvent.key === "End") next = available.at(-1);
      if (next) { keyEvent.preventDefault(); next.focus(); }
      if (keyEvent.key === "Escape") { keyEvent.preventDefault(); keyEvent.stopPropagation(); closeTabMenu({ restoreFocus: true }); }
      if (keyEvent.key === "Tab") closeTabMenu();
    }); root.append(tabMenu); tabMenu.querySelector("button:not(:disabled)")?.focus();
  }
  function renderActive() {
    destroyView(); filesPane.hidden = active !== "files"; membersPane.hidden = active !== "members";
    emptyPane.hidden = active !== null; filePane.hidden = !active || ["files", "members"].includes(active);
    if (filePane.hidden) filePane.replaceChildren();
    filesPane.id = "fw-pane-files"; membersPane.id = "fw-pane-members";
    filesPane.setAttribute("role", "tabpanel"); membersPane.setAttribute("role", "tabpanel");
    filesPane.setAttribute("aria-labelledby", "fw-tab-files"); membersPane.setAttribute("aria-labelledby", "fw-tab-members");
    if (active === "files") renderExplorer();
    if (!filePane.hidden) { filePane.id = `fw-pane-${active}`; filePane.setAttribute("aria-labelledby", `fw-tab-${active}`); void renderFile(tabs.get(active)); }
    if (active === null) {
      emptyPane.replaceChildren(el("h3", "fw-empty-title", t("Open a workspace tab")));
      const actions = el("div", "fw-new-tab-actions");
      actions.append(button("Files", () => openFromPicker("files")), button("Members", () => openFromPicker("members"))); emptyPane.append(actions);
    }
  }

  function renderExplorer() {
    const explorerTicket = ++explorerGeneration; const epoch = generation;
    const focused = Boolean(document.activeElement && document.activeElement === filesPane.querySelector(".fw-search"));
    const selectionStart = focused ? document.activeElement.selectionStart : 0;
    filesPane.replaceChildren();
    if (!context.projectId || !context.userId) { filesPane.append(el("p", "fw-empty", t("Select a project to browse its files."))); return; }
    const location = el("div", "fw-location");
    const providerLabel = el("label", "fw-field"); providerLabel.append(el("span", "fw-label", t("Storage")));
    const providerSelect = el("select", "fw-select"); providerSelect.setAttribute("aria-label", t("Storage"));
    for (const [value, label] of [["gt-cloud", "GT Cloud"], ["github", "GitHub"]]) {
      const option = el("option", "", t(label)); option.value = value; providerSelect.append(option);
    }
    providerSelect.value = provider; providerSelect.disabled = mutationBusy || Boolean(mutation);
    providerSelect.addEventListener("change", async () => {
      const next = providerSelect.value; const epoch = generation; providerSelect.value = provider;
      if (!await confirmLeave() || epoch !== generation) return; resetBranch(); provider = next; void loadBranches();
    }); providerLabel.append(providerSelect);
    const branchLabel = el("label", "fw-field"); branchLabel.append(el("span", "fw-label", t("Branch")));
    const branchSelect = el("select", "fw-select fw-branch-select"); branchSelect.setAttribute("aria-label", t("Branch"));
    branchSelect.dataset.i18nSkip = "";
    if (!branches.length) { const option = el("option", "", loading ? t("Loading files…") : t("Select a branch first.")); option.value = ""; branchSelect.append(option); }
    for (const branch of branches) {
      const owner = context.members?.find((member) => (member.user_id ?? member.userId) === branch.user_id);
      const own = branch.id === "own" || branch.user_id === context.userId;
      const member = context.members?.find(member => (member.userId ?? member.id ?? member.user_id) === branch.user_id);
      const label = branch.id === "own" || branch.user_id === context.userId ? t("Your branch")
        : member?.username ?? member?.display_name ?? branch.name;
      const option = el("option", "", `${label}${owner && !own ? ` · ${owner.display_name ?? owner.displayName ?? ""}` : ""}${canEditFileBranch(context, branch) ? "" : ` · ${t("Read only")}`}`);
      option.value = branch.id; branchSelect.append(option);
    }
    branchSelect.value = branchId; branchSelect.disabled = loading || mutationBusy || Boolean(mutation);
    branchSelect.addEventListener("change", async () => {
      const next = branchSelect.value; const epoch = generation; branchSelect.value = branchId;
      if (!await confirmLeave() || epoch !== generation) return; resetBranch(); branchId = next; void loadTree();
    }); branchLabel.append(branchSelect); location.append(providerLabel, branchLabel); filesPane.append(location);
    const navigation = el("div", "fw-explorer-navigation"); navigation.setAttribute("role", "tablist"); navigation.setAttribute("aria-label", t("File views"));
    const explorerViews = [["files", "Files"], ["changes", "Changes"], ["history", "History"]];
    for (const [view, label] of explorerViews) {
      const choice = button(label, () => { explorerView = view; renderExplorer(); }, { className: explorerView === view ? "is-selected" : "", title: view === "changes" ? "Latest saved changes" : label });
      choice.dataset.explorerView = view; choice.id = `fw-explorer-tab-${view}`; choice.setAttribute("role", "tab");
      choice.setAttribute("aria-selected", String(explorerView === view)); choice.setAttribute("aria-controls", "fw-explorer-panel"); choice.tabIndex = explorerView === view ? 0 : -1;
      choice.addEventListener("keydown", (event) => {
        const index = explorerViews.findIndex(([id]) => id === view); let next;
        if (event.key === "ArrowRight") next = explorerViews[(index + 1) % explorerViews.length][0];
        if (event.key === "ArrowLeft") next = explorerViews[(index + explorerViews.length - 1) % explorerViews.length][0];
        if (event.key === "Home") next = "files"; if (event.key === "End") next = "history";
        if (next) { event.preventDefault(); explorerView = next; renderExplorer(); filesPane.querySelector(`[data-explorer-view="${next}"]`)?.focus(); }
      }); navigation.append(choice);
    }
    filesPane.append(navigation);
    const tools = el("div", "fw-explorer-tools"); tools.classList.toggle("is-review", explorerView !== "files");
    const searchInput = el("input", "fw-search"); searchInput.type = "search"; searchInput.placeholder = t("Search files");
    searchInput.setAttribute("aria-label", t("Search files")); searchInput.value = search;
    searchInput.hidden = explorerView !== "files";
    searchInput.addEventListener("input", () => { search = searchInput.value; renderTree(); }); tools.append(searchInput);
    tools.append(button("↻", () => refresh(), { className: "fw-icon-button", title: "Refresh files", disabled: loading || mutationBusy || Boolean(mutation) }));
    const actions = el("details", "fw-actions"); const summary = el("summary", "fw-button fw-icon-button", "…");
    summary.setAttribute("aria-label", t("File actions")); summary.title = t("File actions"); actions.append(summary);
    actions.addEventListener("toggle", positionActionsMenu);
    const menu = el("div", "fw-actions-menu");
    for (const name of ["New file", "New folder", "Import files", "Rename", "Copy", "Cut", "Paste", "Move", "Delete", "Download"]) {
      const needsWrite = name !== "Download"; const needsSelection = ["Rename", "Copy", "Cut", "Move", "Delete", "Download"].includes(name);
      menu.append(button(name, () => { actions.open = false; void command(name); }, {
        disabled: loading || mutationBusy || Boolean(mutation) || (needsWrite && !writable()) || (needsSelection && !selectedPath)
          || (name === "Download" && selectedEntry()?.directory) || (name === "Paste" && !clipboard),
        className: name === "Delete" ? "is-danger" : "",
      }));
    }
    actions.append(menu); tools.append(actions); filesPane.append(tools);
    actions.hidden = explorerView !== "files";
    const panel = el("div", "fw-explorer-body"); panel.id = "fw-explorer-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `fw-explorer-tab-${explorerView}`);
    const outline = el("div", explorerView === "files" ? "fw-tree" : "fw-repository-review fw-content");
    if (explorerView === "files") { outline.setAttribute("role", "tree"); outline.setAttribute("aria-label", t("File explorer")); }
    else {
      const label = explorerView === "changes" ? "Latest saved changes" : "Branch history";
      const heading = el("p", "fw-review-heading", `${t(label)}${tree?.commit ? ` · ${tree.commit.slice(0, 8)}` : ""}`); heading.dataset.i18nSkip = ""; panel.append(heading);
      outline.dataset.i18nSkip = "";
    }
    panel.append(outline); filesPane.append(panel);
    if (explorerView === "files") renderTree();
    else if (!renderExplorerProblem(outline) && tree?.commit && active === "files") {
      const view = explorerView; const selection = { branchId, commit: tree.commit, connectionRevision: tree.connection_revision };
      const isCurrent = () => !disposed && epoch === generation && explorerTicket === explorerGeneration && active === "files" && explorerView === view;
      if (view === "history") void renderHistory(outline, selection, explorerTicket, isCurrent);
      else void showCommitChanges(outline, selection, { id: tree.commit, parent_ids: [] }, explorerTicket, isCurrent);
    }
    const footer = el("div", "fw-explorer-footer");
    footer.append(el("span", "", `${tree?.entries?.length ?? 0} ${t("Files")}`));
    if (branchId && !canEditFileBranch(context, currentBranch())) footer.append(el("span", "fw-readonly", t("Read only")));
    filesPane.append(footer);
    if (focused) { searchInput.focus(); searchInput.setSelectionRange?.(selectionStart, selectionStart); }
  }
  function positionActionsMenu() {
    const actions = filesPane.querySelector(".fw-actions"); if (!actions?.open) return;
    const menu = actions.querySelector(".fw-actions-menu");
    const anchor = actions.getBoundingClientRect(), pane = filesPane.getBoundingClientRect(), bounds = root.getBoundingClientRect();
    const viewport = window.visualViewport, viewportTop = viewport?.offsetTop ?? 0;
    const top = Math.max(pane.top, bounds.top, viewportTop) + 8;
    const bottom = Math.min(pane.bottom, bounds.bottom, viewportTop + (viewport?.height ?? window.innerHeight ?? bounds.bottom)) - 8;
    const above = Math.max(0, Math.min(anchor.top - 6, bottom) - top);
    const below = Math.max(0, bottom - Math.max(anchor.bottom + 6, top));
    // Prefer the usual dropdown; flip only when it needs more room. The menu
    // scrolls inside the clipped workspace and the keyboard's visual viewport.
    const height = Math.min(menu.scrollHeight + menu.offsetHeight - menu.clientHeight, 440);
    const opensAbove = below < height && above > below;
    const available = opensAbove ? above : below;
    const menuTop = opensAbove ? Math.min(anchor.top - 6, bottom) - Math.min(height, available) : Math.max(anchor.bottom + 6, top);
    menu.style.top = `${menuTop - anchor.top}px`; menu.style.maxHeight = `${Math.min(available, 440)}px`;
  }
  function renderTree() {
    const outline = filesPane.querySelector(".fw-tree"); if (!outline) return;
    const previousScroll = outline.scrollTop; outline.replaceChildren();
    if (renderExplorerProblem(outline)) return;
    const rows = flattenFileTree(buildFileTree(tree?.entries), expanded, search);
    if (!rows.length) { outline.append(el("p", "fw-empty", t(search ? "No matching files" : "No files yet"))); return; }
    for (const row of rows) {
      const item = el("div", "fw-tree-row"); item.setAttribute("role", "treeitem"); item.dataset.path = row.path;
      item.setAttribute("aria-level", String(row.depth + 1)); item.setAttribute("aria-selected", String(selectedPath === row.path));
      item.tabIndex = selectedPath === row.path || (!selectedPath && rows[0] === row) ? 0 : -1;
      item.style.setProperty("--file-depth", String(row.depth));
      if (row.directory) item.setAttribute("aria-expanded", String(expanded.has(row.path) || Boolean(search)));
      item.title = row.path; item.dataset.i18nSkip = "";
      const glyph = el("span", "fw-file-glyph", row.directory ? (expanded.has(row.path) || search ? "⌄" : "›") : fileGlyph(row.path));
      glyph.setAttribute("aria-hidden", "true"); item.append(glyph, el("span", "fw-file-name", row.name));
      item.addEventListener("click", () => {
        selectedPath = row.path;
        if (row.directory) { expanded.has(row.path) ? expanded.delete(row.path) : expanded.add(row.path); renderExplorer(); filesPane.querySelectorAll('[role="treeitem"]').forEach((node) => { if (node.dataset.path === row.path) node.focus(); }); }
        else { renderExplorer(); void openFile(row.path); }
      });
      item.addEventListener("contextmenu", (event) => { event.preventDefault(); selectedPath = row.path; renderExplorer(); const menu = filesPane.querySelector(".fw-actions"); if (menu) { menu.open = true; positionActionsMenu(); menu.querySelector("button:not(:disabled)")?.focus(); } });
      item.addEventListener("keydown", (event) => treeKey(event, row, rows)); outline.append(item);
    }
    outline.scrollTop = previousScroll;
  }
  function renderExplorerProblem(outline) {
    if (loading) { outline.append(el("p", "fw-empty", t("Loading files…"))); return true; }
    if (treeError) {
      const error = el("div", "fw-empty fw-error"); error.append(el("p", "", treeError));
      if (onConfigure) error.append(button(provider === "github" ? "Connect GitHub" : "Configure file sharing", () => onConfigure(provider)));
      error.append(button("Refresh to retry", () => refresh())); outline.append(error); return true;
    }
    return false;
  }
  function treeKey(event, row, rows) {
    const index = rows.findIndex((item) => item.path === row.path); let target;
    if (event.key === "ArrowDown") target = rows[Math.min(index + 1, rows.length - 1)]?.path;
    if (event.key === "ArrowUp") target = rows[Math.max(index - 1, 0)]?.path;
    if (event.key === "Home") target = rows[0]?.path; if (event.key === "End") target = rows.at(-1)?.path;
    if (event.key === "ArrowRight" && row.directory) { expanded.add(row.path); target = row.path; }
    if (event.key === "ArrowLeft") { if (row.directory && expanded.has(row.path)) { expanded.delete(row.path); target = row.path; } else target = fileParent(row.path); }
    if (target !== undefined) { event.preventDefault(); selectedPath = target; renderTree(); [...filesPane.querySelectorAll('[role="treeitem"]')].find((node) => node.dataset.path === target)?.focus(); }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (row.directory) { expanded.has(row.path) ? expanded.delete(row.path) : expanded.add(row.path); renderTree(); } else void openFile(row.path); }
    if (event.key === "F2" && writable()) { event.preventDefault(); selectedPath = row.path; void command("Rename"); }
  }
  function fileGlyph(path) { if (/\.pdf$/iu.test(path)) return "PDF"; if (/\.(?:png|jpe?g|gif|webp)$/iu.test(path)) return "▧"; if (/\.(?:md|markdown)$/iu.test(path)) return "M↓"; return "{}"; }

  function resetBranch() {
    invalidate(); destroyView(); tabs.clear();
    for (const [id, entry] of tabRegistry) if (entry.kind === "file") tabRegistry.delete(id);
    if (!tabRegistry.has(active)) active = tabRegistry.keys().next().value ?? null;
    selectedPath = ""; expanded = new Set(); search = ""; clipboard = null;
    tree = null; treeError = ""; explorerView = "files"; pendingConflict = false; mutation = null; mutationBusy = false; filePane.replaceChildren(); setNotice(); renderTabs(); renderActive();
  }
  async function loadBranches() {
    if (!context.projectId || !context.userId) { renderExplorer(); return; }
    const ticket = ++branchGeneration; loading = true; treeError = ""; renderExplorer();
    try {
      const result = await read("getFileBranches", { provider }); if (!result || ticket !== branchGeneration) return;
      branches = Array.isArray(result.branches) ? result.branches : [];
      if (!branches.some((branch) => branch.id === branchId)) branchId = result.default_branch_id ?? branches.find((branch) => canEditFileBranch(context, branch))?.id ?? branches[0]?.id ?? "";
      if (branchId) await loadTree(); else { loading = false; renderExplorer(); }
    } catch (error) { if (ticket !== branchGeneration) return; loading = false; treeError = errorMessage(error, "Could not load files."); renderExplorer(); }
  }
  async function loadTree() {
    const ticket = ++branchGeneration; loading = true; treeError = ""; renderExplorer();
    try {
      const result = await read("getFileTree", { provider, branch_id: branchId });
      if (!result || ticket !== branchGeneration) return;
      if (tree && tree.connection_revision !== result.connection_revision) {
        clipboard = null;
        if (tabs.size) {
          pendingConflict = true;
          setNotice(t("This branch changed. Your edits are kept. Refresh and review before saving again."), "error");
        }
      }
      tree = result; loading = false; renderExplorer();
    } catch (error) { if (ticket !== branchGeneration) return; loading = false; treeError = errorMessage(error, "Could not load files."); renderExplorer(); }
  }
  async function refresh() {
    const epoch = generation;
    if (mutationBusy || mutation) return;
    if (!await confirmLeave() || epoch !== generation) return;
    resetBranch(); await loadBranches();
  }
  async function openFile(path, { commit, beforeCommit, emptyBefore = false, emptyAfter = false, connectionRevision = tree?.connection_revision } = {}) {
    try { normalizeFilePath(path); } catch { return; }
    let tab = [...tabs.values()].find((item) => item.path === path && item.commit === commit && item.beforeCommit === beforeCommit && item.emptyBefore === emptyBefore && item.emptyAfter === emptyAfter && item.connectionRevision === connectionRevision);
    if (tab) { activate(tab.id); return tab; }
    tab = { id: `file-${++sequence}`, path, branchId, commit, beforeCommit, emptyBefore, emptyAfter, connectionRevision, mode: beforeCommit || emptyBefore || emptyAfter ? "diff" : "preview", loading: true, error: "", original: undefined, draft: undefined };
    tabs.set(tab.id, tab); activate(tab.id);
    const epoch = generation;
    if (emptyAfter) {
      // A deletion has no blob at the selected commit. Its after-side is empty;
      // renderDiff fetches the before-side from the acknowledged parent instead.
      tab.bytes = new Uint8Array(); tab.description = { kind: "text", text: "", mime: "text/plain;charset=utf-8" };
      tab.original = ""; tab.draft = ""; tab.baseCommit = commit; tab.loading = false;
      if (active === tab.id) { renderTabs(); renderActive(); } return tab;
    }
    try {
      const result = await read("getFileContent", { provider, branch_id: branchId, path, ...(commit ? { commit } : {}),
        ...(connectionRevision !== undefined ? { connection_revision: connectionRevision } : {}) });
      if (!result || epoch !== generation || !tabs.has(tab.id)) return;
      tab.bytes = decodeFileContent(result); tab.description = describeFileContent(path, tab.bytes); tab.baseCommit = result.commit;
      tab.connectionRevision = result.connection_revision ?? connectionRevision;
      tab.executable = result.executable ?? false; tab.original = tab.description.text;
      tab.draft = tab.original; tab.loading = false;
      if (active === tab.id) { renderTabs(); renderActive(); }
      return tab;
    } catch (error) { if (epoch !== generation || !tabs.has(tab.id)) return; tab.loading = false; tab.error = errorMessage(error, "Could not load this file."); if (active === tab.id) renderActive(); }
  }

  async function renderFile(tab) {
    const ticket = viewGeneration; filePane.replaceChildren(); if (!tab) return;
    const header = el("div", "fw-file-header"); const heading = el("div", "fw-file-heading");
    const pathLabel = el("span", "fw-file-path", tab.path); pathLabel.dataset.i18nSkip = ""; heading.append(pathLabel);
    if (tab.commit) heading.append(el("span", "fw-version", `${t("Historical version")} · ${tab.commit.slice(0, 8)}`));
    if (tab.emptyAfter) heading.append(el("span", "fw-readonly", t("Deleted")));
    else if (!canEditFileBranch(context, currentBranch())) heading.append(el("span", "fw-readonly", t("Read only")));
    header.append(heading); const tools = el("div", "fw-file-tools");
    tools.append(button("Back to files", () => activate("files"), { className: "fw-back" }));
    if (tab.original !== undefined) {
      for (const [mode, label] of [["preview", "Preview"], ["code", "Code"], ["diff", "Changes"], ["history", "History"]]) {
        const choice = button(label, () => { tab.mode = mode; renderActive(); }, { className: tab.mode === mode ? "is-selected" : "" }); choice.dataset.fileMode = mode; choice.setAttribute("aria-pressed", String(tab.mode === mode)); tools.append(choice);
      }
    } else {
      for (const [mode, label] of [["preview", "Preview"], ["history", "History"]]) {
        const choice = button(label, () => { tab.mode = mode; renderActive(); }, { className: tab.mode === mode ? "is-selected" : "" });
        choice.setAttribute("aria-pressed", String(tab.mode === mode)); tools.append(choice);
      }
    }
    tools.append(button("Download", () => downloadTab(tab), { disabled: tab.loading || Boolean(tab.error) }));
    if (tab.original !== undefined && !tab.commit) {
      const save = button(mutationBusy ? "Saving…" : "Save", () => saveTab(tab), { className: "fw-save", disabled: !writable() || tab.draft === tab.original || tab.loading });
      save.dataset.saveFor = tab.id; tools.append(save);
    }
    header.append(tools); filePane.append(header);
    const content = el("div", "fw-content"); content.dataset.i18nSkip = ""; filePane.append(content);
    if (tab.loading) { content.append(el("p", "fw-empty", t("Loading file…"))); return; }
    if (tab.error) {
      const error = el("div", "fw-empty fw-error"); error.append(el("p", "", tab.error));
      error.append(button("Reload file", () => {
        tabs.delete(tab.id); void openFile(tab.path, { commit: tab.commit, beforeCommit: tab.beforeCommit, emptyBefore: tab.emptyBefore, emptyAfter: tab.emptyAfter, connectionRevision: tab.connectionRevision });
      }));
      if (onConfigure) error.append(button(provider === "github" ? "Connect GitHub" : "Configure file sharing", () => onConfigure(provider)));
      content.append(error); return;
    }
    if (tab.mode === "history") { await renderHistory(content, tab, ticket); return; }
    if (tab.mode === "diff") { await renderDiff(content, tab, ticket); return; }
    if (tab.original !== undefined && (tab.mode === "code" || tab.description.kind === "text")) {
      const editable = tree?.can_write !== false && canEditFileBranch(context, currentBranch(), Boolean(tab.commit)) && !pendingConflict && !mutation;
      if (!editorFactory) { content.append(el("p", "fw-empty", t("Editor unavailable"))); return; }
      try {
        content.dataset.i18nSkip = "";
        const view = await editorFactory({ parent: content, doc: tab.draft, readOnly: !editable, path: tab.path, theme: document.documentElement.dataset.theme,
          onChange: (value) => {
            if (!tabs.has(tab.id) || ticket !== viewGeneration || !canEditFileBranch(context, currentBranch(), Boolean(tab.commit))) return;
            tab.draft = value; renderTabs(); updateSaveButtons();
          } });
        if (ticket !== viewGeneration || active !== tab.id) { view.destroy?.(); return; } mountedView = view;
      } catch { if (ticket === viewGeneration) content.append(el("p", "fw-empty fw-error", t("Editor unavailable"))); }
    } else if (tab.description.kind === "markdown") {
      const preview = el("div", "fw-markdown markdown-body");
      preview.dataset.i18nSkip = "";
      const rendered = renderMarkdown?.(tab.draft);
      if (rendered && typeof rendered.nodeType === "number") preview.append(rendered);
      else if (typeof rendered === "string") preview.innerHTML = rendered;
      else preview.textContent = tab.draft;
      content.append(preview);
    } else if (tab.description.kind === "image") {
      // The isolated example permits data images but deliberately blocks blob
      // image URLs. Both paths use only the raster MIME sniffed from file bytes.
      const url = exampleMode ? `data:${tab.description.mime};base64,${bytesToBase64(tab.bytes)}` : objectUrl(tab.bytes, tab.description.mime);
      const image = el("img", "fw-image"); image.src = url; image.alt = tab.path; content.append(image);
      mountedView = { destroy() { if (!exampleMode) revoke(url); } };
    } else if (tab.description.kind === "pdf") {
      // Workers are forbidden by the opaque example's CSP. Do not relax that
      // boundary merely to demonstrate a format the authored fixture lacks.
      if (exampleMode) { content.append(el("p", "fw-empty", t("PDF preview is not included in the isolated example."))); return; }
      if (!pdfFactory) { content.append(el("p", "fw-empty", t("PDF preview unavailable"))); return; }
      try { const view = await pdfFactory({ host: content, bytes: tab.bytes.slice(), t }); if (ticket !== viewGeneration) view.destroy?.(); else mountedView = view; }
      catch { if (ticket === viewGeneration) content.append(el("p", "fw-empty fw-error", t("PDF preview unavailable"))); }
    } else content.append(el("p", "fw-empty", t("This file is available as a download.")));
  }
  function updateSaveButtons() {
    const tab = tabs.get(active); const save = filePane.querySelector("[data-save-for]");
    if (save && tab) save.disabled = !writable() || tab.draft === tab.original;
    renderNotice();
  }
  async function renderDiff(content, tab, ticket) {
    content.dataset.i18nSkip = "";
    let before = tab.emptyBefore ? "" : tab.original ?? "";
    if (tab.beforeCommit) {
      content.append(el("p", "fw-empty", t("Loading changes…")));
      try {
        const result = await read("getFileContent", { provider, branch_id: tab.branchId, path: tab.path, commit: tab.beforeCommit,
          ...(tab.connectionRevision !== undefined ? { connection_revision: tab.connectionRevision } : {}) });
        if (!result || ticket !== viewGeneration) return;
        const bytes = decodeFileContent(result); before = describeFileContent(tab.path, bytes).text;
        if (tab.emptyAfter) tab.deletedBytes = bytes;
      } catch {
        if (ticket === viewGeneration) content.replaceChildren(el("p", "fw-empty fw-error", t("Could not load this file.")));
        return;
      }
      content.replaceChildren();
    }
    if (before === undefined || tab.draft === undefined) { content.append(el("p", "fw-empty", t("This file is available as a download."))); return; }
    if (diffFactory) {
      try { const view = await diffFactory({ parent: content, before, after: tab.draft, path: tab.path, t, theme: document.documentElement.dataset.theme }); if (ticket !== viewGeneration) view.destroy?.(); else mountedView = view; }
      catch { if (ticket === viewGeneration) content.append(el("p", "fw-empty fw-error", t("Editor unavailable"))); }
    } else {
      const previous = el("pre", "fw-diff-before", before); const next = el("pre", "fw-diff-after", tab.draft);
      previous.setAttribute("aria-label", t("Current version")); next.setAttribute("aria-label", t("Unsaved changes")); content.append(previous, next);
    }
  }
  async function renderHistory(content, tab, ticket, isCurrent = () => ticket === viewGeneration) {
    content.append(el("p", "fw-empty", t("Loading history…")));
    try {
      const result = await read("getFileHistory", { provider, branch_id: tab.branchId, ...(tab.path ? { path: tab.path } : {}), ...(tab.commit ? { commit: tab.commit } : {}),
        ...(tab.connectionRevision !== undefined ? { connection_revision: tab.connectionRevision } : {}), limit: 30 });
      if (!result || !isCurrent()) return;
      content.replaceChildren(); appendHistory(result);
    } catch { if (isCurrent()) { content.replaceChildren(el("p", "fw-empty fw-error", t("Could not load history."))); } }
    function appendHistory(result) {
      if (!result.commits?.length && !content.children.length) content.append(el("p", "fw-empty", t("No history yet")));
      for (const commit of result.commits ?? []) {
        const card = el("article", "fw-history-entry"); const message = el("p", "fw-history-message", commit.message); message.dataset.i18nSkip = ""; card.append(message);
        const metadata = [commit.id.slice(0, 8), commit.author_name, commit.created_at ? new Date(commit.created_at).toLocaleString() : ""].filter(Boolean).join(" · ");
        const meta = el("p", "fw-history-meta", metadata); meta.dataset.i18nSkip = ""; card.append(meta);
        const actions = el("div", "fw-history-actions");
        if (tab.path) actions.append(button("View version", () => openFile(tab.path, { commit: commit.id, connectionRevision: tab.connectionRevision })));
        actions.append(button(tab.path && commit.parent_ids?.[0] ? "Compare with parent" : "View changes", () => showCommitChanges(content, tab, commit, ticket, isCurrent)));
        card.append(actions); content.append(card);
      }
      if (result.next_cursor) {
        const more = button("Load more", async () => {
          more.disabled = true;
          try { const next = await read("getFileHistory", { provider, branch_id: tab.branchId, ...(tab.path ? { path: tab.path } : {}),
            ...(tab.commit ? { commit: tab.commit } : {}), ...(tab.connectionRevision !== undefined ? { connection_revision: tab.connectionRevision } : {}),
            cursor: result.next_cursor, limit: 30 }); if (next && isCurrent()) { more.remove(); appendHistory(next); } }
          catch { if (isCurrent()) { more.disabled = false; setNotice(t("Could not load history."), "error"); } }
        }); content.append(more);
      }
    }
  }
  async function showCommitChanges(content, tab, commit, ticket, isCurrent = () => ticket === viewGeneration) {
    content.replaceChildren(el("p", "fw-empty", t("Loading changes…")));
    try {
      const result = await read("getFileChanges", { provider, branch_id: tab.branchId,
        ...(commit.parent_ids?.[0] ? { base_commit: commit.parent_ids[0] } : {}), commit: commit.id,
        ...(tab.connectionRevision !== undefined ? { connection_revision: tab.connectionRevision } : {}) });
      if (!result || !isCurrent()) return;
      content.replaceChildren(); content.append(el("p", "fw-history-meta", `${result.base_commit ? result.base_commit.slice(0, 8) : t("Empty tree")} → ${result.commit.slice(0, 8)}`));
      if (!result.files?.length) content.append(el("p", "fw-empty", t("No changes")));
      for (const file of result.files ?? []) {
        const label = { added: "Added", modified: "Modified", deleted: "Deleted" }[file.status] ?? "Modified";
        const row = button(`${t(label)} · ${file.path}`, () => openFile(file.path, file.status === "deleted"
          ? { commit: result.commit, beforeCommit: result.base_commit, emptyAfter: true, connectionRevision: tab.connectionRevision }
          : { commit: result.commit, beforeCommit: file.status === "added" ? undefined : result.base_commit, emptyBefore: file.status === "added", connectionRevision: tab.connectionRevision }), { className: `fw-change is-${file.status}` });
        content.append(row);
      }
    } catch { if (isCurrent()) content.replaceChildren(el("p", "fw-empty fw-error", t("Could not load history."))); }
  }

  async function saveTab(tab) {
    if (!writable() || tab.draft === undefined || tab.draft === tab.original || tab.commit) return;
    const savedDraft = tab.draft;
    if (new TextEncoder().encode(savedDraft).length > FILE_TEXT_LIMIT) {
      setNotice(t("Text editing is limited to 2 MiB. Download this draft or reduce its size."), "error"); return;
    }
    await mutate([{ type: "write", path: tab.path, content_base64: textToBase64(savedDraft), executable: tab.executable }], `Edit ${tab.path}`, () => {
      tab.original = savedDraft; tab.bytes = new TextEncoder().encode(savedDraft); tab.baseCommit = tree?.commit;
    }, { baseCommit: tab.baseCommit, connectionRevision: tab.connectionRevision });
  }
  async function mutate(operations, message, onSuccess = () => {}, selection = {}) {
    if (!writable() || !tree?.commit) { setNotice(t("Only your current branch can be edited."), "error"); return; }
    try { validateFileWriteOperations(operations, provider); }
    catch (error) { setNotice(errorMessage(error, "Could not save changes."), "error"); return false; }
    const baseCommit = Object.hasOwn(selection, "baseCommit") ? selection.baseCommit : tree.commit;
    const connectionRevision = Object.hasOwn(selection, "connectionRevision") ? selection.connectionRevision : tree.connection_revision;
    mutation = { projectId: context.projectId, scope, epoch: generation, body: { provider, branch_id: branchId,
      // An open editor acknowledges its own loaded commit. A newer explorer head
      // must never silently rebase that buffer over another device's changes.
      base_commit: baseCommit, ...(connectionRevision !== undefined ? { connection_revision: connectionRevision } : {}),
      operations, message: message.slice(0, 300), idempotency_key: makeKey() }, onSuccess };
    return dispatchMutation();
  }
  async function dispatchMutation() {
    if (!mutation || mutationBusy) return;
    const pending = mutation; mutationBusy = true; renderExplorer(); updateSaveButtons();
    try {
      const controller = new AbortController(); controllers.add(controller); const timer = window.setTimeout(() => controller.abort(), 20000);
      let result;
      try { result = await api.mutateFiles(pending.projectId, pending.body, { signal: controller.signal }); }
      finally { window.clearTimeout(timer); controllers.delete(controller); }
      if (disposed || pending.scope !== scope || pending.epoch !== generation || mutation !== pending) return;
      mutation = null; mutationBusy = false;
      if (result.branch_id && result.branch_id !== branchId) {
        const branch = currentBranch(); branchId = result.branch_id;
        if (branch) branch.id = result.branch_id;
        for (const tab of tabs.values()) if (tab.branchId === pending.body.branch_id) tab.branchId = result.branch_id;
      }
      if (tree) { tree.commit = result.commit; tree.head_commit = result.commit; }
      pending.onSuccess(); setNotice(t("File operation completed"));
      await loadBranches(); renderTabs(); renderActive(); return true;
    } catch (error) {
      if (pending.scope !== scope || pending.epoch !== generation || mutation !== pending) return;
      mutationBusy = false;
      const statusCode = error?.status ?? error?.statusCode; const code = String(error?.code ?? "");
      if (statusCode === 409 || /conflict|stale|changed|non_fast_forward/u.test(code)) {
        mutation = null; pendingConflict = true; setNotice(t("This branch changed. Your edits are kept. Refresh and review before saving again."), "error");
      } else if (statusCode >= 400 && statusCode < 500) {
        mutation = null; setNotice(errorMessage(error, "Could not save changes."), "error");
      } else setNotice(t("The result is unknown. Retry the same operation to check its outcome."), "error");
      renderExplorer(); updateSaveButtons(); return false;
    }
  }
  async function reloadConflict() {
    const epoch = generation;
    if (!await confirmLeave() || epoch !== generation) return; resetBranch(); await loadBranches();
  }
  function selectedEntry() {
    return tree?.entries?.find((entry) => entry.path === selectedPath) ?? (tree?.entries?.some((entry) => pathContains(selectedPath, entry.path)) ? { path: selectedPath, directory: true } : null);
  }
  async function command(name) {
    const epoch = generation;
    const entry = selectedEntry();
    try {
      if (["Copy", "Cut"].includes(name)) {
        if (!entry) { setNotice(t("Select a file or folder first.")); return; }
        if (!writable()) return;
        clipboard = { type: name === "Copy" ? "copy" : "move", path: entry.path, directory: Boolean(entry.directory), provider, branchId, scope, commit: tree.commit };
        setNotice(t(name === "Copy" ? "Copied" : "Cut selected")); return;
      }
      if (name === "Download") { if (entry && !entry.directory) { await downloadPath(entry.path); } return; }
      if (!writable()) { setNotice(t("Only your current branch can be edited."), "error"); return; }
      const parent = entry?.directory ? entry.path : fileParent(entry?.path ?? "");
      if (name === "Import files") { importFiles(parent); return; }
      if (["New file", "New folder"].includes(name)) {
        const value = await prompt(t(name === "New file" ? "File path" : "Folder path"), parent ? `${parent}/` : ""); if (!value || epoch !== generation) return;
        const destination = validateFileDestination(value, tree.entries);
        const path = normalizeFilePath(name === "New folder" ? `${destination}/.gitkeep` : destination);
        const completed = await mutate([{ type: "write", path, content_base64: "", executable: false }], `${name}: ${destination}`, () => { expanded.add(fileParent(path)); selectedPath = destination; });
        if (completed && name === "New file" && epoch === generation) await openFile(path); return;
      }
      if (name === "Paste") {
        if (!clipboard || clipboard.scope !== scope || clipboard.provider !== provider || clipboard.branchId !== branchId) { setNotice(t("Nothing to paste")); return; }
        const defaultPath = `${parent ? `${parent}/` : ""}${fileBasename(clipboard.path)}`;
        const value = await prompt(t("Destination path"), defaultPath); if (!value || epoch !== generation) return;
        const destination = validateFileDestination(value, tree.entries, { source: clipboard.path, isDirectory: clipboard.directory });
        if (clipboard.type === "move" && !await confirmAffected(clipboard.path)) return;
        if (epoch !== generation) return;
        const source = clipboard.path; const type = clipboard.type;
        await mutate([{ type, path: source, destination }], `${type === "copy" ? "Copy" : "Move"} ${source}`, () => {
          if (type === "move") { dropAffected(source); clipboard = null; } selectedPath = destination;
        }); return;
      }
      if (!entry) { setNotice(t("Select a file or folder first.")); return; }
      if (["Rename", "Move"].includes(name)) {
        const value = await prompt(t(name === "Rename" ? "Rename path" : "Destination path"), entry.path); if (!value || value === entry.path || epoch !== generation) return;
        const destination = validateFileDestination(value, tree.entries, { source: entry.path, isDirectory: entry.directory });
        if (!await confirmAffected(entry.path) || epoch !== generation) return;
        await mutate([{ type: "move", path: entry.path, destination }], `Move ${entry.path}`, () => { dropAffected(entry.path); selectedPath = destination; }); return;
      }
      if (name === "Delete") {
        if (!await confirm(t("Delete the selected file or folder?")) || epoch !== generation || !await confirmAffected(entry.path) || epoch !== generation) return;
        await mutate([{ type: "delete", path: entry.path }], `Delete ${entry.path}`, () => { dropAffected(entry.path); selectedPath = ""; });
      }
    } catch (error) { if (epoch === generation) setNotice(errorMessage(error, "Could not save changes."), "error"); }
  }
  async function confirmAffected(path) {
    const dirty = [...tabs.values()].some((tab) => !tab.commit && pathContains(path, tab.path) && tab.draft !== tab.original);
    return !dirty || Boolean(await confirm(t("Discard unsaved changes?")));
  }
  function dropAffected(path) {
    removeTabs([...tabs.values()].filter((tab) => !tab.commit && pathContains(path, tab.path)).map((tab) => tab.id));
  }
  function importFiles(parent) {
    const epoch = generation;
    const picker = el("input"); picker.type = "file"; picker.multiple = true; picker.hidden = true; root.append(picker);
    picker.addEventListener("cancel", () => picker.remove(), { once: true });
    picker.addEventListener("change", async () => {
      const picked = [...picker.files]; picker.remove(); if (epoch !== generation) return;
      try {
        validateFileImport(picked, provider);
        const operations = []; const destinations = [...tree.entries];
        for (const file of picked) {
          const path = validateFileDestination(`${parent ? `${parent}/` : ""}${file.name}`, destinations);
          const bytes = new Uint8Array(await file.arrayBuffer()); if (epoch !== generation) return;
          destinations.push({ path }); operations.push({ type: "write", path, content_base64: bytesToBase64(bytes), executable: false });
        }
        if (operations.length && epoch === generation) await mutate(operations, "Import files");
      } catch (error) { if (epoch === generation) setNotice(errorMessage(error, "Could not save changes."), "error"); }
    }, { once: true }); picker.click();
  }
  function objectUrl(bytes, mime) { const url = window.URL.createObjectURL(new Blob([bytes], { type: mime })); urls.add(url); return url; }
  function revoke(url) { window.URL.revokeObjectURL(url); urls.delete(url); }
  function downloadBytes(bytes, name, mime = "application/octet-stream") {
    const url = objectUrl(bytes, mime); const link = el("a"); link.href = url; link.download = fileBasename(name); link.hidden = true; root.append(link); link.click(); link.remove(); window.setTimeout(() => revoke(url), 1000);
  }
  function downloadTab(tab) { if (tab.emptyAfter && tab.deletedBytes) downloadBytes(tab.deletedBytes, tab.path); else if (tab.draft !== undefined) downloadBytes(new TextEncoder().encode(tab.draft), tab.path, "text/plain;charset=utf-8"); else if (tab.bytes) downloadBytes(tab.bytes, tab.path, tab.description?.mime); }
  async function downloadPath(path) {
    const tab = [...tabs.values()].find((item) => item.path === path && !item.commit && !item.loading);
    if (tab) { downloadTab(tab); return; }
    try { const result = await read("getFileContent", { provider, branch_id: branchId, path }); if (result) downloadBytes(decodeFileContent(result), path); }
    catch (error) { setNotice(errorMessage(error, "Could not load this file."), "error"); }
  }
  function downloadDirty() { for (const tab of tabs.values()) if (tab.draft !== undefined && tab.draft !== tab.original) downloadTab(tab); }
  function clear() {
    resetBranch(); branches = []; branchId = ""; provider = "gt-cloud"; loading = false;
    filePane.replaceChildren(); for (const url of urls) window.URL.revokeObjectURL(url); urls.clear(); renderExplorer();
  }
  async function updateContext() {
    if (disposed) return;
    const next = getContext() ?? {}; const nextScope = fileContextKey(next);
    if (nextScope !== scope) { clear(); context = next; scope = nextScope; renderExplorer(); if (visible && active === "files") await loadBranches(); }
    else { const changedPermission = next.canWrite !== context.canWrite; context = next; renderExplorer(); if (changedPermission) renderActive(); }
  }
  async function open(tab = "files") {
    if (disposed) return;
    const intent = ++visibilityRevision; await updateContext();
    if (disposed || intent !== visibilityRevision) return; activate(tab);
    if (tab === "files" && !tree && !loading) await loadBranches();
  }
  async function show() {
    if (disposed) return;
    const intent = ++visibilityRevision; await updateContext();
    if (disposed || intent !== visibilityRevision) return;
    // Layout can collapse independently at a breakpoint. Reassert presentation
    // without activating a different tab or rebuilding its mounted editor.
    visible = true; onOpen();
    renderTabPickers(); revealActiveTab();
    if (active === "files" && !tree && !loading) await loadBranches();
  }
  // Authored tutorial navigation only. All content still uses the same fenced
  // readers and tabs as real files. Never confirm/discard a practice draft or
  // submit a mutation on behalf of a guide.
  async function navigateExample({ provider: requestedProvider = "gt-cloud", branchId: requestedBranch, path, mode = "preview", compareWithParent = false } = {}) {
    if (!exampleMode || disposed || !["gt-cloud", "github"].includes(requestedProvider)
      || !["preview", "code", "diff", "history"].includes(mode)) return false;
    if (path !== undefined) { try { normalizeFilePath(path); } catch { return false; } }
    const ticket = ++exampleNavigationRevision; const requestedScope = fileContextKey(getContext() ?? {});
    const isCurrent = () => !disposed && ticket === exampleNavigationRevision && requestedScope === scope
      && requestedScope === fileContextKey(getContext() ?? {});
    await open("files");
    if (!isCurrent() || mutationBusy || mutation) return false;
    if (requestedProvider !== provider) {
      if (hasDirty()) { setNotice(t("Save or discard your example edits before switching branches.")); return false; }
      resetBranch(); provider = requestedProvider; branches = []; branchId = ""; await loadBranches();
    } else if (!tree || loading) await loadBranches();
    if (!isCurrent() || !tree) return false;
    const nextBranch = requestedBranch === "own"
      ? branches.find(branch => canEditFileBranch(context, branch))?.id : requestedBranch;
    if (nextBranch && nextBranch !== branchId) {
      if (!branches.some(branch => branch.id === nextBranch)) return false;
      if (hasDirty()) { setNotice(t("Save or discard your example edits before switching branches.")); return false; }
      resetBranch(); branchId = nextBranch; await loadTree();
    }
    if (!isCurrent() || !tree) return false;
    const epoch = generation; const current = () => isCurrent() && epoch === generation;
    if (!path) { explorerView = "files"; renderExplorer(); return true; }
    let selection = {};
    if (compareWithParent) {
      let changes;
      try { changes = await read("getFileChanges", { provider, branch_id: branchId, commit: tree.commit,
        ...(tree.connection_revision !== undefined ? { connection_revision: tree.connection_revision } : {}) }); }
      catch { if (current()) setNotice(t("Could not load history."), "error"); return false; }
      if (!changes || !current()) return false;
      const file = changes.files?.find(file => file.path === path);
      if (!file) return false;
      selection = { commit: changes.commit, beforeCommit: file.status === "added" ? undefined : changes.base_commit,
        emptyBefore: file.status === "added", emptyAfter: file.status === "deleted" };
    }
    if (!current()) return false;
    const tab = await openFile(path, selection);
    if (!tab || !current() || active !== tab.id) return false;
    tab.mode = mode; renderActive(); return true;
  }
  function cancelExampleNavigation() { exampleNavigationRevision += 1; }
  function close() { visibilityRevision += 1; visible = false; closeTabMenu(); newTabPicker.open = false; openTabsPicker.open = false; onClose(); }
  function keydown(event) {
    if (event.key === "Escape") {
      if (tabMenu) { event.preventDefault(); closeTabMenu({ restoreFocus: true }); return; }
      if (newTabPicker.open || openTabsPicker.open) { event.preventDefault(); const picker = newTabPicker.open ? newTabPicker : openTabsPicker; picker.open = false; picker.querySelector("summary")?.focus(); return; }
      const menu = filesPane.querySelector(".fw-actions");
      if (menu?.open) { event.preventDefault(); menu.open = false; menu.querySelector("summary")?.focus(); }
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "w" && visible && active && host.contains(document.activeElement)) {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat && active) void closeTabs([active]); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && visible && host.contains(document.activeElement)) {
      event.preventDefault(); const tab = tabs.get(active); if (tab) void saveTab(tab);
    }
  }
  function beforeUnload(event) { if (hasDirty()) { event.preventDefault(); event.returnValue = ""; } }
  function pointerdown(event) {
    if (tabMenu && !tabMenu.contains(event.target)) closeTabMenu();
    if (!newTabPicker.contains(event.target)) newTabPicker.open = false;
    if (!openTabsPicker.contains(event.target)) openTabsPicker.open = false;
  }
  root.addEventListener("keydown", keydown); window.addEventListener("beforeunload", beforeUnload); window.addEventListener("pointerdown", pointerdown);
  window.addEventListener("resize", positionActionsMenu);
  window.visualViewport?.addEventListener("resize", positionActionsMenu);
  window.visualViewport?.addEventListener("scroll", positionActionsMenu);
  const actionsResizeObserver = window.ResizeObserver ? new window.ResizeObserver(positionActionsMenu) : null;
  actionsResizeObserver?.observe(filesPane);
  function refreshLanguage() {
    root.setAttribute("aria-label", t("File workspace"));
    newTabSummary.setAttribute("aria-label", t("New tab")); newTabSummary.title = t("New tab"); openTabsSummary.setAttribute("aria-label", t("Workspace menu")); openTabsSummary.title = t("Workspace menu");
    renderTabs(); renderExplorer(); renderActive(); renderNotice();
  }
  function destroy() {
    disposed = true; clear(); root.removeEventListener("keydown", keydown); window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("pointerdown", pointerdown);
    window.removeEventListener("resize", positionActionsMenu); actionsResizeObserver?.disconnect();
    window.visualViewport?.removeEventListener("resize", positionActionsMenu);
    window.visualViewport?.removeEventListener("scroll", positionActionsMenu);
    if (membersHost && memberMarker.parentNode) memberMarker.replaceWith(membersHost);
    else if (membersHost && originalMemberParent) originalMemberParent.append(membersHost);
    root.remove();
  }
  renderTabs(); renderExplorer(); renderActive();
  return { updateContext, open, show, close, clear, hasDirty, confirmLeave, refreshLanguage, destroy,
    navigateExample, cancelExampleNavigation };
}
