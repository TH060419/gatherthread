import test from "node:test";
import assert from "node:assert/strict";
import { mountFileWorkspace, WORKSPACE_FILES_ZH_CN } from "../src/workspace-files.js";
import { textToBase64 } from "../src/workspace-files-model.js";
import { markdownToSafeHtml } from "../src/markdown.js";

// A small DOM fixture exercises controller lifetimes without a browser dependency.
class Node {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.children = []; this.dataset = {};
    this.attributes = {}; this.events = new Map(); this.style = { setProperty() {} }; this.text = "";
    this.classList = { toggle: (name, enabled) => { const classes = new Set(this.className?.split(" ") ?? []); enabled ? classes.add(name) : classes.delete(name); this.className = [...classes].join(" "); } };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((node) => node.textContent).join(""); }
  append(...nodes) { for (const node of nodes) { if (node.parentNode) node.remove(); node.parentNode = this; this.children.push(node); } }
  before(node) { const index = this.parentNode.children.indexOf(this); node.parentNode = this.parentNode; this.parentNode.children.splice(index, 0, node); }
  remove() { if (this.parentNode) { const index = this.parentNode.children.indexOf(this); this.parentNode.children.splice(index, 1); this.parentNode = null; } }
  replaceWith(node) { this.before(node); this.remove(); }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.text = ""; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { const list = this.events.get(name) ?? []; list.push(listener); this.events.set(name, list); }
  removeEventListener(name, listener) { this.events.set(name, (this.events.get(name) ?? []).filter((item) => item !== listener)); }
  async fire(name, values = {}) { for (const listener of this.events.get(name) ?? []) await listener({ target: this, preventDefault() {}, stopPropagation() {}, ...values }); }
  click() { return this.fire("click"); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = (node) => {
      if (selector.startsWith(".")) return node.className?.split(" ").includes(selector.slice(1));
      if (selector === "button:not(:disabled)") return node.tagName === "button" && !node.disabled;
      const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u);
      if (attribute) {
        const name = attribute[1]; const value = name.startsWith("data-") ? node.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] : node.attributes[name];
        return attribute[2] === undefined ? value !== undefined : value === attribute[2];
      }
      return node.tagName === selector;
    };
    const output = []; const visit = (node) => { for (const child of node.children) { if (matches(child)) output.push(child); visit(child); } }; visit(this); return output;
  }
  setSelectionRange() {}
  getBoundingClientRect() { return this.ownerDocument.rectFor?.(this) ?? { left: 0, right: 480, top: 0, bottom: 600, width: 480, height: 600 }; }
}
const flush = async () => { for (let index = 0; index < 15; index += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tabOrder = (f) => f.host.querySelector(".fw-tabs").querySelectorAll('[role="tab"]').map((node) => node.dataset.tab);
const closeTabButton = (f, id) => f.host.querySelectorAll(".fw-tab-wrap").find((node) => node.dataset.tabId === id).querySelector(".fw-tab-dismiss");
async function tabMenuAction(f, id, label) {
  await f.host.querySelectorAll(".fw-tab-wrap").find((node) => node.dataset.tabId === id).fire("contextmenu", { clientX: 100, clientY: 50 });
  return f.host.querySelector(".fw-tab-menu").querySelectorAll("button").find((node) => node.textContent === label).click();
}

function fixture(overrides = {}) {
  const document = { createElement: (tag) => new Node(tag, document), createComment: () => new Node("comment", document), activeElement: null };
  document.documentElement = new Node("html", document); const outer = new Node("div", document);
  const host = new Node("div", document); const membersHost = new Node("aside", document); outer.append(membersHost, host);
  const listeners = new Map();
  const window = { setTimeout, clearTimeout, crypto: { randomUUID: () => "stable-operation-key" },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: (name) => listeners.delete(name),
    confirm: () => true, prompt: () => null,
  };
  let context = { scope: "origin", userId: "alice", projectId: "project-a", canWrite: true, members: [] };
  const sha = "a".repeat(40); const branches = [{ id: "main", name: "main", user_id: null, can_write: false, head_commit: sha }, { id: "own", name: "My branch", can_write: true, user_id: "alice", head_commit: sha }];
  const calls = []; const editors = [];
  const api = {
    async getFileBranches() { return { branches, default_branch_id: "own" }; },
    async getFileTree() { return { commit: sha, can_write: true, entries: [{ path: "a.js", size: 3 }, { path: "b.js", size: 3 }] }; },
    async getFileContent(_project, options) { calls.push(["content", options]); return { commit: sha, path: options.path, content_base64: textToBase64(options.path), size: options.path.length }; },
    async mutateFiles(_project, input) { calls.push(["mutate", input]); return { commit: "b".repeat(40), branch_id: "own" }; },
    ...overrides.api,
  };
  const controller = mountFileWorkspace({ ...overrides, document, window, api, host, membersHost, getContext: () => context,
    editorFactory: async ({ doc, onChange, readOnly, parent }) => {
      const node = new Node("editor", document); parent.append(node);
      const editor = { doc, readOnly, destroyed: false, change(value) { onChange(value); }, destroy() { this.destroyed = true; node.remove(); } };
      editors.push(editor); return editor;
    },
  });
  const treeItem = (path) => host.querySelectorAll('[role="treeitem"]').find((node) => node.dataset.path === path);
  const tab = (id) => host.querySelectorAll('[role="tab"]').find((node) => node.dataset.tab === id);
  return { controller, document, window, host, membersHost, outer, calls, editors, treeItem, tab, setContext(value) { context = value; }, getContext: () => context };
}

test("members controls move as one original node and restore on destroy", async () => {
  const f = fixture(); assert.equal(f.membersHost.parentNode.className, "fw-members-pane");
  await f.controller.open("members"); assert.equal(f.membersHost.parentNode.hidden, false);
  f.controller.destroy(); assert.equal(f.membersHost.parentNode, f.outer); assert.equal(f.outer.children[0], f.membersHost);
});

test("function tabs close independently, reopen once, and retain the original member controls", async () => {
  const f = fixture(); let clicks = 0; const originalControl = f.document.createElement("button");
  originalControl.addEventListener("click", () => { clicks += 1; }); f.membersHost.append(originalControl);
  assert.deepEqual(tabOrder(f), ["files"]); await f.controller.open("members");
  assert.deepEqual(tabOrder(f), ["files", "members"]); await originalControl.click();
  await closeTabButton(f, "members").click(); assert.deepEqual(tabOrder(f), ["files"]);
  await closeTabButton(f, "files").click(); assert.deepEqual(tabOrder(f), []);
  assert.equal(f.host.querySelector(".fw-new-tab-view").hidden, false);
  await f.host.querySelector('[data-open-tab="members"]').click(); await flush();
  assert.deepEqual(tabOrder(f), ["members"]); assert.equal(f.membersHost.children[0], originalControl); await originalControl.click(); assert.equal(clicks, 2);
  await f.controller.open("files"); await f.host.querySelector('[data-open-tab="files"]').click();
  assert.deepEqual(tabOrder(f), ["members", "files"]); assert.equal(f.host.querySelector(".fw-new-tab-view").hidden, true); f.controller.destroy();
});

test("tab close picks the nearest survivor and Close other tabs includes utility tabs", async () => {
  const f = fixture(); await f.controller.open(); await f.treeItem("a.js").click(); await flush();
  await f.tab("files").click(); await f.treeItem("b.js").click(); await flush(); await f.controller.open("members");
  assert.deepEqual(tabOrder(f), ["files", "file-1", "file-2", "members"]);
  await closeTabButton(f, "file-2").click(); assert.equal(f.tab("members").getAttribute("aria-selected"), "true");
  await closeTabButton(f, "members").click(); assert.equal(f.tab("file-1").getAttribute("aria-selected"), "true");
  await tabMenuAction(f, "file-1", "Close other tabs"); assert.deepEqual(tabOrder(f), ["file-1"]);
  await f.host.querySelector(".fw-file-pane").querySelectorAll("button").find((node) => node.textContent === "Back to files").click();
  assert.deepEqual(tabOrder(f), ["file-1", "files"]); f.controller.destroy();
});

test("batch close is atomic when dirty confirmation is cancelled or accepted", async () => {
  let accepted = false; let confirmations = 0; const f = fixture({ confirm: () => { confirmations += 1; return accepted; } });
  await f.controller.open(); await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("dirty A");
  await f.tab("files").click(); await f.treeItem("b.js").click(); await flush(); f.editors.at(-1).change("dirty B");
  await tabMenuAction(f, "file-1", "Close all tabs");
  assert.deepEqual(tabOrder(f), ["files", "file-1", "file-2"]); assert.equal(f.controller.hasDirty(), true); assert.equal(confirmations, 1);
  accepted = true; await tabMenuAction(f, "file-1", "Close all tabs");
  assert.deepEqual(tabOrder(f), []); assert.equal(f.controller.hasDirty(), false); assert.equal(confirmations, 2); f.controller.destroy();
});

test("context and drag reorder preserve tab buffers and Close right follows the current order", async () => {
  const f = fixture(); await f.controller.open(); await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("retained A");
  await f.tab("files").click(); await f.treeItem("b.js").click(); await flush(); await f.controller.open("members");
  await tabMenuAction(f, "file-1", "Move tab right"); assert.deepEqual(tabOrder(f), ["files", "file-2", "file-1", "members"]);
  const dragged = f.host.querySelectorAll(".fw-tab-wrap").find((node) => node.dataset.tabId === "file-1");
  const target = f.host.querySelectorAll(".fw-tab-wrap").find((node) => node.dataset.tabId === "files");
  await dragged.fire("dragstart", { dataTransfer: { setData() {} } }); await target.fire("drop", { clientX: 0 });
  assert.deepEqual(tabOrder(f), ["file-1", "files", "file-2", "members"]);
  await f.tab("file-1").click(); await flush(); assert.equal(f.editors.at(-1).doc, "retained A");
  await tabMenuAction(f, "files", "Close tabs to the right"); assert.deepEqual(tabOrder(f), ["file-1", "files"]); assert.equal(f.controller.hasDirty(), true); f.controller.destroy();
});

test("a pending batch-close confirmation cannot close a new account's tabs", async () => {
  const answer = deferred(); const f = fixture({ confirm: () => answer.promise }); await f.controller.open();
  await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("private old draft");
  const pending = tabMenuAction(f, "file-1", "Close all tabs"); await flush();
  f.setContext({ ...f.getContext(), projectId: "project-b", userId: "bob" }); await f.controller.updateContext();
  await f.controller.open("members"); answer.resolve(true); await pending; await flush();
  assert.deepEqual(tabOrder(f), ["files", "members"]); assert.equal(f.controller.hasDirty(), false); assert.equal(f.host.textContent.includes("private old draft"), false); f.controller.destroy();
});

test("edits made during a batch-close confirmation cancel the whole close operation", async () => {
  const answer = deferred(); const f = fixture({ confirm: () => answer.promise }); await f.controller.open();
  await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("first draft");
  const pending = tabMenuAction(f, "file-1", "Close all tabs"); await flush(); f.editors.at(-1).change("new edit during confirmation");
  answer.resolve(true); await pending; await flush(); assert.deepEqual(tabOrder(f), ["files", "file-1"]);
  assert.equal(f.controller.hasDirty(), true); assert.match(f.host.textContent, /Tabs changed while confirmation/u); f.controller.destroy();
});

test("workspace keyboard close is scoped to its own focus and supports function tabs", async () => {
  const f = fixture(); await f.controller.open(); let prevented = false;
  const workspace = f.host.querySelector(".file-workspace"); f.document.activeElement = f.document.createElement("input");
  await workspace.fire("keydown", { key: "w", ctrlKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false); assert.deepEqual(tabOrder(f), ["files"]);
  f.tab("files").focus(); await workspace.fire("keydown", { key: "w", metaKey: true, preventDefault() { prevented = true; } }); await flush();
  assert.equal(prevented, true); assert.deepEqual(tabOrder(f), []); assert.equal(f.host.querySelector(".fw-new-tab-view").hidden, false);
  prevented = false; await workspace.fire("keydown", { key: "w", metaKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, "an empty workspace leaves the browser close shortcut available");
  await f.controller.open("members"); await f.tab("members").fire("keydown", { key: "Delete" }); assert.deepEqual(tabOrder(f), []); f.controller.destroy();
});

test("tab arrows and background-close controls restore focus to the tablist", async () => {
  const f = fixture(); await f.controller.open(); await f.treeItem("a.js").click(); await flush(); await f.controller.open("members");
  f.tab("members").focus(); await f.tab("members").fire("keydown", { key: "ArrowLeft" });
  assert.equal(f.document.activeElement.dataset.tab, "file-1"); assert.equal(f.tab("file-1").getAttribute("aria-selected"), "true");
  const dismiss = closeTabButton(f, "members"); dismiss.focus(); await dismiss.click();
  assert.equal(f.document.activeElement.dataset.tab, "file-1"); assert.deepEqual(tabOrder(f), ["files", "file-1"]); f.controller.destroy();
});

test("the open-tabs picker reveals an offscreen active tab using only horizontal tab scrolling", async () => {
  const f = fixture(); await f.controller.open(); await f.treeItem("a.js").click(); await flush();
  await f.tab("files").click(); await f.treeItem("b.js").click(); await flush();
  const strip = f.host.querySelector(".fw-tabs"); strip.scrollLeft = 0;
  f.document.rectFor = (node) => {
    if (node === strip) return { left: 0, right: 120, top: 0, bottom: 40, width: 120, height: 40 };
    if (node.className?.split(" ").includes("fw-tab-wrap")) {
      const left = tabOrder(f).indexOf(node.dataset.tabId) * 100 - strip.scrollLeft;
      return { left, right: left + 100, top: 0, bottom: 40, width: 100, height: 40 };
    }
    return { left: 0, right: 480, top: 0, bottom: 600, width: 480, height: 600 };
  };
  await f.host.querySelector('[data-select-tab="file-2"]').click(); await flush();
  assert.equal(strip.scrollLeft, 180); assert.equal(f.document.activeElement.dataset.tab, "file-2");
  strip.scrollLeft = 0; f.editors.at(-1).change("editing does not move the tab strip");
  assert.equal(strip.scrollLeft, 0, "draft updates preserve a manually scrolled tab strip");
  await f.host.querySelector('[data-select-tab="files"]').click(); await flush(); assert.equal(strip.scrollLeft, 0); f.controller.destroy();
});

test("keyboard context close of a background tab restores focus to the surviving active tab", async () => {
  const f = fixture(); await f.controller.open(); await f.treeItem("a.js").click(); await flush(); await f.controller.open("members");
  f.tab("file-1").focus(); await f.tab("file-1").fire("keydown", { key: "F10", shiftKey: true });
  const close = f.host.querySelector(".fw-tab-menu").querySelectorAll("button").find((node) => node.textContent === "Close tab");
  close.focus(); await close.click(); await flush();
  assert.deepEqual(tabOrder(f), ["files", "members"]); assert.equal(f.document.activeElement.dataset.tab, "members"); f.controller.destroy();
});

test("workspace opening, expansion and configuration use explicit integration callbacks", async () => {
  let opened = 0; let expanded = false; let configured;
  const f = fixture({ onOpen: () => { opened += 1; }, onExpand: () => { expanded = !expanded; }, isExpanded: () => expanded,
    onConfigure: (provider) => { configured = provider; }, api: { async getFileBranches() { throw Object.assign(new Error("disabled"), { code: "code_sync_disabled" }); } },
  });
  await f.controller.open(); assert.equal(opened, 1);
  const expand = f.host.querySelectorAll("button").find((node) => node.getAttribute("aria-label") === "Expand workspace");
  await expand.click(); assert.equal(expanded, true); assert.equal(expand.getAttribute("aria-label"), "Restore workspace");
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Configure file sharing").click(); assert.equal(configured, "gt-cloud");
  f.controller.destroy();
});

test("the panel toolbar has only New tab and Workspace menu controls", async () => {
  const f = fixture({ onExpand() {} }); await f.controller.show();
  const top = f.host.querySelector(".fw-topbar");
  assert.deepEqual(top.children.map((node) => node.className), ["fw-tabs", "fw-new-tab-picker", "fw-tabs-picker"]);
  assert.equal(top.querySelector(".fw-expand"), null); assert.equal(top.querySelector(".fw-close"), null);
  assert.equal(top.querySelector(".fw-new-tab").getAttribute("aria-label"), "New tab");
  assert.equal(top.querySelector(".fw-tabs-list").getAttribute("aria-label"), "Workspace menu");
  assert.equal(top.querySelector(".fw-tabs-list").textContent, "…"); assert.ok(f.treeItem("a.js")); f.controller.destroy();
});

test("collapse and show preserve the active editor, unsaved draft and zero-tab state", async () => {
  let opened = 0; let collapsed = 0;
  const f = fixture({ onOpen: () => { opened += 1; }, onClose: () => { collapsed += 1; } }); await f.controller.open();
  await f.treeItem("a.js").click(); await flush(); const editor = f.editors.at(-1); editor.change("unsaved visible after reopening");
  f.controller.close(); assert.equal(collapsed, 1); assert.equal(editor.destroyed, false);
  await f.controller.show(); assert.equal(opened, 2); assert.equal(f.editors.at(-1), editor);
  assert.equal(f.tab("file-1").getAttribute("aria-selected"), "true"); assert.equal(f.controller.hasDirty(), true);
  assert.deepEqual(tabOrder(f), ["files", "file-1"]); assert.equal(f.calls.filter(([kind]) => kind === "content").length, 1);
  await f.controller.open("members"); f.controller.close(); await f.controller.show();
  assert.equal(f.tab("members").getAttribute("aria-selected"), "true"); assert.equal(f.controller.hasDirty(), true);
  await tabMenuAction(f, "members", "Close all tabs"); assert.deepEqual(tabOrder(f), []);
  f.controller.close(); await f.controller.show(); assert.deepEqual(tabOrder(f), []);
  assert.equal(f.host.querySelector(".fw-new-tab-view").hidden, false); f.controller.destroy();
});

test("Workspace menu exposes localized expand, restore and collapse commands", async () => {
  let locale = "en"; let expanded = false; let collapsed = 0;
  const f = fixture({ t: (text) => locale === "zh-CN" ? WORKSPACE_FILES_ZH_CN[text] ?? text : text,
    onExpand: () => { expanded = !expanded; }, isExpanded: () => expanded, onClose: () => { collapsed += 1; },
  }); await f.controller.show();
  const summary = f.host.querySelector(".fw-tabs-list"); const picker = f.host.querySelector(".fw-tabs-picker"); picker.open = true;
  let expand = f.host.querySelector(".fw-expand-command"); assert.equal(expand.getAttribute("aria-label"), "Expand workspace");
  await expand.click(); assert.equal(expanded, true); assert.equal(picker.open, false); assert.equal(f.document.activeElement, summary);
  assert.equal(expand.getAttribute("aria-label"), "Restore workspace"); assert.equal(expand.getAttribute("aria-expanded"), "true");
  locale = "zh-CN"; f.controller.refreshLanguage(); assert.equal(summary.getAttribute("aria-label"), "工作区菜单");
  expand = f.host.querySelector(".fw-expand-command"); assert.equal(expand.textContent, "还原工作区");
  await expand.click(); assert.equal(expanded, false); assert.equal(expand.textContent, "展开工作区");
  const collapse = f.host.querySelector(".fw-collapse-command"); assert.equal(collapse.getAttribute("aria-label"), "收起工作区");
  await collapse.click(); assert.equal(collapsed, 1); assert.deepEqual(tabOrder(f), ["files"]); f.controller.destroy();
});

test("a later collapse fences an unfinished show without reopening the workspace", async () => {
  let opened = 0; const f = fixture({ onOpen: () => { opened += 1; } });
  const showing = f.controller.show(); f.controller.close(); await showing; assert.equal(opened, 0);
  await f.controller.show(); assert.equal(opened, 1); assert.deepEqual(tabOrder(f), ["files"]); f.controller.destroy();
});

test("show reasserts presentation after an external layout hide without rebuilding the editor", async () => {
  let layoutVisible = false; let shown = 0;
  const f = fixture({ onOpen: () => { layoutVisible = true; shown += 1; } }); await f.controller.show();
  await f.treeItem("a.js").click(); await flush(); const editor = f.editors.at(-1); editor.change("retained after a breakpoint hide");
  layoutVisible = false; // A breakpoint may hide the host without calling close().
  await f.controller.show(); assert.equal(layoutVisible, true); assert.equal(shown, 2);
  assert.equal(f.editors.at(-1), editor); assert.equal(editor.destroyed, false);
  assert.equal(f.tab("file-1").getAttribute("aria-selected"), "true"); assert.equal(f.controller.hasDirty(), true); f.controller.destroy();
});

test("tab changes retain unsaved buffers; a dirty tab cannot close without consent", async () => {
  const f = fixture({ confirm: () => false }); await f.controller.open(); await f.treeItem("a.js").click(); await flush();
  f.editors.at(-1).change("draft a"); assert.equal(f.controller.hasDirty(), true);
  await f.tab("files").click(); await f.treeItem("b.js").click(); await flush();
  await f.tab("file-1").click(); await flush(); assert.equal(f.editors.at(-1).doc, "draft a");
  const dismiss = f.host.querySelectorAll("button").find((node) => node.getAttribute("aria-label") === "Close file: a.js"); await dismiss.click(); await flush();
  assert.ok(f.tab("file-1")); assert.equal(await f.controller.confirmLeave(), false); f.controller.destroy();
});

test("Markdown switches between editable source and sanitized rendered unsaved content", async () => {
  const initial = "# README\n\nOriginal"; const rendered = [];
  const f = fixture({ renderMarkdown(source) {
    const node = f.document.createElement("div"); node.nodeType = 1; node.innerHTML = markdownToSafeHtml(source); rendered.push(node); return node;
  }, api: {
    async getFileTree() { return { commit: "a".repeat(40), can_write: true, entries: [{ path: "README.md", size: initial.length }] }; },
    async getFileContent() { return { commit: "a".repeat(40), content_base64: textToBase64(initial), size: initial.length }; },
  } });
  await f.controller.open(); await f.treeItem("README.md").click(); await flush();
  const preview = f.host.querySelector(".fw-markdown"); assert.equal(preview.children[0], rendered.at(-1));
  assert.match(rendered.at(-1).innerHTML, /<h1>README<\/h1>/u); assert.equal(preview.dataset.i18nSkip, "");
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Code").click(); await flush();
  assert.equal(f.editors.at(-1).doc, initial);
  const draft = "# Unsaved\n\n<script>evil()</script>\n\n[bad](javascript:evil())";
  f.editors.at(-1).change(draft);
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Preview").click(); await flush();
  assert.match(rendered.at(-1).innerHTML, /<h1>Unsaved<\/h1>/u); assert.doesNotMatch(rendered.at(-1).innerHTML, /<script|href="javascript:/iu);
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Code").click(); await flush();
  assert.equal(f.editors.at(-1).doc, draft); assert.equal(f.controller.hasDirty(), true);
  assert.equal(f.host.querySelector(".fw-content").dataset.i18nSkip, ""); f.controller.destroy();
});

test("declining branch navigation preserves the branch and its dirty file", async () => {
  const f = fixture({ confirm: () => false }); await f.controller.open(); await f.treeItem("a.js").click(); await flush();
  f.editors.at(-1).change("stay on my branch"); await f.tab("files").click();
  const branch = f.host.querySelector(".fw-branch-select"); branch.value = "main"; await branch.fire("change"); await flush();
  assert.equal(branch.value, "own"); assert.equal(f.controller.hasDirty(), true); assert.ok(f.tab("file-1"));
  await f.tab("file-1").click(); await flush(); assert.equal(f.editors.at(-1).doc, "stay on my branch"); f.controller.destroy();
});

test("late content cannot repopulate a different account or project", async () => {
  const delayed = deferred(); const f = fixture({ api: { getFileContent: () => delayed.promise } });
  await f.controller.open(); await f.treeItem("a.js").click();
  f.setContext({ scope: "origin", userId: "bob", projectId: "project-b", canWrite: false }); await f.controller.updateContext();
  delayed.resolve({ commit: "a".repeat(40), content_base64: textToBase64("private old text"), size: 16 }); await flush();
  assert.equal(f.editors.length, 0); assert.equal(f.host.textContent.includes("private old text"), false); assert.equal(f.controller.hasDirty(), false); f.controller.destroy();
});

test("a delayed path prompt cannot dispatch its operation into a newly selected project", async () => {
  const answer = deferred(); const f = fixture({ prompt: () => answer.promise }); await f.controller.open();
  const create = f.host.querySelectorAll("button").find((node) => node.textContent === "New file");
  const interaction = create.click(); await flush();
  f.setContext({ ...f.getContext(), projectId: "project-b" }); await f.controller.updateContext();
  answer.resolve("old-project-file.js"); await interaction; await flush();
  assert.equal(f.calls.filter(([kind]) => kind === "mutate").length, 0); f.controller.destroy();
});

test("unknown mutation outcomes retain the exact original body and key for explicit retry", async () => {
  let attempts = 0; const writes = [];
  const f = fixture({ api: { async mutateFiles(_project, input) { writes.push(input); if (++attempts === 1) throw new Error("network"); return { branch_id: "own", commit: "b".repeat(40) }; } } });
  await f.controller.open(); await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("changed");
  await f.host.querySelector("[data-save-for]").click(); await flush(); assert.equal(f.controller.hasDirty(), true); assert.equal(writes.length, 1);
  const retry = f.host.querySelectorAll("button").find((node) => node.textContent === "Retry operation"); assert.ok(retry); await retry.click(); await flush();
  assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]); assert.equal(writes[1].idempotency_key, "stable-operation-key"); assert.equal(f.controller.hasDirty(), false); f.controller.destroy();
});

test("head conflicts keep the buffer, block further saves, and do not retry automatically", async () => {
  let writes = 0; const f = fixture({ confirm: () => false, api: { async mutateFiles() { writes += 1; throw Object.assign(new Error("changed"), { status: 409 }); } } });
  await f.controller.open(); await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("must survive");
  await f.host.querySelector("[data-save-for]").click(); await flush();
  assert.equal(writes, 1); assert.equal(f.controller.hasDirty(), true); assert.equal(f.host.querySelector("[data-save-for]").disabled, true);
  assert.match(f.host.textContent, /Your edits are kept/u); await f.tab("files").click(); await f.tab("file-1").click(); await flush();
  assert.equal(f.editors.at(-1).doc, "must survive"); assert.equal(f.editors.at(-1).readOnly, true); f.controller.destroy();
});

test("refreshing the tree after another tab saves cannot rebase a stale buffer over native edits", async () => {
  const initial = "a".repeat(40), savedA = "b".repeat(40), native = "c".repeat(40);
  let head = initial; let serverB = "b.js"; const writes = [];
  const f = fixture({ api: {
    async getFileTree() { return { commit: head, can_write: true, entries: [{ path: "a.js", size: 4 }, { path: "b.js", size: serverB.length }] }; },
    async getFileContent(_project, { path }) { const content = path === "b.js" ? serverB : "a.js"; return { commit: head, content_base64: textToBase64(content), size: content.length }; },
    async mutateFiles(_project, input) {
      writes.push(input);
      if (input.base_commit !== head) throw Object.assign(new Error("head changed"), { status: 409 });
      // The accepted A save is followed by an independent native edit to B
      // before the UI's post-save tree read returns.
      if (input.operations[0].path === "a.js") { head = native; serverB = "native B"; return { branch_id: "own", commit: savedA }; }
      serverB = "overwritten"; return { branch_id: "own", commit: "d".repeat(40) };
    },
  } });
  await f.controller.open(); await f.treeItem("b.js").click(); await flush();
  f.editors.at(-1).change("draft B from H1");
  await f.tab("files").click(); await f.treeItem("a.js").click(); await flush();
  f.editors.at(-1).change("edited A"); await f.host.querySelector("[data-save-for]").click(); await flush();
  await f.tab("file-1").click(); await flush(); assert.equal(f.editors.at(-1).doc, "draft B from H1");
  await f.host.querySelector("[data-save-for]").click(); await flush();
  assert.equal(writes.length, 2); assert.equal(writes[0].base_commit, initial); assert.equal(writes[1].base_commit, initial);
  assert.equal(serverB, "native B"); assert.equal(f.controller.hasDirty(), true); assert.match(f.host.textContent, /Your edits are kept/u);
  assert.equal(f.host.querySelector("[data-save-for]").disabled, true); f.controller.destroy();
});

test("a same-commit GitHub repository rebind blocks old buffers and preserves their pinned revision", async () => {
  const commit = "a".repeat(40); let revision = "repository-one"; const writes = [];
  const f = fixture({ api: {
    async getFileTree() { return { commit, connection_revision: revision, can_write: true, entries: [{ path: "a.js", size: 4 }, { path: "b.js", size: 4 }] }; },
    async getFileContent(_project, { path }) { return { commit, connection_revision: revision, content_base64: textToBase64(path), size: path.length }; },
    async mutateFiles(_project, input) {
      writes.push(input);
      if (input.connection_revision !== revision) throw Object.assign(new Error("binding changed"), { status: 409 });
      revision = "repository-two"; return { branch_id: "own", commit, connection_revision: "repository-one" };
    },
  } });
  await f.controller.open();
  const storage = f.host.querySelectorAll("select").find((node) => node.getAttribute("aria-label") === "Storage"); storage.value = "github"; await storage.fire("change"); await flush();
  await f.treeItem("b.js").click(); await flush(); f.editors.at(-1).change("draft from first repository");
  await f.tab("files").click(); await f.host.querySelectorAll("button").find((node) => node.textContent === "Copy").click();
  await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("first save");
  await f.host.querySelector("[data-save-for]").click(); await flush();
  await f.tab("file-1").click(); await flush(); await f.host.querySelector("[data-save-for]").click(); await flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].base_commit, commit);
  assert.equal(writes[0].connection_revision, "repository-one"); assert.equal(f.controller.hasDirty(), true);
  assert.equal(f.host.querySelector("[data-save-for]").disabled, true);
  assert.match(f.host.textContent, /Your edits are kept/u);
  await f.tab("files").click(); assert.equal(f.host.querySelectorAll("button").find((node) => node.textContent === "Paste").disabled, true); f.controller.destroy();
});

test("oversized imports fail locally without queuing an uncertain mutation", async () => {
  let read = false; const f = fixture(); await f.controller.open();
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Import files").click();
  const picker = f.host.querySelectorAll("input").find((node) => node.type === "file");
  picker.files = [{ name: "too-big.bin", size: 2 * 1024 * 1024 + 1, async arrayBuffer() { read = true; return new ArrayBuffer(0); } }];
  await picker.fire("change"); await flush();
  assert.equal(read, false); assert.equal(f.calls.some(([kind]) => kind === "mutate"), false);
  assert.match(f.host.textContent, /GT Cloud files must be 2 MiB or smaller/u);
  assert.equal(f.host.querySelectorAll("button").some((node) => node.textContent === "Retry operation"), false);
  assert.equal(f.host.querySelectorAll("select").find((node) => node.getAttribute("aria-label") === "Storage").disabled, false); f.controller.destroy();
});

test("the isolated example previews only sniffed raster images as data URLs", async () => {
  const f = fixture({ exampleMode: true, api: {
    async getFileTree() { return { commit: "a".repeat(40), can_write: true, entries: [{ path: "image.png", size: 8 }] }; },
    async getFileContent() { return { commit: "a".repeat(40), content_base64: "iVBORw0KGgo=", size: 8 }; },
  } });
  let blobs = 0; f.window.URL.createObjectURL = () => { blobs += 1; return "blob:unexpected"; };
  await f.controller.open(); await f.treeItem("image.png").click(); await flush();
  assert.equal(f.host.querySelector("img").src, "data:image/png;base64,iVBORw0KGgo="); assert.equal(blobs, 0); f.controller.destroy();
});

test("initial commit history compares additions against an empty tree", async () => {
  const root = "a".repeat(40); const diffs = [];
  const f = fixture({ diffFactory: async (input) => { diffs.push(input); return { destroy() {} }; }, api: {
    async getFileHistory() { return { commits: [{ id: root, parent_ids: [], message: "Initial", author_name: "Alice", created_at: "2026-10-18T00:00:00.000Z" }] }; },
    async getFileChanges(_project, input) { assert.equal(Object.hasOwn(input, "base_commit"), false); return { base_commit: null, commit: root, files: [{ path: "a.js", status: "added" }] }; },
  } });
  await f.controller.open(); await f.treeItem("a.js").click(); await flush();
  await f.host.querySelector(".fw-file-pane").querySelectorAll("button").find((node) => node.textContent === "History").click(); await flush();
  await f.host.querySelectorAll("button").find((node) => node.textContent === "View changes").click(); await flush();
  assert.match(f.host.textContent, /Empty tree → aaaaaaaa/u);
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Added · a.js").click(); await flush();
  assert.equal(diffs.at(-1).before, ""); assert.equal(diffs.at(-1).after, "a.js"); f.controller.destroy();
});

test("historical Load more preserves the selected commit across every history page", async () => {
  const commit = "a".repeat(40); const cursor = "b".repeat(40); const historyReads = [];
  const f = fixture({ api: { async getFileHistory(_project, input) {
    historyReads.push(input);
    return { commits: input.cursor ? [] : [{ id: commit, parent_ids: [], message: "Pinned history", author_name: "Alice", created_at: "2026-10-18T00:00:00.000Z" }],
      ...(input.commit && !input.cursor ? { next_cursor: cursor } : {}) };
  } } });
  await f.controller.open(); await f.treeItem("a.js").click(); await flush();
  await f.host.querySelector(".fw-file-pane").querySelectorAll("button").find((node) => node.textContent === "History").click(); await flush();
  await f.host.querySelectorAll("button").find((node) => node.textContent === "View version").click(); await flush();
  await f.host.querySelector(".fw-file-pane").querySelectorAll("button").find((node) => node.textContent === "History").click(); await flush();
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Load more").click(); await flush();
  assert.equal(historyReads.at(-1).cursor, cursor); assert.equal(historyReads.at(-1).commit, commit); f.controller.destroy();
});

test("a deleted historical file opens a red deletion diff without requesting a missing after blob", async () => {
  const before = "a".repeat(40), deleted = "b".repeat(40); const diffs = []; const contentReads = [];
  const f = fixture({ diffFactory: async (input) => { diffs.push(input); return { destroy() {} }; }, api: {
    async getFileHistory() { return { commits: [{ id: deleted, parent_ids: [before], message: "Delete b", author_name: "Alice", created_at: "2026-10-18T00:00:00.000Z" }] }; },
    async getFileChanges() { return { base_commit: before, commit: deleted, files: [{ path: "b.js", status: "deleted" }] }; },
    async getFileContent(_project, input) {
      contentReads.push(input); if (input.path === "b.js" && input.commit !== before) throw new Error("after blob does not exist");
      const text = input.path === "b.js" ? "deleted source" : "a.js"; return { commit: input.commit ?? deleted, content_base64: textToBase64(text), size: text.length };
    },
  } });
  await f.controller.open(); await f.treeItem("a.js").click(); await flush();
  await f.host.querySelector(".fw-file-pane").querySelectorAll("button").find((node) => node.textContent === "History").click(); await flush();
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Compare with parent").click(); await flush();
  await f.host.querySelectorAll("button").find((node) => node.textContent === "Deleted · b.js").click(); await flush();
  assert.equal(diffs.at(-1).before, "deleted source"); assert.equal(diffs.at(-1).after, "");
  assert.deepEqual(contentReads.filter((input) => input.path === "b.js").map((input) => input.commit), [before]);
  assert.equal(f.controller.hasDirty(), false); f.controller.destroy();
});

test("whole-branch History discovers deleted paths absent from the current file tree", async () => {
  const parent = "b".repeat(40), commit = "a".repeat(40); const historyReads = []; const diffs = [];
  const f = fixture({ diffFactory: async (input) => { diffs.push(input); return { destroy() {} }; }, api: {
    async getFileTree() { return { commit, can_write: false, entries: [{ path: "a.js", size: 4 }] }; },
    async getFileHistory(_project, input) { historyReads.push(input); return { commits: [{ id: commit, parent_ids: [parent], message: "Remove old file", author_name: "Alice", created_at: "2026-10-18T00:00:00.000Z" }] }; },
    async getFileChanges() { return { base_commit: parent, commit, files: [{ path: "gone.js", status: "deleted" }] }; },
    async getFileContent(_project, input) { assert.equal(input.commit, parent); return { commit: parent, content_base64: textToBase64("old code"), size: 8 }; },
  } });
  await f.controller.open(); const branch = f.host.querySelector(".fw-branch-select"); branch.value = "main"; await branch.fire("change"); await flush();
  assert.equal(f.treeItem("gone.js"), undefined);
  await f.host.querySelector('[data-explorer-view="history"]').click(); await flush();
  assert.equal(Object.hasOwn(historyReads.at(-1), "path"), false); assert.equal(historyReads.at(-1).commit, commit); assert.equal(historyReads.at(-1).branch_id, "main");
  await f.host.querySelector(".fw-repository-review").querySelectorAll("button").find((node) => node.textContent === "View changes").click(); await flush();
  await f.host.querySelector(".fw-repository-review").querySelectorAll("button").find((node) => node.textContent === "Deleted · gone.js").click(); await flush();
  assert.equal(diffs.at(-1).before, "old code"); assert.equal(diffs.at(-1).after, "");
  assert.equal(f.host.querySelector(".fw-file-pane").querySelector("[data-save-for]"), null); f.controller.destroy();
});

test("explorer Changes compares the latest saved commit and keeps independent dirty drafts", async () => {
  const commit = "a".repeat(40), parent = "b".repeat(40); const changesReads = []; const diffs = [];
  const f = fixture({ diffFactory: async (input) => { diffs.push(input); return { destroy() {} }; }, api: {
    async getFileChanges(_project, input) { changesReads.push(input); return { base_commit: parent, commit, files: [{ path: "a.js", status: "modified" }] }; },
    async getFileContent(_project, input) { const text = input.commit === parent ? "before saved change" : "saved source"; return { commit: input.commit ?? commit, content_base64: textToBase64(text), size: text.length }; },
  } });
  await f.controller.open(); await f.treeItem("a.js").click(); await flush(); f.editors.at(-1).change("unsaved draft stays here");
  await f.tab("files").click(); await f.host.querySelector('[data-explorer-view="changes"]').click(); await flush();
  assert.match(f.host.textContent, /Latest saved changes · aaaaaaaa/u);
  assert.equal(changesReads.at(-1).commit, commit); assert.equal(Object.hasOwn(changesReads.at(-1), "base_commit"), false);
  await f.host.querySelector(".fw-repository-review").querySelectorAll("button").find((node) => node.textContent === "Modified · a.js").click(); await flush();
  assert.equal(diffs.at(-1).before, "before saved change"); assert.equal(diffs.at(-1).after, "saved source");
  await f.tab("file-1").click(); await flush(); assert.equal(f.editors.at(-1).doc, "unsaved draft stays here"); assert.equal(f.controller.hasDirty(), true); f.controller.destroy();
});

test("late repository-history responses cannot replace a new explorer view or project", async () => {
  const viewRead = deferred(), scopeRead = deferred(); let attempts = 0;
  const f = fixture({ api: { getFileHistory: () => (++attempts === 1 ? viewRead.promise : scopeRead.promise) } });
  const reply = { commits: [{ id: "a".repeat(40), parent_ids: [], message: "private stale history", author_name: "Alice", created_at: "2026-10-18T00:00:00.000Z" }] };
  await f.controller.open(); await f.host.querySelector('[data-explorer-view="history"]').click(); await flush();
  await f.host.querySelector('[data-explorer-view="files"]').click(); viewRead.resolve(reply); await flush();
  assert.equal(f.host.textContent.includes("private stale history"), false); assert.ok(f.treeItem("a.js"));
  await f.host.querySelector('[data-explorer-view="history"]').click(); await flush();
  f.setContext({ ...f.getContext(), projectId: "different-project", userId: "bob" }); await f.controller.updateContext();
  scopeRead.resolve(reply); await flush(); assert.equal(f.host.textContent.includes("private stale history"), false); f.controller.destroy();
});
