import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { guideSteps } from "../src/onboarding-content.js";

test("both privacy notices explain author deletion, retained envelopes and independent-copy limits", async () => {
  const source = await readFile(new URL("../../../site/privacy/index.html", import.meta.url), "utf8");
  const zh = source.match(/<article lang="zh-CN"[\s\S]*?<\/article>/)?.[0] ?? "";
  const en = source.match(/<article lang="en"[\s\S]*?<\/article>/)?.[0] ?? "";
  assert.match(zh, /删除自己发出的消息/);
  assert.match(en, /Delete your own messages/);
  assert.match(zh, /自己.*聊天消息.*Agent 请求.*Agent 回复/);
  assert.match(en, /own chat messages, Agent requests and Agent replies/);
  assert.match(zh, /顺序.*作者.*时间/);
  assert.match(en, /order, author and time/);
  assert.match(zh, /后续.*GatherThread.*历史.*不再/);
  assert.match(en, /future GatherThread.*history.*exclude/);
  assert.match(zh, /摘要.*失效/);
  assert.match(en, /summaries.*invalidated/);
  assert.match(zh, /不回滚.*文件改动/);
  assert.match(en, /does not roll back.*file changes/);
  assert.match(zh, /其他成员.*独立.*手工/);
  assert.match(en, /other members.*independent.*manual/);
  assert.match(zh, /不会瞬间/);
  assert.match(en, /not instant/);
  assert.match(zh, /不再可达的云端 Git 对象.*14 天/);
  assert.match(en, /cloud Git objects.*unreachable.*14 days/);
  assert.match(zh, /用户标识.*日志.*30 天/);
  assert.match(en, /logs containing user identifiers.*30 days/);
});

test("Web README describes the real delete transport and bilingual future-history boundary", async () => {
  const source = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(source, /deleteMessage\(sessionId, eventId,/);
  assert.match(source, /POST \/v1\/sessions\/:id\/events\/:event_id\/delete/);
  assert.match(source, /"content_revision": 0/);
  assert.match(source, /Delete your own messages/);
  assert.match(source, /删除自己发出的消息/);
  assert.match(source, /future GatherThread.*history.*exclude/);
  assert.match(source, /后续.*GatherThread.*历史.*不再/);
  assert.match(source, /does not roll back.*file changes/);
  assert.match(source, /不回滚.*文件改动/);
  assert.match(source, /local-only.*not uploaded again/);
  assert.match(source, /仅本地.*不会再上传/);
});

test("public product READMEs expose deletion without implying loss of other members' work", async () => {
  const en = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
  const zh = await readFile(new URL("../../../README.zh-CN.md", import.meta.url), "utf8");
  assert.match(en, /\| Delete your own messages \|/);
  assert.match(zh, /删除自己的消息/);
  assert.match(en, /future Agent history.*exclude/);
  assert.match(zh, /后续.*Agent.*历史.*不再/);
  assert.match(en, /does not roll back file changes/);
  assert.match(zh, /不回滚文件改动/);
  assert.match(en, /independent messages or manual reposts/);
  assert.match(zh, /独立消息或手工重发的副本/);
});

test("illustrated beginner guides identify the author's trash button and retain only valid summary sources", async () => {
  const en = await readFile(new URL("../../../docs/PRODUCT_GUIDE.md", import.meta.url), "utf8");
  const zh = await readFile(new URL("../../../docs/PRODUCT_GUIDE.zh-CN.md", import.meta.url), "utf8");
  assert.match(en, /trash icon beside your own message or Agent reply/);
  assert.match(zh, /自己的消息或 Agent 回复旁的垃圾桶/);
  assert.match(en, /Undeleted original messages and valid older summary versions/);
  assert.match(zh, /未删除的原文和有效的旧摘要/);
});

test("illustrated guides use the current desktop Launcher and compact Agent controls", async () => {
  const en = await readFile(new URL("../../../docs/PRODUCT_GUIDE.md", import.meta.url), "utf8");
  const zh = await readFile(new URL("../../../docs/PRODUCT_GUIDE.zh-CN.md", import.meta.url), "utf8");
  assert.match(en, /Launcher v2/);
  assert.match(zh, /启动器 v2/);
  assert.match(en, /DMG.*Applications/);
  assert.match(zh, /DMG.*应用程序/);
  assert.match(en, /email.*password.*Launcher/);
  assert.match(zh, /邮箱.*启动器.*密码/);
  assert.match(en, /production and test.*independent.*device/);
  assert.match(zh, /正式.*测试.*独立.*设备/);
  assert.match(en, /On computers, phones and tablets.*Agent button/);
  assert.match(zh, /电脑、手机和平板.*Agent 按钮/);
  for (const source of [en, zh]) assert.doesNotMatch(source, /Launcher v1|启动器 v1|production-origin-only|云端任务暂不支持/);
});

test("desktop and compact beginner guides point to the author's trash icon without adding steps", () => {
  for (const layout of ["desktop", "mobile"]) {
    const basics = guideSteps("basics", { layout });
    const answer = basics.find(item => item.id === "answer");
    assert.equal(basics.length, 10);
    assert.match(answer.text[0], /trash icon.*your message or AI reply/);
    assert.match(answer.text[1], /垃圾桶.*自己的消息或 AI 回复/);
    const original = guideSteps("summaries", { layout }).find(item => item.id === "original");
    assert.match(original.text[0], /Undeleted original messages/);
    assert.match(original.text[1], /未删除的原始消息/);
    assert.doesNotMatch(answer.text.join(" "), /content_revision|tombstone|WAL|上下文/);
  }
});
