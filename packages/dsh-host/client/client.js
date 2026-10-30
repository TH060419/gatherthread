window.__ModuleLoader__.load({ id: "@gatherthread/dsh-host", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

const React = require("react");
// Public, host-provided DSH atoms. Older hosts keep the accessible HTML path.
let DshUI = {};
try { DshUI = require("@deepseek-ai/dsh-client-ui-primitives"); } catch {}
function workspaceElement(type, props, ...children) {
  if (type === 'button' && DshUI.Button) {
    return React.createElement(DshUI.Button, { size: 'sm', variant: props?.className?.includes('gtw-primary') ? 'primary' : 'outline', ...props, className: `gtw-native-button ${props?.className || ''}` }, ...children);
  }
  return React.createElement(type, props, ...children);
}
function workspaceIcon(name, fallback = '') {
  return DshUI[name] ? React.createElement(DshUI[name], { size: 16, 'aria-hidden': true }) : fallback;
}
function WorkspaceDialog({ title, onClose, busy, className = '', children }) {
  const close = () => { if (!busy) onClose(); };
  if (DshUI.Modal) return React.createElement(DshUI.Modal, {
    open: true, title, closeLabel: workspaceText('关闭', 'Close'), onClose: close,
    className: `gtw-dialog gtw-native-dialog ${className}`, contentClassName: 'gtw-modal-scroll',
  }, children);
  return workspaceElement('dialog', { className: `gtw-dialog ${className}`, 'aria-label': title,
    ref: node => { if (node && !node.open) node.showModal(); },
    onCancel: event => { event.preventDefault(); close(); } },
  workspaceElement('div', { className: 'gtw-dialog-heading' }, workspaceElement('h2', null, title),
    workspaceElement('button', { type: 'button', disabled: busy, 'aria-label': workspaceText('关闭', 'Close'), onClick: close }, workspaceIcon('IconCloseOutlineRegular', '×'))),
  workspaceElement('div', { className: 'gtw-dialog-body' }, children));
}
const STATUS_PATH = "/api/gatherthread.status";
// Generated from the Web avatar catalog by build-dsh-plugin.mjs, never arbitrary URLs.
const WORKSPACE_AVATARS = {"cat":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2080%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2220%22%20fill%3D%22%23dceee9%22%2F%3E%3Cpath%20d%3D%22M18%2037V13l20%2015M62%2037V13L42%2028%22%20fill%3D%22%23e9b969%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2246%22%20rx%3D%2225%22%20ry%3D%2224%22%20fill%3D%22%23e9b969%22%2F%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2249%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2253%22%20rx%3D%2210%22%20ry%3D%227%22%20fill%3D%22%23fff4e7%22%2F%3E%3Cpath%20d%3D%22M37%2050h6l-3%204z%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22M40%2054v3%22%20stroke%3D%22%23253442%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M19%2049h12m-11%207%2011-2m18-5h12m-12%205%2011%202%22%20stroke%3D%22%23805e35%22%20stroke-width%3D%221.5%22%2F%3E%3C%2Fsvg%3E","fox":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2080%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2220%22%20fill%3D%22%23f7e7d9%22%2F%3E%3Cpath%20d%3D%22m17%2036%204-25%2019%2019m23%206-4-25-19%2019%22%20fill%3D%22%23e79054%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2246%22%20rx%3D%2225%22%20ry%3D%2224%22%20fill%3D%22%23e79054%22%2F%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2249%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2253%22%20rx%3D%2210%22%20ry%3D%227%22%20fill%3D%22%23fff4e7%22%2F%3E%3Cpath%20d%3D%22M37%2050h6l-3%204z%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22M40%2054v3%22%20stroke%3D%22%23253442%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22m21%2045%2019%2013%2019-13-9%2020H30z%22%20fill%3D%22%23fff4e7%22%2F%3E%3Ccircle%20cx%3D%2240%22%20cy%3D%2253%22%20r%3D%223%22%20fill%3D%22%23253442%22%2F%3E%3C%2Fsvg%3E","bear":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2080%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2220%22%20fill%3D%22%23e7e1f1%22%2F%3E%3Ccircle%20cx%3D%2221%22%20cy%3D%2224%22%20r%3D%2211%22%20fill%3D%22%23ac8b72%22%2F%3E%3Ccircle%20cx%3D%2259%22%20cy%3D%2224%22%20r%3D%2211%22%20fill%3D%22%23ac8b72%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2246%22%20rx%3D%2225%22%20ry%3D%2224%22%20fill%3D%22%23ac8b72%22%2F%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2249%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2253%22%20rx%3D%2210%22%20ry%3D%227%22%20fill%3D%22%23fff4e7%22%2F%3E%3Cpath%20d%3D%22M37%2050h6l-3%204z%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22M40%2054v3%22%20stroke%3D%22%23253442%22%20stroke-width%3D%222%22%2F%3E%3C%2Fsvg%3E","rabbit":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2080%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2220%22%20fill%3D%22%23f5e0e5%22%2F%3E%3Cellipse%20cx%3D%2228%22%20cy%3D%2223%22%20rx%3D%228%22%20ry%3D%2220%22%20fill%3D%22%23fff5ed%22%2F%3E%3Cellipse%20cx%3D%2252%22%20cy%3D%2223%22%20rx%3D%228%22%20ry%3D%2220%22%20fill%3D%22%23fff5ed%22%2F%3E%3Cellipse%20cx%3D%2228%22%20cy%3D%2220%22%20rx%3D%223%22%20ry%3D%2212%22%20fill%3D%22%23eab3bd%22%2F%3E%3Cellipse%20cx%3D%2252%22%20cy%3D%2220%22%20rx%3D%223%22%20ry%3D%2212%22%20fill%3D%22%23eab3bd%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2246%22%20rx%3D%2225%22%20ry%3D%2224%22%20fill%3D%22%23fff5ed%22%2F%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2249%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2253%22%20rx%3D%2210%22%20ry%3D%227%22%20fill%3D%22%23fff4e7%22%2F%3E%3Cpath%20d%3D%22M37%2050h6l-3%204z%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22M40%2054v3%22%20stroke%3D%22%23253442%22%20stroke-width%3D%222%22%2F%3E%3C%2Fsvg%3E","penguin":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2080%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2220%22%20fill%3D%22%23dce9f7%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2246%22%20rx%3D%2225%22%20ry%3D%2224%22%20fill%3D%22%233c5367%22%2F%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2249%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2253%22%20rx%3D%2210%22%20ry%3D%227%22%20fill%3D%22%23fff4e7%22%2F%3E%3Cpath%20d%3D%22M37%2050h6l-3%204z%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22M40%2054v3%22%20stroke%3D%22%23253442%22%20stroke-width%3D%222%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2246%22%20rx%3D%2218%22%20ry%3D%2219%22%20fill%3D%22%23fff5ed%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22m35%2051%205%206%205-6z%22%20fill%3D%22%23e9b969%22%2F%3E%3C%2Fsvg%3E","owl":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2080%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2220%22%20fill%3D%22%23f0edd3%22%2F%3E%3Cpath%20d%3D%22m18%2035-3-20%2025%2013%2025-13-3%2020%22%20fill%3D%22%238f9c74%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2246%22%20rx%3D%2225%22%20ry%3D%2224%22%20fill%3D%22%238f9c74%22%2F%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2249%22%20cy%3D%2242%22%20r%3D%222.5%22%20fill%3D%22%23253442%22%2F%3E%3Cellipse%20cx%3D%2240%22%20cy%3D%2253%22%20rx%3D%2210%22%20ry%3D%227%22%20fill%3D%22%23fff4e7%22%2F%3E%3Cpath%20d%3D%22M37%2050h6l-3%204z%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22M40%2054v3%22%20stroke%3D%22%23253442%22%20stroke-width%3D%222%22%2F%3E%3Ccircle%20cx%3D%2230%22%20cy%3D%2243%22%20r%3D%2210%22%20fill%3D%22%23fff5ed%22%2F%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2243%22%20r%3D%2210%22%20fill%3D%22%23fff5ed%22%2F%3E%3Ccircle%20cx%3D%2230%22%20cy%3D%2243%22%20r%3D%223%22%20fill%3D%22%23253442%22%2F%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2243%22%20r%3D%223%22%20fill%3D%22%23253442%22%2F%3E%3Cpath%20d%3D%22m36%2052%204%206%204-6z%22%20fill%3D%22%23e9b969%22%2F%3E%3C%2Fsvg%3E","agent":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2080%22%3E%3Crect%20x%3D%222%22%20y%3D%222%22%20width%3D%2276%22%20height%3D%2276%22%20rx%3D%2224%22%20fill%3D%22%23fff5d6%22%2F%3E%3Cpath%20d%3D%22M40%2015v10%22%20stroke%3D%22%2375531f%22%20stroke-width%3D%225%22%2F%3E%3Ccircle%20cx%3D%2240%22%20cy%3D%2213%22%20r%3D%225%22%20fill%3D%22%2375531f%22%2F%3E%3Crect%20x%3D%2216%22%20y%3D%2225%22%20width%3D%2248%22%20height%3D%2238%22%20rx%3D%2212%22%20fill%3D%22%2375531f%22%2F%3E%3Ccircle%20cx%3D%2230%22%20cy%3D%2241%22%20r%3D%224%22%20fill%3D%22%23fff5d6%22%2F%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2241%22%20r%3D%224%22%20fill%3D%22%23fff5d6%22%2F%3E%3Cpath%20d%3D%22M30%2053h20%22%20stroke%3D%22%23fff5d6%22%20stroke-width%3D%223%22%2F%3E%3C%2Fsvg%3E"};
// Approved final-f asset; refreshed from logo/svg/mark-color-transparent-light.svg by the build.
const WORKSPACE_MARK = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB2aWV3Qm94PSIwIDAgNTkwIDM4MCIgd2lkdGg9IjU5MCIgaGVpZ2h0PSIzODAiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0iR2F0aGVyVGhyZWFkIGxvZ28iPgo8ZGVmcz4KICA8bGluZWFyR3JhZGllbnQgaWQ9ImN5YW4iIHgxPSIyMCIgeTE9IjQwIiB4Mj0iNTYwIiB5Mj0iMTg2IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzIwQzFEQyIvPjxzdG9wIG9mZnNldD0iLjQzIiBzdG9wLWNvbG9yPSIjMkFDOUU1Ii8+PHN0b3Agb2Zmc2V0PSIuNTciIHN0b3AtY29sb3I9IiM2MEMwRUMiLz48c3RvcCBvZmZzZXQ9Ii42OCIgc3RvcC1jb2xvcj0iIzlBOTZGNSIvPjxzdG9wIG9mZnNldD0iLjgwIiBzdG9wLWNvbG9yPSIjQzk4NkU5Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRjQ3QkJDIi8+PC9saW5lYXJHcmFkaWVudD4KICA8bGluZWFyR3JhZGllbnQgaWQ9ImJsdWUiIHgxPSIyMCIgeTE9IjEzNSIgeDI9IjMzMCIgeTI9IjI0MSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIHN0b3AtY29sb3I9IiMyRTk2RjUiLz48c3RvcCBvZmZzZXQ9Ii40OCIgc3RvcC1jb2xvcj0iIzRBOEVGNiIvPjxzdG9wIG9mZnNldD0iLjcyIiBzdG9wLWNvbG9yPSIjNzY4OUYzIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjQTc4OUYwIi8+PC9saW5lYXJHcmFkaWVudD4KICA8bGluZWFyR3JhZGllbnQgaWQ9InZpb2xldCIgeDE9IjIwIiB5MT0iMjI4IiB4Mj0iMzMwIiB5Mj0iMTI5IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iI0E3NjZGMCIvPjxzdG9wIG9mZnNldD0iLjQ2IiBzdG9wLWNvbG9yPSIjQjI3M0VEIi8+PHN0b3Agb2Zmc2V0PSIuNzIiIHN0b3AtY29sb3I9IiNCNzg5RjIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNBMzlDRjgiLz48L2xpbmVhckdyYWRpZW50PgogIDxsaW5lYXJHcmFkaWVudCBpZD0icGluayIgeDE9IjIwIiB5MT0iMzIyIiB4Mj0iNDIwIiB5Mj0iMTg2IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iI0Y2NkRCOSIvPjxzdG9wIG9mZnNldD0iLjQ4IiBzdG9wLWNvbG9yPSIjRjM3OEJEIi8+PHN0b3Agb2Zmc2V0PSIuNjgiIHN0b3AtY29sb3I9IiNFQTgyQ0IiLz48c3RvcCBvZmZzZXQ9Ii44NCIgc3RvcC1jb2xvcj0iI0QyOEZFNSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0JCOTlGMSIvPjwvbGluZWFyR3JhZGllbnQ+CjwvZGVmcz4KPGcgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSI0MCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgPHBhdGggZD0iTTUwIDEzNSBIMTU4IEMyMTAgMTM1IDI0NSAyMTUgMjk4IDI0MCIgc3Ryb2tlPSJ1cmwoI2JsdWUpIiBzdHJva2UtbGluZWNhcD0iYnV0dCIvPgogIDxwYXRoIGQ9Ik01MCAyMjggSDE2MiBDMjE0IDIyOCAyNDcgMTQzIDI5OCAxMzAiIHN0cm9rZT0idXJsKCN2aW9sZXQpIiBzdHJva2UtbGluZWNhcD0iYnV0dCIvPgogIDxwYXRoIGQ9Ik01MCAzMjIgSDE3NCBDMjQ4IDMyMiAzMjIgMTg0IDQwNCAxODQgSDU0MCIgc3Ryb2tlPSJ1cmwoI3BpbmspIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8cGF0aCBkPSJNNTAgNDIgSDE2NyBDMjQxIDQyIDMyMCAxODQgNDA0IDE4NCBINTQwIiBzdHJva2U9InVybCgjY3lhbikiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L2c+CjxnPjxjaXJjbGUgY3g9IjUwIiBjeT0iNDIiIHI9IjI4IiBmaWxsPSIjMjBDMURDIi8+PGNpcmNsZSBjeD0iNTAiIGN5PSIxMzUiIHI9IjI4IiBmaWxsPSIjMkU5NkY1Ii8+PGNpcmNsZSBjeD0iNTAiIGN5PSIyMjgiIHI9IjI4IiBmaWxsPSIjQTc2NkYwIi8+PGNpcmNsZSBjeD0iNTAiIGN5PSIzMjIiIHI9IjI4IiBmaWxsPSIjRjY2REI5Ii8+PC9nPgo8L3N2Zz4K";
const RPC_CHANNEL = "/gatherthread";
const POLL_INTERVAL_MS = 2000;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CONNECTION_STATES = new Set(["connecting", "connected", "offline", "error", "stopped"]);
const SESSION_STATES = new Set(["connecting", "idle", "running", "offline", "error"]);
const AUTHORIZATION_STATES = new Set(["unpaired", "pairing", "paired"]);

const inject = ["slots", "connection", "sessions"];

function apply(ctx) {
  const workspaceMemory = { drafts: {}, attempts: {}, fileDrafts: {}, projectId: "", sessionId: "", connectionId: null };
  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "gatherthread" },
    () => GatherThreadWorkspace({ connection: ctx.connection, nativeSessions: ctx.sessions, memory: workspaceMemory, fileDrag: ctx.get?.('fileDrag')?.actions, nativeFiles: async (sessionId) => {
      const workspace = ctx.get?.('uiWorkspace'), sidebar = ctx.get?.('sidebarRight');
      if (typeof workspace?.openSession !== 'function' || typeof sidebar?.openTab !== 'function') throw new Error('workspace_native_unavailable');
      workspace.openSession(sessionId);
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (sidebar.mounted?.getSnapshot() !== sessionId) throw new Error('workspace_native_unavailable');
      sidebar.openTab('files');
    } })));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "gatherthread", order: 35, label: "GatherThread / 共序" },
    () => React.createElement("img", { src: WORKSPACE_MARK, alt: "", width: 24, height: 16 })));
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "gatherthread",
    order: 30,
    label: "GatherThread / 共序",
  }, () => GatherThreadStatusPanel({ connection: ctx.connection, sessions: ctx.sessions })));
}

