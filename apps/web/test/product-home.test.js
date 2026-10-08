import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const productRoot = new URL("../../../site/", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const source = Promise.all(["index.html", "app.js", "styles.css", "boot.js"].map((name) =>
  readFile(new URL(name, productRoot), "utf8")));

// Inspect authored semantic markup, not a particular presentation class or order.
function elements(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gu"))].map((match) => {
    const attributes = {};
    for (const attribute of match[1].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/gu)) {
      attributes[attribute[1]] = (attribute[2] ?? attribute[3] ?? "").replaceAll("&amp;", "&");
    }
    return attributes;
  });
}

function authoredCopy(html, language) {
  return [...html.matchAll(new RegExp(`data-${language}="([^"]*)"`, "gu"))]
    .map((match) => match[1]).join("\n");
}

function mediaBlocks(css, condition) {
  const blocks = [];
  for (const match of css.matchAll(/@media\s*([^{}]+)\{/gu)) {
    if (!match[1].includes(condition)) continue;
    let depth = 1;
    let end = match.index + match[0].length;
    const start = end;
    while (depth && end < css.length) {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
      end++;
    }
    assert.equal(depth, 0, `Complete media block: ${condition}`);
    blocks.push(css.slice(start, end - 1));
  }
  assert.ok(blocks.length, `Media fallback: ${condition}`);
  return blocks.join("\n");
}

test("home names GatherThread and clearly presents people, devices and individually requested Agents", async () => {
  const [html] = await source;
  const headings = elements(html, "h1");
  assert.equal(headings.length, 1);
  assert.equal(headings[0]["data-zh"], "GatherThread，一起做项目。");
  assert.equal(headings[0]["data-en"], "GatherThread. Build together.");
  const zh = authoredCopy(html, "zh");
  const en = authoredCopy(html, "en");
  assert.match(zh, /多人、多端、多 Agent/u);
  assert.match(en, /people[\s\S]*screens[\s\S]*Agents/iu);
  assert.match(zh, /普通聊天不会启动 AI/u);
  assert.match(en, /chat message does not start AI/iu);
  assert.match(zh, /未来规划[\s\S]*自动分工[\s\S]*当前/u);
  assert.match(en, /Future plans[\s\S]*automatic collaboration[\s\S]*Today/iu);
});

test("home prominently links the source and leads computer setup with the Codex Launcher and DSH plugin", async () => {
  const [html] = await source;
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  const repository = elements(header, "a").find((link) => link.href === "https://github.com/TH060419/gatherthread");
  assert.ok(repository, "Repository entry in the main header");
  assert.equal(repository.target, "_blank");
  assert.ok(repository.rel.split(/\s+/u).includes("noopener"));
  assert.ok(repository.rel.split(/\s+/u).includes("noreferrer"));
  assert.match(authoredCopy(html, "zh"), /Codex 启动器.*DSH 插件/u);
  assert.match(authoredCopy(html, "en"), /Codex launcher.*DSH plugin/iu);
  for (const name of ["CODEX_CONNECT", "DSH_CONNECT"]) {
    for (const suffix of [".md", ".zh-CN.md"]) {
      assert.ok((await readFile(new URL(`docs/${name}${suffix}`, repositoryRoot), "utf8")).length);
    }
  }
});

test("product home enters the same-origin app and preserves operational deep links", async () => {
  const [html, , , boot] = await source;
  const links = elements(html, "a");
  assert.ok(links.some((link) => link.href === "./app/"));
  for (const link of links.filter((link) => /(?:\/app\/|\/privacy\/)/u.test(link.href ?? ""))) {
    assert.ok(link.href.startsWith("./"), `Stay on the selected server: ${link.href}`);
  }

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

test("home has usable same-origin examples and no-JavaScript chapter destinations", async () => {
  const [html, , , boot] = await source;
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "Unique control and destination IDs");
  for (const link of elements(html, "a")) {
    if (link.href?.startsWith("#")) assert.ok(ids.includes(link.href.slice(1)), `Destination: ${link.href}`);
    if (Object.hasOwn(link, "data-example")) {
      const destination = new URL(link.href, "https://self-host.example/");
      assert.equal(destination.origin, "https://self-host.example");
      assert.equal(destination.pathname, "/app/example.html");
      assert.equal(destination.searchParams.get("locale"), "zh-CN");
      assert.equal(destination.searchParams.get("topic"), "browse");
    }
  }
  for (const fragment of ["overview", "workflow", "devices", "files", "faq", "start"]) {
    const replacements = [];
    runInNewContext(boot, {
      URL, URLSearchParams,
      window: {
        location: { href: `https://self-host.example/#${fragment}`, replace: (value) => replacements.push(value) },
        matchMedia: () => ({ matches: true }),
      },
      document: { documentElement: { setAttribute() {} } },
      localStorage: { getItem: () => null },
      navigator: { userAgent: "Chromium" },
    });
    assert.deepEqual(replacements, [], `Product chapter stays on the home: ${fragment}`);
  }
});

test("home ships local scripts, styles and real bilingual product images without external execution", async () => {
  const [html, app] = await source;
  const scripts = elements(html, "script");
  assert.ok(scripts.some((script) => script.src === "boot.js"));
  assert.ok(scripts.some((script) => script.src === "app.js" && Object.hasOwn(script, "defer")));
  for (const script of scripts) {
    assert.ok(script.src && !/^(?:https?:)?\/\//u.test(script.src), "Only packaged local scripts");
    assert.ok((await readFile(new URL(script.src, productRoot))).length);
  }
  assert.doesNotMatch(html, /<script\b[^>]*>\s*[^<\s]/iu);
  assert.doesNotMatch(html, /\bon(?:click|load|error)\s*=/iu);
  assert.doesNotMatch(app, /\bfetch\s*\(|\bXMLHttpRequest\b|new\s+WebSocket\s*\(/u);
  for (const link of elements(html, "link").filter((link) => ["stylesheet", "icon"].includes(link.rel))) {
    assert.ok(!/^(?:https?:)?\/\//u.test(link.href), `Packaged resource: ${link.href}`);
    assert.ok((await readFile(new URL(link.href, productRoot))).length);
  }
  const images = elements(html, "img");
  assert.ok(images.some((image) => image["data-image"] === "desktop"));
  assert.ok(images.some((image) => image["data-image"] === "phone"));
  for (const image of images) {
    assert.ok(image.alt, `Useful image description: ${image.src}`);
    assert.ok(Number(image.width) > 0 && Number(image.height) > 0, "Reserve image dimensions");
    assert.ok(!/^(?:https?:)?\/\//u.test(image.src));
    assert.ok((await readFile(new URL(image.src, productRoot))).length);
    if (image["data-image"]) {
      assert.ok(image["data-alt-zh"] && image["data-alt-en"], "Bilingual screenshot descriptions");
      for (const language of ["zh-CN", "en"]) {
        const asset = new URL(`assets/product/${language}/${image["data-image"]}.jpg`, productRoot);
        const content = await readFile(asset);
        assert.equal(content.readUInt16BE(0), 0xffd8, `Valid JPEG resource: ${asset.pathname}`);
      }
    }
  }
});

test("published documentation links resolve to source files and bilingual guides", async () => {
  const [html, app] = await source;
  const root = "https://github.com/TH060419/gatherthread/blob/main/";
  const docs = elements(html, "a").filter((link) => link.href?.startsWith(root));
  assert.ok(docs.some((link) => link.href.endsWith("docs/CODE_SYNC.md")));
  assert.ok(docs.some((link) => link.href.endsWith("docs/SELF_HOSTING.md")));
  for (const link of docs) {
    assert.ok((await readFile(new URL(link.href.slice(root.length), repositoryRoot))).length, link.href);
  }
  for (const name of ["PRODUCT_GUIDE", "CODEX_CONNECT", "DSH_CONNECT"]) {
    assert.ok(app.includes(name), `Translated document target: ${name}`);
    for (const suffix of [".md", ".zh-CN.md"]) {
      assert.ok((await readFile(new URL(`docs/${name}${suffix}`, repositoryRoot))).length);
    }
  }
});

test("menu and workflow tabs expose complete semantic relationships", async () => {
  const [html] = await source;
  const buttons = elements(html, "button");
  const navigation = elements(html, "nav");
  const menu = buttons.find((button) => button["aria-controls"] === "navigation");
  assert.ok(menu?.["aria-label"]);
  assert.equal(menu.type, "button");
  assert.equal(menu["aria-expanded"], "false");
  assert.ok(navigation.some((nav) => nav.id === menu["aria-controls"] && nav["aria-label"]));
  const chapterLinks = elements(html, "a").filter((link) => "data-chapter-link" in link);
  assert.deepEqual(chapterLinks.map((link) => link.href), ["#together", "#workflow", "#devices", "#files", "#faq"]);
  assert.doesNotMatch(html, /class="chapter-nav"|aria-owns/u);
  assert.ok(elements(html, "div").some((element) => element.role === "tablist" && element["aria-label"]));
  const tabs = buttons.filter((button) => button.role === "tab");
  const panels = elements(html, "div").filter((element) => element.role === "tabpanel");
  assert.ok(tabs.length >= 3);
  assert.equal(tabs.length, panels.length);
  assert.equal(tabs.filter((tab) => tab["aria-selected"] === "true").length, 1);
  for (const tab of tabs) {
    assert.equal(tab.type, "button");
    const panel = panels.find((candidate) => candidate.id === tab["aria-controls"]);
    assert.ok(panel, `Panel for ${tab.id}`);
    assert.equal(panel["aria-labelledby"], tab.id);
    assert.equal(tab.tabindex, tab["aria-selected"] === "true" ? "0" : "-1");
    assert.equal(Object.hasOwn(panel, "hidden"), tab["aria-selected"] !== "true");
  }
  assert.ok(elements(html, "a").some((link) => link.href === "#main" && link["data-en"] === "Skip to content"));
});

test("home preserves native scrolling and readable reduced-effect fallbacks", async () => {
  const [, app, styles] = await source;
  assert.match(styles, /scroll-snap-type:\s*y proximity/u);
  assert.doesNotMatch(styles, /scroll-snap-type:\s*y mandatory/u);
  assert.doesNotMatch(app, /addEventListener\s*\(\s*['"](?:wheel|touchmove)['"]/u);
  assert.match(styles, /:focus-visible/u);
  const reducedMotion = mediaBlocks(styles, "prefers-reduced-motion");
  assert.match(reducedMotion, /scroll-snap-type:\s*none/u);
  assert.match(reducedMotion, /scroll-behavior:\s*auto/u);
  assert.match(reducedMotion, /opacity:\s*1/u);
  const transparency = mediaBlocks(styles, "prefers-reduced-transparency");
  assert.match(transparency, /backdrop-filter:\s*none/u);
  const contrast = mediaBlocks(styles, "prefers-contrast");
  assert.match(contrast, /backdrop-filter:\s*none/u);
  const forced = mediaBlocks(styles, "forced-colors");
  assert.match(forced, /CanvasText/u);
  assert.match(forced, /Highlight/u);
  assert.match(styles, /html:not\(\.glass-ready\)[^{]*\.story-panel\[hidden\]\s*\{[^}]*display:\s*grid/u);
});

test("home retains the shared cross-page language contract", async () => {
  const [html, app] = await source;
  const language = elements(html, "button").find((button) => button.id === "language");
  assert.ok(language?.["aria-label"]);
  assert.equal(language.type, "button");
  assert.match(app, /localStorage\.getItem\(['"]gt-lang['"]\)/u);
  assert.match(app, /localStorage\.setItem\(['"]gt-lang['"]/u);
  assert.match(app, /localStorage\.getItem\(['"]gatherthread\.settings\.v1['"]\)/u);
  assert.match(app, /addEventListener\(['"]storage['"]/u);
  assert.match(app, /event\.key\s*===\s*['"]gt-lang['"]/u);
  assert.match(app, /event\.newValue\s*,\s*false/u);
  for (const element of [...html.matchAll(/<[a-z][^>]*\bdata-zh="([^"]*)"[^>]*>/gu)]) {
    assert.match(element[0], /\bdata-en="[^"]+"/u, `English partner for ${element[1]}`);
  }
});

test("product copy explains current local execution, mobile requirements and pending cloud availability", async () => {
  const [html] = await source;
  const zh = authoredCopy(html, "zh");
  const en = authoredCopy(html, "en");
  assert.match(zh, /电脑和连接器.*在线/u);
  assert.match(en, /computer and its connector.*online/iu);
  assert.match(zh, /云端体验 Agent.*开放情况/u);
  assert.match(en, /cloud trial Agent.*(?:planned|availability)/iu);
  assert.match(zh, /自己已连接的 Codex\s*\/\s*DSH.*共享摘要/u);
  assert.match(en, /connected Codex\s*\/\s*DSH.*(?:shared summary|summarize)/iu);
  assert.match(zh, /电脑 Agent.*暂停/u);
  assert.match(en, /computer Agent request.*(?:pause|continue)|pause a computer Agent/iu);
  assert.doesNotMatch(zh, /直接选择云端体验 Agent|选择云端体验 Agent，或/u);
});

test("file and conversation uploads, manual imports and human integration remain separate", async () => {
  const [html] = await source;
  const zh = authoredCopy(html, "zh");
  const en = authoredCopy(html, "en");
  assert.match(zh, /文件.*上传.*会话回合上传另行控制/u);
  assert.match(en, /Upload files.*Conversation uploads have separate controls/iu);
  assert.match(zh, /不会自动下载.*不会自动合并/u);
  assert.match(en, /No automatic downloads or merges/iu);
  assert.match(zh, /手动导入.*新建本地任务.*旧任务.*自行归档/u);
  assert.match(en, /manual import creates a new local task.*archive the old/iu);
  assert.match(zh, /历史传递不受影响/u);
  assert.match(en, /history transfer is unaffected/iu);
  assert.match(zh, /GitHub.*PR 审核.*GT Cloud.*创建者/u);
  assert.match(en, /GitHub.*PR reviews.*project owner.*GT Cloud/iu);
  assert.match(zh, /不占 GatherThread 文件额度/u);
  assert.match(zh, /每用户有效文件版本额度/u);
  assert.match(zh, /本地密钥.*工具批准权.*不会自动交给同伴/u);
});

test("home uses email/password and project visibility terms, not retired account entry flows", async () => {
  const [html] = await source;
  const zh = authoredCopy(html, "zh");
  const en = authoredCopy(html, "en");
  assert.match(zh, /邮箱.*密码/u);
  assert.match(zh, /注册.*找回密码.*登录页/u);
  assert.match(en, /email.*password/iu);
  assert.match(en, /sign-in page.*registration.*password[- ]recovery/iu);
  assert.match(zh, /Solo 不是私聊.*其他成员仍可阅读/u);
  assert.match(en, /Solo is not a private chat.*project members can still read/iu);
  assert.doesNotMatch(html, /template=test-access|qualification code|申请测试资格|邀请码登录|邀请制测试/iu);
  assert.doesNotMatch(html, /0\.1\.0-alpha\.\d+/u);
});

test("home retains useful discovery metadata and public privacy, contact and filing links", async () => {
  const [html] = await source;
  const links = elements(html, "link");
  assert.ok(links.some((link) => link.rel === "canonical" && link.href === "https://gatherthread.cn/"));
  const metadata = elements(html, "meta");
  for (const property of ["og:title", "og:description", "og:url", "og:type", "og:locale", "og:locale:alternate"]) {
    assert.ok(metadata.some((meta) => meta.property === property && meta.content), property);
  }
  assert.ok(metadata.some((meta) => meta.name === "description" && meta.content.includes("GatherThread")));
  assert.ok(metadata.some((meta) => meta.name === "twitter:card" && meta.content === "summary"));
  const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
  const resources = elements(footer, "a");
  for (const href of ["./privacy/", "mailto:coolhezi@sjtu.edu.cn", "https://github.com/TH060419/gatherthread/issues", "https://beian.miit.gov.cn/"]) {
    assert.ok(resources.some((link) => link.href === href), href);
  }
  assert.match(footer, /冀ICP备2026037466号-1/u);
  assert.match(authoredCopy(footer, "zh"), /联系与反馈/u);
  assert.match(authoredCopy(footer, "en"), /Contact & feedback/iu);
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

test("product home and privacy prepare public-registration Beta without retired access gates", async () => {
  const [html] = await source;
  const privacy = await readFile(new URL("privacy/index.html", productRoot), "utf8");
  assert.match(authoredCopy(html, "zh"), /公开注册 Beta/u);
  assert.match(authoredCopy(html, "en"), /Public-registration Beta/u);
  assert.match(privacy, /Beta 测试采用公开邮箱注册/u);
  assert.match(privacy, /Beta uses public email registration/u);
  assert.doesNotMatch(html + privacy, /邀请制|invitation-only|invite-only|资格码激活|not deployed|待上线功能/iu);
  assert.match(privacy, /独立测试服[\s\S]*不代表正式服的注册要求/u);
  assert.match(privacy, /separate test environment[\s\S]*not a production registration requirement/u);
  assert.match(privacy, /最多 14 天[\s\S]*最多 30 天/u);
  assert.match(privacy, /no more than 14 days[\s\S]*no more than 30 days/u);
});
