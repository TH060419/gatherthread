import test from 'node:test';
import assert from 'node:assert/strict';
import { mountExampleProject } from '../src/example-project-view.js';

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function fixture() {
  const nodes = new Map(); const requests = []; const frames = new Map(); let frameId = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.children = []; }
    set id(value) { this.identifier = value; nodes.set(value, this); }
    set innerHTML(value) { for (const match of value.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/gu)) { const node = new Element(match[1]); node.id = match[2]; } }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'srcdoc') delete this.srcdoc; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, callback, options = {}) { const entries = this.listeners.get(type) ?? []; entries.push({ callback, once: options.once }); this.listeners.set(type, entries); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.callback !== callback)); }
    fire(type, event = {}) { for (const entry of [...(this.listeners.get(type) ?? [])]) { if (entry.once) this.removeEventListener(type, entry.callback); entry.callback({ target: this, ...event }); } }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
  }
  const document = { documentElement: { lang: 'en' }, body: new Element('body'), createElement: tag => new Element(tag), defaultView: {
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
  } };
  document.getElementById = id => nodes.get(id);
  const view = mountExampleProject({ document, api: { getProjectCodeSnapshot() {
    let resolve; const promise = new Promise(done => { resolve = done; }); requests.push(resolve); return promise;
  } } });
  return { view, requests, frame: nodes.get('example-project-frame'), dialog: nodes.get('example-project-dialog'),
    version: nodes.get('example-project-version'), status: nodes.get('example-project-status'),
    paint() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); } };
}

test('result preview becomes interactive only after its current authored iframe load', async () => {
  const f = fixture(); f.view.open();
  assert.equal(f.frame.getAttribute('aria-busy'), 'true'); assert.equal(f.frame.inert, true); assert.equal(f.frame.style.pointerEvents, 'none');
  f.requests[0]({ snapshot: { commit: '1'.repeat(40), files: [{ path: 'index.html', content: '<script>untrusted()</script>' }] } }); await flush();
  assert.equal(f.frame.getAttribute('aria-busy'), 'true'); assert.match(f.status.textContent, /Reading example/u);
  assert.doesNotMatch(f.frame.srcdoc, /untrusted\(\)/u);
  f.frame.fire('load'); assert.equal(f.frame.getAttribute('aria-busy'), 'true');
  assert.equal(f.frame.inert, false); assert.equal(f.frame.style.pointerEvents, 'none');
  assert.match(f.status.textContent, /Try the signup button/u, 'layout-changing copy is applied before readiness');
  f.paint(); assert.equal(f.frame.getAttribute('aria-busy'), 'true');
  f.paint(); assert.equal(f.frame.getAttribute('aria-busy'), 'false'); assert.equal(f.frame.inert, false);
  assert.equal(f.frame.style.pointerEvents, ''); assert.match(f.status.textContent, /Try the signup button/u);
});

test('version changes and close fence late readiness callbacks without clearing isolation', async () => {
  const f = fixture(); f.view.open(); f.requests[0]({ snapshot: { commit: '1'.repeat(40) } }); await flush();
  const staleLoad = f.frame.listeners.get('load')[0].callback;
  f.version.value = 'branch-maya'; f.version.fire('change'); staleLoad();
  assert.equal(f.frame.getAttribute('aria-busy'), 'true'); assert.equal(f.frame.inert, true);
  f.requests[1]({ snapshot: { commit: '3'.repeat(40) } }); await flush();
  assert.equal(f.frame.listeners.get('load').length, 1, 'the old readiness listener is removed');
  const pendingLoad = f.frame.listeners.get('load')[0].callback;
  f.view.close(); pendingLoad();
  assert.equal(f.frame.srcdoc, undefined); assert.equal(f.frame.inert, true); assert.equal(f.frame.getAttribute('aria-busy'), 'true');
  assert.equal(f.frame.listeners.get('load').length, 0);
});

test('closing during paint readiness cannot unlock or retain the executed document', async () => {
  const f = fixture(); f.view.open(); f.requests[0]({ snapshot: { commit: '1'.repeat(40) } }); await flush();
  f.frame.fire('load'); f.paint(); f.view.close(); f.paint();
  assert.equal(f.frame.getAttribute('aria-busy'), 'true'); assert.equal(f.frame.inert, true); assert.equal(f.frame.srcdoc, undefined);
});
