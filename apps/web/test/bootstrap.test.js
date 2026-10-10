import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../src/bootstrap.js", import.meta.url), "utf8"))
  .replace(/await import\("\.\/main\.js\?[^"\n]+"\);/u, "await loadMain();");

for (const [language, label] of [["en", "Reload"], ["zh-CN", "重新加载"]]) {
  test(`module failure offers a safe ${language} reload without revealing login or error details`, async () => {
    const button = { addEventListener(type, callback) { this[type] = callback; } };
    const screen = { replaceChildren(child) { this.child = child; } };
    let reloads = 0;
    const document = { documentElement: { dataset: { bootState: "loading" } },
      getElementById(id) { assert.equal(id, "boot-screen"); return screen; }, createElement() { return button; } };
    const context = vm.createContext({ document, navigator: { language }, location: { reload() { reloads++; } },
      async loadMain() { throw new Error("Private transport detail must not be shown"); } });
    await vm.runInContext(`(async () => { ${source} })()`, context);
    assert.equal(document.documentElement.dataset.bootState, "failed");
    assert.equal(screen.child, button); assert.equal(button.textContent, label);
    assert.doesNotMatch(button.textContent, /Private/);
    button.click(); assert.equal(reloads, 1);
  });
}
