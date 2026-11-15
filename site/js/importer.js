// Turn an exported file into normalized posts. Handles:
//  - CSV/TSV exports from analytics dashboards (columns are detected, then the user can adjust them)
//  - X/Twitter archive tweets.js ("window.YTD.tweets.part0 = [...]")
//  - Reddit listing JSON saved from a logged-in browser (…/top.json)
//  - any JSON array of objects (treated like a table)

import { hostOf } from './sources.js';

/** RFC 4180 CSV parser with delimiter detection. Returns rows of strings. */
export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const pad = (n) => String(n).padStart(2, '0');

/** Offset (ms) of a time zone at a UTC instant. */
function zoneOffset(utcMs, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in a zone to a UTC timestamp. */
export function wallToUTC(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - zoneOffset(guess, timeZone);
  t = guess - zoneOffset(t, timeZone); // second pass settles DST edges
  return t;
}

/**
 * Parse a date string or number. Strings with an explicit offset or Z are exact;
 * wall-clock strings are read in `timeZone`. `order` is 'mdy' or 'dmy' for slash dates.
 */
export function parseDate(value, { timeZone = 'UTC', order = 'mdy' } = {}) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number' || /^\d{9,13}(\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    return n < 1e11 ? n * 1000 : n; // seconds vs milliseconds
  }
  const s = String(value).trim();
  // ISO-like: 2026-11-15, 2026-11-15T14:05, 2026-11-15 14:05:09, optional offset
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', off] = m;
    if (off) return Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${mi}:${pad(sec)}${off.toUpperCase() === 'Z' ? 'Z' : off.length === 5 ? `${off.slice(0, 3)}:${off.slice(3)}` : off}`);
    return wallToUTC(+y, +mo, +d, +h, +mi, +sec, timeZone);
  }
  // Slash dates: 11/15/2026 2:05 PM, 15/11/2026 14:05
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    let [, a, b, y, h = '0', mi = '0', sec = '0', ap] = m;
    let mo = order === 'dmy' ? +b : +a;
    let d = order === 'dmy' ? +a : +b;
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    let yy = +y; if (yy < 100) yy += 2000;
    let hh = +h;
    if (ap) { hh %= 12; if (/p/i.test(ap)) hh += 12; }
    return wallToUTC(yy, mo, d, hh, +mi, +sec, timeZone);
  }
  // Anything else (e.g. "Wed Oct 10 20:19:24 +0000 2018", RFC 2822) — let the engine try.
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

const METRIC_PATTERNS = [
  ['likes', /^(likes?|like count|reactions?|favou?rites?|favorite_count|hearts?|upvotes?|ups)$/i],
  ['comments', /^(comments?|comment count|replies|reply count|num_comments)$/i],
  ['shares', /^(shares?|reposts?|retweets?|retweet_count|boosts?|reshares?)$/i],
  ['saves', /^(saves?|saved|bookmarks?)$/i],
  ['score', /^(score|points|karma)$/i],
  ['engagements', /^(engagements?|total engagements?|interactions?)$/i],
  ['clicks', /^(clicks?|link clicks?)$/i],
  ['views', /^(views?|impressions?|reach|plays?|video views?)$/i],
];
const DATE_HINT = /(date|time|created|published|posted|timestamp|publish)/i;
const TEXT_HINT = /(title|text|caption|message|content|description|post|tweet|body)/i;
const URL_HINT = /(url|link|permalink)/i;

function toNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/[\s,](?=\d{3}\b)/g, '').replace(/%$/, '');
  const k = s.match(/^([\d.]+)\s*([kKmM])$/);
  if (k) return parseFloat(k[1]) * (/k/i.test(k[2]) ? 1e3 : 1e6);
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** Guess which columns hold the date, text, link and metrics. */
export function detectColumns(headers, rows) {
  const sample = rows.slice(0, 50);
  const numericShare = (i) => sample.filter((r) => Number.isFinite(toNumber(r[i]))).length / (sample.length || 1);
  const dateShare = (i) => sample.filter((r) => Number.isFinite(parseDate(r[i]))).length / (sample.length || 1);
  let date = headers.findIndex((h, i) => DATE_HINT.test(h) && dateShare(i) > 0.8);
  if (date < 0) date = headers.findIndex((h, i) => numericShare(i) < 0.5 && dateShare(i) > 0.8);
  const metrics = {};
  headers.forEach((h, i) => {
    const name = h.trim();
    const hit = METRIC_PATTERNS.find(([, re]) => re.test(name) || re.test(name.replace(/[_-]/g, ' ')));
    if (hit && numericShare(i) > 0.6 && !(hit[0] in metrics)) metrics[hit[0]] = i;
  });
  const text = headers.findIndex((h, i) => i !== date && TEXT_HINT.test(h) && numericShare(i) < 0.2);
  const url = headers.findIndex((h, i) => URL_HINT.test(h) && sample.some((r) => /^https?:\/\//.test(r[i] || '')));
  // Day-first if any slash date has a first part above 12.
  const order = date >= 0 && sample.some((r) => { const m = String(r[date] || '').match(/^(\d{1,2})[/.]/); return m && +m[1] > 12; }) ? 'dmy' : 'mdy';
  return { date, metrics, text, url, order };
}

export function rowsToPosts(headers, rows, mapping, timeZone) {
  const posts = [];
  rows.forEach((r, n) => {
    const createdAt = parseDate(r[mapping.date], { timeZone, order: mapping.order });
    if (!Number.isFinite(createdAt)) return;
    const metrics = {};
    for (const [k, i] of Object.entries(mapping.metrics)) {
      if (i === undefined || i < 0) continue;
      const v = toNumber(r[i]);
      metrics[k] = Number.isFinite(v) ? v : 0;
    }
    const text = mapping.text >= 0 ? String(r[mapping.text] || '') : '';
    const url = mapping.url >= 0 ? String(r[mapping.url] || '') : '';
    const tags = (text.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase());
    posts.push({ id: `row${n}`, createdAt, metrics, text, title: '', url, domain: url ? hostOf(url) : null, tags });
  });
  return posts;
}

/** Recognize structured exports that need no column mapping. Returns posts or null. */
function structured(json) {
  // X archive
  const tweets = Array.isArray(json) && json.length && json[0] && json[0].tweet ? json.map((x) => x.tweet) : null;
  if (tweets) {
    return {
      kind: 'X archive',
      metricsAvailable: ['likes', 'reposts'],
      posts: tweets
        .filter((t) => !String(t.full_text || '').startsWith('RT @') && !t.in_reply_to_status_id_str)
        .map((t) => ({
          id: t.id_str,
          createdAt: Date.parse(t.created_at),
          metrics: { likes: Number(t.favorite_count) || 0, reposts: Number(t.retweet_count) || 0 },
          text: t.full_text || '',
          url: `https://x.com/i/web/status/${t.id_str}`,
          domain: t.entities?.urls?.[0]?.expanded_url ? hostOf(t.entities.urls[0].expanded_url) : (t.extended_entities?.media?.length ? 'Media post' : 'Text post'),
          tags: (t.entities?.hashtags || []).map((h) => `#${h.text.toLowerCase()}`),
        })),
    };
  }
  // Reddit listing(s)
  const listings = (Array.isArray(json) ? json : [json]).filter((l) => l && l.kind === 'Listing' && l.data?.children);
  if (listings.length) {
    const children = listings.flatMap((l) => l.data.children).filter((c) => c.kind === 't3');
    return {
      kind: 'Reddit listing',
      metricsAvailable: ['upvotes', 'comments'],
      posts: children.map(({ data: p }) => ({
        id: p.id,
        createdAt: p.created_utc * 1000,
        metrics: { upvotes: p.score || 0, comments: p.num_comments || 0 },
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        domain: p.is_self ? 'Text post' : p.domain,
        tags: p.link_flair_text ? [p.link_flair_text] : [],
        author: p.author,
      })),
      profileName: children[0] ? `r/${children[0].data.subreddit}` : 'Reddit file',
    };
  }
  return null;
}