function GatherThreadStatusPanel({ connection, sessions, syncProjectId }) {
  const [snapshot, setSnapshot] = React.useState(undefined);
  const [nativeState, setNativeState] = React.useState(undefined);
  const [catalog, setCatalog] = React.useState(undefined);
  const [unavailable, setUnavailable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [serverUrl, setServerUrl] = React.useState("");
  const [deviceName, setDeviceName] = React.useState("DeepSeek Harness");
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const visibleSessionSignature = React.useRef("");
  /** Recovery observed from both status polls and action responses. */
  const lastRecoverableError = React.useRef(undefined);

  const observeRouteRecovery = (next, configureResponse = false) => {
    const recovery = next?.recoverableError;
    // A failed configure is a new revoked choice even if the error code has not
    // changed. Steady polls must leave an operator's new selection alone.
    if (recovery === "route_unavailable"
      && (configureResponse || lastRecoverableError.current !== "route_unavailable")) {
      setCatalog(undefined);
      setProvider("");
      setModel("");
    }
    lastRecoverableError.current = recovery;
  };

  React.useEffect(() => {
    let disposed = false;
    let timer;
    let activeRequest;
    let transientFailures = 0;

    const refresh = async () => {
      activeRequest = new AbortController();
      let terminalFailure = false;
      try {
        const result = await readHostState(connection, activeRequest.signal);
        terminalFailure = result.terminalFailure;
        if (!disposed) {
          transientFailures = 0;
          const nextSignature = result.nativeState?.runtime.sessions
            .map((session) => session.sessionId)
            .sort()
            .join("\n") ?? "";
          if (nextSignature !== visibleSessionSignature.current) {
            visibleSessionSignature.current = nextSignature;
            void Promise.resolve(sessions.refresh()).catch(() => undefined);
          }
          setSnapshot(result.snapshot);
          setNativeState(result.nativeState);
          observeRouteRecovery(result.nativeState);
          setUnavailable(false);
          timer = setTimeout(refresh, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (disposed || activeRequest.signal.aborted) return;
        terminalFailure = error?.terminalFailure === true;
        setSnapshot(undefined);
        setNativeState(undefined);
        setCatalog(undefined);
        setUnavailable(true);
        if (!terminalFailure && transientFailures < MAX_TRANSIENT_RETRIES) {
          transientFailures += 1;
          timer = setTimeout(refresh, POLL_INTERVAL_MS * (2 ** (transientFailures - 1)));
        }
      }
    };

    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      activeRequest?.abort();
    };
  }, [connection, sessions]);

  const runAction = async (endpoint, payload, onSuccess) => {
    if (busy) return;
    const controller = new AbortController();
    setBusy(true);
    setNotice("");
    try {
      const value = await callNative(connection, endpoint, payload, controller.signal);
      const next = endpoint === "catalog/get" ? parseCatalog(value) : parseNativeState(value);
      if (endpoint === "catalog/get") {
        setCatalog(next);
        const selectedProvider = next.providers.find((entry) => entry.id === provider) ?? next.providers[0];
        setProvider(selectedProvider?.id ?? "");
        setModel((current) => selectedProvider?.models.some((entry) => entry.id === current)
          ? current : selectedProvider?.models[0]?.id ?? "");
      } else {
        observeRouteRecovery(next, endpoint === "connection/configure");
        setNativeState(next);
        setSnapshot(next.runtime);
        if (endpoint === "connection/configure") await sessions.refresh();
      }
      onSuccess?.(next);
    } catch {
      setNotice(endpoint.startsWith("github/") && githubEnglish()
        ? "GitHub sync did not finish. Check local sign-in, project access and the remote version; no files were forcibly overwritten."
        : endpoint.startsWith("code/") || endpoint.startsWith("github/")
        ? "代码同步未完成。请检查本机授权、项目权限和云端版本；不会强制覆盖文件。"
        : endpoint.startsWith("sync/")
        ? "上传操作未完成。请检查连接和会话权限后重试。"
        : "操作未完成。请检查服务器地址、当前授权和模型配置。");
    } finally {
      setBusy(false);
    }
  };

  if (syncProjectId) {
    const filtered = nativeState && { ...nativeState, codeSync: nativeState.codeSync?.filter(p => p.projectId === syncProjectId), githubSync: nativeState.githubSync?.filter(p => p.projectId === syncProjectId) };
    return React.createElement('section', { style: styles.panel },
      notice && React.createElement('p', { role: 'alert', style: styles.notice }, notice),
      !filtered ? React.createElement('p', { role: 'status' }, unavailable ? workspaceText('同步状态不可用，请检查 DSH 连接。', 'Sync status unavailable. Check DSH connection.') : workspaceText('正在读取同步状态…', 'Loading synchronization…'))
        : React.createElement(React.Fragment, null, renderCodeSyncControls(filtered, busy, runAction), renderCodeSyncControls(filtered, busy, runAction, true),
          !filtered.codeSync?.length && !filtered.githubSync?.length && React.createElement('p', null, workspaceText('本项目尚未连接到这台 DSH。请先完成连接。', 'Connect this project to this DSH first.'))));
  }
  const connectionState = snapshot?.connection ?? "connecting";
  const project = snapshot?.projectName ?? "GatherThread";
  const sessionRows = snapshot?.sessions ?? [];
  return React.createElement("section", {
    "data-gatherthread-status": connectionState,
    style: styles.panel,
  },
  React.createElement("div", { style: styles.heading },
    React.createElement("div", null,
      React.createElement("h2", { style: styles.title }, "GatherThread / 共序"),
      React.createElement("p", { style: styles.subtitle }, project)),
    React.createElement("span", { style: badgeStyle(connectionState) }, statusLabel(connectionState))),
  unavailable
    ? React.createElement("p", { role: "status", style: styles.notice }, "状态暂不可用。请在 Host 恢复后刷新页面。")
    : null,
  React.createElement("p", { style: styles.summary },
    `活跃会话 ${String(snapshot?.activeSessionCount ?? 0)} / ${String(sessionRows.length)}`),
  React.createElement("div", { style: styles.list },
    ...sessionRows.map((session) => {
      const sync = nativeState?.localSync?.find((item) => item.sessionId === session.sessionId);
      return React.createElement("div", {
      key: session.sessionId,
      style: styles.row,
    },
    React.createElement("div", { style: styles.sessionText },
      React.createElement("strong", { style: styles.sessionTitle }, session.title),
      React.createElement("span", { style: styles.sessionMeta },
        session.lastSyncedAt === undefined ? "尚未同步" : `最近同步 ${formatTime(session.lastSyncedAt)}`)),
    sync === undefined ? React.createElement("span", { style: badgeStyle(session.state) }, statusLabel(session.state))
      : React.createElement("div", { style: styles.syncActions },
        React.createElement("label", { style: styles.syncToggle },
          React.createElement("input", {
            type: "checkbox",
            checked: sync.automaticUpload,
            disabled: busy,
            onChange: (event) => void runAction("sync/set-auto-upload", {
              projectId: sync.projectId,
              sessionId: sync.sessionId,
              enabled: event.target.checked,
            }),
          }),
          "自动上传"),
        workspaceElement("button", {
          type: "button",
          disabled: busy || sync.uploadableLocalTurns < 1,
          style: styles.compactButton,
          onClick: () => void runAction("sync/upload", {
            projectId: sync.projectId,
            sessionId: sync.sessionId,
          }),
        }, sync.uploadableLocalTurns > 0 ? `手动上传 ${String(sync.uploadableLocalTurns)}` : "已上传")));
    })),
  nativeState === undefined || unavailable
    ? null
    : renderNativeControls({
      nativeState,
      catalog,
      busy,
      notice,
      serverUrl,
      deviceName,
      provider,
      model,
      setServerUrl,
      setDeviceName,
      setProvider,
      setModel,
      setCatalog,
      runAction,
    }),
  nativeState === undefined || unavailable ? null : renderCodeSyncControls(nativeState, busy, runAction, true),
  nativeState === undefined || unavailable ? null : renderCodeSyncControls(nativeState, busy, runAction));
}

function githubEnglish() {
  return typeof navigator !== "undefined" && typeof navigator.language === "string"
    && !/^zh(?:-|$)/iu.test(navigator.language);
}

function renderCodeSyncControls(state, busy, runAction, github = false) {
  const projects = github ? state.githubSync : state.codeSync;
  if (!projects?.length) return null;
  const label = (zh, en) => github && githubEnglish() ? en : zh;
  const actions = [
    ["code_sync_status", label("检查状态", "Check status")],
    ["code_upload", label("上传代码", "Upload code")],
    ["code_download", label("下载更新", "Download updates")],
    ["code_recover", label("恢复到新目录", "Recover to a new folder")],
  ];
  if (github) actions.push(["code_update", label("从主分支更新", "Update from base branch")]);
  const prefix = github ? "github_" : "";
  return React.createElement("section", { style: styles.connectionCard, "aria-label": github ? label("GitHub 项目代码同步", "GitHub project code sync") : "项目代码同步" },
    React.createElement("h3", { style: styles.sectionTitle }, github ? label("项目代码 · GitHub（推荐）", "Project code · GitHub (recommended)") : "项目代码 · GatherThread 云端"),
    React.createElement("p", { style: styles.muted },
      github ? label("本机直接与 GitHub 同步，代码和 GitHub 凭据不经过 GatherThread。GitHub 仓库成员权限独立管理；自动上传可能触发仓库 Actions。", "This device syncs directly with GitHub; source and credentials do not pass through GatherThread. GitHub access is managed separately, and automatic pushes may trigger Actions.") : "代码与会话上传独立。每位成员使用自己的云端分支；项目成员均可读取代码。上传前请检查源文件，不上传密钥或私人资料。"),
    github ? React.createElement("p", { style: styles.muted }, label("先在本机安装 Git 和 GitHub CLI；点击下方按钮会打开浏览器完成 GitHub 登录。", "Install Git and GitHub CLI on this device, then use the button below to open browser sign-in.")) : null,
    ...projects.map((project) => {
      const invoke = (action) => void runAction(github ? "github/action" : "code/action", { projectId: project.projectId, action: `${prefix}${action}` });
      const status = project.status;
      const enabled = github ? project.connection?.enabled === true : status?.enabled;
      return React.createElement("details", { key: project.projectId, style: { ...styles.row, display: "block" } },
        React.createElement("summary", { style: styles.sessionTitle }, project.projectName),
        React.createElement("div", { style: styles.form },
          github ? React.createElement("p", { style: styles.sessionMeta }, project.connection
            ? `${project.connection.repository} · ${label("主分支", "Base")} ${project.connection.base_branch} · ${label("成员分支", "My branch")} ${project.branch ?? label("尚未分配", "not assigned")}${enabled ? "" : ` · ${label("已暂停", "paused")}`}`
            : label("请由项目创建者在 GatherThread 的项目代码中绑定 GitHub 仓库。", "Ask the project owner to connect a GitHub repository in GatherThread project code settings.")) : null,
          github ? workspaceElement("button", { type: "button", style: styles.compactButton,
            disabled: busy || !project.connection,
            onClick: () => void runAction("github/connect", { projectId: project.projectId }),
          }, label("连接 GitHub · 打开浏览器", "Connect GitHub · Open browser")) : null,
          React.createElement("label", { style: styles.syncToggle },
            React.createElement("input", {
              type: "checkbox", checked: project.authorized, disabled: busy || (github && !project.authorized && !enabled),
              onChange: (event) => void runAction(github ? "github/authorize" : "code/authorize", {
                projectId: project.projectId, enabled: event.target.checked,
                ...(github && event.target.checked && project.connection ? {
                  repository: project.connection.repository, base_branch: project.connection.base_branch, revision: project.connection.revision,
                } : {}),
              }),
            }), github ? label("允许此 DSH 将本项目代码同步到上述 GitHub 仓库", "Allow this DSH to sync this project's code to the GitHub repository above") : "允许此 DSH 同步该项目代码"),
          React.createElement("p", { style: styles.muted }, label("仅访问此项目已经绑定的本地目录，不改动原 Git 分支或暂存区。下载要求本地没有未上传改动；恢复始终新建目录，不更换当前 Agent 工作目录。", "Only the local folder already bound to this project is accessed. Your original Git branch and index stay unchanged. Downloads require no unuploaded changes; recovery creates a separate folder.")),
          status ? React.createElement("p", { style: styles.sessionMeta },
            status.local_status_unknown ? label("已恢复云端副本；原工作区状态未知，请单独检查。", "A remote copy was recovered. Review the original workspace separately; its state is unknown.") : status.enabled
              ? `${status.file_count} ${label("个源文件", "source files")} · ${status.local_changes} ${label("项待上传", "pending changes")} · ${status.excluded_count} ${label("项已排除", "excluded")} · ${label("云端", "remote")} ${status.cloud_commit?.slice(0, 8) ?? label("尚无版本", "no version yet")}`
              : github ? label("GitHub 同步已暂停，请由项目创建者恢复。", "GitHub sync is paused; ask the project owner to resume it.") : "请先由项目创建者在 GatherThread 的「项目代码」中启用 Git。") : null,
          status?.needs_download ? React.createElement("p", { style: styles.notice }, label("云端有新版本。请先下载；本地有改动时请恢复到新目录比较，不会自动覆盖。", "A newer remote version exists. Download when your local files are clean; otherwise recover to a new folder for comparison.")) : null,
          project.authorized ? React.createElement("label", { style: styles.syncToggle },
            React.createElement("input", {
              type: "checkbox", checked: status?.automatic_upload === true,
              disabled: busy || (!enabled && !status?.automatic_upload),
              onChange: (event) => invoke(event.target.checked ? "code_auto_upload_enable" : "code_auto_upload_disable"),
            }), github ? label("空闲时自动上传本地代码至 GitHub", "Automatically upload local code to GitHub while idle") : "空闲时自动上传本地代码至云端") : null,
          React.createElement("div", { style: styles.syncActions }, ...actions.map(([action, actionLabel]) => (
            workspaceElement("button", {
              key: action, type: "button", style: styles.compactButton,
              disabled: busy || (!project.authorized && !(github && action === "code_sync_status")) || (action !== "code_sync_status" && !enabled),
              onClick: () => {
                if (action === "code_recover" && !window.confirm(label("将云端代码恢复到当前项目旁的新目录，原目录和会话保持不变。继续？", "Recover remote code to a new sibling folder? The original folder and conversations stay unchanged."))) return;
                invoke(action);
              },
            }, actionLabel)
          ))),
          status?.recovery_directory ? React.createElement("p", { role: "status", style: styles.notice },
            `${label("已恢复至项目同级目录：", "Recovered to a sibling folder: ")}${status.recovery_directory}${label("。在本地 Agent 中打开该目录继续工作；原会话保持不变。", ". Open that folder in your local Agent to continue; original conversations remain unchanged.")}`) : null,
          project.error ? React.createElement("p", { role: "status", style: styles.notice }, codeSyncErrorLabel(project.error, github)) : null,
        ));
    }));
}

function codeSyncErrorLabel(code, github = false) {
  if (github && githubEnglish()) {
    const labels = {
      code_sync_disabled: "Allow this DSH to sync project code first.",
      code_sync_busy: "The Agent is working. Try again after this turn finishes.",
      code_workspace_busy: "The Agent is working. Try again after this turn finishes.",
      code_sync_dirty: "Local changes are not uploaded. Upload them first, or recover remote code to a new folder for comparison.",
      code_sync_recovery_required: "The local folder is missing or a download was interrupted. Recover remote code to a new folder first.",
      code_sync_forbidden: "Code access was denied. Check this device's sign-in and project permissions.",
      code_sync_conflict: "The remote version changed. Download safely or recover to a new folder; nothing was overwritten.",
      code_conflict: "The remote version conflicted. Check the latest branch while preserving local changes.",
      code_stale_head: "A newer remote version exists. Recover to a new folder before comparing changes.",
      code_merge_conflict: "Branches conflict. Preserve local changes and resolve the conflict after comparing versions.",
      code_git_unavailable: "Git is unavailable. Check this device's Git installation.",
      code_secret_detected: "A possible secret was detected, so the upload was blocked. Check project files.",
      code_sync_secret: "A possible secret was detected, so the upload was blocked. Check project files.",
      code_github_binding_changed: "The GitHub repository changed. Review the repository and base branch, then authorize again.",
      code_github_not_configured: "Ask the project owner to connect a GitHub repository first.",
      code_github_unavailable: "GitHub settings are temporarily unavailable. Check the connection and retry.",
      code_sync_binding: "The code sync target changed. Review the repository and local authorization.",
      code_sync_unavailable: "Cannot connect to GitHub. Check Git, GitHub CLI sign-in, network and repository access on this device.",
      code_sync_limit: "Project files exceed this sync method's safety limits. Check large files and exclusions.",
      code_sync_unsupported: "This repository contains unsupported content; no code was changed.",
      code_sync_unsafe_path: "The project contains an unsafe or unsupported path. Sync was stopped.",
    };
    return labels[code] ?? "Code sync did not finish. Check authorization, files and remote status; conversation sync is unaffected.";
  }
  const labels = {
    code_sync_disabled: "请先允许此 DSH 同步项目代码。",
    code_sync_busy: "Agent 正在工作，请等待本轮结束后再同步。",
    code_workspace_busy: "Agent 正在工作，请等待本轮结束后再同步。",
    code_sync_dirty: "本地有未上传修改。先上传，或恢复云端版本到新目录比较。",
    code_sync_recovery_required: "本地目录缺失或上次下载中断，请先将云端副本恢复到新目录。",
    code_sync_forbidden: "代码访问被拒绝，请检查该设备的登录状态与项目权限。",
    code_sync_conflict: "云端版本已变化。请先安全下载或恢复到新目录比较，未覆盖任何云端版本。",
    code_conflict: "云端版本冲突。请检查最新分支，保留本地修改后重试。",
    code_stale_head: "云端已有新版本。请恢复到新目录比较，不要覆盖未上传的本地修改。",
    code_merge_conflict: "分支存在冲突。请保留本地修改，比较云端版本并处理冲突。",
    code_storage_quota_exceeded: "项目代码存储额度已满，请联系服务管理员。",
    code_storage_check_required: "代码写入因存储检查暂时停止，请联系服务管理员；会话同步仍可使用。",
    code_git_unavailable: "Git 不可用，请检查服务器与本机的 Git 安装。",
    code_secret_detected: "检测到可能的密钥，已阻止上传。请检查项目文件。",
    code_not_enabled: "请先由项目创建者在 GatherThread 启用项目 Git。",
    code_sync_secret: "检测到可能的密钥，已阻止上传。请检查项目文件。",
    code_github_binding_changed: "GitHub 仓库配置已变化，请核对最新仓库和主分支后重新授权。",
    code_github_not_configured: "请先由项目创建者绑定 GitHub 仓库。",
    code_github_unavailable: "GitHub 配置信息暂不可用，请检查连接后重试。",
    code_sync_binding: "代码同步绑定已变化。请核对当前仓库与本地授权后重试。",
    code_sync_unavailable: github ? "无法连接 GitHub。请检查本机 Git、GitHub CLI 登录状态、网络和仓库访问权限。" : "代码同步暂不可用，请检查本机 Git 与服务连接。",
    code_sync_limit: "项目文件超过同步限制，未上传。请检查大文件和排除范围。",
    code_sync_unsupported: "仓库包含当前同步方式不支持的内容，未修改代码。",
    code_sync_unsafe_path: "项目含不安全或不支持的文件路径，已停止同步。",
  };
  return labels[code] ?? "代码同步未完成。请检查授权、文件和云端状态后重试；会话同步不受影响。";
}

async function readHostState(connection, signal) {
  if (typeof connection?.rpc?.call === "function") {
    try {
      const value = await callNative(connection, "status/get", {}, signal);
      const nativeState = parseNativeState(value);
      return { snapshot: nativeState.runtime, nativeState, terminalFailure: false };
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = error instanceof Error ? error : new Error("native status unavailable");
      failure.terminalFailure = true;
      throw failure;
    }
  }
  const response = await fetch(STATUS_PATH, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const error = new Error("status unavailable");
    error.terminalFailure = response.status >= 400 && response.status < 500;
    throw error;
  }
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("status response too large");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("status response too large");
  return { snapshot: parseSnapshot(JSON.parse(text)), nativeState: undefined, terminalFailure: false };
}

async function callNative(connection, endpoint, payload, signal) {
  if (connection === undefined || connection === null || typeof connection.rpc?.call !== "function") {
    throw new Error("native status unavailable");
  }
  const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload, signal);
  exactObject(result, ["ok", "value", "error"]);
  if (result.ok !== true) throw new Error("native action failed");
  return result.value;
}

function renderNativeControls(input) {
  const state = input.nativeState;
  const controls = [];
  if (state.authorization === "unpaired") {
    controls.push(
      React.createElement("div", { key: "service-options", style: styles.choiceRow },
        workspaceElement("button", {
          type: "button",
          disabled: input.busy || state.officialServerUrl === undefined,
          style: styles.secondaryButton,
          onClick: () => input.setServerUrl(state.officialServerUrl || ""),
        }, state.officialServerUrl === undefined ? "输入共序服务器地址" : "使用共序官方服务"),
        React.createElement("span", { style: styles.muted }, "局域网、自托管与 Tailscale 请使用自定义地址。")),
      React.createElement("form", {
        key: "pairing-form",
        style: styles.form,
        onSubmit: (event) => {
          event.preventDefault();
          void input.runAction("pairing/start", {
            serverUrl: input.serverUrl,
            deviceName: input.deviceName,
          });
        },
      },
      field("GatherThread 服务器地址", React.createElement("input", {
        type: "url",
        required: true,
        maxLength: 2048,
        value: input.serverUrl,
        placeholder: "https://gatherthread.example",
        autoComplete: "url",
        style: styles.input,
        onChange: (event) => input.setServerUrl(event.target.value),
      })),
      field("DSH 设备名称", React.createElement("input", {
        type: "text",
        required: true,
        maxLength: 120,
        value: input.deviceName,
        autoComplete: "off",
        style: styles.input,
        onChange: (event) => input.setDeviceName(event.target.value),
      })),
      workspaceElement("button", {
        type: "submit",
        disabled: input.busy,
        style: styles.primaryButton,
      }, input.busy ? "正在创建配对…" : "登录并配对")),
      React.createElement("p", { key: "account-note", style: styles.muted },
        "当前版本使用你已打开的 GatherThread 浏览器会话或邀请身份确认，不假设另有公共账户。长期凭据只保存在 DSH 本机凭据库。"),
    );
  } else if (state.authorization === "pairing") {
    controls.push(
      React.createElement("div", { key: "pairing", style: styles.pairing },
        React.createElement("p", { style: styles.summary }, "在浏览器中确认这次短时、单次配对："),
        React.createElement("code", { style: styles.code }, state.pairing.userCode),
        React.createElement("a", {
          href: state.pairing.verificationUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          style: styles.linkButton,
        }, "打开 GatherThread 确认"),
        workspaceElement("button", {
          type: "button",
          disabled: input.busy,
          style: styles.secondaryButton,
          onClick: () => void input.runAction("pairing/cancel", {}),
        }, "取消配对")),
    );
  } else if (state.route === undefined) {
    const providers = input.catalog?.providers ?? [];
    const selectedProvider = providers.find((entry) => entry.id === input.provider);
    const models = selectedProvider?.models ?? [];
    const validSelection = models.some((entry) => entry.id === input.model);
    controls.push(
      connectionSummary(state),
      // Reaching this branch means authorization is already "paired": the
      // "unpaired" and "pairing" states are handled by earlier branches. The
      // browser approval succeeded, but without a provider and model no runtime
      // is registered, so a bare stopped connection is indistinguishable from a
      // fresh install. State the remaining step explicitly.
      React.createElement("p", { key: "select-model-notice", style: styles.notice },
        // A dropped route is not the same situation as a fresh pairing, and saying
        // so is the whole point of not repointing the model silently: the reader has
        // to know their previous choice no longer exists before picking another.
        state.recoverableError === "route_unavailable"
          ? "DSH 当前已不再提供此前为该连接选择的模型，因此该连接已停止并取消注册。请重新选择 Provider 与 Model；在此之前的旧模型不会被自动替换。"
          : "配对完成后，尚未选择 DSH Provider 与 Model。完成选择并点击下方按钮后，本机 DSH 运行时才会注册到 GatherThread；在此之前，GatherThread 网页无法发现这台 DSH。"),
      input.catalog === undefined
        ? workspaceElement("button", {
          key: "load-catalog",
          type: "button",
          disabled: input.busy,
          style: styles.primaryButton,
          onClick: () => void input.runAction("catalog/get", {}),
        }, input.busy ? "正在读取…" : "选择 DSH 模型")
        : React.createElement("form", {
          key: "binding-form",
          style: styles.form,
          onSubmit: (event) => {
            event.preventDefault();
            if (input.busy || !validSelection) return;
            void input.runAction("connection/configure", {
              provider: input.provider,
              model: input.model,
            }, () => input.setCatalog(undefined));
          },
        },
        React.createElement("p", { style: styles.muted },
          `将同步全部 ${String(input.catalog.projects.length)} 个可访问的 GatherThread 项目；项目权限分别生效。`),
        field("DSH Provider", selectControl(
          providers,
          input.provider,
          (value) => {
            input.setProvider(value);
            const next = providers.find((entry) => entry.id === value);
            input.setModel(next?.models[0]?.id || "");
          },
          (entry) => entry.id,
          (entry) => entry.name,
        )),
        field("DSH Model", selectControl(
          models,
          input.model,
          input.setModel,
          (entry) => entry.id,
          (entry) => entry.name,
        )),
        workspaceElement("button", {
          type: "submit",
          disabled: input.busy || !validSelection,
          style: styles.primaryButton,
        }, input.busy ? "正在连接…" : "连接全部可访问项目")),
      disconnectButton(input),
    );
  } else {
    controls.push(
      connectionSummary(state),
      React.createElement("dl", { key: "binding", style: styles.details },
        detail("项目", `${String(state.projectCount)} 个可访问项目`),
        detail("Provider", state.route.provider),
        detail("Model", state.route.model)),
      React.createElement("p", { key: "projects", style: styles.muted },
        state.bindings.map((binding) => binding.projectName).join(" · ") || "当前没有可访问的活跃项目。"),
      disconnectButton(input),
    );
  }
  return React.createElement("section", { style: styles.connectionCard },
    React.createElement("div", { style: styles.subheading },
      React.createElement("h3", { style: styles.sectionTitle }, "连接共序"),
      React.createElement("span", { style: styles.muted }, "插件主动出站连接，不需要公网访问本机 DSH。")),
    ...controls,
    React.createElement("p", { style: styles.muted },
      `已验证兼容：${state.compatibility.package}@${state.compatibility.version} · ${state.compatibility.profile}`),
    input.notice ? React.createElement("p", { role: "alert", style: styles.notice }, input.notice) : null);
}

function connectionSummary(state) {
  return React.createElement("dl", { key: "connection-summary", style: styles.details },
    detail("服务器", state.serverUrl),
    detail("设备", state.deviceName));
}

function disconnectButton(input) {
  return workspaceElement("button", {
    key: "disconnect",
    type: "button",
    disabled: input.busy,
    style: styles.secondaryButton,
    onClick: () => void input.runAction("connection/disconnect", {}, () => input.setCatalog(undefined)),
  }, "断开此 DSH 的本地配对");
}

function field(label, control) {
  return React.createElement("label", { style: styles.field },
    React.createElement("span", { style: styles.fieldLabel }, label),
    control);
}

function selectControl(entries, value, setValue, keyOf, labelOf) {
  return React.createElement("select", {
    required: true,
    value,
    style: styles.select,
    onChange: (event) => setValue(event.target.value),
  }, ...entries.map((entry) => React.createElement("option", {
    key: keyOf(entry),
    value: keyOf(entry),
    style: styles.option,
  }, labelOf(entry))));
}

function detail(label, value) {
  return React.createElement("div", { style: styles.detailRow },
    React.createElement("dt", { style: styles.muted }, label),
    React.createElement("dd", { style: styles.detailValue }, value));
}

function parseNativeState(value) {
  exactObject(value, [
    "schemaVersion", "integration", "authorization", "compatibility", "runtime",
    "officialServerUrl", "serverUrl", "deviceName", "route", "projectCount", "bindings", "localSync", "codeSync", "githubSync", "pairing", "recoverableError",
  ]);
  if (value.schemaVersion !== 2 || value.integration !== "gatherthread") throw new Error("invalid native status identity");
  if (!AUTHORIZATION_STATES.has(value.authorization)) throw new Error("invalid native authorization state");
  exactObject(value.compatibility, ["package", "version", "profile", "targets"]);
  // Older Host builds sent only the scalar pair; the current one also lists every
  // verified release/profile pair, because the profile layer is gated to the
  // release that names `webStartup` and serves both the Web and Desktop profiles.
  const verified = Array.isArray(value.compatibility.targets)
    ? value.compatibility.targets
    : [{ version: "0.1.7-rc.2", profile: "web" }];
  if (!verified.every((target) => target !== null && typeof target === "object"
    && typeof target.version === "string" && (target.profile === "web" || target.profile === "desktop"))) {
    throw new Error("invalid native DSH compatibility targets");
  }
  if (value.compatibility.package !== "@deepseek-ai/dsh"
    || !verified.some((target) => target.version === value.compatibility.version
      && target.profile === value.compatibility.profile)) throw new Error("incompatible native DSH Host");
  const runtime = parseSnapshot(value.runtime);
  const optionalUrl = (url) => {
    if (url === undefined) return undefined;
    boundedText(url, 2048);
    const parsed = new URL(url);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("invalid public server URL");
    }
    return parsed.toString().replace(/\/$/u, "");
  };
  const serverUrl = optionalUrl(value.serverUrl);
  const officialServerUrl = optionalUrl(value.officialServerUrl);
  if (value.deviceName !== undefined) boundedText(value.deviceName, 120);
  let route;
  let bindings;
  let localSync;
  let codeSync;
  let githubSync;
  if (value.route !== undefined || value.bindings !== undefined || value.projectCount !== undefined) {
    if (value.route === undefined || !Number.isSafeInteger(value.projectCount) || value.projectCount < 0
      || !Array.isArray(value.bindings) || value.bindings.length > 100
      || value.bindings.length > value.projectCount) {
      throw new Error("invalid native Project bindings");
    }
    exactObject(value.route, ["provider", "model"]);
    boundedText(value.route.provider, 80);
    boundedText(value.route.model, 160);
    route = { ...value.route };
    bindings = value.bindings.map((binding) => {
      exactObject(binding, ["projectId", "projectName", "provider", "model"]);
      boundedText(binding.projectId, 128);
      boundedText(binding.projectName, 160);
      boundedText(binding.provider, 80);
      boundedText(binding.model, 160);
      if (binding.provider !== route.provider || binding.model !== route.model) {
        throw new Error("inconsistent native Project route");
      }
      return { ...binding };
    });
    const localSyncValue = value.localSync ?? [];
    if (!Array.isArray(localSyncValue) || localSyncValue.length > 100) throw new Error("invalid local sync status");
    localSync = localSyncValue.map((sync) => {
      exactObject(sync, [
        "projectId", "projectName", "sessionId", "localSessionId", "title", "automaticUpload",
        "pendingLocalTurns", "uploadableLocalTurns",
      ]);
      boundedText(sync.projectId, 128);
      boundedText(sync.projectName, 160);
      boundedText(sync.sessionId, 128);
      boundedText(sync.localSessionId, 200);
      boundedText(sync.title, 160);
      if (typeof sync.automaticUpload !== "boolean"
        || !Number.isSafeInteger(sync.pendingLocalTurns) || sync.pendingLocalTurns < 0
        || !Number.isSafeInteger(sync.uploadableLocalTurns) || sync.uploadableLocalTurns < 0) {
        throw new Error("invalid local sync status");
      }
      return { ...sync };
    });
    const parseCodeProjects = (codeSyncValue, github = false) => {
    if (!Array.isArray(codeSyncValue) || codeSyncValue.length > 100) throw new Error("invalid code sync status");
    return codeSyncValue.map((project) => {
      exactObject(project, ["projectId", "projectName", "authorized", "status", "error", ...(github ? ["connection", "branch"] : [])]);
      boundedText(project.projectId, 128);
      boundedText(project.projectName, 160);
      if (typeof project.authorized !== "boolean") throw new Error("invalid code sync authorization");
      if (project.error !== undefined && !/^(?:github_)?code_[a-z_]{1,60}$/u.test(project.error)) throw new Error("invalid code sync error");
      if (github) {
        if (project.connection !== null) {
          exactObject(project.connection, ["repository", "base_branch", "revision", "enabled"]);
          boundedText(project.connection.repository, 160);
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(project.connection.repository)) throw new Error("invalid GitHub repository");
          boundedText(project.connection.base_branch, 255);
          boundedText(project.connection.revision, 128);
          if (typeof project.connection.enabled !== "boolean") throw new Error("invalid GitHub state");
        }
        if (project.branch !== null) boundedText(project.branch, 255);
      }
      if (project.status !== undefined) {
        const status = project.status;
        exactObject(status, ["enabled", "automatic_upload", "local_changes", "file_count", "excluded_count", "base_commit", "cloud_commit", "branch_id", "needs_download", "recovery_directory", "local_status_unknown", ...(github ? ["provider", "repository", "branch", "base_branch"] : [])]);
        if (github) {
          if (status.provider !== undefined && status.provider !== "github") throw new Error("invalid code provider");
          if (status.repository !== undefined && status.repository !== project.connection?.repository) throw new Error("GitHub target mismatch");
          if (status.base_branch !== undefined && status.base_branch !== project.connection?.base_branch) throw new Error("GitHub base mismatch");
          if (status.branch !== undefined) boundedText(status.branch, 255);
        }
        if (status.local_status_unknown !== undefined && typeof status.local_status_unknown !== "boolean") throw new Error("invalid local status flag");
        for (const key of ["enabled", "automatic_upload", "needs_download"]) {
          if (typeof status[key] !== "boolean") throw new Error("invalid code sync flag");
        }
        for (const key of ["local_changes", "file_count", "excluded_count"]) {
          if (!Number.isSafeInteger(status[key]) || status[key] < 0) throw new Error("invalid code sync count");
        }
        for (const key of ["base_commit", "cloud_commit"]) {
          if (status[key] !== null && !/^[a-f0-9]{40}$/u.test(status[key])) throw new Error("invalid code commit");
        }
        if (status.branch_id !== null) boundedText(status.branch_id, 128);
        if (status.recovery_directory !== undefined) {
          boundedText(status.recovery_directory, 255);
          if (/[\\/\u0000-\u001f]/u.test(status.recovery_directory)) throw new Error("invalid recovery directory");
        }
      }
      return { ...project };
    });
    };
    codeSync = parseCodeProjects(value.codeSync ?? []);
    githubSync = parseCodeProjects(value.githubSync ?? [], true);
  }
  let pairing;
  if (value.pairing !== undefined) {
    exactObject(value.pairing, ["schemaVersion", "status", "userCode", "verificationUrl", "expiresAt", "intervalSeconds"]);
    if (value.pairing.schemaVersion !== 1 || value.pairing.status !== "pending"
      || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(value.pairing.userCode)
      || !Number.isSafeInteger(value.pairing.intervalSeconds)
      || value.pairing.intervalSeconds < 1 || value.pairing.intervalSeconds > 30) {
      throw new Error("invalid native pairing state");
    }
    boundedText(value.pairing.expiresAt, 64);
    boundedText(value.pairing.verificationUrl, 2048);
    const verificationUrl = new URL(value.pairing.verificationUrl);
    if (!/^https?:$/u.test(verificationUrl.protocol) || verificationUrl.username || verificationUrl.password
      || verificationUrl.search || verificationUrl.hash !== `#dsh-pair=${value.pairing.userCode}`) {
      throw new Error("invalid native verification URL");
    }
    pairing = { ...value.pairing, verificationUrl: verificationUrl.toString() };
  }
  if (value.authorization === "pairing" && pairing === undefined) throw new Error("missing native pairing state");
  if (value.authorization === "paired" && (serverUrl === undefined || value.deviceName === undefined)) {
    throw new Error("missing native grant labels");
  }
  if (value.recoverableError !== undefined
    && value.recoverableError !== "pairing_failed"
    && value.recoverableError !== "connection_failed"
    && value.recoverableError !== "route_unavailable") throw new Error("invalid native recovery state");
  return {
    schemaVersion: 2,
    integration: "gatherthread",
    authorization: value.authorization,
    compatibility: { ...value.compatibility },
    runtime,
    ...(officialServerUrl === undefined ? {} : { officialServerUrl }),
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(value.deviceName === undefined ? {} : { deviceName: value.deviceName }),
    ...(route === undefined ? {} : { route, projectCount: value.projectCount, bindings, localSync, codeSync, githubSync }),
    ...(pairing === undefined ? {} : { pairing }),
    ...(value.recoverableError === undefined ? {} : { recoverableError: value.recoverableError }),
  };
}

