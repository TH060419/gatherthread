import assert from "node:assert/strict";
import test from "node:test";
import katex from "katex";
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

test("KaTeX ignores inherited renderer settings and macro definitions", () => {
  const options = Object.assign(Object.create({ trust: true }), {
    throwOnError: false,
    strict: "ignore",
  });
  const untrusted = katex.renderToString("\\href{https://example.invalid/math}{link}", options);
  assert.doesNotMatch(untrusted, /href=/i);

  const macros = Object.assign(Object.create({ "\\gtInherited": "\\text{prototype-macro}" }), {
    "\\gtOwned": "\\text{own-macro}",
  });
  const inherited = katex.renderToString("\\gtInherited", { throwOnError: false, macros });
  const undefinedCommand = katex.renderToString("\\gtInherited", {
    throwOnError: false,
    macros: Object.create(null),
  });
  const owned = katex.renderToString("\\gtOwned", { throwOnError: false, macros });
  assert.equal(inherited, undefinedCommand);
  assert.doesNotMatch(inherited, /prototype-macro/);
  assert.match(owned, /own-macro/);
});

test("application formulas ignore inherited setting processors", () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "processor");
  try {
    Object.defineProperty(Object.prototype, "processor", {
      configurable: true,
      value: (value) => value === false ? true : value,
    });
    const html = formulaToSafeHtml("\\href{https://example.invalid/math}{link}");
    const ordinary = formulaToSafeHtml("E = mc^2");
    assert.doesNotMatch(html, /href=|<img|<script/i);
    assert.match(ordinary, /class="katex"/);
    assert.match(ordinary, /<math/);
  } finally {
    if (original) Object.defineProperty(Object.prototype, "processor", original);
    else delete Object.prototype.processor;
  }
});

test("application formulas keep macro expansion and size limits", () => {
  const loop = formulaToSafeHtml("\\def\\a{\\a}\\a");
  const size = formulaToSafeHtml("\\rule{999em}{999em}");
  assert.match(loop, /class="katex-error"/);
  assert.match(loop, /Too many expansions/);
  assert.match(size, /width:20em/);
  assert.doesNotMatch(size, /(?:width|height):999em/);
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
