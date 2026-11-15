// Tools page: character counters, UTM link builder, Unicode font styles.
import { initTheme } from './theme.js';

/* ---------- character counting ---------- */

// X counts with twitter-text config v3: code points in these ranges weigh 1,
// everything else 2, every emoji 2, and every URL 23.
// https://github.com/twitter/twitter-text/blob/master/config/v3.json
const X_LIGHT_RANGES = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const URL_RE = /\bhttps?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|co|app|dev|me|ly|gg|ai|social)\b(?:\/[^\s]*)?/gi;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function graphemes(text) {
  return segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : Array.from(text);
}

export function xWeightedLength(text) {
  text = text.normalize('NFC');
  let urls = 0;
  const stripped = text.replace(URL_RE, () => { urls += 1; return ''; });
  let weight = 0;
  for (const g of graphemes(stripped)) {
    if (EMOJI_RE.test(g)) { weight += 2; continue; }
    for (const ch of g) {
      const cp = ch.codePointAt(0);
      weight += X_LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return weight + urls * 23;
}

export function mastodonLength(text) {
  // Mastodon counts every link as 23 characters and @user@domain mentions by the username only.
  let urls = 0;
  const stripped = text.replace(/\bhttps?:\/\/[^\s]+/gi, () => { urls += 1; return ''; }).replace(/(@[\w.]+)@[\w.-]+\.[a-z]{2,}/gi, '$1');
  return Array.from(stripped).length + urls * 23;
}

const length = (t) => Array.from(t).length; // code points; close to what most sites show

// Limits checked November 2026; sources in the README.
export const PLATFORMS = [
  { id: 'x', name: 'X / Twitter post', limit: 280, count: xWeightedLength, note: 'Weighted: links count 23, emoji and most non-Latin characters count 2. Premium accounts can post up to 25,000.' },
  { id: 'bluesky', name: 'Bluesky post', limit: 300, count: (t) => graphemes(t).length, note: 'Counted in graphemes, so an emoji with skin tone counts once.' },
  { id: 'threads', name: 'Threads post', limit: 500, count: length },
  { id: 'mastodon', name: 'Mastodon post', limit: 500, count: mastodonLength, note: 'Default limit; some servers allow more. Links count 23.' },
  { id: 'reddit', name: 'Reddit title', limit: 300, count: length },
  { id: 'instagram', name: 'Instagram caption', limit: 2200, count: length, note: 'Only the first 125 or so characters show before “more”.' },
  { id: 'tiktok', name: 'TikTok caption', limit: 4000, count: length, note: 'In the app. Captions posted through scheduling tools are capped at 2,200.' },
  { id: 'linkedin', name: 'LinkedIn post', limit: 3000, count: length },
  { id: 'facebook', name: 'Facebook post', limit: 63206, count: length },
  { id: 'youtube-title', name: 'YouTube title', limit: 100, count: length },
  { id: 'youtube-desc', name: 'YouTube description', limit: 5000, count: length },
  { id: 'pinterest-title', name: 'Pinterest pin title', limit: 100, count: length },
  { id: 'pinterest-desc', name: 'Pinterest pin description', limit: 800, count: length },
];

/* ---------- UTM ---------- */
export function buildUTM(base, params) {
  let url;
  try { url = new URL(base.trim()); } catch { return { error: 'Enter a full address starting with https://' }; }
  if (!/^https?:$/.test(url.protocol)) return { error: 'Only http and https links can carry UTM tags.' };
  for (const [k, v] of Object.entries(params)) {
    const value = String(v || '').trim();
    if (value) url.searchParams.set(k, value); else url.searchParams.delete(k);
  }
  return { url: url.toString() };
}

/* ---------- Unicode styles ---------- */
const A = 65, a = 97, ZERO = 48;
function mapAlpha(text, upperStart, lowerStart, digitStart, exceptions = {}) {
  let out = '';
  for (const ch of text) {
    if (exceptions[ch]) { out += exceptions[ch]; continue; }
    const c = ch.codePointAt(0);
    if (c >= A && c < A + 26 && upperStart) out += String.fromCodePoint(upperStart + c - A);
    else if (c >= a && c < a + 26 && lowerStart) out += String.fromCodePoint(lowerStart + c - a);
    else if (c >= ZERO && c < ZERO + 10 && digitStart) out += String.fromCodePoint(digitStart + c - ZERO);
    else out += ch;
  }
  return out;
}
// Mathematical Alphanumeric Symbols block; a few letters live in Letterlike Symbols instead.
export const STYLES = [
  { name: 'Bold', fn: (t) => mapAlpha(t, 0x1d400, 0x1d41a, 0x1d7ce) },
  { name: 'Italic', fn: (t) => mapAlpha(t, 0x1d434, 0x1d44e, 0, { h: 'ℎ' }) },
  { name: 'Bold italic', fn: (t) => mapAlpha(t, 0x1d468, 0x1d482, 0) },
  { name: 'Sans bold', fn: (t) => mapAlpha(t, 0x1d5d4, 0x1d5ee, 0x1d7ec) },
  { name: 'Sans italic', fn: (t) => mapAlpha(t, 0x1d608, 0x1d622, 0) },
  { name: 'Script', fn: (t) => mapAlpha(t, 0x1d49c, 0x1d4b6, 0, { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' }) },
  { name: 'Fraktur', fn: (t) => mapAlpha(t, 0x1d504, 0x1d51e, 0, { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' }) },
  { name: 'Double-struck', fn: (t) => mapAlpha(t, 0x1d538, 0x1d552, 0x1d7d8, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' }) },
  { name: 'Monospace', fn: (t) => mapAlpha(t, 0x1d670, 0x1d68a, 0x1d7f6) },
  { name: 'Small caps', fn: (t) => [...t].map((c) => 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'[c.toLowerCase().charCodeAt(0) - 97] || c).join('') },
  { name: 'Circled', fn: (t) => mapAlpha(t, 0x24b6, 0x24d0, 0, { 0: '⓪', 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤', 6: '⑥', 7: '⑦', 8: '⑧', 9: '⑨' }) },
  { name: 'Fullwidth', fn: (t) => [...t].map((c) => { const x = c.codePointAt(0); return x >= 33 && x <= 126 ? String.fromCodePoint(x + 0xfee0) : c === ' ' ? '　' : c; }).join('') },
  { name: 'Strikethrough', fn: (t) => [...t].map((c) => (c === ' ' ? c : `${c}̶`)).join('') },
  { name: 'Underline', fn: (t) => [...t].map((c) => `${c}̲`).join('') },
];

/* ---------- page wiring (browser only) ---------- */
if (typeof document !== 'undefined') {
  initTheme();
  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } n.append(...kids); return n; };

  // counter
  const text = $('count-text');
  const list = $('count-list');
  const rows = PLATFORMS.map((p) => {
    const value = h('span', { class: 'score' });
    const meter = h('i');
    const li = h('li', {}, h('div', {}, h('div', { class: 'when' }, p.name), p.note ? h('div', { class: 'sub' }, p.note) : '', h('div', { class: 'meter', 'aria-hidden': 'true' }, meter)), value);
    list.append(li);
    return { p, value, meter, li };
  });
  const update = () => {
    const t = text.value;
    $('count-basic').textContent = `${Array.from(t).length.toLocaleString()} characters, ${(t.match(/\S+/g) || []).length.toLocaleString()} words, ${t ? t.split(/\n/).length : 0} lines`;
    for (const r of rows) {
      const n = r.p.count(t);
      const over = n > r.p.limit;
      r.value.textContent = `${n.toLocaleString()} / ${r.p.limit.toLocaleString()}`;
      r.value.style.color = over ? 'var(--danger)' : '';
      r.meter.style.transform = `scaleX(${Math.min(1, n / r.p.limit)})`;
      r.meter.style.background = over ? 'var(--danger)' : '';
      r.li.dataset.over = over;
      r.value.setAttribute('aria-label', `${r.p.name}: ${n} of ${r.p.limit}${over ? `, ${n - r.p.limit} over` : ''}`);
    }
  };
  text.addEventListener('input', update);
  update();

  // UTM
  const utmForm = $('utm');
  const presets = {
    '': {}, reddit: { utm_source: 'reddit', utm_medium: 'social' }, x: { utm_source: 'twitter', utm_medium: 'social' },
    bluesky: { utm_source: 'bluesky', utm_medium: 'social' }, mastodon: { utm_source: 'mastodon', utm_medium: 'social' },
    linkedin: { utm_source: 'linkedin', utm_medium: 'social' }, facebook: { utm_source: 'facebook', utm_medium: 'social' },
    instagram: { utm_source: 'instagram', utm_medium: 'social' }, threads: { utm_source: 'threads', utm_medium: 'social' },
    tiktok: { utm_source: 'tiktok', utm_medium: 'social' }, pinterest: { utm_source: 'pinterest', utm_medium: 'social' },
    youtube: { utm_source: 'youtube', utm_medium: 'video' }, newsletter: { utm_source: 'newsletter', utm_medium: 'email' },
  };
  const renderUTM = () => {
    const f = new FormData(utmForm);
    const r = buildUTM(f.get('base') || '', Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map((k) => [k, f.get(k)])));
    $('utm-out').value = r.url || '';
    $('utm-error').textContent = f.get('base') ? r.error || '' : '';
    $('utm-copy').disabled = !r.url;
  };
  utmForm.addEventListener('input', renderUTM);
  utmForm.querySelector('[name=preset]').addEventListener('change', (e) => {
    for (const [k, v] of Object.entries(presets[e.target.value] || {})) utmForm.elements[k].value = v;
    renderUTM();
  });
  $('utm-copy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText($('utm-out').value); e.target.textContent = 'Copied'; } catch { $('utm-out').select(); e.target.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { e.target.textContent = 'Copy link'; }, 2000);
  });
  renderUTM();

  // fonts
  const fontIn = $('font-text');
  const fontList = $('font-list');
  const renderFonts = () => {
    const t = fontIn.value || 'Post when your crowd is awake';
    fontList.replaceChildren(...STYLES.map((s) => {
      const out = s.fn(t);
      const btn = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Copy');
      btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(out); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
      return h('li', {}, h('div', {}, h('div', { class: 'sub' }, s.name), h('div', { class: 'when font-sample' }, out)), btn);
    }));
  };
  fontIn.addEventListener('input', renderFonts);
  renderFonts();
}