function parseCatalog(value) {
  exactObject(value, ["schemaVersion", "projects", "providers"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.length > 100
    || !Array.isArray(value.providers) || value.providers.length > 64) throw new Error("invalid native catalog");
  const projects = value.projects.map((project) => {
    exactObject(project, ["id", "name", "role", "state", "sessionCount"]);
    boundedText(project.id, 128);
    boundedText(project.name, 160);
    if (!new Set(["owner", "participant", "viewer"]).has(project.role) || project.state !== "active"
      || !Number.isSafeInteger(project.sessionCount) || project.sessionCount < 0) throw new Error("invalid native Project");
    return { ...project };
  });
  let modelCount = 0;
  const providers = value.providers.map((provider) => {
    exactObject(provider, ["id", "name", "models"]);
    boundedText(provider.id, 80);
    boundedText(provider.name, 160);
    if (!Array.isArray(provider.models)) throw new Error("invalid native models");
    const models = provider.models.map((model) => {
      modelCount += 1;
      if (modelCount > 256) throw new Error("native catalog too large");
      exactObject(model, ["id", "name"]);
      boundedText(model.id, 160);
      boundedText(model.name, 160);
      return { ...model };
    });
    return { id: provider.id, name: provider.name, models };
  });
  return { schemaVersion: 1, projects, providers };
}

function parseSnapshot(value) {
  exactObject(value, [
    "schemaVersion", "integration", "connection", "bindingMode", "projectName",
    "activeSessionCount", "sessions", "updatedAt",
  ]);
  if (value.schemaVersion !== 1 || value.integration !== "gatherthread") throw new Error("invalid status identity");
  if (!CONNECTION_STATES.has(value.connection)) throw new Error("invalid connection state");
  if (value.bindingMode !== "single" && value.bindingMode !== "project") throw new Error("invalid binding mode");
  boundedText(value.projectName, 160);
  boundedText(value.updatedAt, 32);
  if (!Number.isSafeInteger(value.activeSessionCount) || value.activeSessionCount < 0) {
    throw new Error("invalid active Session count");
  }
  if (!Array.isArray(value.sessions) || value.sessions.length > 100) throw new Error("invalid Sessions");
  const sessions = value.sessions.map((session) => {
    exactObject(session, ["sessionId", "title", "state", "lastSyncedAt"]);
    boundedText(session.sessionId, 128);
    boundedText(session.title, 160);
    if (!SESSION_STATES.has(session.state)) throw new Error("invalid Session state");
    if (session.lastSyncedAt !== undefined) boundedText(session.lastSyncedAt, 32);
    return {
      sessionId: session.sessionId,
      title: session.title,
      state: session.state,
      ...(session.lastSyncedAt === undefined ? {} : { lastSyncedAt: session.lastSyncedAt }),
    };
  });
  if (value.activeSessionCount > sessions.length) throw new Error("invalid active Session count");
  return {
    schemaVersion: 1,
    integration: "gatherthread",
    connection: value.connection,
    bindingMode: value.bindingMode,
    projectName: value.projectName,
    activeSessionCount: value.activeSessionCount,
    sessions,
    updatedAt: value.updatedAt,
  };
}

function exactObject(value, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid status object");
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("unexpected status field");
}

function boundedText(value, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error("invalid status text");
  for (const character of value) {
    const code = character.codePointAt(0) || 0;
    if (code < 32 || (code >= 127 && code <= 159)) throw new Error("invalid status text");
  }
}

function statusLabel(state) {
  return ({
    connecting: "连接中",
    connected: "已连接",
    idle: "空闲",
    running: "运行中",
    offline: "离线",
    error: "错误",
    stopped: "已停止",
  })[state] || "未知";
}

function badgeStyle(state) {
  const emphasis = state === "connected" || state === "idle"
    ? 0.92
    : state === "running" || state === "connecting" ? 0.78 : 0.62;
  return { ...styles.badge, opacity: emphasis };
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "未知";
}

const styles = {
  panel: { minWidth: 0, overflowWrap: "anywhere", display: "grid", gap: 16, padding: 8, color: "inherit" },
  heading: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" },
  title: { margin: 0, fontSize: 20, lineHeight: 1.3 },
  subtitle: { margin: "4px 0 0", opacity: 0.68, fontSize: 13 },
  summary: { margin: 0, fontSize: 13, opacity: 0.72 },
  notice: { margin: 0, padding: "10px 12px", borderRadius: 10, background: "rgba(127,127,127,.12)", color: "inherit", border: "1px solid rgba(127,127,127,.2)" },
  list: { display: "grid", gap: 8 },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid rgba(127,127,127,.2)", borderRadius: 12 },
  sessionText: { minWidth: 0, display: "grid", gap: 3 },
  sessionTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14 },
  sessionMeta: { opacity: 0.62, fontSize: 12 },
  syncActions: { flex: "none", display: "grid", justifyItems: "end", gap: 6 },
  syncToggle: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" },
  compactButton: { height: "auto", maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", flexShrink: 0, minHeight: 28, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12, cursor: "pointer" },
  badge: { flex: "none", padding: "4px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: "rgba(127,127,127,.12)", color: "inherit", border: "1px solid rgba(127,127,127,.2)" },
  connectionCard: { minWidth: 0, display: "grid", gap: 12, padding: "14px", border: "1px solid rgba(127,127,127,.2)", borderRadius: 14, background: "rgba(127,127,127,.06)" },
  subheading: { display: "grid", gap: 4 },
  sectionTitle: { margin: 0, fontSize: 16, lineHeight: 1.35 },
  form: { display: "grid", gap: 12 },
  field: { display: "grid", gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: 600, opacity: 0.76 },
  input: { width: "100%", minHeight: 36, boxSizing: "border-box", padding: "7px 10px", borderRadius: 9, border: "1px solid rgba(127,127,127,.28)", background: "transparent", color: "inherit", font: "inherit" },
  // A dropdown owns a popup it cannot inherit: the list surface is painted from the
  // control's own background and each row from its option, while the text keeps
  // following the panel. Sharing `input` therefore drew the model names in the
  // panel's foreground on the UA's own surface — white on white under a dark harness
  // theme. Both the control and the rows name the system field pair instead, which
  // the UA resolves against the used color scheme, so neither can match the other.
  select: { width: "100%", minHeight: 36, boxSizing: "border-box", padding: "7px 10px", borderRadius: 9, border: "1px solid rgba(127,127,127,.28)", background: "Field", color: "FieldText", font: "inherit" },
  option: { background: "Field", color: "FieldText" },
  primaryButton: { height: "auto", maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", flexShrink: 0, minHeight: 36, padding: "8px 12px", borderRadius: 9, border: "1px solid Highlight", background: "Highlight", color: "HighlightText", WebkitTextFillColor: "HighlightText", font: "inherit", fontWeight: 600, cursor: "pointer" },
  secondaryButton: { height: "auto", maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", flexShrink: 0, minHeight: 36, padding: "8px 12px", borderRadius: 9, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" },
  linkButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 36, padding: "0 12px", borderRadius: 9, border: "1px solid rgba(127,127,127,.3)", color: "inherit", textDecoration: "none", fontWeight: 600 },
  muted: { margin: 0, fontSize: 12, lineHeight: 1.55, opacity: 0.68 },
  choiceRow: { display: "grid", gap: 6 },
  pairing: { display: "grid", gap: 10 },
  code: { justifySelf: "start", padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(127,127,127,.24)", background: "rgba(127,127,127,.1)", fontSize: 18, letterSpacing: ".08em" },
  details: { display: "grid", gap: 7, margin: 0 },
  detailRow: { display: "grid", gridTemplateColumns: "88px minmax(0,1fr)", gap: 10, alignItems: "baseline" },
  detailValue: { margin: 0, overflowWrap: "anywhere", fontSize: 13 },
};

// Workspace is a canonical-log reader. Native settings still own pairing and
// provider selection; no browser credential or native transcript is needed here.
function workspaceText(zh, en) { return githubEnglish() ? en : zh; }
function workspaceError(code) {
  const copy = {
    workspace_file_local_unavailable: ['本项目在这台 DSH 上尚未就绪，请先连接本项目后重试。', 'This project is not ready on this DSH. Connect it first.'],
    workspace_file_path: ['文件路径不受支持或涉及受保护目录。请在本机文件管理器检查。', 'Unsupported or protected path. Check it in your local file manager.'],
    workspace_file_large: ['此预览最多支持 64 KiB 文本。请使用 DSH 原生预览或网页文件管理。', 'Preview supports text up to 64 KiB. Use native DSH or Web file tools.'],
    workspace_file_binary: ['这是二进制或非 UTF-8 文件，请使用 DSH 原生预览或网页文件管理。', 'Binary or non-UTF-8 file. Use native DSH or Web file tools.'],
    workspace_file_private: ['检测到可能的敏感信息，已阻止在共序面板展示。请在本机检查文件。', 'Possible secrets detected. Inspect this file locally.'],
    workspace_file_changed: ['文件或比较基准正在变化，请刷新后重试。', 'Files or comparison baseline changed. Refresh and retry.'],
    workspace_file_missing: ['文件已移动或删除，请刷新文件列表。', 'File moved or deleted. Refresh the file list.'],
    workspace_file_baseline: ['没有完整的比较基准。可在任务开始前建立基准，再查看更改。', 'No complete baseline. Capture one before running a task.'],
    workspace_file_conflict: ['云端版本已变化，当前编辑仍保留。先复制修改，再刷新并对比新版本后保存。', 'Remote version changed. Your edit is retained. Copy it, reload and compare before saving.'],
    workspace_file_forbidden: ['没有此分支的访问或写入权限，请联系项目创建者。当前编辑仍保留。', 'Branch access denied. Contact the project owner. Your edit is retained.'],
    workspace_file_not_configured: ['此文件来源尚未配置或服务不可用。请在 Git 同步或网页版检查项目代码设置。', 'File source not configured or unavailable. Check Git sync or project code settings on Web.'],
    workspace_file_unavailable: ['文件服务暂不可用。请检查连接后重试；未收到保存回执时，重试会沿用同一次保存。', 'File service unavailable. Check connection and retry; an unconfirmed save reuses its original identity.'],
    workspace_file_busy: ['本项目 Agent 正在执行。请等任务结束后再重建比较基准。', 'Project Agent is busy. Wait before resetting the comparison baseline.'],
    workspace_native_unavailable: ['DSH 原生文件面板暂不可用。请在 DSH 侧栏手动打开本项目会话，再选择文件。', 'Native file panel unavailable. Open the project conversation in DSH and select Files.'],
    workspace_unpaired: ['请先在 DSH 设置 → GatherThread 中完成账号配对。', 'Pair your account in DSH Settings → GatherThread first.'],
    workspace_access_denied: ['访问权限已变化，请刷新项目；必要时联系项目创建者。', 'Access changed. Refresh projects or contact the project owner.'],
    workspace_connection_changed: ['账号连接已变化，请刷新项目后重试。', 'The account connection changed. Refresh projects.'],
    workspace_read_only: ['此会话当前只读，不能发送消息。', 'This conversation is read-only.'],
    workspace_agent_unavailable: ['本机 DSH 尚未就绪。请在 GatherThread 设置中选择模型并等待连接。', 'This DSH is not ready. Select a model in GatherThread settings and wait for connection.'],
    workspace_model_unavailable: ['所选模型或推理强度已不可用，请重新选择。不会自动改用其他模型。', 'The selected model or reasoning effort is unavailable. Choose again; no fallback is used.'],
    workspace_request_unavailable: ['此请求已结束、记录已变化，或不属于本机 DSH。请刷新会话检查状态。', 'This request ended, changed, or belongs to another runtime. Refresh the conversation.'],
    workspace_invalid_response: ['工作区数据格式不兼容，请更新插件与服务器后重试。', 'Workspace data is incompatible. Update the plugin and server, then retry.'],
    workspace_response_too_large: ['此会话数据较多，请先在 GatherThread 网页查看。', 'This conversation is too large to preview. Open it in GatherThread Web.'],
    workspace_conflict: ['请求与当前状态冲突，请刷新会话后检查。', 'The request conflicts with current state. Refresh and check the conversation.'],
    workspace_rate_limited: ['请求过于频繁或额度不足，请稍后重试。', 'Request or quota limit reached. Try again later.'],
  };
  const pair = copy[code] || ['连接暂时不可用，请稍后重试。发送未收到回执时不代表没有发送成功。', 'Connection unavailable. Retry later. A missing receipt does not mean the message was not sent.'];
  return workspaceText(...pair);
}
async function workspaceCall(connection, input, signal) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer;
  try {
    const response = await Promise.race([
      connection.rpc.call(RPC_CHANNEL, 'workspace/action', input, abort.signal),
      new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('workspace_unavailable')); }, 22000); }),
    ]);
    if (abort.signal.aborted) throw new Error('workspace_unavailable');
    if (response?.ok !== true) throw new Error(response?.error?.code || 'workspace_unavailable');
    const value = response.value;
    if (!value || typeof value.connectionId !== 'string' || JSON.stringify(value).length > 256 * 1024
      || (input.connectionId && value.connectionId !== input.connectionId)
      || (input.projectId && value.projectId !== input.projectId)
      || (input.sessionId && value.sessionId !== input.sessionId)) throw new Error('workspace_invalid_response');
    return value;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

