// Real-pointer presentation checks with synthetic accounts and GitHub responses.
// All non-loopback traffic is blocked; no GitHub repository is created or changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWebServer } from "../../apps/web/scripts/serve.mjs";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
const root = resolve("apps/web/dist");
const bootstrap = readFileSync(resolve(root, "app/src/bootstrap.js"), "utf8");
const mainName = bootstrap.match(/import\("\.\/([^\"]*main\.js[^\"]*)"\)/)[1];
const main = readFileSync(resolve(root, "app/src", mainName.split("?")[0]), "utf8");
const apiName = main.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)[1];
const server = createWebServer({ root, host: "127.0.0.1", port: 0, upstream: new URL("http://127.0.0.1:1") });
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
async function signIn(page) {
  await page.locator("#auth-view:not([hidden])").waitFor();
  await page.locator("#auth-select-email-login").click();
  await page.locator("#email-login-email").fill("demo@example.invalid");
  await page.locator("#email-login-password").fill("isolated demo password");
  await page.locator("#email-login-form button[type=submit]").click();
}
async function dismissNotice(page) {
  await page.locator("#workspace:not([hidden])").waitFor();
  if (await page.locator("#code-notice-dialog[open]").isVisible()) await page.locator("#code-notice-continue").click();
  await page.locator("#session-view:not([hidden])").waitFor();
}
try {
  for (const [name, engine, locale, width, mobile] of [
    ["chromium-desktop", chromium, "en", 1440, false],
    ["webkit-phone", webkit, "zh-CN", 390, true],
    ["chromium-tablet", chromium, "en", 1024, true],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width, height: 840 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [], state = { connected: false, binding: null, writes: 0, completions: 0 };
    page.setDefaultTimeout(12_000);
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("githubSetupFixture", async (action, value) => {
      if (action === "complete") { assert.deepEqual(value, { code: "fixture-code", state: "fixture-state" }); state.connected = true; state.completions++; }
      if (action === "bind") { state.binding = value; state.writes++; }
      return { enabled: true, connected: state.connected, login: state.connected ? "fixture-owner" : null,
        binding: state.binding, installation_url: "https://github.com/apps/fixture/installations/new" };
    });
    await context.addInitScript(({ locale, origin }) => {
      if (window.location.origin !== origin) return;
      localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) { return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : getItem.call(this, key); };
    }, { locale, origin });
    await context.route(/^https?:/, route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.endsWith("/src/bootstrap.js")) return route.continue();
      const fixture = `import { MockCollaborationApi } from ${JSON.stringify(apiName)};
        const proto = MockCollaborationApi.prototype, listProjects = proto.listProjects;
        proto.listProjects = async function () {
          if (!this.extraFixtureProject) { this.extraFixtureProject = true; this.projects.unshift({ ...this.projects[0], id: "project-first", name: "Other fixture project" }); }
          return listProjects.call(this);
        };
        proto.getHostedGithubStatus = async () => window.githubSetupFixture("status");
        proto.completeHostedGithub = async input => window.githubSetupFixture("complete", input);
        proto.authorizeHostedGithub = async () => ({ authorization_url: "https://github.com/login/oauth/authorize?client_id=fixture&state=fixture-state" });
        proto.listHostedGithubTasks = async () => ({ tasks: [] });
        proto.bindHostedGithub = async (_project, input) => window.githubSetupFixture("bind", input);`;
      return route.fulfill({ status: 200, contentType: "text/javascript", body: fixture + "\n" + bootstrap });
    });
    try {
      await page.goto(`${origin}/app/?mock=1#project=project-orbit&session=session-orbit`);
      await signIn(page); await dismissNotice(page);
      // Mobile and desktop use the same ordinary file-settings trigger.
      await page.locator("#project-code-button").click();
      await page.locator("#github-cloud-account:not([hidden])").waitFor();
      assert.equal(await page.locator("#code-provider-github").getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator(".github-mode-picker").count(), 0);
      assert.equal(state.writes, 0);
      const outbound = page.waitForRequest(request => request.url().startsWith("https://github.com/login/oauth/authorize"));
      await page.locator("#cloud-github-authorize").click();
      await outbound;
      // The external navigation is intentionally blocked. A different query
      // forces a fresh callback document even when WebKit kept the old page.
      await page.goto(`${origin}/app/?mock=1&github-fixture-return=1#github_code=fixture-code&github_state=fixture-state`);
      await signIn(page);
      await page.locator("#project-code-dialog[open]").waitFor();
      await page.locator("#cloud-github-repository-form:not([hidden])").waitFor();
      assert.match(page.url(), /project=project-orbit/);
      assert.doesNotMatch(page.url(), /github_code|github_state/);
      assert.equal(state.completions, 1);
      assert.equal(await page.locator("#cloud-github-owner").inputValue(), "fixture-owner");
      await page.locator("#cloud-github-name").fill("team-project");
      assert.equal(new URL(await page.locator("#cloud-github-create").getAttribute("href")).searchParams.get("name"), "team-project");
      await page.locator("#cloud-github-repository-form button[type=submit]").click();
      await page.locator("#github-cloud-home:not([hidden])").waitFor();
      assert.equal(state.writes, 1);
      assert.deepEqual(state.binding, { repository: "fixture-owner/team-project", base_branch: "main" });
      await page.locator("#github-mode-local").click();
      await page.locator("#github-code-form:not([hidden])").waitFor();
      assert.equal(await page.locator("#github-code-owner").inputValue(), "fixture-owner");
      assert.equal(await page.locator("#github-code-name").inputValue(), "team-project");
      assert.equal(state.writes, 1, "choosing computer sync does not rebind or upload");
      await page.locator("#github-code-owner").fill("different-owner");
      await page.locator("#github-code-name").fill("unsaved-computer-draft");
      await page.locator("#github-code-form details.github-advanced > summary").click();
      await page.locator("#github-code-base").fill("draft-base");
      await page.locator("#github-mode-cloud").click();
      await page.locator("#github-mode-local").click();
      assert.equal(await page.locator("#github-code-owner").inputValue(), "different-owner");
      assert.equal(await page.locator("#github-code-name").inputValue(), "unsaved-computer-draft");
      assert.equal(await page.locator("#github-code-base").inputValue(), "draft-base");
      await page.locator("#github-mode-cloud").click();
      await page.locator("#cloud-github-edit").click();
      await page.locator("#cloud-github-name").fill("unfinished-edit");
      await page.locator("#cloud-github-back").click();
      await page.locator("#code-provider-gt-cloud").click();
      await page.locator("#code-gt-cloud-panel:not([hidden])").waitFor();
      assert.equal(state.writes, 1);
      assert.equal(await page.locator("#project-code-dialog").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: storage hierarchy, OAuth return, repository setup, computer draft, GT Cloud and ordinary clicks`);
    } finally { await context.close(); await browser.close(); }
  }
} finally { await new Promise(done => server.close(done)); }
