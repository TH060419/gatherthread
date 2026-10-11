import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "source");
const dirs = Object.fromEntries(["svg", "png", "pdf", "eps"].map((name) => [name, path.join(root, name)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PDFTOPS = "/opt/homebrew/bin/pdftops";
const warmWhite = "#FBFAF7";
const dark = "#08111F";
const black = "#111318";

function innerSvg(file) {
  const text = fs.readFileSync(path.join(source, file), "utf8");
  const match = text.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!match) throw new Error(`Invalid SVG: ${file}`);
  return match[1].replace(/<!--[^]*?-->/g, "").trim();
}

// The approved clean Bézier mark and outlined Helvetica Neue Regular wordmark
// are the only production masters. Raster traces remain reference evidence only.
const markColor = innerSvg("mark-master.svg");
const wordBlack = innerSvg("wordmark-regular-outline.svg")
  .replace(/<rect[^>]*\/>/g, "")
  .replace(/fill="rgb\(0%, 0%, 0%\)"/g, 'fill="currentColor"');
const mono = (body) => body
  .replace(/stroke="url\(#[^)]+\)"/g, 'stroke="currentColor"')
  .replace(/fill="url\(#[^)]+\)"/g, 'fill="currentColor"')
  .replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="currentColor"')
  .replace(/stop-color="#[0-9A-Fa-f]{6}"/g, 'stop-color="currentColor"');

function document(viewBox, body, background = null) {
  const [, , width, height] = viewBox.split(" ").map(Number);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}" width="${width}" height="${height}" role="img" aria-label="GatherThread logo">\n` +
    `${background ? `<rect width="${width}" height="${height}" fill="${background}"/>\n` : ""}${body}\n</svg>\n`;
}

function mark({ color = false, background = null } = {}) {
  const body = color ? markColor : `<g color="${background === dark ? "#FFFFFF" : black}">${mono(markColor)}</g>`;
  return document("0 0 590 380", body, background);
}

function lockup({ color = false, background = null, lightWord = false } = {}) {
  const markBody = color ? markColor : mono(markColor);
  const wordBody = mono(wordBlack);
  const ink = lightWord || background === dark ? "#FFFFFF" : black;
  const body = `<g transform="translate(20 9) scale(.3333333333)"${color ? "" : ` color="${ink}"`}>${markBody}</g>\n` +
    `<g color="${ink}"><svg x="220" y="0" width="650" height="150" viewBox="0 0 622 143.84375">${wordBody}</svg></g>`;
  return document("0 0 890 145", body, background);
}

function appIcon(background) {
  return document("0 0 512 512", `<rect x="8" y="8" width="496" height="496" rx="112" fill="${background}"/>\n` +
    `<g transform="translate(18 103) scale(.807)">${markColor}</g>`);
}

const assets = new Map([
  ["mark-color-transparent-light", mark({ color: true })],
  ["mark-color-transparent-dark", mark({ color: true })],
  ["mark-color-on-white", mark({ color: true, background: warmWhite })],
  ["mark-color-on-dark", mark({ color: true, background: dark })],
  ["mark-monochrome-black-transparent", mark()],
  ["mark-monochrome-white-transparent", document("0 0 590 380", `<g color="#FFFFFF">${mono(markColor)}</g>`)],
  ["lockup-color-transparent-light", lockup({ color: true })],
  ["lockup-color-transparent-dark", lockup({ color: true, lightWord: true })],
  ["lockup-color-on-white", lockup({ color: true, background: warmWhite })],
  ["lockup-color-on-dark", lockup({ color: true, background: dark, lightWord: true })],
  ["lockup-monochrome-black-transparent", lockup()],
  ["lockup-monochrome-white-transparent", lockup({ lightWord: true })],
  ["app-icon-color-on-white", appIcon(warmWhite)],
  ["app-icon-color-on-dark", appIcon(dark)],
]);

const sheet = document("0 0 1600 1050", `
<rect width="1600" height="1050" fill="#F1F0ED"/>
<rect x="60" y="60" width="1480" height="420" rx="28" fill="${warmWhite}"/>
<g transform="translate(150 95) scale(.72)">${markColor}</g>
<g transform="translate(650 180) scale(1.16)" color="${black}">${mono(wordBlack)}</g>
<rect x="60" y="510" width="1480" height="360" rx="28" fill="${dark}"/>
<g transform="translate(150 555) scale(.65)">${markColor}</g>
<g transform="translate(650 615) scale(1.16)" color="#FFFFFF">${mono(wordBlack)}</g>
<g transform="translate(200 920) scale(.24)" color="${black}">${mono(markColor)}</g>
<g transform="translate(650 920) scale(.24)" color="#FFFFFF">${mono(markColor)}</g>
<text x="1010" y="960" font-family="Helvetica Neue,Arial,sans-serif" font-size="24" fill="#4B4D52" letter-spacing="2">CANONICAL FINAL</text>`);
assets.set("gatherthread-logo-brand-sheet", sheet);

for (const [name, svg] of assets) fs.writeFileSync(path.join(dirs.svg, `${name}.svg`), svg);

const widths = (name) => name.startsWith("mark-") ? [512, 1024, 2048]
  : name.startsWith("lockup-") ? [1200, 2400]
    : name.startsWith("app-") ? [256, 512, 1024] : [1600, 2400];

for (const [name] of assets) {
  for (const width of widths(name)) {
    let raster = sharp(path.join(dirs.svg, `${name}.svg`), { density: 300 })
      .resize({ width });
    // Baked white/dark lockups and marks are deliberately opaque. Keep alpha
    // only for transparent variants and the rounded app-icon canvas.
    if (!name.startsWith("app-icon-") && (name.endsWith("-on-white") || name.endsWith("-on-dark"))) {
      raster = raster.flatten({ background: name.endsWith("-on-dark") ? dark : warmWhite });
    }
    await raster.png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(path.join(dirs.png, `${name}-${width}px.png`));
  }
}

function svgToPdf(name) {
  const svg = fs.readFileSync(path.join(dirs.svg, `${name}.svg`), "utf8");
  const [, width, height] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const html = path.join(source, `.${name}.html`);
  const pdf = path.join(dirs.pdf, `${name}.pdf`);
  fs.writeFileSync(html, `<!doctype html><style>@page{size:${width}px ${height}px;margin:0}*{margin:0}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`);
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, `file://${html}`], { stdio: "ignore" });
  fs.rmSync(html);
  execFileSync(PDFTOPS, ["-eps", pdf, path.join(dirs.eps, `${name}.eps`)]);
}

for (const [name] of assets) svgToPdf(name);
console.log(`Built ${assets.size} canonical logo variants from the approved clean Bézier master.`);
