// Small DOM and formatting helpers shared by the analyzer and the planner.

export const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const hour12 = !['h23', 'h24'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle);

/** Tiny DOM builder. Text only, never innerHTML with data. */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.style.cssText = v;
    // Links come from third-party servers; only let web, relative and blob links through.
    else if (k === 'href' && !/^(https?:|blob:|[./#]|[\w-]+\.html)/i.test(String(v))) continue;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

/** Every IANA time zone the browser knows, with UTC and the visitor's own zone guaranteed. */
export function timeZones() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.includes(localZone)) zones.unshift(localZone);
  if (!zones.includes('UTC')) zones.unshift('UTC');
  return zones;
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
