import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const productRoot = new URL("../../../site/", import.meta.url);

test("product home enters the same-origin app and preserves operational deep links", async () => {
  const [html, boot, app] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("boot.js", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
  ]);

  assert.match(html, /<script src="boot\.js"><\/script>/u);
  assert.doesNotMatch(html, /<script>(?:.|\n)*?<\/script>/u);
  assert.equal((html.match(/href="\.\/app\/"/gu) ?? []).length, 3);
  assert.match(html, /data-i18n="nav\.app">进入共序/u);
  assert.match(html, /data-i18n="hero\.cta1">开始使用/u);
  assert.match(html, /data-i18n="final\.cta1">打开登录页/u);
  assert.match(app, /"nav\.app":\s*\{ zh: "进入共序", en: "Open App" \}/u);

  for (const deepLink of ["project", "session", "dsh-pair"]) {
    assert.match(boot, new RegExp(`hash\\.has\\("${deepLink}"\\)`));
  }
  assert.match(boot, /current\.searchParams\.get\("mock"\) === "1"/u);
  assert.match(boot, /current\.searchParams\.has\("api"\)/u);
  assert.match(boot, /fragment === "main-content"/u);
  assert.match(boot, /fragment\.indexOf\("settings-"\) === 0/u);
  assert.match(boot, /new URL\("\.\/app\/", current\)/u);
  assert.match(boot, /application\.search = current\.search/u);
  assert.match(boot, /application\.hash = current\.hash/u);
  assert.match(boot, /window\.location\.replace\(application\.href\)/u);

  for (const [entry, expected] of [
    [
      "http://127.0.0.1:4173/?api=https%3A%2F%2Fowner.example%2Fv1#project=p1&session=s1",
      "http://127.0.0.1:4173/app/?api=https%3A%2F%2Fowner.example%2Fv1#project=p1&session=s1",
    ],
    [
      "http://127.0.0.1:4173/?mock=1#dsh-pair=ABCD-2345",
      "http://127.0.0.1:4173/app/?mock=1#dsh-pair=ABCD-2345",
    ],
    [
      "http://127.0.0.1:4173/#settings-agents",
      "http://127.0.0.1:4173/app/#settings-agents",
    ],
    [
      "http://127.0.0.1:4173/#main-content",
      "http://127.0.0.1:4173/app/#main-content",
    ],
  ]) {
    const replacements = [];
    runInNewContext(boot, {
      URL,
      URLSearchParams,
      window: {
        location: {
          href: entry,
          replace(value) { replacements.push(value); },
        },
      },
    });
    assert.deepEqual(replacements, [expected]);
  }
});

test("product home keeps required accessibility and reduced-effect paths", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("styles.css", productRoot), "utf8"),
  ]);

  assert.match(html, /aria-label="主导航"/u);
  assert.match(html, /data-i18n-aria="nav\.aria"/u);
  assert.match(html, /aria-label="Switch language \/ 切换语言"/u);
  assert.match(html, /<span class="line" data-split data-i18n="hero\.l1">/u);
  assert.doesNotMatch(html, /class="line gradient"/u);
  assert.match(styles, /\.hero-title\s*\{[\s\S]*?color:\s*var\(--text\)/u);
  assert.doesNotMatch(styles, /\.hero-title \.gradient \.char/u);
  assert.match(styles, /:focus-visible/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hero-eyebrow,[\s\S]*?\.hero-mark,[\s\S]*?\.page \.fx[\s\S]*?opacity:\s*1 !important/u);
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/u);
  assert.match(styles, /@media \(prefers-contrast: more\)[\s\S]*?--text-2:\s*#f5f5f7[\s\S]*?-webkit-backdrop-filter:\s*none/u);
  assert.match(styles, /@media \(forced-colors: active\)/u);
  assert.match(styles, /--text-3:\s*rgba\(29, 29, 31, 0\.66\)/u);
  assert.match(styles, /scroll-snap-type:\s*y proximity/u);
  assert.doesNotMatch(styles, /scroll-snap-type:\s*y mandatory/u);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.hero \{ padding: 112px 20px 64px; \}[\s\S]*?\.hero-title[\s\S]*?8\.2vw[\s\S]*?\.sec-grid \{ grid-template-columns: 1fr; \}/u);
  assert.match(styles, /@media \(max-width: 380px\)[\s\S]*?\.nav-inner[\s\S]*?padding:\s*0 12px[\s\S]*?\.nav-actions \{ gap: 8px; \}/u);
});