// Local files stay private. Only an explicit path reference enters the chat draft.
function GatherThreadFiles({ connection, seat, nativeFiles, canWrite, webLink, onClose, onReference, fileDrafts }) {
  const h = workspaceElement, t = workspaceText;
  const cacheKey = JSON.stringify([seat.connectionId, seat.projectId, seat.sessionId]);
  const saved = fileDrafts[cacheKey];
  const [source, setSource] = React.useState(saved?.source || 'local');
  const [listing, setListing] = React.useState(saved?.listing ?? null);
  const [branches, setBranches] = React.useState(saved?.branches ?? null);
  const [branch, setBranch] = React.useState(saved?.branch ?? '');
  const [file, setFile] = React.useState(saved?.file ?? null);
  const [text, setText] = React.useState(saved?.text ?? '');
  const [details, setDetails] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const active = React.useRef(null), attempt = React.useRef(saved?.attempt || null);
  const dirty = file?.kind === 'text' && text !== file.text;
  const dirtyRef = React.useRef(dirty); dirtyRef.current = dirty;
  const cloud = source === 'gt-cloud' || source === 'github';
  if (dirty && cloud) fileDrafts[cacheKey] = { source, listing, branches, branch, file, text, attempt: attempt.current };
  else delete fileDrafts[cacheKey];
  const call = async (request, token) => {
    const value = await workspaceCall(connection, { action: 'files', connectionId: seat.connectionId, projectId: seat.projectId, sessionId: seat.sessionId, request }, token.signal);
    if (token.signal.aborted || seat.controller.signal.aborted || active.current !== token) throw new Error('workspace_connection_changed');
    if (!value.result || typeof value.result.kind !== 'string') throw new Error('workspace_invalid_response');
    return value.result;
  };
  const run = async action => {
    if (active.current) return;
    const token = new AbortController(); active.current = token; setBusy(true); setNotice('');
    try { await action(token); }
    catch (error) { if (!token.signal.aborted && !seat.controller.signal.aborted) setNotice(workspaceError(error.message)); }
    finally { if (active.current === token) { active.current = null; setBusy(false); } }
  };
  const leave = () => !dirtyRef.current || window.confirm(t('当前文件有未保存修改，放弃这些修改？', 'Discard this file’s unsaved edits?'));
  const close = () => { if (busy || !leave()) return; delete fileDrafts[cacheKey]; onClose(); };
  const selection = (id = branch, provider = source, revision = branches?.connection_revision) => ({ provider, branch_id: id, ...(revision === undefined ? {} : { connection_revision: revision }) });
  const clearFile = () => { setFile(null); setText(''); setDetails(null); attempt.current = null; };
  const load = (nextSource = source, nextBranch) => run(async token => {
    clearFile(); setListing(null); setBranches(null); setBranch(''); setSource(nextSource);
    if (nextSource === 'local' || nextSource === 'changes') {
      const result = await call({ operation: nextSource === 'local' ? 'localTree' : 'localChanges' }, token); setListing(result);
    } else {
      const result = await call({ operation: 'branches', provider: nextSource }, token);
      const values = result.value, id = nextBranch || values.default_branch_id;
      setBranches(values); setBranch(id);
      setListing(await call({ operation: 'tree', input: selection(id, nextSource, values.connection_revision) }, token));
    }
  });
  React.useEffect(() => {
    if (!saved) void load('local');
    else setNotice(t('已恢复此会话的未保存文件草稿。保存时仍会检查云端版本。', 'Unsaved file draft restored; saving still checks the remote version.'));
    const unload = event => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { active.current?.abort(); window.removeEventListener('beforeunload', unload); };
  }, []);
  const chooseFile = path => { if (busy || !leave()) return; void run(async token => {
    clearFile();
    const result = await call(cloud ? { operation: 'content', input: { ...selection(), commit: listing.value.commit, path } }
      : { operation: source === 'changes' ? 'localDiff' : 'localRead', path }, token);
    setFile(result); setText(result.text || '');
  }); };
  const save = () => run(async token => {
    if (!dirty || !cloud || !listing?.value?.can_write || !canWrite) return;
    if (!attempt.current) {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > 65536) throw new Error('workspace_file_large');
      const entry = listing.value.entries.find(entry => entry.path === file.path);
      attempt.current = { operation: 'save', input: { ...selection(), base_commit: listing.value.commit,
        operations: [{ type: 'write', path: file.path, content_base64: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')), ...(entry?.executable === undefined ? {} : { executable: entry.executable }) }],
        message: `Update ${file.path}`.slice(0,300), idempotency_key: `dsh-files-${crypto.randomUUID()}` } };
    }
    const result = await call(attempt.current, token);
    // A confirmed receipt is enough to clear the frozen attempt; reloading is separate.
    attempt.current = null; setFile({ ...file, text });
    setListing({ ...listing, value: { ...listing.value, commit: result.value.commit, head_commit: result.value.commit } });
    setDetails(null); setNotice(t('已保存到云端分支。本机目录需通过 Git 同步下载更新。', 'Saved to the cloud branch. Download via Git sync to update local files.'));
  });
  const entries = listing?.entries || listing?.value?.entries || listing?.files || [];
  const statusName = value => ({ added: t('新增', 'Added'), modified: t('修改', 'Modified'), deleted: t('删除', 'Deleted') })[value] || '';
  const button = (label, action, disabled = false) => h('button', { type: 'button', disabled: busy || disabled, onClick: action }, label);
  return h(WorkspaceDialog, { className: 'gtw-files', title: t('项目文件', 'Project files'), busy, onClose: close },
    h('div', { className: 'gtw-dialog-body gtw-file-body' },
      h('div', { className: 'gtw-file-toolbar', 'aria-label': t('文件来源', 'File source') }, ...[['local', t('本机文件', 'Local files')], ['changes', t('本机更改', 'Local changes')], ['gt-cloud', t('GT 云端', 'GT cloud')], ['github', 'GitHub']].map(([id, label]) => h('button', { key: id, type: 'button', disabled: busy, 'aria-pressed': source === id, onClick: () => { if (leave()) void load(id); } }, label)),
        button(t('刷新', 'Refresh'), () => { if (leave()) void load(); })),
      notice && h('p', { role: 'alert', className: 'gtw-notice' }, notice),
      busy && h('p', { role: 'status' }, t('处理中…', 'Working…')),
      h('small', null, cloud ? t('云端文件与本机目录分别保存；分支写入权限由服务器检查。', 'Cloud and local files are separate; the server checks branch write access.')
        : t('仅显示本机已绑定项目目录，不自动分享文件内容。Multi / Solo 共用项目目录，Solo 只隔离对话。', 'Only this device’s bound project folder. File contents are not shared automatically. Multi/Solo share the folder; Solo isolates conversation history.')),
      listing?.directory && h('code', { className: 'gtw-file-directory' }, listing.directory),
      (listing?.truncated || listing?.incomplete) && h('small', { role: 'status' }, t('列表或比较不完整：最多 300 个文件，文本预览上限 64 KiB；忽略私密、生成目录和链接文件。', 'Partial listing/comparison: up to 300 files, 64 KiB text previews; private/generated paths and links are excluded.')),
      source === 'changes' && h('div', { className: 'gtw-file-toolbar' }, h('small', null, listing?.baseline ? `${t('比较基准', 'Baseline')} · ${new Date(listing.baseline).toLocaleString()}` : t('尚无比较基准。任务执行前会自动建立，也可手动建立。', 'No baseline. It is captured before execution or can be captured manually.')),
        button(t('重新建立基准', 'Reset baseline'), () => { if (!window.confirm(t('以当前项目文件作为新基准？上次比较记录将清除。', 'Use current files as baseline? The previous comparison is cleared.'))) return; void run(async token => { clearFile(); setListing(await call({ operation: 'baseline' }, token)); }); }, !canWrite)),
      source === 'changes' && h('small', null, t('比较整个项目目录的变化，可能包含其他进程的编辑；不是某位 Agent 的精确操作记录。基准只保存在本次连接的内存中。', 'Project-wide changes may include other processes’ edits; this is not exact Agent attribution. Baselines last only for this connection.')),
      cloud && branches && h('label', { className: 'gtw-field' }, t('分支', 'Branch'), h('select', { value: branch, disabled: busy, onChange: event => { if (leave()) void load(source, event.target.value); } }, ...branches.branches.map(item => h('option', { key: item.id, value: item.id }, `${item.name}${item.can_write ? '' : t(' · 只读', ' · Read-only')}`)))),
      h('div', { className: 'gtw-file-grid' },
        h('nav', { className: 'gtw-file-list', 'aria-label': t('文件列表', 'File list') }, h('input', { type: 'search', 'aria-label': t('筛选文件', 'Filter files'), placeholder: t('筛选文件', 'Filter files'), value: query, onChange: event => setQuery(event.target.value) }),
          ...entries.filter(entry => entry.path.toLowerCase().includes(query.toLowerCase())).map(entry => h('button', { key: entry.path, type: 'button', disabled: busy, 'aria-current': file?.path === entry.path ? 'true' : undefined, onClick: () => chooseFile(entry.path) }, h('span', null, entry.path), entry.status && h('small', null, statusName(entry.status)))),
          !entries.length && !busy && h('small', null, source === 'changes' ? t('暂无可比较的更改。', 'No comparable changes.') : t('暂无可预览文件。请检查同步设置或切换来源。', 'No previewable files. Check sync or choose another source.'))),
        h('section', { className: 'gtw-file-preview' }, file ? h(React.Fragment, null, h('strong', null, file.path),
          file.kind === 'diff' ? h('div', { className: 'gtw-diff' }, h('div', null, h('small', null, t('基准内容', 'Baseline')), h('pre', null, file.before)), h('div', null, h('small', null, t('当前内容', 'Current')), h('pre', null, file.after)))
            : h('textarea', { 'aria-label': t('文件内容', 'File content'), spellCheck: false, readOnly: !cloud || !canWrite || !listing?.value?.can_write || busy || !!attempt.current, value: text, onChange: event => setText(event.target.value) }),
          h('div', { className: 'gtw-file-toolbar' }, cloud && button(attempt.current ? t('重试保存', 'Retry save') : t('保存到云端', 'Save to cloud'), () => void save(), !dirty || !canWrite || !listing?.value?.can_write),
            button(t('复制内容', 'Copy content'), () => void run(async () => { await navigator.clipboard.writeText(file.kind === 'diff' ? file.after : text); setNotice(t('已复制。', 'Copied.')); })),
            !cloud && file.kind === 'text' && button(t('将文本加入聊天草稿', 'Add text to chat draft'), () => { if (!window.confirm(t('将当前文本放入聊天草稿？点击发送后，当前会话成员与 Agent 可读。请先确认不包含隐私。', 'Add this text to the draft? Sending shares it with conversation members and Agents. Check it for private information first.'))) return; try { onReference(file.path, file.text); } catch (error) { setNotice(workspaceError(error.message)); } }, !canWrite || file.text.length > 6000),
            !cloud && button(t('引用路径到输入框', 'Reference path in composer'), () => { try { onReference(file.path); } catch (error) { setNotice(workspaceError(error.message)); } }, !canWrite)))
          : h('p', { className: 'gtw-empty' }, t('从左侧选择文件查看。', 'Select a file on the left.')))),
      cloud && listing?.value && h('div', { className: 'gtw-file-toolbar' }, button(t('提交历史', 'Commit history'), () => void run(async token => setDetails(await call({ operation: 'history', input: { ...selection(), commit: listing.value.commit, limit: 20 } }, token)))),
        button(t('最近提交的更改', 'Latest commit changes'), () => void run(async token => setDetails(await call({ operation: 'changes', input: { ...selection(), commit: listing.value.commit } }, token))))),
      details?.kind === 'history' && details.value.next_cursor && h('small', null, t('显示最近 20 次提交，更多历史可在网页版查看。', 'Showing the latest 20 commits; open Web for more history.')),
      details?.kind === 'history' && h('ul', null, ...details.value.commits.map(item => h('li', { key: item.id }, `${item.id.slice(0,8)} · ${item.message.slice(0,300)} · ${item.author_name}`))),
      details?.kind === 'changes' && h('ul', null, ...details.value.files.slice(0,300).map(item => h('li', { key: item.path }, `${statusName(item.status)} · ${item.path}`))),
      h('div', { className: 'gtw-file-toolbar' }, button(t('DSH 原生文件预览 ↗', 'Native DSH file preview ↗'), () => void run(async token => {
        if (!leave()) return;
        const result = await call({ operation: 'native' }, token);
        if (!nativeFiles) throw new Error('workspace_native_unavailable');
        delete fileDrafts[cacheKey];
        try { await nativeFiles(result.sessionId); } catch { window.alert(workspaceError('workspace_native_unavailable')); }
      }), !canWrite), webLink && h('a', { href: webLink, target: '_blank', rel: 'noopener noreferrer' }, t('网页版文件管理 ↗', 'File management on Web ↗'))),
      h('small', null, t('本机预览为只读；编辑请使用本机编辑器。引用仅插入相对路径，不上传文件，其他设备可能没有同一文件。图片、文档等附件暂不自动同步。', 'Local previews are read-only; edit with a local editor. References insert relative paths only; other devices may not have the file. Images/documents are not automatically synchronized.'))));
}

async function leaveWorkspaceSolo(connection, memory, seat) {
  const key = JSON.stringify([seat.projectId, seat.sessionId]);
  if (memory.soloDrafts?.[key] !== seat.connectionId || memory.drafts[key]?.trim() || memory.attempts[key]
    || memory.fileDrafts?.[JSON.stringify([seat.connectionId, seat.projectId, seat.sessionId])]) return;
  const receipt = await workspaceCall(connection, { action: 'discardEmptySolo', connectionId: seat.connectionId,
    projectId: seat.projectId, sessionId: seat.sessionId }, seat.controller.signal);
  if (receipt.sessionId !== seat.sessionId || typeof receipt.discarded !== 'boolean') throw new Error('workspace_invalid_response');
  delete memory.soloDrafts[key];
}

function WorkspaceAvatar({ name = '', avatarId, agent = false }) {
  const h = React.createElement;
  const image = Object.prototype.hasOwnProperty.call(WORKSPACE_AVATARS, avatarId) && WORKSPACE_AVATARS[avatarId];
  return h('span', { className: 'gtw-avatar', 'aria-hidden': true },
    h('span', null, [...name].slice(0, 1).join('')),
    image && h('img', { src: image, alt: '', onError: event => { event.currentTarget.hidden = true; } }),
    agent && h('img', { className: 'gtw-avatar-agent', src: WORKSPACE_AVATARS.agent, alt: '' }));
}
const WorkspaceRichBoundary = React.Component ? class extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? React.createElement('div', null,
      React.createElement('small', { role: 'status' }, workspaceText('格式化显示暂不可用，已显示原文。', 'Formatting unavailable; showing source.')),
      React.createElement('p', { className: 'gtw-content' }, this.props.text)) : this.props.children;
  }
} : ({ children }) => children;

