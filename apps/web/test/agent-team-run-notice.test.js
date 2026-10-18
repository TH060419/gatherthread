import test from "node:test";
import assert from "node:assert/strict";
import { mountTeamRunNotice } from "../src/agent-team-run-notice.js";

function fixture() {
  const node = () => ({ textContent: "", dataset: {}, hidden: false, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, handler) { this[type] = handler; } });
  const host = node(), message = node(), advice = node(), button = node();
  let notice = null, locale = "en", opened = 0, focused = 0;
  host.ownerDocument = { activeElement: null };
  const view = mountTeamRunNotice({ host, message, advice, button, getNotice: () => notice,
    openRecords: () => { opened++; }, t: text => locale === "zh" ? "查看运行记录" : text,
    fallbackFocus: { focus() { focused++; } } });
  return { host, message, advice, button, view, setNotice(value) { notice = value; },
    locale(value) { locale = value; }, opened: () => opened, focused: () => focused };
}

test("an interrupted Team is visible outside its dialog with an explicit records action", () => {
  const f = fixture(); f.view.update(); assert.equal(f.host.hidden, true);
  f.setNotice({ runId: "run-a", text: "执行模块：共享额度已用尽。", advice: "额度恢复后重新发起团队任务。" });
  f.locale("zh"); f.view.update();
  assert.equal(f.host.hidden, false); assert.equal(f.host.dataset.runId, "run-a");
  assert.equal(f.message.textContent, "执行模块：共享额度已用尽。");
  assert.equal(f.advice.hidden, false); assert.equal(f.advice.textContent, "额度恢复后重新发起团队任务。");
  assert.equal(f.button.textContent, "查看运行记录"); f.button.click(); assert.equal(f.opened(), 1);
});

test("scope clearing removes private diagnostic text and moves focus off the newly hidden action", () => {
  const f = fixture(); f.setNotice({ runId: "private-run-a", text: "Private module label", advice: "Synthetic private hint" }); f.view.update();
  f.host.ownerDocument.activeElement = f.button; f.setNotice(null); f.view.update();
  assert.equal(f.host.hidden, true); assert.equal(f.message.textContent, ""); assert.equal(f.advice.textContent, "");
  assert.equal(f.host.dataset.runId, undefined); assert.equal(f.focused(), 1);
});

test("polling unchanged feedback does not repeatedly rewrite the live region, and recovery replaces it safely", () => {
  const f = fixture(); let writes = 0, value = "";
  Object.defineProperty(f.message, "textContent", { get: () => value, set: next => { value = next; writes++; } });
  f.setNotice({ runId: "run-a", text: "<img src=x onerror=unsafe()> stopped", advice: "Inspect the module" });
  f.view.update(); f.view.update(); assert.equal(writes, 1); assert.equal(value, "<img src=x onerror=unsafe()> stopped");
  f.setNotice({ text: "Connection interrupted; current task state is unconfirmed." }); f.view.update();
  assert.equal(f.host.dataset.runId, undefined); assert.equal(f.advice.hidden, true); assert.equal(f.advice.textContent, "");
  assert.equal(writes, 2);
});
