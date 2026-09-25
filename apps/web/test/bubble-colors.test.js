import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const stylesPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
const domainPath = fileURLToPath(new URL("../src/domain.js", import.meta.url));

/**
 * The bubble tints are theme variables, so a unit test of the role classifier
 * cannot see what a reader actually gets. This file resolves the real cascade
 * out of styles.css instead.
 *
 * It exists because the first version of the tints defined dark values only
 * under `data-theme="dark"` and missed the separate
 * `@media (prefers-color-scheme: dark)` block that serves `data-theme="system"`.
 * A reader on the default "follow the system" setting with a dark device
 * therefore got a light wash behind near-white text: about 1.1:1.
 */

function parseRules(text, media, out) {
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === "}") { i++; continue; }
    let end = i;
    while (end < text.length && text[end] !== "{" && text[end] !== ";") end++;
    if (end >= text.length) break;
    // A statement at-rule such as @import has no block.
    if (text[end] === ";") { i = end + 1; continue; }
    const prelude = text.slice(i, end).trim();
    let depth = 0, close = end;
    for (; close < text.length; close++) {
      if (text[close] === "{") depth++;
      else if (text[close] === "}" && --depth === 0) break;
    }
    const body = text.slice(end + 1, close);
    // @keyframes and @supports cannot carry theme variables we resolve here.
    if (prelude.startsWith("@media")) parseRules(body, prelude, out);
    else if (!prelude.startsWith("@")) out.push({ selector: prelude.replace(/\s+/g, " "), media, body });
    i = close + 1;
  }
  return out;
}

function declarations(body) {
  const found = new Map();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return found;
}

/** Apply matching rules in document order. Specificity and order agree for the
 *  theme blocks, so a flat last-wins map models them correctly. */
