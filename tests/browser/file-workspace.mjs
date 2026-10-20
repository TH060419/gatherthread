// Isolated real HTTP + browser checks. Synthetic identities/files, no model or GitHub calls.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import { CodeRepository } from "../../apps/server/dist/src/code-repository.js";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH?.replace(/index\.mjs$/u, "index.js") ?? "playwright");
const output = resolve(process.env.BROWSER_OUTPUT_DIRECTORY ?? "output/playwright/file-workspace"); mkdirSync(output, { recursive: true });
const mails = [];
const reserve = createServer(); await new Promise(done => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port; await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`;
const registration = { enabled: true, origin, siteKey: "test-site-key", challenge: { async verify() { return true; } },
  mailer: { async send(mail) { mails.push(mail); } } };
const codeRoot = mkdtempSync(resolve(tmpdir(), "gt-file-browser-"));
const server = await startCollaborationServer({ databasePath: ":memory:", codeRepositoryDirectory: codeRoot, authTokenPepper: randomBytes(32).toString("hex"),
  registration, publicBaseUrl: origin, allowedOrigins: [origin], staticDirectory: resolve("apps/web/dist") }, port);
const repository = new CodeRepository(server.database, codeRoot);
const email = `${randomUUID()}@example.invalid`, password = "isolated file workspace password", marker = randomUUID();
const sent = await server.database.registration.send({ email, locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, marker, randomUUID(), registration);
const { actor } = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id, code: mails.at(-1).code,
  display_name: "File reviewer", device_name: "Synthetic device", remember_device: false, password, privacy_acknowledged: true }, marker, randomUUID(), registration);
const project = server.service.createProject(actor, { title: "File workspace demo", idempotency_key: randomUUID() });
const { session } = server.service.createSession(actor, { project_id: project.id, title: "Build together", mode: "multi", idempotency_key: randomUUID() });
const base = repository.enable(actor, project.id, { idempotency_key: randomUUID() });
function pdfBytes() {
  const parts = ["%PDF-1.4\n"]; const offsets = [0];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 18 Tf 20 90 Td (GatherThread PDF preview) Tj ET";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.forEach((object, index) => { offsets.push(parts.join("").length); parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`); });
  const xref = parts.join("").length;
  parts.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return Buffer.from(parts.join(""));
}
const files = [
  { path: "README.md", content_base64: Buffer.from("# Project guide\n\nA **shared** project.\n\n| File | Purpose |\n| --- | --- |\n| main.js | Start |\n").toString("base64") },
  { path: "src/main.js", content_base64: Buffer.from("export const greeting = 'Hello, team';\n").toString("base64") },
  { path: "guide.pdf", content_base64: pdfBytes().toString("base64") },
  { path: "pixel.png", content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
];
const first = repository.checkpoint(actor, project.id, { base_commit: base.commit,
  files: [...files, { path: "obsolete.txt", content_base64: Buffer.from("Previous version\n").toString("base64") }].map(file => ({ ...file, executable: false })),
  message: "Create sample files", idempotency_key: randomUUID() });
repository.checkpoint(actor, project.id, { base_commit: first.commit, files: files.map(file => ({ ...file, executable: false })),
  message: "Remove obsolete file", idempotency_key: randomUUID() });
const teammate = server.database.createIdentity({ display_name: "Maya", device_name: "Synthetic teammate" });
const invitation = server.service.createProjectInvitation(actor, project.id, { role: "participant", ttl: "1h" });
server.service.claimInvitationForActor(teammate.actor, invitation.invite_token);
repository.checkpoint(teammate.actor, project.id, { base_commit: base.commit,
  files: [{ path: "README.md", content_base64: Buffer.from("# Teammate branch\n").toString("base64"), executable: false }],
  message: "Teammate work", idempotency_key: randomUUID() });
const otherBranch = repository.status(teammate.actor, project.id).own_branch_id;
const ownBranch = repository.status(actor, project.id).own_branch_id;
const browser = await (process.env.FILE_WORKSPACE_WEBKIT === "1" ? webkit.launch({ headless: true })
  : chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) }));
