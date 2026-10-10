import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createGithubCodeSyncController, githubLinks } from "../src/github-code-sync.js";
import { codeRuntimeChoices } from "../src/code-sync.js";
import { fillRepositoryFields, bindRepositoryFields } from "../src/github-setup.js";
import { translateUiText } from "../src/i18n.js";

// Exercise Windows checkout line endings on every platform.
const source = (await readFile(new URL("../src/github-code-sync-view.js", import.meta.url), "utf8"))
  .replace(/\r?\n/gu, "\r\n").replace(/^import .*\r?\n/gmu, "").replace("export function", "function");
function node() {
  const listeners = new Map();
  return { value: "", textContent: "", hidden: false, disabled: false, dataset: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { return listeners.get(event.type)?.(event); },
    setAttribute() {}, replaceChildren(...children) { this.children = children; } };
}
for (const locale of ["en", "zh-CN"]) {
  test(`${locale} saved repository still requires a computer; changing settings can return to overview`, async () => {
    const nodes = new Map();
    const el = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
    const document = { getElementById: el, createElement: node };
    const connection = { repository: "team/project", base_branch: "main", enabled: true, revision: "fixture" };
    const api = { async getProjectGithub() { return { connection, can_configure: true, can_write: true, branch: "gatherthread/fixture/owner" }; } };
    const sandbox = vm.createContext({ createGithubCodeSyncController, githubLinks, codeRuntimeChoices,
      fillRepositoryFields, bindRepositoryFields });
    vm.runInContext(source, sandbox);
    const controller = sandbox.mountGithubCodeSync({ document, api,
      localizer: { t: text => translateUiText(text, locale) }, confirm: async () => true });
    controller.setContext({ project: { id: "project", role: "owner" }, sessionId: "session", userId: "owner", sessionWritable: true, runtimes: [], devices: [] });
    controller.open(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(el("github-code-device").hidden, false);
    assert.equal(el("github-code-form").hidden, true);
    assert.equal(el("github-code-status").textContent, translateUiText("Repository saved. Connect your computer to start syncing.", locale));
    assert.equal(el("github-code-auth").disabled, true);
    el("github-code-ready").dispatchEvent({ type: "click" });
    assert.equal(el("github-local-home").hidden, false);
    assert.equal(el("github-code-upload").disabled, true);
    assert.equal(el("github-code-back").hidden, true);
    el("github-code-edit").dispatchEvent({ type: "click" });
    assert.equal(el("github-code-form").hidden, false);
    assert.equal(el("github-code-owner").value, "team");
    assert.equal(el("github-code-name").value, "project");
    assert.equal(el("github-code-back").hidden, false);
    el("github-code-back").dispatchEvent({ type: "click" });
    assert.equal(el("github-local-home").hidden, false);
    assert.equal(el("github-code-form").hidden, true);
    controller.close();
  });
}