function workspaceRelativeFile(path) {
  if (typeof path !== 'string' || path.length > 512 || /[\\\x00-\x1f:?%#]/.test(path) || path.startsWith('/')) return null;
  const value = path.replace(/^\.\//, '');
  if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return value;
}

// This preview never fetches URLs or arbitrary native files. The Host validates
// the exact session/project and its existing localRead allowlist on each click.
function WorkspaceAttachment({ path, connection, seat, nativeFiles, onClose }) {
  const h = workspaceElement, t = workspaceText;
  const [result, setResult] = React.useState(null), [error, setError] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const alive = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController(); alive.current = true; setError(''); setResult(null);
    const request = { action: 'files', connectionId: seat.connectionId, projectId: seat.projectId, sessionId: seat.sessionId,
      request: { operation: 'localRead', path } };
    workspaceCall(connection, request, controller.signal).then(value => {
      if (controller.signal.aborted || seat.controller.signal.aborted) return;
      if (value.result?.kind !== 'text' || value.result.path !== path) throw new Error('workspace_invalid_response');
      setResult(value.result);
    }).catch(reason => { if (!controller.signal.aborted && !seat.controller.signal.aborted) setError(workspaceError(reason.message)); });
    return () => { alive.current = false; controller.abort(); };
  }, [path, reload]);
  const openNative = async () => {
    try {
      const value = await workspaceCall(connection, { action: 'files', connectionId: seat.connectionId, projectId: seat.projectId,
        sessionId: seat.sessionId, request: { operation: 'native' } }, seat.controller.signal);
      if (!alive.current || seat.controller.signal.aborted) return;
      if (value.result?.kind !== 'native') throw new Error('workspace_invalid_response');
      await nativeFiles(value.result.sessionId);
    } catch (reason) { if (alive.current && !seat.controller.signal.aborted) setError(workspaceError(reason.message)); }
  };
  return h(WorkspaceDialog, { title: t('文件预览', 'File preview'), onClose, busy: false },
    h('p', { className: 'gtw-file-reference' }, workspaceIcon('IconFileOutlineRegular', '↗'), path),
    h('small', null, t('只读查看本机项目中的副本；不代表发送者的原始附件，也不会上传文件。', 'Read-only copy in this local project, not the sender’s original attachment. Nothing is uploaded.')),
    error ? h('div', { role: 'alert', className: 'gtw-notice' }, error,
      h('button', { type: 'button', onClick: () => setReload(value => value + 1) }, t('重试', 'Retry')))
      : result ? h('div', { className: 'gtw-rich gtw-file-preview' }, DshUI.CodeBlock
        ? h(DshUI.CodeBlock, { code: result.text, lang: path.split('.').pop(), copyLabel: t('复制', 'Copy'), copiedLabel: t('已复制', 'Copied') })
        : h('pre', null, result.text)) : h('p', { role: 'status' }, t('正在读取…', 'Loading…')),
    nativeFiles && h('button', { type: 'button', onClick: openNative }, t('在 DSH 原生文件面板查看', 'View in DSH’s file panel')));
}

function WorkspaceMessageBody({ item, connection, seat, fileDrag, nativeFiles }) {
  const h = workspaceElement, t = workspaceText;
  const [expanded, setExpanded] = React.useState(null), [raw, setRaw] = React.useState(false);
  const [notice, setNotice] = React.useState(''), [busy, setBusy] = React.useState(false), [file, setFile] = React.useState(null);
  const request = React.useRef(null);
  React.useEffect(() => () => { request.current?.abort(); }, []);
  const current = expanded || item;
  const labels = React.useMemo(() => ({ code: { copyLabel: t('复制代码', 'Copy code'), copiedLabel: t('已复制', 'Copied') }, footnotes: t('脚注', 'Footnotes') }), []);
  // Reuse the public DSH image lightbox/drag transport, but do not give shared
  // Markdown DSH's unrestricted local media resolver or any credential URL.
  const fileImages = React.useMemo(() => fileDrag ? { fileDrag, resolve: () => undefined,
    labels: { open: t('查看图片', 'View image'), loading: t('加载图片…', 'Loading image…'), failed: t('图片加载失败', 'Image unavailable'),
      dialog: t('图片预览', 'Image preview'), close: t('关闭', 'Close') } } : undefined, [fileDrag]);
  const openFile = path => {
    const relative = workspaceRelativeFile(path);
    if (!relative || !seat || seat.controller.signal.aborted) { setNotice(t('此链接不是有效的项目相对路径，请在项目文件面板中查找。', 'Not a valid project-relative path. Find the file in the project file panel.')); return; }
    setFile(relative);
  };
  const expand = async () => {
    if (request.current || !seat || seat.controller.signal.aborted) return;
    const token = new AbortController(); request.current = token; setBusy(true); setNotice('');
    try {
      const value = await workspaceCall(connection, { action: 'message', connectionId: seat.connectionId, projectId: seat.projectId,
        sessionId: seat.sessionId, eventId: item.id, sequence: item.sequence, contentRevision: seat.revision }, token.signal);
      if (token.signal.aborted || seat.controller.signal.aborted) return;
      if (value.contentRevision !== seat.revision || value.message?.id !== item.id || value.message?.sequence !== item.sequence) throw new Error('workspace_conflict');
      setExpanded(value.message);
    } catch (error) { if (!token.signal.aborted && !seat.controller.signal.aborted) setNotice(workspaceError(error.message)); }
    finally { if (request.current === token) { request.current = null; if (!token.signal.aborted) setBusy(false); } }
  };
  let body = h('p', { className: 'gtw-content' }, current.deleted ? t('消息已删除', 'Message deleted') : current.content);
  if (!raw && !current.deleted && DshUI.MarkdownText) {
    body = h(DshUI.MarkdownText, { text: current.content, labels, textInteractionSource: true });
    if (DshUI.MarkdownDelegateProvider) body = h(DshUI.MarkdownDelegateProvider, { openFile, fileImages }, body);
    body = h(WorkspaceRichBoundary, { key: `${item.id}:${current.content.length}`, text: current.content }, body);
  }
  return h('div', null,
    h('div', { className: 'gtw-rich' }, body),
    notice && h('p', { className: 'gtw-notice', role: 'status' }, notice),
    h('div', { className: 'gtw-message-actions' },
      DshUI.MarkdownText && !current.deleted && h('button', { type: 'button', onClick: () => setRaw(value => !value), 'aria-pressed': raw }, raw ? t('格式化显示', 'Formatted view') : t('查看原文', 'View source')),
      item.truncated && !expanded && h('button', { type: 'button', disabled: busy, onClick: expand }, busy ? t('正在展开…', 'Loading…') : t('展开长消息', 'Expand message')),
      expanded && !current.deleted && h('button', { type: 'button', onClick: async () => {
        try { await navigator.clipboard.writeText(current.content); setNotice(t('已复制展开的内容。', 'Expanded content copied.')); }
        catch { setNotice(t('复制失败，请选中文字后复制。', 'Select the text and copy it.')); }
      } }, t('复制展开内容', 'Copy expanded content'))),
    current.truncated && h('small', null, expanded ? t('消息超过 32,000 字，剩余内容请在共序网页查看。', 'Over 32,000 characters; open GatherThread Web for the rest.')
      : t('当前为长消息预览，可点击展开。', 'Long message preview; expand to read more.')),
    file && h(WorkspaceAttachment, { path: file, connection, seat, nativeFiles, onClose: () => setFile(null) }));
}

function GatherThreadWorkspace({ connection, nativeSessions, memory, nativeFiles, fileDrag }) {
  const h = workspaceElement, t = workspaceText;
  const [projects, setProjects] = React.useState([]);
  const [projectId, setProjectId] = React.useState(memory.projectId);
  const [sessions, setSessions] = React.useState([]);
  const [sessionId, setSessionId] = React.useState(memory.sessionId);
  const [page, setPage] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [context, setContext] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const [connected, setConnected] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [contextBusy, setContextBusy] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const [drafts, setDrafts] = React.useState(memory.drafts);
  const [attempts, setAttempts] = React.useState(memory.attempts);
  const [quoteId, setQuoteId] = React.useState('');
  const [modelChoice, setModelChoice] = React.useState('');
  const [effortChoice, setEffortChoice] = React.useState('');
  const [editor, setEditor] = React.useState(null);
  const [actor, setActor] = React.useState(null);
  const [webUrl, setWebUrl] = React.useState('');
  const [sessionQuery, setSessionQuery] = React.useState('');
  const [leftOpen, setLeftOpen] = React.useState(true);
  const [rightOpen, setRightOpen] = React.useState(null);
  const [compact, setCompact] = React.useState(false);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [management, setManagement] = React.useState(null);
  const [webHandoff, setWebHandoff] = React.useState(null);
  const [linkNotice, setLinkNotice] = React.useState('');
  const [filePanel, setFilePanel] = React.useState(false);
  const [syncPanel, setSyncPanel] = React.useState(false);
  const rootNode = React.useRef(null);
  const scope = React.useRef(null);
  const submitting = React.useRef(false);
  const projectSelection = React.useRef(memory.connectionId);
  const messageList = React.useRef(null);
  Object.assign(memory, { drafts, attempts, projectId, sessionId, connectionId: projectSelection.current });
  const draftKey = JSON.stringify([projectId, sessionId]);
  const draft = scope.current?.connectionId ? drafts[draftKey] || '' : '';
  const attempt = attempts[draftKey];
  React.useEffect(() => {
    const controller = new AbortController();
    const seat = { controller, projectId, sessionId, connectionId: '', cursor: 0, revision: undefined };
    scope.current = seat;
    const alive = () => scope.current === seat && !controller.signal.aborted;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      if (alive()) { const narrow = entries[0].contentRect.width < 980; setCompact(previous => { if (narrow && !previous) setRightOpen(false); return narrow; }); }
    }) : null;
    if (rootNode.current) resize?.observe(rootNode.current);
    let timer;
    setConnected(false); setPage(null); setMessages([]); setContext(null); setNotice(memory.navigationNotice || ''); delete memory.navigationNotice; setContextBusy(false); setQuoteId(''); setEditor(null); setProfileOpen(false); setManagement(null); setWebHandoff(null); setLinkNotice(''); setFilePanel(false); setSyncPanel(false);
    const fail = error => {
      if (!alive()) return;
      seat.error = workspaceError(error.message);
      setConnected(false); setPage(null); setContext(null); setNotice(workspaceError(error.message));
      if (['workspace_access_denied', 'workspace_connection_changed', 'workspace_unpaired'].includes(error.message)) {
        setMessages([]); setSessions([]); setFilePanel(false); setSyncPanel(false);
        if (error.message !== 'workspace_access_denied') { memory.fileDrafts = {}; setProjects([]); setDrafts({}); setAttempts({}); setActor(null); setWebUrl(''); }
      }
    };
    const poll = async () => {
      try {
        const next = await workspaceCall(connection, { action: 'read', connectionId: seat.connectionId, projectId, sessionId,
          afterSequence: seat.cursor, ...(seat.revision === undefined ? {} : { contentRevision: seat.revision }) }, controller.signal);
        if (!alive()) return;
        if (!Array.isArray(next.messages) || !Array.isArray(next.members) || !Number.isSafeInteger(next.cursor)
          || (!next.reset && next.cursor < seat.cursor)) throw new Error('workspace_invalid_response');
        if ('targetId' in seat && seat.targetId !== (next.target?.runtimeId ?? null)) { setRefresh(value => value + 1); return; }
        seat.targetId = next.target?.runtimeId ?? null;
        if (next.reset || next.cursor !== seat.cursor) setContext(null);
        if (next.reset) setQuoteId('');
        const follow = seat.cursor === 0 || (messageList.current && messageList.current.scrollHeight - messageList.current.scrollTop - messageList.current.clientHeight < 60);
        seat.cursor = next.cursor; seat.revision = next.contentRevision;
        setMessages(previous => {
          const byId = new Map((next.reset ? [] : previous).map(item => [item.id, item]));
          next.messages.forEach(item => byId.set(item.id, item));
          return [...byId.values()].sort((a, b) => a.sequence - b.sequence).slice(-500);
        });
        setPage(next); setConnected(true);
        if (seat.error) { const recovered = seat.error; seat.error = null; setNotice(previous => previous === recovered ? '' : previous); }
        if (follow && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
          if (alive() && messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
        });
        // A read revalidates identity and membership through several HTTP calls.
        // Leave budget for the connector and another open Desktop/Web panel.
        timer = setTimeout(poll, next.hasMore ? 250 : 5000);
      } catch (error) {
        fail(error);
        if (alive() && !['workspace_access_denied', 'workspace_connection_changed', 'workspace_unpaired'].includes(error.message)) timer = setTimeout(poll, error.message === 'workspace_rate_limited' ? 30000 : 5000);
      }
    };
    void (async () => {
      try {
        const listing = await workspaceCall(connection, { action: 'list' }, controller.signal);
        if (!alive()) return;
        if (!Array.isArray(listing.projects)) throw new Error('workspace_invalid_response');
        if (projectSelection.current && projectSelection.current !== listing.connectionId) { memory.fileDrafts = {}; memory.soloDrafts = {}; setDrafts({}); setAttempts({}); }
        projectSelection.current = listing.connectionId;
        seat.connectionId = listing.connectionId; setProjects(listing.projects);
        setActor(listing.actor); setWebUrl(listing.webUrl || '');
        if (!projectId) { setSessions([]); setConnected(true); return; }
        const list = await workspaceCall(connection, { action: 'sessions', connectionId: seat.connectionId, projectId }, controller.signal);
        if (!alive()) return;
        if (!Array.isArray(list.sessions)) throw new Error('workspace_invalid_response');
        setSessions(list.sessions);
        if (sessionId) await poll(); else setConnected(true);
      } catch (error) { fail(error); }
    })();
    return () => { controller.abort(); resize?.disconnect(); clearTimeout(timer); if (scope.current === seat) scope.current = null; };
  }, [connection, projectId, sessionId, refresh]);
  const showContext = async () => {
    const seat = scope.current;
    if (!seat || !connected || contextBusy) return;
    setContextBusy(true);
    try {
      const next = await workspaceCall(connection, { action: 'context', connectionId: seat.connectionId, projectId, sessionId }, seat.controller.signal);
      if (scope.current !== seat || seat.controller.signal.aborted) return;
      if (next.contentRevision !== seat.revision || next.throughSequence < seat.cursor) throw new Error('workspace_conflict');
      setContext(next);
    } catch (error) { if (scope.current === seat) setNotice(workspaceError(error.message)); }
    finally { if (scope.current === seat) setContextBusy(false); }
  };
  const profiles = page?.target?.profiles || (page?.target ? [{ ...page.target, reasoningEfforts: [] }] : []);
  const profileKey = profile => JSON.stringify([profile.provider, profile.model]);
  const selectedKey = modelChoice || (page?.target ? profileKey(page.target) : '');
  const selectedProfile = profiles.find(profile => profileKey(profile) === selectedKey);
  const selectedEffort = effortChoice;
  const quote = messages.find(item => item.id === quoteId && !item.deleted);
  const latestRequest = [...messages].reverse().find(item => item.controllable && !item.deleted);
  const linked = latestRequest ? messages.filter(item => item.replyTo === latestRequest.id) : [];
  const agentAction = !latestRequest || linked.some(item => item.type === 'agent_response') ? 'request'
    : linked.some(item => item.status === 'paused') ? 'resume' : linked.some(item => item.type === 'agent_progress') ? 'pause' : 'wait';
  const send = async kind => {
    const seat = scope.current;
    if (!seat || !connected || !page?.canWrite || submitting.current || (!attempt && !draft.trim())) return;
    if (!attempt && kind === 'agent' && (!page.target || !selectedProfile || (selectedEffort && !selectedProfile.reasoningEfforts.includes(selectedEffort)))) return;
    if (!attempt && typeof globalThis.crypto?.randomUUID !== 'function') { setNotice(t('此环境无法安全生成请求编号，请升级 DSH 后重试。', 'This environment cannot generate request identities. Update DSH and retry.')); return; }
    submitting.current = true; setBusy(true); setNotice('');
    const request = attempt || { action: 'send', connectionId: seat.connectionId, projectId, sessionId, kind,
      content: draft.trim(), idempotencyKey: globalThis.crypto.randomUUID(), contentRevision: page.contentRevision,
      ...(quote ? { replyTo: quote.id } : {}), ...(kind === 'agent' ? { runtimeId: page.target.runtimeId,
        selection: { provider: selectedProfile.provider, model: selectedProfile.model, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) } } : {}) };
    setAttempts(previous => ({ ...previous, [draftKey]: request }));
    try {
      const receipt = await workspaceCall(connection, request, seat.controller.signal);
      if (scope.current !== seat || seat.controller.signal.aborted) return;
      if (receipt.message) setMessages(previous => [...previous.filter(item => item.id !== receipt.message.id), receipt.message].sort((a, b) => a.sequence - b.sequence).slice(-500));
      setAttempts(previous => { const next = { ...previous }; delete next[draftKey]; return next; });
      if (request.action === 'send') { delete memory.soloDrafts?.[draftKey]; setDrafts(previous => ({ ...previous, [draftKey]: '' })); setQuoteId(''); }
      if (request.action === 'resume') setRefresh(value => value + 1);
      setNotice('');
    } catch (error) { if (scope.current === seat) setNotice(workspaceError(error.message)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const controlAgent = async () => {
    const seat = scope.current;
    if (!seat || !connected || submitting.current || !page?.canWrite || page.hasMore || !latestRequest || !['pause', 'resume'].includes(agentAction)) return;
    submitting.current = true; setBusy(true); setNotice('');
    const request = { action: agentAction, connectionId: seat.connectionId, projectId, sessionId,
      requestId: latestRequest.id, requestSequence: latestRequest.sequence, contentRevision: page.contentRevision,
      ...(agentAction === 'resume' ? { idempotencyKey: globalThis.crypto.randomUUID() } : {}) };
    if (agentAction === 'resume') setAttempts(previous => ({ ...previous, [draftKey]: request }));
    try {
      await workspaceCall(connection, request, seat.controller.signal);
      if (scope.current !== seat || seat.controller.signal.aborted) return;
      setAttempts(previous => { const next = { ...previous }; delete next[draftKey]; return next; });
      setRefresh(value => value + 1);
    } catch (error) { if (scope.current === seat) setNotice(workspaceError(error.message)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const saveSession = async () => {
    const seat = scope.current;
    if (!seat || !connected || submitting.current || !editor?.title.trim()) return;
    submitting.current = true; setBusy(true); setNotice('');
    const request = editor.attempt || { action: editor.action, connectionId: seat.connectionId, projectId,
      ...(editor.action === 'renameSession' ? { sessionId } : { mode: editor.mode }),
      title: editor.title.trim(), idempotencyKey: globalThis.crypto.randomUUID() };
    setEditor({ ...editor, attempt: request });
    try {
      const next = await workspaceCall(connection, request, seat.controller.signal);
      if (scope.current !== seat || seat.controller.signal.aborted) return;
      if (request.action === 'createSession') {
        await leaveSolo(seat);
        if (scope.current !== seat || seat.controller.signal.aborted) return;
        if (next.session.mode === 'solo') (memory.soloDrafts ||= {})[JSON.stringify([projectId, next.sessionId])] = seat.connectionId;
      }
      setEditor(null); setSessionId(next.sessionId); setRefresh(value => value + 1);
    } catch (error) { if (scope.current === seat) setNotice(workspaceError(error.message)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const leaveSolo = async seat => {
    try { await leaveWorkspaceSolo(connection, memory, seat); }
    catch (error) {
      if (scope.current === seat && !seat.controller.signal.aborted) memory.navigationNotice = t('未能确认空 Solo 清理结果，原会话暂时保留。', 'Could not confirm empty Solo cleanup; the conversation is retained for now.') + ' ' + workspaceError(error.message);
    }
  };
  const navigate = async (nextProject, nextSession) => {
    const seat = scope.current;
    if (busy || submitting.current || !seat || (nextProject === projectId && nextSession === sessionId)) return;
    submitting.current = true; setBusy(true);
    try {
      await leaveSolo(seat);
      if (scope.current !== seat || seat.controller.signal.aborted) return;
      if (nextProject !== projectId) { setSessions([]); setSessionQuery(''); }
      setProjectId(nextProject); setSessionId(nextSession);
    } finally { submitting.current = false; setBusy(false); }
  };
  const copyMessage = async item => {
    const seat = scope.current;
    try { await navigator.clipboard.writeText(item.content); if (scope.current === seat) setNotice(t('已复制消息文本。', 'Message text copied.')); }
    catch { if (scope.current === seat) setNotice(t('无法访问剪贴板，请选中文字后复制。', 'Clipboard unavailable. Select the text and copy it.')); }
  };
  const select = (label, value, items, update, extraLabel) => h('label', { className: 'gtw-field' }, label,
    h('select', { value, disabled: busy, onChange: e => update(e.target.value) },
      h('option', { value: '', disabled: true, hidden: true }, t('请选择', 'Select')),
      ...items.map(item => h('option', { key: item.id, value: item.id }, item.name + (extraLabel ? ` · ${item.mode.toUpperCase()}` : '')))));
  const controlsDisabled = busy || !connected || !page?.canWrite || page.hasMore;
  const timeline = [];
  for (const item of messages) {
    const previous = timeline[timeline.length - 1];
    if (item.type === 'agent_progress') {
      if (previous?.progress && previous.replyTo === item.replyTo) previous.items.push(item);
      else timeline.push({ id: item.id, progress: true, replyTo: item.replyTo, items: [item] });
    } else timeline.push(item);
  }
  const renderMessage = item => h('article', { key: item.id, className: `gtw-message ${item.type === 'agent_response' ? 'gtw-agent' : item.actorId === actor?.id ? 'gtw-own' : ''}` },
    h('div', { className: 'gtw-meta' }, h(WorkspaceAvatar, { name: item.author, avatarId: page?.avatars?.find(a => a.user_id === item.ownerId)?.avatar_id, agent: item.type === 'agent_response' }), h('strong', null, item.author),
      h('span', null, item.type === 'agent_response' ? 'Agent' : item.type === 'agent_request' ? t('请求 Agent', 'Agent request') : ''),
      h('time', null, new Date(item.timestamp).toLocaleString())),
    item.replyTo && ['human_chat', 'agent_request'].includes(item.type) && h('div', { className: 'gtw-quote' }, t('引用：', 'Reply to: '), (() => {
      const source = messages.find(m => m.id === item.replyTo);
      return !source || source.deleted ? t('原消息不可用', 'Original unavailable') : `${source.author} · ${source.content.slice(0, 90)}`;
    })()),
    item.status && h('p', { className: 'gtw-notice' }, item.status === 'timeout' ? t('Agent 超时 · 请检查结果后重新请求', 'Agent timed out · check results before requesting again')
      : item.status === 'cancelled' ? t('任务已停止', 'Task stopped') : item.status === 'paused' ? t('任务已暂停', 'Task paused') : t('Agent 执行失败 · 请检查连接与任务说明', 'Agent failed · check the connection and task')),
    item.deleted ? h('p', { className: 'gtw-content' }, t('消息已删除', 'Message deleted'))
      : h(WorkspaceMessageBody, { key: `${item.id}:${page?.contentRevision}`, item, connection, seat: scope.current, fileDrag, nativeFiles }),
    !item.deleted && h('div', { className: 'gtw-message-actions' },
      h('button', { type: 'button', onClick: () => copyMessage(item) }, item.truncated ? t('复制预览', 'Copy preview') : t('复制', 'Copy')),
      h('button', { type: 'button', disabled: controlsDisabled || !!attempt, onClick: () => setQuoteId(item.id) }, t('引用', 'Reply'))));
  const currentSession = sessions.find(item => item.id === sessionId);
  const showMembers = rightOpen ?? !compact;
  const sessionLink = webUrl && projectId ? `${webUrl}#project=${encodeURIComponent(projectId)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}` : '';
  const roleName = role => ({ owner: t('创建者', 'Owner'), participant: t('参与者', 'Participant'), viewer: t('访者', 'Viewer') })[role] || role;
  const effortName = effort => ({ off: t('关闭思考', 'Off'), low: t('低', 'Low'), medium: t('中', 'Medium'), high: t('高', 'High'), max: t('最高', 'Maximum'), xhigh: t('极高', 'Extra high') })[effort] || effort || t('默认', 'Default');
  const dialog = (label, close, children) => h(WorkspaceDialog, { title: label, busy, onClose: close }, children);
  const profileFields = h('div', { className: 'gtw-profile-fields' },
    h('div', { className: 'gtw-target' }, h('strong', null, t('本机 DeepSeek Harness', 'This DeepSeek Harness')), h('small', null, t('读取当前会话的共享上下文', 'Uses this conversation’s shared context'))),
    h('label', { className: 'gtw-field' }, t('模型', 'Model'), h('select', {
      value: selectedKey, disabled: controlsDisabled || !!attempt || !profiles.length || agentAction !== 'request',
      onChange: event => { setModelChoice(event.target.value); setEffortChoice(''); } },
      !selectedProfile && h('option', { value: selectedKey, disabled: true, hidden: true }, t('选择可用模型', 'Select an available model')),
      ...profiles.map(profile => h('option', { key: profileKey(profile), value: profileKey(profile) }, `${profile.model} · ${profile.provider}`)))),
    h('label', { className: 'gtw-field' }, t('推理强度', 'Reasoning effort'), h('select', { value: selectedEffort,
      disabled: controlsDisabled || !!attempt || !selectedProfile?.reasoningEfforts?.length || agentAction !== 'request', onChange: event => setEffortChoice(event.target.value) },
      h('option', { value: '' }, t('模型默认', 'Model default')), ...(selectedProfile?.reasoningEfforts || []).map(effort => h('option', { key: effort, value: effort }, effortName(effort))))),
    agentAction !== 'request' && h('small', null, t('当前请求沿用原模型，结束后可重新选择。', 'This request keeps its original model; choose again after it ends.')),
    h('button', { type: 'button', onClick: () => setProfileOpen(false) }, t('完成', 'Done')));
  const composer = sessionId && h('div', { className: 'gtw-composer' },
    quote && h('div', { className: 'gtw-quote' }, h('span', null, `${t('引用', 'Reply to')} ${quote.author} · ${quote.content.slice(0, 90)}`),
      h('button', { type: 'button', disabled: busy || !!attempt, onClick: () => setQuoteId(''), 'aria-label': t('取消引用', 'Remove reply') }, workspaceIcon('IconCloseOutlineRegular', '×'))),
    h('label', { className: 'gtw-field' }, h('span', { className: 'gtw-sr-only' }, t('发送到此会话', 'Send to this conversation')),
      h('textarea', { value: draft, maxLength: 8000, disabled: !connected || busy || !!attempt, rows: 3,
        placeholder: t('输入发送到会话的内容…', 'Message this conversation…'), onChange: event => setDrafts(previous => ({ ...previous, [draftKey]: event.target.value })) })),
    attempt && h('p', { role: 'status', className: 'gtw-notice' }, t('正在等待回执。重试沿用同一次请求，不会重复创建。刷新页面前请先复制草稿。', 'Awaiting a receipt. Retry reuses the same request. Copy the draft before reloading.')),
    attempt && !busy && h('button', { type: 'button', onClick: () => { setAttempts(previous => { const next = { ...previous }; delete next[draftKey]; return next; }); setNotice(t('已保留草稿。原消息可能已发送，请先检查聊天记录。', 'Draft kept. The original message may have been sent; check history first.')); } }, t('保留草稿，结束重试', 'Keep draft and stop retrying')),
    agentAction === 'resume' && h('small', null, t('继续会使用原模型和最新共享上下文重新发起任务。', 'Resume starts a new request with the original model and latest shared context.')),
    h('div', { className: 'gtw-composer-bar' },
      h('div', { className: 'gtw-agent-controls' },
        h('button', { type: 'button', className: 'gtw-profile-trigger', disabled: busy || !!attempt, 'aria-haspopup': 'dialog',
          onClick: () => setProfileOpen(true), title: t('Agent、模型与推理强度', 'Agent, model and reasoning') }, `DSH · ${effortName(selectedEffort)}`, workspaceIcon('IconChevronDownOutlineRegular', '▾')),
        h('button', { type: 'button', className: 'gtw-manage-trigger', onClick: () => setManagement('home') }, t('管理我的 Agent', 'Manage my Agents'))),
      h('div', { className: 'gtw-actions' }, attempt ? h('button', { type: 'button', disabled: controlsDisabled, onClick: () => send(attempt.kind) }, t('重试同一次发送', 'Retry same send')) : [
        h('button', { key: 'chat', type: 'button', disabled: controlsDisabled || !draft.trim(), onClick: () => send('chat') }, t('发送聊天', 'Send chat')),
        h('button', { key: 'agent', type: 'button', className: 'gtw-primary', disabled: controlsDisabled || !page?.target || agentAction === 'wait' || (agentAction === 'request' && (!selectedProfile || !draft.trim() || (selectedEffort && !selectedProfile.reasoningEfforts.includes(selectedEffort)))),
          onClick: () => agentAction === 'request' ? send('agent') : controlAgent() }, agentAction === 'pause' ? t('暂停 Agent', 'Pause Agent') : agentAction === 'resume' ? t('继续 Agent', 'Resume Agent') : agentAction === 'wait' ? t('等待 Agent 接单…', 'Waiting for Agent…') : t('请求本机 DSH', 'Request this DSH'))])),
    h('div', { className: 'gtw-composer-caption' }, h('small', null, selectedProfile ? selectedProfile.model : t('本机 DSH 未就绪', 'This DSH is not ready')),
      h('small', null, t('发送聊天仅共享消息，不运行 Agent', 'Chat shares a message without running an Agent'))),
    !page?.target && h('small', null, t('在「管理我的 Agent」中检查连接与模型。', 'Check the connection and model in Manage my Agents.')));
  return h('section', { ref: rootNode, className: 'gtw', 'aria-label': t('共序工作区', 'GatherThread workspace') },
    h('style', null, WORKSPACE_CSS),
    h('header', { className: 'gtw-header' },
      h('div', { className: 'gtw-brand' }, h('img', { src: WORKSPACE_MARK, alt: '', width: 32, height: 22 }), h('h1', null, t('共序工作区', 'GatherThread workspace'))),
      h('div', { className: 'gtw-header-actions' },
        !sessionId && h('button', { type: 'button', onClick: () => setManagement('connection') }, t('连接 DSH', 'Connect DSH')),
        h('button', { type: 'button', 'aria-expanded': leftOpen, 'aria-controls': 'gtw-session-rail', onClick: () => setLeftOpen(!leftOpen) }, t('会话', 'Conversations')),
        h('button', { type: 'button', 'aria-expanded': showMembers, 'aria-controls': 'gtw-member-panel', onClick: () => setRightOpen(!showMembers) }, t('成员与上下文', 'Members & context')),
        h('button', { type: 'button', disabled: !connected || !sessionId, onClick: () => setFilePanel(true) }, t('文件', 'Files')),
        h('button', { type: 'button', disabled: !connected || !projectId, onClick: () => setSyncPanel(true) }, t('Git 同步', 'Git sync')),
        h('button', { type: 'button', disabled: busy, onClick: () => setRefresh(value => value + 1) }, t('刷新项目', 'Refresh projects')))),
    h('div', { className: `gtw-grid ${leftOpen ? 'gtw-left-open' : ''} ${showMembers && !compact ? 'gtw-right-open' : ''}` },
      leftOpen && h('nav', { id: 'gtw-session-rail', className: 'gtw-session-rail', 'aria-label': t('项目与会话', 'Projects and conversations') },
        select(t('项目', 'Project'), projectId, projects, value => void navigate(value, '')),
        h('div', { className: 'gtw-rail-heading' }, h('h2', null, t('会话', 'Conversations')),
          h('button', { type: 'button', 'aria-label': t('＋ 新建会话', '＋ New conversation'), title: t('新建会话', 'New conversation'), disabled: busy || !connected || !projects.some(project => project.id === projectId && ['owner', 'participant'].includes(project.role)),
            onClick: () => setEditor({ action: 'createSession', title: '', mode: 'multi' }) }, workspaceIcon('IconPlusOutlineRegular', '+'))),
        h('label', { className: 'gtw-field' }, h('span', { className: 'gtw-sr-only' }, t('搜索会话', 'Search conversations')),
          h('input', { type: 'search', value: sessionQuery, placeholder: t('搜索会话', 'Search conversations'), onChange: event => setSessionQuery(event.target.value) })),
        h('ul', { className: 'gtw-session-list' }, ...sessions.filter(item => item.name.toLowerCase().includes(sessionQuery.trim().toLowerCase())).map(item => h('li', { key: item.id },
          h('button', { type: 'button', className: 'gtw-session-item', 'aria-current': item.id === sessionId ? 'page' : undefined, 'data-session-id': item.id, disabled: busy,
            onClick: () => void navigate(projectId, item.id) }, h('span', { className: 'gtw-session-title', title: item.name }, item.name), h('small', { className: 'gtw-mode' }, item.mode.toUpperCase()))))),
        sessions.length > 0 && !sessions.some(item => item.name.toLowerCase().includes(sessionQuery.trim().toLowerCase())) && h('p', { className: 'gtw-empty' }, t('没有匹配的会话', 'No matching conversations')),
        !sessions.length && h('p', { className: 'gtw-empty' }, projectId ? t('暂无会话，可点击 + 创建。', 'No conversations yet. Use + to create one.') : t('先选择一个项目。', 'Choose a project first.')),
        sessionLink && h('a', { className: 'gtw-web-link', href: sessionLink, target: '_blank', rel: 'noopener noreferrer' }, t('在网页管理项目 ↗', 'Manage project on Web ↗'))),
      h('main', { className: 'gtw-conversation' },
        h('header', { className: 'gtw-session-header' }, h('div', null,
          h('div', { className: 'gtw-title-row' }, h('h2', null, currentSession?.name || t('选择会话开始协作', 'Choose a conversation')), currentSession && h('span', { className: 'gtw-mode' }, currentSession.mode.toUpperCase())),
          h('div', { className: 'gtw-status', role: 'status' }, !sessionId ? t('多人对话与 Agent 共用一份上下文', 'Shared context for people and Agents')
            : !connected ? t('连接中或暂时离线 · 发送已暂停', 'Connecting or offline · sending paused') : page?.hasMore ? t('正在补齐共享记录…', 'Replaying shared history…') : t('共享记录已同步', 'Shared history synced'), page && !page.canWrite && t(' · 只读', ' · Read-only'))),
          h('button', { type: 'button', disabled: busy || !connected || !page?.canManage, onClick: () => setEditor({ action: 'renameSession', title: currentSession?.name || '' }) }, t('重命名', 'Rename'))),
        notice && h('p', { role: 'alert', className: 'gtw-notice' }, notice),
        h('div', { ref: messageList, className: 'gtw-messages', 'aria-label': t('共享消息', 'Shared messages') },
          !messages.length && h('p', { className: 'gtw-empty' }, sessionId ? t('在这里与项目成员交流，也可以请求本机 DSH。', 'Talk to project members or request this DSH here.') : t('从左侧选择或创建会话。', 'Select or create a conversation on the left.')),
          ...timeline.map(item => item.progress ? h('details', { key: item.id, className: 'gtw-progress' }, h('summary', null,
            item.items.some(message => message.status === 'paused') ? t('Agent 已暂停', 'Agent paused') : t('Agent 执行记录', 'Agent activity'), ` · ${item.items.length}`), ...item.items.map(renderMessage)) : renderMessage(item))),
        messages.length >= 500 && h('small', null, t('显示最近 500 条；Agent 仍使用服务器的有效共享上下文。', 'Showing the last 500 messages; Agent context comes from the server.')),
        composer),
      showMembers && !compact && h('aside', { id: 'gtw-member-panel', className: 'gtw-member-panel', 'aria-label': t('成员与上下文', 'Members & context') }, renderMembers())),
    showMembers && compact && dialog(t('成员与上下文', 'Members & context'), () => setRightOpen(false), renderMembers()),
    filePanel && scope.current?.connectionId && h(GatherThreadFiles, { key: `${scope.current.connectionId}:${projectId}:${sessionId}`, connection,
      seat: scope.current, nativeFiles, fileDrafts: memory.fileDrafts || (memory.fileDrafts = {}), canWrite: page?.canWrite === true, webLink: sessionLink,
      onClose: () => setFilePanel(false), onReference: (path, content) => {
        if (attempt || !page?.canWrite) throw new Error('workspace_read_only');
        const value = `${draft}${draft ? '\n' : ''}${content === undefined ? `@${path}` : `${t('文件摘录', 'File excerpt')} · ${path}\n${content}`}`;
        if (value.length > 8000) throw new Error('workspace_file_large');
        setDrafts(previous => ({ ...previous, [draftKey]: value })); setFilePanel(false);
      } }),
    syncPanel && dialog(t('项目 Git 同步', 'Project Git synchronization'), () => setSyncPanel(false), h(GatherThreadStatusPanel, { connection, sessions: nativeSessions, syncProjectId: projectId })),
    profileOpen && dialog(t('Agent、模型与推理强度', 'Agent, model and reasoning'), () => setProfileOpen(false), profileFields),
    editor && dialog(editor.action === 'createSession' ? t('新建会话', 'New conversation') : t('重命名会话', 'Rename conversation'), () => { setEditor(null); setRefresh(value => value + 1); },
      h('div', { className: 'gtw-editor' }, h('label', { className: 'gtw-field' }, t('会话名称', 'Conversation name'), h('input', { value: editor.title, maxLength: 200, disabled: busy || !!editor.attempt, onChange: event => setEditor({ ...editor, title: event.target.value }) })),
        editor.action === 'createSession' && h('label', { className: 'gtw-field' }, t('类型', 'Type'), h('select', { value: editor.mode, disabled: busy || !!editor.attempt, onChange: event => setEditor({ ...editor, mode: event.target.value }) },
          h('option', { value: 'multi' }, t('Multi · 项目成员协作', 'Multi · Project collaboration')), h('option', { value: 'solo' }, t('Solo · 仅自己可见', 'Solo · Private')))),
        editor.action === 'createSession' && editor.mode === 'solo' && h('small', null, t('在此新建的 Solo，未发送内容且没有草稿时，切换会话会自动清理。已有会话和 Multi 会保留。', 'A Solo created here is cleaned up when switching conversations if unused and without a draft. Existing conversations and Multi remain.')),
        editor.attempt && h('small', null, t('回执尚未确认，重试会沿用同一次操作；关闭后请检查会话列表。', 'Receipt unconfirmed. Retry reuses this operation; check the conversation list after closing.')),
        h('div', { className: 'gtw-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => { setEditor(null); setRefresh(value => value + 1); } }, t('取消', 'Cancel')),
          h('button', { type: 'button', disabled: busy || !editor.title.trim(), onClick: saveSession }, busy ? t('保存中…', 'Saving…') : editor.attempt ? t('重试保存', 'Retry save') : t('保存', 'Save'))))),
    management && dialog(t('管理我的 Agent', 'Manage my Agents'), () => setManagement(null), management === 'connection'
      ? h('div', null, h('button', { type: 'button', onClick: () => setManagement('home') }, workspaceIcon('IconChevronLeftOutlineRegular', '‹'), t('返回', 'Back')), h(GatherThreadStatusPanel, { connection, sessions: nativeSessions }))
      : h('div', { className: 'gtw-management-menu' },
        h('button', { type: 'button', onClick: () => setManagement('connection') }, h('strong', null, t('添加 / 连接我的 Agent', 'Add / connect my Agent')), h('small', null, t('本机 DSH 连接、模型与同步设置', 'This DSH’s connection, models and synchronization')), h('span', null, workspaceIcon('IconChevronRightOutlineRegular', '›'))),
        ...[[t('共享我的 Agent', 'Share my Agent'), t('管理允许名单与调用限额', 'Manage access and usage limits')], [t('Agent 团队', 'Agent Teams'), t('预设、JSON 配置、AI 辅助配置与团队任务', 'Presets, JSON, AI-assisted configuration and team tasks')]].map(([title, caption]) =>
          sessionLink ? h('a', { key: title, href: sessionLink, target: '_blank', rel: 'noopener noreferrer', onClick: () => { setWebHandoff({ title, url: sessionLink }); setLinkNotice(''); } }, h('strong', null, title), h('small', null, `${caption} · ${t('前往网页版', 'Open Web')}`), h('span', null, workspaceIcon('IconLinkOutlineRegular', '↗')))
            : h('p', { key: title }, title, h('small', null, t(' · 连接账号并选择项目后可在网页管理', ' · Pair and select a project to manage on Web')))),
        h('small', null, t('在浏览器打开当前项目，再从「管理我的 Agent」进入相应功能。浏览器可能需要单独登录；不会传递 DSH 登录凭据。', 'Opens this project in your browser. Choose the feature under Manage my Agents. Browser sign-in may be required; DSH credentials are not forwarded.')),
        webHandoff?.url === sessionLink && h('div', { className: 'gtw-web-handoff', role: 'status' },
          h('p', null, t(`已请求打开网页。登录后选择「管理我的 Agent → ${webHandoff.title}」。`, `Requested browser opening. After signing in, choose Manage my Agents → ${webHandoff.title}.`)),
          h('small', null, t('没有看到新页面？复制下面的地址到浏览器打开。如果返回接口错误，请确认连接的服务器已部署网页。', 'No new page? Copy this address into your browser. If an API error appears, check that your connected server also serves the Web app.')),
          h('input', { value: sessionLink, readOnly: true, 'aria-label': t('项目网页地址', 'Project Web address'), onFocus: event => event.target.select() }),
          h('button', { type: 'button', onClick: async () => {
            try { await navigator.clipboard.writeText(sessionLink); setLinkNotice(t('已复制项目地址。', 'Project URL copied.')); }
            catch { setLinkNotice(t('无法自动复制，请选中上面的地址手动复制。', 'Select the address above and copy it manually.')); }
          } }, workspaceIcon('IconCopyOutlineRegular'), t('复制地址', 'Copy address')),
          linkNotice && h('small', null, linkNotice)))));

  function renderMembers() {
    return h(React.Fragment || 'div', null,
      h('div', { className: 'gtw-member-heading' }, h('h2', null, t('成员', 'Members')), h('small', null, `${page?.members.length || 0}`)),
      h('ul', { className: 'gtw-members' }, ...(page?.members || []).map((member, index) => h('li', { key: index },
        h(WorkspaceAvatar, { name: member.name, avatarId: page?.avatars?.find(a => a.user_id === member.userId)?.avatar_id }),
        h('div', null, h('strong', null, member.name), h('small', null, roleName(member.role)),
          h('small', { className: member.online ? 'gtw-online' : '' }, member.online ? t('Agent 在线', 'Agent online') : t('Agent 离线', 'Agent offline')))))),
      h('details', { className: 'gtw-context' }, h('summary', null, t('共享上下文', 'Shared context')),
        h('p', null, t('Agent 执行时自动读取最新共享信息。', 'Agents read the latest shared context when executing.')),
        h('button', { type: 'button', disabled: !connected || !sessionId || contextBusy || page?.hasMore, onClick: showContext }, contextBusy ? t('读取中…', 'Loading…') : t('查看当前上下文', 'View current context')),
        context && h('div', null, h('p', null, `${t('截至消息', 'Through event')} #${context.throughSequence} · ${context.totalItems} ${t('条', 'items')}`),
          context.truncated && h('small', null, t('预览最后 30 条，每条最多 2000 字。', 'Last 30 items, up to 2,000 characters each.')),
          ...context.items.map(item => h('article', { key: item.id }, h('small', null, `${messages.find(message => message.id === item.id)?.author || t('共享记录', 'Shared history')} · ${item.type === 'summary' ? t('摘要', 'Summary') : t('原始信息', 'Original')}`), h('p', { className: 'gtw-content' }, item.content))))),
      sessionLink && h('a', { className: 'gtw-web-link', href: sessionLink, target: '_blank', rel: 'noopener noreferrer' }, t('邀请与权限 · 前往网页版 ↗', 'Invites & permissions · Open Web ↗')));
  }
}
const WORKSPACE_CSS = `
.gtw{box-sizing:border-box;height:100%;min-height:0;overflow:hidden;color:inherit;background:inherit;padding:calc(var(--dsh-frame-top-clearance,0px) + 16px) 16px 12px;--gtw-line:var(--dsw-alias-border-l3,rgba(127,127,127,.2));font:inherit;display:flex;flex-direction:column;gap:14px}
.gtw *,.gtw-dialog *{box-sizing:border-box}.gtw h1,.gtw h2,.gtw p{margin:0}.gtw h1{font-size:19px}.gtw h2{font-size:14px}.gtw small{font-size:11px;opacity:.72}.gtw button:not(.gtw-native-button):not(.gtw-rich button),.gtw select,.gtw textarea,.gtw input:not([type=checkbox]):not([type=radio]),.gtw-dialog:not(.gtw-native-dialog) button:not(.gtw-native-button),.gtw-dialog select,.gtw-dialog input:not([type=checkbox]):not([type=radio]){font:inherit;color:inherit;border:1px solid var(--gtw-line);border-radius:8px;background:transparent}.gtw button:not(.gtw-native-button):not(.gtw-rich button){padding:7px 10px;cursor:pointer;min-height:32px;font-size:12px;white-space:nowrap}.gtw button:not(.gtw-native-button):not(.gtw-rich button):hover:not(:disabled){background:rgba(127,127,127,.08)}.gtw button:not(.gtw-native-button):not(.gtw-rich button):disabled{opacity:.48;cursor:default}.gtw :focus-visible{outline:2px solid Highlight;outline-offset:3px}.gtw .gtw-primary:not(.gtw-native-button){background:Highlight;color:HighlightText;border-color:Highlight}.gtw .gtw-primary:not(.gtw-native-button):hover:not(:disabled){background:Highlight}.gtw-header,.gtw-header-actions,.gtw-brand{display:flex;align-items:center;gap:10px}.gtw-header{flex:none;flex-wrap:wrap;justify-content:space-between;padding-left:var(--dsh-frame-leading-clearance,0px)}.gtw-header-actions{gap:6px;flex-wrap:wrap;min-width:0}.gtw-header-actions button{font-size:11px;border-color:transparent;min-height:28px;padding:5px 8px}.gtw-brand{flex-shrink:0}.gtw-grid{display:grid;grid-template-columns:minmax(0,1fr);flex:1;min-height:0;gap:14px}.gtw-grid.gtw-left-open{grid-template-columns:180px minmax(0,1fr)}.gtw-grid.gtw-right-open{grid-template-columns:minmax(0,1fr) 196px}.gtw-grid.gtw-left-open.gtw-right-open{grid-template-columns:180px minmax(0,1fr) 196px}
.gtw-session-rail{display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0;border-right:1px solid var(--gtw-line);padding-right:14px}.gtw-field{display:grid;gap:7px;font-size:12px;min-width:0}.gtw select{padding:8px;width:100%;background:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,FieldText);font-size:12px}.gtw option{background:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,FieldText)}.gtw input:not([type=checkbox]):not([type=radio]){padding:8px;min-width:0;width:100%;background:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,FieldText);font-size:12px}.gtw-rail-heading{display:flex;align-items:center;justify-content:space-between;margin-top:8px}.gtw-rail-heading button{font-size:22px;line-height:1;padding:0 7px;min-height:28px}.gtw-session-list{list-style:none;display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1;padding:0;margin:0}
/* DSH Button sm has a fixed 28px height. Conversation rows own their multi-line
   layout; neither the button nor its list item may compress the title/badge. */
.gtw .gtw-native-button,.gtw-dialog .gtw-native-button{height:auto;min-height:28px;max-width:100%;white-space:normal;overflow-wrap:anywhere;flex-shrink:0}
.gtw-session-list>li{flex:0 0 auto;min-width:0}
.gtw .gtw-session-item{width:100%;height:auto;min-height:64px;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:6px;border-color:transparent;padding:10px;white-space:normal;text-align:start}
.gtw-session-title{display:block;flex:none;max-width:100%;overflow-wrap:anywhere;line-height:1.5}
.gtw-session-item>.gtw-mode{flex:none;align-self:flex-start}
.gtw .gtw-session-item[aria-current=page]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.1));border-color:var(--gtw-line);font-weight:600}.gtw-mode{display:inline-block;font-size:10px;letter-spacing:.07em;border:1px solid var(--gtw-line);border-radius:4px;padding:2px 5px;line-height:1.25;font-weight:600;white-space:nowrap}.gtw-web-link{font-size:11px;color:inherit;opacity:.72;text-decoration:none;line-height:1.6;padding:6px 0}.gtw-web-link:hover{text-decoration:underline;opacity:1}
.gtw-conversation{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto}.gtw-session-header{flex:none;display:flex;gap:8px;align-items:start;justify-content:space-between;border-bottom:1px solid var(--gtw-line);padding:2px 0 12px}.gtw-session-header>div{min-width:0}.gtw-title-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.gtw-title-row h2{font-size:17px;overflow-wrap:anywhere}.gtw-session-header>button{flex-shrink:0;white-space:nowrap;border-color:transparent;font-size:11px;padding:3px 6px;min-height:26px}.gtw-status{font-size:11px;opacity:.66;margin-top:6px;line-height:1.5}.gtw-messages{flex:1;min-height:110px;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:12px;padding:16px 4px 14px 0}.gtw-message{border:1px solid var(--gtw-line);padding:12px;border-radius:10px;flex-shrink:0}.gtw-agent{background:rgba(127,127,127,.045);border-inline-start:2px solid var(--dsw-alias-border-l3,Highlight)}.gtw-meta{overflow-wrap:anywhere;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:11px}.gtw-meta time{margin-left:auto;opacity:.6;font-size:10px}.gtw-content{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;margin-top:8px!important;line-height:1.65}.gtw-message-actions{display:flex;flex-wrap:wrap;gap:4px;margin:6px -4px -4px}.gtw-message-actions button{min-height:23px;padding:3px 5px;font-size:11px;border-color:transparent;border-radius:5px}.gtw-progress{padding:6px 10px;border-left:2px solid var(--gtw-line);font-size:11px;flex-shrink:0}.gtw summary{cursor:pointer;font-size:12px;line-height:1.6}.gtw-progress .gtw-message{margin-top:8px;padding:10px}.gtw-progress .gtw-content{font-size:12px}.gtw-notice{overflow-wrap:anywhere;padding:9px 11px;border:1px solid var(--gtw-line);border-radius:8px;font-size:12px;line-height:1.55;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));flex-shrink:0}
.gtw-composer{border-top:1px solid var(--gtw-line);padding-top:12px;display:grid;gap:10px;flex-shrink:0}.gtw textarea{padding:12px;resize:vertical;min-height:78px;max-height:28vh;width:100%;background:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,FieldText);font-size:13px;line-height:1.6}.gtw-composer-bar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.gtw-agent-controls,.gtw-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.gtw-actions{justify-content:flex-end;margin-left:auto}.gtw-profile-trigger,.gtw-manage-trigger{font-size:11px!important}.gtw-composer-caption{display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between}.gtw-composer-caption small{min-width:0;overflow-wrap:anywhere;font-size:10px}.gtw-quote{border-left:2px solid Highlight;padding:6px 9px;font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));display:flex;justify-content:space-between;gap:8px;overflow-wrap:anywhere;margin:6px 0}.gtw-quote>span{min-width:0}.gtw-quote button{min-height:22px;padding:0 6px;align-self:start}.gtw-empty{opacity:.6;font-size:12px;padding:20px 6px!important;line-height:1.6}
.gtw-rich{min-width:0;max-width:100%;margin-top:8px;overflow-wrap:anywhere}.gtw-rich>div{min-width:0;max-width:100%}.gtw-rich pre{max-width:100%;overflow-x:auto;white-space:pre;font-size:12px}.gtw-rich table{display:block;max-width:100%;overflow-x:auto}.gtw-rich img{max-width:100%;max-height:360px;object-fit:contain}.gtw-rich p,.gtw-rich li{line-height:1.7}.gtw-rich a{overflow-wrap:anywhere}.gtw-rich button{height:auto;max-width:100%}.gtw-meta{align-items:center}.gtw-avatar{position:relative}.gtw-avatar>img{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;object-fit:cover}.gtw-avatar>img.gtw-avatar-agent{inset:auto -3px -3px auto;width:15px;height:15px;border:1px solid var(--dsw-alias-bg-layer-1,Canvas);border-radius:5px}.gtw-file-reference{display:flex;gap:6px;overflow-wrap:anywhere}.gtw-file-preview{max-height:55vh;overflow:auto}
.gtw-member-panel{border-left:1px solid var(--gtw-line);padding-left:14px;min-width:0;overflow:auto;min-height:0}.gtw-member-heading{display:flex;align-items:center;justify-content:space-between;margin:4px 0 18px}.gtw-members{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:18px}.gtw-members li{display:flex;gap:9px;min-width:0}.gtw-members li>div{display:grid;gap:3px;min-width:0}.gtw-members strong{font-size:12px;overflow-wrap:anywhere}.gtw-avatar{display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;border:1px solid var(--gtw-line);border-radius:50%;font-size:12px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}.gtw-online{color:inherit;opacity:.9!important}.gtw-online:before{content:'●';font-size:7px;margin-right:5px}.gtw-context{margin-top:22px;padding-top:15px;border-top:1px solid var(--gtw-line)}.gtw-context>p{margin:12px 0;font-size:12px;line-height:1.6;opacity:.7}.gtw-context article{padding:10px 0;border-top:1px solid var(--gtw-line)}.gtw-context>div{margin-top:12px}.gtw-context button{font-size:11px;max-width:100%;white-space:normal}.gtw-member-panel>.gtw-web-link{display:block;margin-top:18px}
.gtw-dialog{--gtw-line:var(--dsw-alias-border-l3,rgba(127,127,127,.2));background:Canvas;color:CanvasText;border:1px solid var(--gtw-line);border-radius:14px;max-height:85vh;width:min(560px,calc(100vw - 40px));padding:0;box-shadow:0 20px 70px rgba(0,0,0,.18);font:inherit}.gtw-dialog::backdrop{background:rgba(0,0,0,.22)}.gtw-dialog-heading{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--gtw-line)}.gtw-dialog-heading h2{font-size:16px}.gtw-dialog-heading button{font-size:20px;border:0;min-height:28px;padding:0 7px}.gtw-dialog-body{padding:18px;max-height:calc(85vh - 65px);overflow:auto}.gtw-profile-fields,.gtw-editor{display:grid;gap:16px}.gtw-target{display:grid;gap:5px;padding-bottom:12px;border-bottom:1px solid var(--gtw-line);font-size:13px}.gtw-management-menu{display:grid;gap:10px}.gtw-management-menu>a,.gtw-management-menu>button{height:auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;text-align:start;overflow-wrap:anywhere;white-space:normal;padding:14px;border:1px solid var(--gtw-line);border-radius:10px;color:inherit;background:transparent;text-decoration:none}.gtw-management-menu strong{font-size:13px}.gtw-management-menu small{grid-column:1;line-height:1.5}.gtw-management-menu>a>span,.gtw-management-menu>button>span{grid-column:2;grid-row:1/3;align-self:center}.gtw-management-menu>a:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}.gtw-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.gtw-dialog.gtw-files{width:min(1040px,calc(100vw - 40px))}.gtw-file-body{display:flex;flex-direction:column;gap:12px}.gtw-file-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.gtw-file-toolbar button[aria-pressed=true]{background:rgba(127,127,127,.14);font-weight:600;border-color:Highlight}.gtw-file-directory{font-size:11px;overflow-wrap:anywhere;opacity:.7}.gtw-file-grid{display:grid;grid-template-columns:minmax(170px,26%) minmax(0,1fr);gap:16px;min-height:300px}.gtw-file-list{min-width:0;display:flex;flex-direction:column;gap:5px;max-height:400px;overflow:auto;padding-right:10px;border-right:1px solid var(--gtw-line)}.gtw-file-list button{height:auto;min-height:32px;flex-shrink:0;padding:7px 10px;text-align:left;white-space:normal;overflow-wrap:anywhere;display:grid;grid-template-columns:minmax(0,1fr);justify-content:stretch;justify-items:start;gap:3px}.gtw-file-list button[aria-current=true]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.1));font-weight:600}.gtw-file-preview{display:flex;flex-direction:column;gap:10px;min-width:0}.gtw-file-preview>strong{font-size:12px;overflow-wrap:anywhere}.gtw-file-preview textarea{height:280px;max-height:400px;max-width:100%;font:12px/1.6 ui-monospace,monospace;white-space:pre;overflow:auto;border:1px solid var(--gtw-line);border-radius:8px;background:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,FieldText)}.gtw-diff{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}.gtw-diff>div{min-width:0}.gtw-diff pre{overflow:auto;max-height:300px;font:12px/1.6 ui-monospace,monospace;white-space:pre;border:1px solid var(--gtw-line);padding:10px;border-radius:8px}.gtw-file-toolbar a{font-size:12px;color:inherit}.gtw-files small{line-height:1.6}
.gtw-dialog.gtw-native-dialog{border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);max-height:100%;padding:0 0 24px;width:min(560px,100%)}
.gtw-dialog.gtw-native-dialog.gtw-files{width:min(1040px,100%)}.gtw-modal-scroll{overflow:auto;min-height:0}
/* The public Modal content slot includes its official header. Keep its close
   control reachable while long forms scroll, without replacing DSH chrome. */
.gtw-modal-scroll>:first-child{position:sticky;top:0;z-index:1;flex-shrink:0;background:var(--dsw-alias-bg-layer-2)}.gtw-native-dialog .gtw-dialog-body{padding:0;max-height:none;overflow:visible}.gtw-native-dialog small{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}.gtw-native-dialog input:not([type=checkbox]):not([type=radio]),.gtw-native-dialog select{font:inherit;padding:8px;min-width:0;max-width:100%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.gtw-web-handoff{min-width:0;overflow-wrap:anywhere;display:grid;gap:10px;padding:12px;border:1px solid var(--gtw-line);border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:1.6}.gtw-web-handoff p{margin:0}.gtw-web-handoff input{width:100%;font-size:11px}.gtw-web-handoff button{justify-self:start}.gtw-dialog :focus-visible{outline:2px solid Highlight;outline-offset:3px}
@media(max-width:650px){.gtw-file-grid,.gtw-diff{grid-template-columns:1fr}.gtw-file-list{max-height:160px;border-right:0;border-bottom:1px solid var(--gtw-line);padding-bottom:10px}}
@media(max-width:800px){.gtw{padding:12px 10px;overflow:auto}.gtw-header{align-items:start}.gtw-header-actions{flex-wrap:wrap;justify-content:flex-end}.gtw-header h1{font-size:16px}.gtw-grid.gtw-left-open{grid-template-columns:150px minmax(0,1fr)}.gtw-grid{gap:10px;min-height:470px}.gtw-session-rail{padding-right:10px}.gtw-title-row{flex-wrap:wrap}.gtw-composer-caption small:last-child{display:none}.gtw .gtw-manage-trigger{max-width:150px;overflow:hidden;text-overflow:ellipsis}}
@media(forced-colors:active){.gtw button:not(.gtw-native-button):not(.gtw-rich button),.gtw-message,.gtw textarea,.gtw-session-item[aria-current=page]{border-color:CanvasText}.gtw-dialog{border-color:CanvasText}}`;

module.exports = { inject, apply };
return module.exports; } });
