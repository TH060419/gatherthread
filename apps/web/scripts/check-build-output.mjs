import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);

test("Web build publishes the product home above the existing application", async () => {
  const [home, application] = await Promise.all([
    readFile(new URL("index.html", dist), "utf8"),
    readFile(new URL("app/index.html", dist), "utf8"),
  ]);

  assert.match(home, /href="\.\/app\/"/u);
  assert.match(home, /<script src="boot\.js"><\/script>/u);
  assert.doesNotMatch(home, /id="login-form"/u);
  assert.match(application, /id="login-form"/u);
  assert.match(application, /id="workspace"/u);

  await Promise.all([
    access(new URL("boot.js", dist)),
    access(new URL("app.js", dist)),
    access(new URL("styles.css", dist)),
    access(new URL("assets/lockup-color-transparent-light.svg", dist)),
    access(new URL("app/src/main.js", dist)),
    access(new URL("app/src/styles.css", dist)),
    access(new URL("app/brand/lockup-color-transparent-light.svg", dist)),
  ]);
});
