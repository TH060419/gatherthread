// Authored, dependency-free demo code. No account, provider or user files enter
// this module. The same files supply the conversation, review and live preview.
export const EXAMPLE_REVIEWED_COMMIT = '3'.repeat(40);

export function exampleProjectFiles(locale = 'en', improved = false) {
  const zh = locale === 'zh-CN';
  const text = (en, cn) => zh ? cn : en;
  const confirmation = text(improved ? 'You’re signed up! See you Saturday.' : 'You’re signed up.', improved ? '报名成功！周六见。' : '报名成功。');
  const source = `const signupButton = document.getElementById('signup');
const confirmation = document.getElementById('confirmation');

signupButton.addEventListener('click', () => {
  confirmation.textContent = ${JSON.stringify(confirmation)};
  confirmation.hidden = false;
  signupButton.textContent = ${JSON.stringify(text('Signed up', '已报名'))};
  signupButton.disabled = true;
});
`;
  const html = `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${text('Club event signup', '社团活动报名')}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <p class="eyebrow">${text('Saturday club meetup', '周末社团活动')}</p>
    <h1>${text('A little time outdoors.', '这个周六，一起出发。')}</h1>
    <p>${text('Meet your teammates and enjoy an afternoon together.', '认识新伙伴，一起度过轻松的下午。')}</p>
    <dl><dt>${text('When', '时间')}</dt><dd>${text('Saturday at 2 pm', '周六下午两点')}</dd>
      <dt>${text('Where', '地点')}</dt><dd>${text('school sports field', '学校操场')}</dd></dl>
    <button type="button" id="signup">${text('Sign me up', '我要报名')}</button>
    <p id="confirmation" role="status" hidden></p>
    <p class="note">${text('Demo only · no signup data is sent or saved.', '示例页面 · 不发送或保存实际报名信息。')}</p>
  </main>
  <script src="src/signup.js"></script>
</body>
</html>
`;
  const css = `* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #f2f8f5; color: #18382e; font: 18px/1.6 system-ui, sans-serif; }
main { width: min(580px, calc(100% - 40px)); margin: 24px auto; padding: 36px;
  background: white; border: 1px solid #dae9e3; border-radius: 24px; }
.eyebrow { color: #087f69; font-size: 14px; font-weight: 600; }
h1 { margin: 12px 0; font-size: clamp(28px, 6vw, 44px); line-height: 1.2; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 24px; margin: 28px 0; }
dt { color: #59716a; } dd { margin: 0; }
button { min-height: 48px; padding: 12px 24px; border: 0; border-radius: 12px;
  background: #087f69; color: white; font: inherit; cursor: pointer; }
button:focus-visible { outline: 3px solid #087f69; outline-offset: 4px; }
button:disabled { background: #44665d; cursor: default; }
#confirmation { font-weight: 600; color: #087f69; }
.note { margin-top: 28px; font-size: 14px; color: #59716a; }
@media (max-width: 420px) { main { padding: 24px; } }
`;
  const tests = `const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { join } = require('node:path');
const source = readFileSync(join(__dirname, '../src/signup.js'), 'utf8');

function page() {
  let click;
  const button = { disabled: false, textContent: '', addEventListener(type, handler) { click = handler; } };
  const confirmation = { hidden: true, textContent: '' };
  runInNewContext(source, { document: { getElementById: id => id === 'signup' ? button : confirmation } });
  return { button, confirmation, click };
}
test('confirmation starts hidden', () => {
  assert.equal(page().confirmation.hidden, true);
});
test('clicking confirms signup', () => {
  const view = page(); view.click();
  assert.equal(view.confirmation.hidden, false);
  assert.ok(view.confirmation.textContent.length > 0);
});
test('the button prevents repeated signup', () => {
  const view = page(); view.click();
  const message = view.confirmation.textContent;
  assert.equal(view.button.disabled, true);
  view.click(); assert.equal(view.confirmation.textContent, message);
});
`;
  return [
    { path: 'index.html', description: text('Page content', '页面内容'), content: html },
    { path: 'styles.css', description: text('Appearance', '页面外观'), content: css },
    { path: 'src/signup.js', description: text('What the button does', '按钮点击后的动作'), content: source },
    { path: 'tests/signup.test.cjs', description: text('Three behavior checks', '三个行为检查'), content: tests },
    { path: 'package.json', description: text('Run the checks', '运行检查的入口'), content: JSON.stringify({ name: 'club-signup', private: true, scripts: { test: 'node --test tests/signup.test.cjs' } }, null, 2) + '\n' },
    { path: 'README.md', description: text('How to try the page', '如何使用这个页面'), content: text(
      '# Club signup page\n\nOpen index.html in a browser, then click “Sign me up”.\nThis frontend demo sends and saves no signup data. Refreshing resets the page.\n\n## Files\n- index.html: event content\n- styles.css: appearance\n- src/signup.js: button behavior\n- tests/signup.test.cjs: three behavior checks\n\n## Check\nWith Node.js installed, run npm test in this folder. No package installation is needed.\n',
      '# 社团活动报名页\n\n用浏览器打开 index.html，再点“我要报名”。\n这是前端示例，不发送或保存实际报名数据；刷新后回到初始状态。\n\n## 文件\n- index.html：活动内容\n- styles.css：页面外观\n- src/signup.js：按钮动作\n- tests/signup.test.cjs：三个行为检查\n\n## 检查\n已安装 Node.js 时，在此文件夹运行 npm test。无需安装额外依赖。\n') },
  ];
}

// Inline only the authored demo's exact CSS/JS for the existing opaque sandbox.
// This helper never accepts user HTML or code; its fixed public nonce matches
// the example document's restrictive CSP. No external resource is requested.
export function examplePreviewDocument(locale, improved = false) {
  const files = new Map(exampleProjectFiles(locale, improved).map(file => [file.path, file.content]));
  return files.get('index.html')
    .replace('<link rel="stylesheet" href="styles.css">', `<style>${files.get('styles.css')}</style>`)
    .replace('<script src="src/signup.js"></script>', `<script nonce="gatherthread-example-v1">${files.get('src/signup.js')}</script>`);
}