test("product home uses the application's bilingual session terminology", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
  ]);

  assert.match(html, /data-i18n="sessions\.solo\.h3">Solo · 个人会话/u);
  assert.match(html, /data-i18n="sessions\.multi\.h3">Multi · 协作会话/u);
  assert.match(app, /"sessions\.solo\.h3": \{ zh: "Solo · 个人会话", en: "Solo" \}/u);
  assert.match(app, /"sessions\.multi\.h3": \{ zh: "Multi · 协作会话", en: "Multi" \}/u);
});

test("product home release label matches the repository package version", async () => {
  const [html, app, packageSource] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
    readFile(new URL("../package.json", productRoot), "utf8"),
  ]);
  const version = JSON.parse(packageSource).version.toUpperCase();
  assert.match(html, new RegExp(`\\[ ${version.replaceAll(".", "\\.")} · ALPHA 预览版 \\]`, "u"));
  assert.match(app, new RegExp(`\\[ ${version.replaceAll(".", "\\.")} · ALPHA PREVIEW \\]`, "u"));
});

test("product home reports clipboard failures without false success", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
    readFile(new URL("styles.css", productRoot), "utf8"),
  ]);
  assert.match(html, /id="copyStatus" role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(styles, /\.sr-only\s*\{[\s\S]*?clip:\s*rect\(0, 0, 0, 0\)/u);
  assert.match(app, /"copy\.success": \{ zh: "命令已复制", en: "Command copied" \}/u);
  assert.match(app, /announceCopyStatus\(I18N\["copy\.success"\]\[lang\]\)/u);
  assert.match(app, /announceCopyStatus\(I18N\["copy\.failed"\]\[lang\]\)/u);
  assert.match(app, /writeText\(text\)\.then\(done, failed\)/u);
  assert.match(app, /if \(copied\) done\(\);\s*else failed\(\);/u);
  assert.doesNotMatch(app, /writeText\(text\)\.then\(done, done\)/u);
});

test("product home documents complete connection commands", async () => {
  const html = await readFile(new URL("index.html", productRoot), "utf8");
  assert.match(html, /npm run connection:local/u);
  assert.match(html, /npm run lan:start/u);
  assert.match(html, /npm run connection:tailscale -- --url https:\/\/host\.tailnet\.ts\.net/u);
});

test("product home ends with public contact and the gatherthread.cn ICP record", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
    readFile(new URL("styles.css", productRoot), "utf8"),
  ]);
  const footer = html.slice(html.indexOf('<footer class="footer">'));

  assert.match(footer, /data-i18n="foot\.contact">联系与反馈：/u);
  assert.match(footer, /href="https:\/\/github\.com\/TH060419\/gatherthread\/issues"[^>]*>GitHub Issues<\/a>/u);
  assert.match(footer, /data-i18n="foot\.icp">gatherthread\.cn 备案：/u);
  assert.match(footer, /href="https:\/\/beian\.miit\.gov\.cn\/"[^>]*>冀ICP备2026037466号-1<\/a>/u);
  assert.ok(footer.indexOf('data-i18n="foot.contact"') < footer.indexOf('data-i18n="foot.icp"'));
  assert.match(app, /"foot\.contact": \{ zh: "联系与反馈：", en: "Contact & feedback:" \}/u);
  assert.match(app, /"foot\.icp": \{ zh: "gatherthread\.cn 备案：", en: "gatherthread\.cn ICP filing:" \}/u);
  assert.match(styles, /\.footer \{ scroll-snap-align: end; \}/u);
});

test("product home reuses the canonical application lockups", async () => {
  const applicationBrand = new URL("../brand/", import.meta.url);
  for (const asset of ["lockup-color-transparent-light.svg", "lockup-color-transparent-dark.svg"]) {
    const [home, application] = await Promise.all([
      readFile(new URL(`assets/${asset}`, productRoot), "utf8"),
      readFile(new URL(asset, applicationBrand), "utf8"),
    ]);
    assert.equal(home, application);
  }
});
