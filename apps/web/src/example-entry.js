// This classic bundle starts before the application and never imports remote code.
const raw = window.name ? JSON.parse(window.name) : Object.fromEntries(new URLSearchParams(location.search));
const config = { ...raw, layout: raw.layout === 'mobile' ? 'mobile' : 'desktop' };
const query = new URLSearchParams(config);
window.__examplePresentation = config;
const memory = new Map();
const storage = { getItem: (key) => memory.get(String(key)) ?? null,
  setItem: (key, value) => memory.set(String(key), String(value)), removeItem: (key) => memory.delete(String(key)),
  clear: () => memory.clear(), key: (index) => [...memory.keys()][index] ?? null, get length() { return memory.size; } };
Object.defineProperty(window, 'localStorage', { value: storage });
Object.defineProperty(window, 'sessionStorage', { value: storage });
const locale = query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
storage.setItem('gt-lang', locale);
storage.setItem('gatherthread.settings.v1', JSON.stringify({ version: 12, general: { locale }, appearance: { theme: query.get('theme') ?? 'system' } }));
// Defense in depth alongside opaque-origin sandbox + connect-src 'none'.
window.fetch = () => Promise.reject(new Error('Example mode does not access a server.'));
window.WebSocket = class { constructor() { throw new Error('Example mode has no runtime connection.'); } };
document.documentElement.dataset.example = 'true';
document.addEventListener('click', (event) => { const anchor = event.target.closest?.('a'); if (anchor && !anchor.getAttribute('href')?.startsWith('#')) event.preventDefault(); }, true);
// The sandbox forbids native form submission. Run only the shell's local
// handlers so saving example settings never navigates or needs allow-forms.
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('button, input');
  if (button?.type !== 'submit' || !button.form || button.disabled) return;
  event.preventDefault();
  if (button.form.reportValidity()) button.form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button }));
}, true);
import('./main.js');
