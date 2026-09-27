import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { Script } from "node:vm";

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
    access(new URL("app/example.html", dist)),
    access(new URL("app/src/onboarding.js", dist)),
    access(new URL("app/licenses/driver.js.txt", dist)),
    access(new URL("app/src/styles.css", dist)),
    access(new URL("app/brand/lockup-color-transparent-light.svg", dist)),
  ]);
});

test("isolated example uses a classic bundle and forbids backend connections", async () => {
  const example = await readFile(new URL("app/example.html", dist), "utf8");
  assert.match(example, /connect-src 'none'/u);
  assert.match(example, /form-action 'none'/u);
  assert.match(example, /<script nonce="gatherthread-example-v1">/u);
  assert.match(example, /<style>/u);
  assert.doesNotMatch(example, /<(?:script|img)[^>]*src="\.\//u);
  assert.doesNotMatch(example, /<script type="module"/u);
  const script = example.match(/<script nonce="gatherthread-example-v1">([\s\S]*?)<\/script>/u);
  assert.ok(script, 'self-contained example has one authored script');
  assert.doesNotThrow(() => new Script(script[1]), 'bundling preserves literal replacement characters');
});