const pageErrors = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1500, height: 980 },
      ...(mobile ? { isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
    const page = await context.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${origin}/app/#project=${project.id}&session=${session.id}`);
    if (mobile) { await page.locator("#interface-mode-dialog[open]").waitFor(); await page.locator("#interface-mode-use-mobile").click(); }
    await page.locator("#auth-select-email-login").click(); await page.locator("#email-login-email").fill(email);
    await page.locator("#email-login-password").fill(password); await page.locator("#email-login-form button[type=submit]").click();
    await page.locator("#workspace:not([hidden])").waitFor();
    await page.locator("#code-notice-dialog[open]").waitFor(); await page.locator("#code-notice-continue").click();
    // Dismiss only product-authored guidance in this synthetic profile.
    await page.locator(".onboarding-example-dialog[open]").waitFor();
    await page.frameLocator(".onboarding-example-dialog iframe").getByRole("button", { name: "Exit", exact: true }).click();
    await page.locator(".onboarding-example-dialog[open]").waitFor({ state: "hidden" });
    const sidebarToggle = page.locator("#open-files-button");
    if (await sidebarToggle.getAttribute("aria-expanded") === "true") await sidebarToggle.click();
    await sidebarToggle.click();
    const workspace = page.locator(".file-workspace");
    if (!mobile) {
      assert.equal(await page.locator("#session-rail").evaluate(node => Math.round(node.getBoundingClientRect().width)), 300);
      assert.equal(await page.locator("#file-workspace-host").evaluate(node => Math.round(node.getBoundingClientRect().width)), 380);
      await page.locator("#settings-button").click();
      assert.equal(await page.locator("#settings-left-width-preset").inputValue(), "300");
      assert.equal(await page.locator("#settings-right-width-preset").inputValue(), "380");
      await page.locator("#settings-dialog").press("Escape");
    }
    assert.equal(await workspace.locator('[data-tab="members"]').count(), 0, "Members is not a permanent tab");
    await workspace.locator(".fw-new-tab").click();
    await workspace.locator('[data-open-tab="members"]').click();
    const originalMembers = await page.locator("#member-panel").elementHandle();
    await workspace.locator('[data-tab-id="members"] > .fw-tab-dismiss').click();
    assert.equal(await workspace.locator('[data-tab="members"]').count(), 0);
    await workspace.locator(".fw-new-tab").click();
    await workspace.locator('[data-open-tab="members"]').click();
    assert.equal(await page.locator("#member-panel").evaluate((node, original) => node === original, originalMembers), true, "Members DOM and handlers are reused");
    await workspace.locator('[data-tab-id="files"] > .fw-tab-dismiss').click();
    await workspace.locator(".fw-new-tab").click(); await workspace.locator('[data-open-tab="files"]').click();
    await page.locator('.fw-tree [data-path="README.md"]').click();
    await page.locator(".fw-markdown h1").waitFor(); assert.equal(await page.locator(".fw-markdown h1").innerText(), "Project guide");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const editor = page.locator(".fw-content .cm-content"); await editor.waitFor();
    await editor.click(); await editor.press("Meta+End"); await editor.press("End"); await editor.press("Enter"); await editor.pressSequentially("Unsaved browser edit");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    assert.match(await page.locator(".fw-markdown").innerText(), /Unsaved browser edit/);
    const dirtyTabCount = await workspace.locator('.fw-tabs [role="tab"]').count();
    const activeBeforeCollapse = await workspace.locator('.fw-tabs [aria-selected="true"]').getAttribute("data-tab");
    if (mobile) {
      await workspace.locator(".fw-tabs-list").click(); await workspace.locator(".fw-collapse-command").click();
    } else await sidebarToggle.click();
    await workspace.waitFor({ state: "hidden" });
    assert.equal(await workspace.locator('.fw-tabs [role="tab"]').count(), dirtyTabCount, "collapse keeps tabs mounted");
    await sidebarToggle.click(); await workspace.waitFor();
    assert.equal(await workspace.locator('.fw-tabs [aria-selected="true"]').getAttribute("data-tab"), activeBeforeCollapse, "show restores the active file, not Files");
    assert.match(await page.locator(".fw-markdown").innerText(), /Unsaved browser edit/);
    page.once("dialog", (dialog) => dialog.dismiss());
    await workspace.locator(".fw-tabs-list").click();
    await workspace.getByRole("button", { name: "Close all tabs", exact: true }).click();
    assert.equal(await workspace.locator('.fw-tabs [role="tab"]').count(), dirtyTabCount, "cancelled batch close leaves every tab open");
    assert.match(await page.locator(".fw-markdown").innerText(), /Unsaved browser edit/);
    await page.screenshot({ path: resolve(output, mobile ? "mobile-markdown.png" : "desktop-markdown.png") });
    await page.getByRole("button", { name: "Code", exact: true }).click(); assert.match(await editor.innerText(), /Unsaved browser edit/);
    await page.getByRole("button", { name: "Save", exact: true }).click(); await page.getByText("File operation completed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Changes", exact: true }).click(); await page.locator(".cm-mergeView").waitFor();
    await page.screenshot({ path: resolve(output, mobile ? "mobile-diff.png" : "desktop-diff.png") });
    await page.getByRole("button", { name: "Back to files", exact: true }).click();
    await page.locator('.fw-tree [data-path="guide.pdf"]').click(); await page.locator(".workspace-pdf canvas").waitFor();
    await page.waitForFunction(() => document.querySelector(".workspace-pdf canvas")?.width > 0);
    await page.getByRole("button", { name: "Back to files", exact: true }).click();
    await page.locator('.fw-tree [data-path="pixel.png"]').click();
    await page.waitForFunction(() => document.querySelector(".fw-image")?.naturalWidth === 1);
    await workspace.locator('[data-tab="members"]').click();
    assert.equal(await page.locator("#member-panel").count(), 1); await page.locator("#member-list").waitFor();
    await workspace.locator('[data-tab="files"]').click();
    await page.getByRole("combobox", { name: "Branch", exact: true }).selectOption(otherBranch);
    await page.locator('.fw-tree [data-path="README.md"]').click();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.locator(".cm-content[contenteditable=false]").waitFor();
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Back to files", exact: true }).click();
    await page.getByRole("combobox", { name: "Branch", exact: true }).selectOption(ownBranch);
    await page.locator('[data-explorer-view="changes"]').click(); await page.locator(".fw-change").first().waitFor();
    await page.locator('[data-explorer-view="history"]').click();
    const removal = page.locator(".fw-history-entry").filter({ hasText: "Remove obsolete file" });
    await removal.getByRole("button", { name: "View changes", exact: true }).click();
    await page.locator(".fw-change.is-deleted").filter({ hasText: "obsolete.txt" }).click();
    await page.locator(".cm-mergeView .cm-deletedLine").first().waitFor();
    await page.screenshot({ path: resolve(output, mobile ? "mobile-history.png" : "desktop-history.png") });
    await page.getByRole("button", { name: "Back to files", exact: true }).click();
    await page.locator('[data-explorer-view="files"]').click();
    await workspace.locator(".fw-tabs-list").click();
    await workspace.getByRole("button", { name: "Close all tabs", exact: true }).click();
    await workspace.locator(".fw-new-tab-view:not([hidden])").waitFor();
    assert.equal(await workspace.locator('.fw-tabs [role="tab"]').count(), 0);
    await workspace.locator(".fw-new-tab-view").getByRole("button", { name: "Files", exact: true }).click();
    await page.locator('.fw-tree [data-path="README.md"]').click();
    await page.locator(".fw-markdown h1").waitFor();
    await workspace.locator('[data-tab="files"]').click();
    if (mobile) {
      await page.locator("#mobile-members-dialog > [data-mobile-close]").click();
      await page.locator("#mobile-members-dialog[open]").waitFor({ state: "hidden" });
      await page.locator("#open-files-button").click(); await page.locator("#mobile-members-dialog[open]").waitFor();
      await page.locator('.fw-tree [data-path="README.md"]').click({ button: "right" });
      const actionMenu = workspace.locator(".fw-actions-menu");
      async function assertActionsFit(label, viewportBottom) {
        await page.waitForFunction((bottom) => {
          const menu = document.querySelector(".fw-actions-menu"), pane = document.querySelector(".fw-files-pane");
          const bounds = menu?.getBoundingClientRect(), clip = pane?.getBoundingClientRect();
          return bounds && bounds.height > 40 && bounds.top >= Math.max(0, clip.top) - 1
            && bounds.bottom <= Math.min(bottom, clip.bottom) + 1;
        }, viewportBottom);
        const result = await actionMenu.evaluate((menu) => {
          menu.scrollTop = menu.scrollHeight;
          const last = menu.lastElementChild, rect = last.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
          return { scrollable: getComputedStyle(menu).overflowY === "auto", withinMenu: rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1,
            hit: last.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)) };
        });
        assert.equal(result.scrollable && result.withinMenu && result.hit, true, `${label}: the final file action is visible after scrolling`);
        await page.screenshot({ path: resolve(output, `mobile-actions-${label.replaceAll(" ", "-")}.png`) });
        await actionMenu.getByRole("button", { name: "Download", exact: true }).focus();
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Download", `${label}: the final action retains keyboard focus`);
      }
      await assertActionsFit("portrait", 844);
      await page.setViewportSize({ width: 844, height: 390 });
      await assertActionsFit("landscape", 390);
      await page.setViewportSize({ width: 390, height: 844 });
      // A software keyboard can shrink only the visual viewport, leaving the
      // dialog/layout viewport unchanged. Exercise that resize independently.
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 320 });
        window.visualViewport.dispatchEvent(new Event("resize"));
      });
      await assertActionsFit("keyboard-short visual viewport", 320);
      await actionMenu.getByRole("button", { name: "Download", exact: true }).focus();
      const download = page.waitForEvent("download"); await page.keyboard.press("Enter");
      assert.equal((await download).suggestedFilename(), "README.md");
      await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event("resize")); });
    }
    await page.screenshot({ path: resolve(output, mobile ? "mobile-files.png" : "desktop-files.png") });
    const chromeStyle = await workspace.evaluate((node) => {
      const frame = getComputedStyle(node), bar = getComputedStyle(node.querySelector(".fw-topbar"));
      return { radius: parseFloat(frame.borderTopLeftRadius), blur: bar.backdropFilter || bar.webkitBackdropFilter,
        contrast: document.documentElement.dataset.contrast,
        reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
        increasedContrast: matchMedia("(prefers-contrast: more)").matches,
        forcedColors: matchMedia("(forced-colors: active)").matches };
    });
    assert.equal(chromeStyle.radius, 0, "sidebar has no rounded outer frame");
    assert.equal(await page.locator("#file-workspace-host").evaluate(node => getComputedStyle(node).paddingTop), "0px", "sidebar content is flush");
    assert.equal(await workspace.locator(".fw-topbar > *").count(), 3, "toolbar contains only tabs, + and More");
    assert.match(chromeStyle.blur, /blur/u, `window chrome uses frosted layering: ${JSON.stringify(chromeStyle)}`);
    await workspace.locator(".fw-new-tab").click();
    await page.screenshot({ path: resolve(output, mobile ? "mobile-new-tab.png" : "desktop-new-tab.png") });
    await workspace.locator('[data-open-tab="members"]').click();
    await workspace.locator('[data-tab="members"]').click({ button: "right" });
    await workspace.getByRole("menuitem", { name: "Move tab left", exact: true }).click();
    assert.equal(await workspace.locator('.fw-tabs [role="tab"]').first().getAttribute("data-tab"), "files");
    assert.equal(await workspace.locator('.fw-tabs [role="tab"]').nth(1).getAttribute("data-tab"), "members");
    await workspace.locator('.fw-tabs [data-path="README.md"]').click();
    await workspace.locator(".fw-markdown h1").waitFor();
    if (!mobile) {
      await workspace.locator(".fw-tabs-list").click();
      await workspace.getByRole("button", { name: "Expand workspace", exact: true }).click();
      await page.screenshot({ path: resolve(output, "desktop-window.png") });
    }
    await workspace.locator(".fw-tabs-list").click();
    await page.screenshot({ path: resolve(output, mobile ? "mobile-tab-list.png" : "desktop-tab-list.png") });
    await workspace.locator(".fw-tabs-list").click();
    await page.emulateMedia({ colorScheme: "dark" });
    // Wait beyond the 140ms chrome color transition. Do not wait on all native
    // animation promises: WebKit can retain paused or non-finishing effects.
    await page.waitForTimeout(350);
    await page.screenshot({ path: resolve(output, mobile ? "mobile-dark.png" : "desktop-dark.png") });
    assert.equal(await page.locator("body").evaluate(node => node.scrollWidth > window.innerWidth + 1), false, "page does not overflow horizontally");
    await context.close();
  }
  assert.deepEqual(pageErrors, []); console.log("File workspace: desktop/mobile tab open/close/reopen, original Members DOM, empty workspace, edit, Markdown source+preview, save/diff, PDF, image and history passed.");
} finally { await browser.close(); await server.close(); rmSync(codeRoot, { recursive: true, force: true }); }