/**
 * Read a file. Returns either { posts, kind } for a recognized export, or
 * { table: { headers, rows }, mapping } for the user to confirm.
 */
export function readFile(name, text) {
  const trimmed = text.trim().replace(/^﻿/, '');
  const looksJSON = /^[[{]/.test(trimmed) || /^window\.YTD\./.test(trimmed);
  if (looksJSON) {
    const json = JSON.parse(trimmed.replace(/^window\.YTD\.[\w.]+\s*=\s*/, ''));
    const s = structured(json);
    if (s) return s;
    const arr = Array.isArray(json) ? json : Object.values(json).find(Array.isArray);
    if (!arr || !arr.length || typeof arr[0] !== 'object') throw new Error('This JSON file has no list of posts in it.');
    const headers = [...new Set(arr.slice(0, 200).flatMap((o) => Object.keys(o).filter((k) => typeof o[k] !== 'object' || o[k] === null)))];
    const rows = arr.map((o) => headers.map((h) => (o[h] === null || o[h] === undefined ? '' : String(o[h]))));
    return { table: { headers, rows }, mapping: detectColumns(headers, rows) };
  }
  const all = parseCSV(text);
  // Some exports put a title line above the header; use the first row with 3+ non-empty cells.
  const headerIndex = all.findIndex((r) => r.filter((c) => c.trim()).length >= 3);
  if (headerIndex < 0) throw new Error(`Couldn't find a table in ${name}.`);
  const headers = all[headerIndex].map((h) => h.trim());
  const rows = all.slice(headerIndex + 1).filter((r) => r.some((c) => c.trim()));
  return { table: { headers, rows }, mapping: detectColumns(headers, rows) };
}
