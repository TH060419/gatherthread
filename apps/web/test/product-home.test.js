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
  assert.equal((html.match(/href="\.\/app\/"/gu) ?? []).length, 4);
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

test("product home uses the shared workspace language and follows changes from another tab", async () => {
  const app = await readFile(new URL("app.js", productRoot), "utf8");
  assert.match(app, /localStorage\.getItem\("gt-lang"\)/u);
  assert.match(app, /localStorage\.getItem\("gatherthread\.settings\.v1"\)/u);
  assert.match(app, /savedLanguage === "zh" \|\| savedLanguage === "en"/u);
  assert.match(app, /window\.addEventListener\("storage", function \(event\)/u);
  assert.match(app, /event\.key === "gt-lang"/u);
  assert.match(app, /applyLang\(event\.newValue, false, false\)/u);
});

test("product home labels the current invitation-only preview without claiming Unreleased features shipped in alpha.7", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
  ]);
  assert.match(html, /\[ ALPHA 预览版 · 邀请制测试 \]/u);
  assert.match(app, /\[ ALPHA PREVIEW · BY INVITATION \]/u);
  assert.doesNotMatch(html, /0\.1\.0-alpha\.7/u);
});

test("product home exposes canonical and bilingual social discovery metadata", async () => {
  const html = await readFile(new URL("index.html", productRoot), "utf8");
  assert.match(html, /<link rel="canonical" href="https:\/\/gatherthread\.cn\/">/u);
  assert.match(html, /<title>GatherThread 共序 \| 多人本地 AI Agent 协作工作区<\/title>/u);
  assert.match(html, /name="description" content="GatherThread 共序是面向多人和各自本地 AI Agent 的协作工作区/u);
  assert.match(html, /property="og:title" content="GatherThread 共序 \| Local AI Agent Collaboration"/u);
  assert.match(html, /property="og:description" content="Self-hostable collaboration for teams using local AI coding agents/u);
  assert.match(html, /property="og:url" content="https:\/\/gatherthread\.cn\/"/u);
  assert.match(html, /name="twitter:card" content="summary"/u);
});

test("product home and access Issue clearly explain public optional email delivery", async () => {
  const [html, app, issueTemplate] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
    readFile(new URL("../../../.github/ISSUE_TEMPLATE/test-access.yml", import.meta.url), "utf8"),
  ]);
  const issueLink = /https:\/\/github\.com\/TH060419\/gatherthread\/issues\/new\?template=test-access\.yml/gu;
  assert.ok((html.match(issueLink) ?? []).length >= 2);
  assert.match(html, /邮箱选填；若愿意公开，建议填写，方便获批后私下发送资格码/u);
  assert.match(html, /申请理由、希望测试的内容和了解渠道也可填写/u);
  assert.match(html, /若介意公开邮箱，可在获批后把 Issue 链接私信至 coolhezi@sjtu\.edu\.cn/u);
  assert.match(html, /维护者会在 Issue 回复审核结果，但不会公开资格码/u);
  assert.match(app, /Email is optional; if you're comfortable sharing it publicly, we recommend including it/u);
  assert.match(app, /share why you're applying, what you'd like to test, and how you heard about GatherThread/u);
  assert.match(app, /If you prefer not to publish your email, after approval privately email the Issue link to coolhezi@sjtu\.edu\.cn/u);
  assert.match(app, /maintainer will post the review decision on the Issue, but never the qualification code/u);
  assert.match(issueTemplate, /邮箱选填；若愿意公开，建议填写/u);
  assert.match(issueTemplate, /维护者会在此 Issue 回复审核结果，但不会公开发布资格码/u);
  assert.match(issueTemplate, /Email is optional; if you are comfortable sharing it publicly, we recommend including it/u);
  assert.match(issueTemplate, /the review result, but codes are never published in Issues/u);
  assert.doesNotMatch(html, /公开 Issue 中发送资格码、设备 Token 或个人信息/u);
  assert.doesNotMatch(app, /personal information in a public Issue/u);
  assert.match(app, /"connect\.c2\.link"/u);
  assert.doesNotMatch(html, /<form[^>]*test-access/u);
});

test("product home leads with the hosted server while keeping local Agents local", async () => {
  const html = await readFile(new URL("index.html", productRoot), "utf8");
  assert.match(html, /当前 Alpha 在 gatherthread\.cn 邀请制测试/u);
  assert.match(html, /你的 Agent 与工作目录仍留在自己的设备上/u);
  assert.match(html, /data-i18n="connect\.c3\.h3">连接本地 Agent/u);
  assert.doesNotMatch(html, /npm run connection:local/u);
});

test("product home ends with public contact and the gatherthread.cn ICP record", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("index.html", productRoot), "utf8"),
    readFile(new URL("app.js", productRoot), "utf8"),
    readFile(new URL("styles.css", productRoot), "utf8"),
  ]);
  const footer = html.slice(html.indexOf('<footer class="footer">'));

  assert.match(footer, /data-i18n="foot\.3">³ Alpha 测试资格通过公开 GitHub Issue 申请；邮箱选填，愿意公开时建议填写。请勿发布资格码、设备 Token、密码、密钥或私有代码。<\/p>/u);
  assert.doesNotMatch(footer, /公开 Issue 中发送资格码、设备 Token 或个人信息/u);
  assert.match(app, /Email is optional and recommended if you are comfortable sharing it publicly/u);
  assert.doesNotMatch(app, /personal information in a public Issue/u);
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
