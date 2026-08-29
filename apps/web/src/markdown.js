import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import katex from "katex";
import renderMathInElement from "katex/contrib/auto-render";

const MAX_MARKDOWN_CHARACTERS = 180_000;
const KATEX_OPTIONS = Object.freeze({
  throwOnError: false,
  trust: false,
  strict: "ignore",
  maxExpand: 1_000,
  maxSize: 20,
  output: "htmlAndMathml",
});

const MATH_DELIMITERS = Object.freeze([
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
  { left: "$", right: "$", display: false },
]);

const ESCAPED_MATH_SEGMENT = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/gu;

export function markdownToSafeHtml(value) {
  const segments = [];
  const source = String(value ?? "").slice(0, MAX_MARKDOWN_CHARACTERS).replace(
    ESCAPED_MATH_SEGMENT,
    (segment) => {
      const token = `\uE000gatherthread-math-${segments.length}\uE001`;
      segments.push({ token, segment });
      return token;
    },
  );
  let html = micromark(source, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
  for (const { token, segment } of segments) {
    html = html.replaceAll(token, escapeHtml(segment));
  }
  return html;
}

export function renderMarkdown(value, documentRef = globalThis.document) {
  const body = documentRef.createElement("div");
  body.className = "markdown-body";
  // micromark escapes raw HTML and strips dangerous protocols. Remove its
  // generated image elements before DOM parsing as an additional privacy
  // boundary: detached image nodes can still initiate remote requests.
  body.innerHTML = markdownToSafeHtml(value).replace(
    /<img(?:\s[^<>]*)?>/giu,
    '<span class="markdown-image-placeholder">Image</span>',
  );

  for (const link of body.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    if (!href || !safeLink(href, documentRef.baseURI)) {
      link.replaceWith(documentRef.createTextNode(link.textContent ?? ""));
      continue;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
  }

  renderMathInElement(body, {
    ...KATEX_OPTIONS,
    delimiters: MATH_DELIMITERS,
    ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
    ignoredClasses: ["no-math-render"],
  });

  return body;
}

export function formulaToSafeHtml(value, displayMode = false) {
  return katex.renderToString(String(value ?? "").slice(0, MAX_MARKDOWN_CHARACTERS), {
    ...KATEX_OPTIONS,
    displayMode,
  });
}

function safeLink(href, baseURI) {
  if (href.startsWith("#")) return true;
  try {
    const url = new URL(href, baseURI);
    return new Set(["http:", "https:", "mailto:"]).has(url.protocol);
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