function variablesFor(rules, groups) {
  const vars = new Map();
  for (const rule of rules) {
    const group = groups.find((candidate) =>
      (candidate.media === null ? rule.media === null : (rule.media ?? "").includes(candidate.media))
      && candidate.selectors.includes(rule.selector));
    if (!group) continue;
    for (const [name, value] of declarations(rule.body)) vars.set(name, value);
  }
  return vars;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

function parseHex(text) {
  const digits = text.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
}

function parseChannel(value) {
  const number = Number.parseFloat(value);
  return value.trim().endsWith("%") ? Math.round((number / 100) * 255) : Math.round(number);
}

/** Resolve `var()` chains, `color-mix(in srgb, ...)` and literals. Anything else
 *  throws so a future edit fails loudly instead of silently skipping a check. */
function resolve(value, vars, seen = new Set()) {
  const text = value.trim();
  if (text.startsWith("var(")) {
    const [name, ...fallback] = splitTopLevel(text.slice(4, text.lastIndexOf(")")));
    assert.ok(!seen.has(name), `Circular theme variable: ${name}`);
    const declared = vars.get(name);
    if (declared === undefined) {
      assert.ok(fallback.length, `Theme variable ${name} is not defined for this appearance`);
      return resolve(fallback.join(","), vars, new Set([...seen, name]));
    }
    return resolve(declared, vars, new Set([...seen, name]));
  }
  if (text.startsWith("color-mix(")) {
    const [space, ...operands] = splitTopLevel(text.slice("color-mix(".length, text.lastIndexOf(")")));
    assert.match(space, /^in srgb$/, `Unsupported color-mix space: ${space}`);
    const weights = operands.map((operand) => {
      const parsed = operand.match(/^(.*?)(?:\s+([\d.]+)%)?$/s);
      const color = resolve(parsed[1].trim(), vars, seen);
      return { color, percent: parsed[2] === undefined ? null : Number(parsed[2]) };
    });
    assert.equal(weights.length, 2, "Only two color-mix operands are resolved");
    const percents = weights.map((weight) => weight.percent);
    if (percents[0] === null && percents[1] === null) percents.fill(50);
    else if (percents[0] === null) percents[0] = 100 - percents[1];
    else if (percents[1] === null) percents[1] = 100 - percents[0];
    const total = percents[0] + percents[1];
    return [0, 1, 2].map((channel) =>
      Math.round((weights[0].color[channel] * percents[0] + weights[1].color[channel] * percents[1]) / total));
  }
  if (text.startsWith("rgb")) {
    const [inner] = splitTopLevel(text.slice(text.indexOf("(") + 1, text.lastIndexOf(")")));
    return splitTopLevel(inner).slice(0, 3).map(parseChannel);
  }
  assert.match(text, /^#[0-9a-f]{3,8}$/i, `Unsupported theme value: ${text}`);
  return parseHex(text);
}

function relativeLuminance([r, g, b]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const formatColor = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

async function themePaths() {
  const source = await readFile(stylesPath, "utf8");
  // Comments are stripped first: a comment holding a `;` or a `:` inside a
  // declaration block would otherwise be read as a declaration.
  const css = source.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = parseRules(css, null, []);
  return {
    css,
    rules,
    light: variablesFor(rules, [{ media: null, selectors: [":root"] }]),
    dark: variablesFor(rules, [{ media: null, selectors: [":root", ':root[data-theme="dark"]'] }]),
    systemDark: variablesFor(rules, [
      { media: null, selectors: [":root"] },
      { media: "prefers-color-scheme: dark", selectors: [':root[data-theme="system"]'] },
    ]),
  };
}

/** Theme variables plus whatever a card-scoped rule redefines on the card itself.
 *  Custom properties inherit, so a card that re-derives a token also changes
 *  every descendant that reads it. */
function withCardOverrides(rules, themeVars, selector) {
  const vars = new Map(themeVars);
  for (const rule of rules) {
    if (rule.media !== null) continue;
    if (!rule.selector.split(",").map((part) => part.trim()).includes(selector)) continue;
    for (const [name, value] of declarations(rule.body)) {
      if (name.startsWith("--")) vars.set(name, value);
    }
  }
  return vars;
}

const BUBBLE_ROLES = [
  ["self", ".event-card.event-bubble-self", "--bubble-self-bg"],
  ["agent", ".event-card.event-bubble-agent", "--bubble-agent-bg"],
];

const APPEARANCES = ["light", "dark", "systemDark"];

const BUBBLE_TINTS = [
  "--bubble-self-bg",
  "--bubble-self-border",
  "--bubble-agent-bg",
  "--bubble-agent-border",
];

test("conversation bubble text stays readable in every appearance path", async () => {
  const themes = await themePaths();
  for (const appearance of ["light", "dark", "systemDark"]) {
    const vars = themes[appearance];
    const ink = resolve(vars.get("--ink"), vars);
    for (const tint of ["--bubble-self-bg", "--bubble-agent-bg"]) {
      const background = resolve(vars.get(tint), vars);
      const ratio = contrastRatio(ink, background);
      // WCAG AA asks 4.5:1 for body text. The chosen tints measure 8.5:1 or
      // better, so a palette edit that makes a message hard to read fails here.
      assert.ok(
        ratio >= 4.5,
        `${appearance} ${tint} is ${formatColor(background)} behind ${formatColor(ink)}: ${ratio.toFixed(2)}:1`,
      );
    }
  }
});

test("every text tier inside a tinted bubble clears the contrast bar", async () => {
  const themes = await themePaths();
  // A card carries more than body copy. --ink-soft drives the metadata
  // (.event-type, .event-sequence, time, .provenance, the worklog summary) at
  // 0.68 to 0.76rem, and --teal-dark colours links inside Agent markdown.
  // Tinting the card drops the metadata below 4.5:1 unless the card re-derives
  // it, which is what the first revision of the tints got wrong.
  const tiers = [
    ["metadata", "--ink-soft"],
    ["links", "--teal-dark"],
  ];
  for (const appearance of APPEARANCES) {
    for (const [role, selector, background] of BUBBLE_ROLES) {
      const vars = withCardOverrides(themes.rules, themes[appearance], selector);
      for (const [tier, token] of tiers) {
        const foreground = resolve(vars.get(token), vars);
        const ratio = contrastRatio(foreground, resolve(vars.get(background), vars));
        assert.ok(
          ratio >= 4.5,
          `${appearance} ${role} ${tier} is ${formatColor(foreground)}: ${ratio.toFixed(2)}:1`,
        );
      }
    }
  }
});

test("both dark appearance paths resolve the same bubble tints", async () => {
  const themes = await themePaths();
  for (const tint of BUBBLE_TINTS) {
    const explicitDark = formatColor(resolve(themes.dark.get(tint), themes.dark));
    const systemDark = formatColor(resolve(themes.systemDark.get(tint), themes.systemDark));
    // A reader who picks Dark and a reader whose device is dark must see the
    // same conversation. Defining these only under data-theme="dark" broke it.
    assert.equal(systemDark, explicitDark, `${tint} must agree between the two dark paths`);
  }
  // And the dark tints must actually differ from the light ones, or the two
  // paths would "agree" by both being wrong.
  const lightSelf = formatColor(resolve(themes.light.get("--bubble-self-bg"), themes.light));
  const darkSelf = formatColor(resolve(themes.dark.get("--bubble-self-bg"), themes.dark));
  assert.notEqual(darkSelf, lightSelf);
});

test("bubble tints are declared once and derive from the theme accents", async () => {
  const { css } = await themePaths();
  for (const tint of BUBBLE_TINTS) {
    const declarationsFound = css.match(new RegExp(`${tint}\\s*:`, "g")) ?? [];
    // One declaration, in the base :root block. Repeating the values per
    // appearance is exactly how the system-dark path was missed before.
    assert.equal(declarationsFound.length, 1, `${tint} must be declared exactly once`);
  }
  // Deriving from --teal/--amber mixed into --paper-raised is what makes one
  // declaration serve all three paths, and keeps the text contrast safe: the
  // wash stays close to the surface that --ink was chosen for.
  const self = css.match(/--bubble-self-bg:([^;]+);/)?.[1] ?? "";
  const agent = css.match(/--bubble-agent-bg:([^;]+);/)?.[1] ?? "";
  assert.match(self, /color-mix\(in srgb, var\(--teal\)[\d. ]+%, var\(--paper-raised\)\)/);
  assert.match(agent, /color-mix\(in srgb, var\(--amber\)[\d. ]+%, var\(--paper-raised\)\)/);
});

test("forced colors reaches the failed agent card too", async () => {
  const themes = await themePaths();
  // A failed answer is three classes deep, so the two-class forced-colors rule
  // loses to it on specificity and the system colors never apply.
  const selector = ".event-card.event-bubble-agent.event-agent_response-failed";
  const forced = themes.rules.filter((rule) =>
    (rule.media ?? "").includes("forced-colors")
    && rule.selector.split(",").map((part) => part.trim()).includes(selector));
  assert.ok(forced.length > 0, `forced-colors must cover ${selector}`);
  const forcedDeclarations = new Map(forced.flatMap((rule) => [...declarations(rule.body)]));
  assert.equal(forcedDeclarations.get("background"), "Canvas");
  assert.equal(forcedDeclarations.get("color"), "CanvasText");
});

test("a self-authored agent request keeps its coral request accent", async () => {
  const styles = await readFile(stylesPath, "utf8");
  // .event-agent_request marks a request with a coral left edge. The bubble tint
  // sets border-color on all four sides at a higher specificity, so without this
  // the green card silently loses the marker.
  assert.match(
    styles,
    /\.event-card\.event-bubble-self\.event-agent_request \{[\s\S]*?border-left-color: var\(--coral\);/,
  );
});

test("the timeline tints bubbles by role and keeps failures on the warning wash", async () => {
  const [styles, main, domain] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(domainPath, "utf8"),
  ]);
  assert.match(styles, /\.event-card\.event-bubble-self \{[\s\S]*?background: var\(--bubble-self-bg\);/);
  assert.match(styles, /\.event-card\.event-bubble-agent \{[\s\S]*?background: var\(--bubble-agent-bg\);/);
  // These have to outrank the later generic .event-card layers without !important.
  const bubbleRule = styles.indexOf(".event-card.event-bubble-self");
  assert.ok(bubbleRule > styles.lastIndexOf(".event-card {"), "Bubble tints must follow the generic card rules");
  // A failed answer is agent-produced but must not read as an ordinary one.
  assert.match(styles, /\.event-card\.event-bubble-agent\.event-agent_response-failed \{[\s\S]*?background: var\(--amber-wash\);/);
  assert.match(main, /eventBubbleRole\(event, state\.currentUser\?\.id/);
  assert.match(main, /classList\.add\("event-bubble-self"\)/);
  assert.match(main, /classList\.add\("event-bubble-agent"\)/);
  assert.match(domain, /export function eventBubbleRole\(/);
});
