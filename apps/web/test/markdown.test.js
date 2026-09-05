import assert from "node:assert/strict";
import test from "node:test";
import { formulaToSafeHtml, markdownToSafeHtml } from "../src/markdown.js";

test("agent Markdown renders GFM structure without executable HTML", () => {
  const html = markdownToSafeHtml("# Result\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst ok = true;\n```");
  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<table>/);
  assert.match(html, /language-js/);
});

test("agent Markdown escapes raw HTML and drops dangerous link protocols", () => {
  const html = markdownToSafeHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[bad](javascript:alert(3))');
  assert.doesNotMatch(html, /<script|<img|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="">bad<\/a>/);
});

test("KaTeX renders bounded formulas without trusting formula-supplied links", () => {
  const inline = formulaToSafeHtml("E = mc^2");
  const display = formulaToSafeHtml("\\int_0^1 x^2\\,dx = \\frac{1}{3}", true);
  const untrusted = formulaToSafeHtml("\\href{javascript:alert(1)}{bad}");
  assert.match(inline, /class="katex"/);
  assert.match(inline, /<math/);
  assert.match(display, /class="katex-display"/);
  assert.doesNotMatch(untrusted, /href=/i);
  assert.doesNotMatch(`${inline}${display}${untrusted}`, /<script/i);
});

test("Markdown preserves escaped LaTeX delimiters for the DOM formula pass", () => {
  const html = markdownToSafeHtml("\\[\\int_0^1 x^2\\,dx = \\frac{1}{3}\\]");
  const hostile = markdownToSafeHtml("\\[<img src=x onerror=alert(1)>\\]");
  assert.equal(html.includes("\\["), true);
  assert.equal(html.includes("\\]"), true);
  assert.equal(html.includes("\\int_0^1"), true);
  assert.doesNotMatch(hostile, /<img/i);
  assert.match(hostile, /&lt;img/);
});
