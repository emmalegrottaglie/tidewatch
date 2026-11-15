// Builds a platform-wide "best time to post on Bluesky" benchmark from measured posts.
//
//   node scripts/bluesky-benchmark.mjs <data-dir> [--sample-minutes 5] [--keep 100]
//
// Each run does three things:
//  1. Settle: posts sampled at least 48 hours ago are re-read with app.bsky.feed.getPosts
//     (25 per request) to get their like, repost, reply and quote counts.
//  2. Sample: listen to Jetstream for --sample-minutes, count every new top-level post per
//     minute and language (activity), and keep a uniform random sample of --keep of them
//     (reservoir sampling) to settle two days later.
//  3. Publish: drop anything older than the window and write <data-dir>/public/bluesky.json,
//     which the benchmarks page feeds straight into the same analysis as the analyzer.
//
// The pipeline runs this every hour, so over a few weeks every hour of the week gets sampled on
// several days. State lives in <data-dir>/state/bluesky-pending.json.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identifyRequests, readJSON, argValue, isMain } from './util.mjs';

export const JETSTREAM = 'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';
export const GET_POSTS = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts';
/** Language groups kept separately; everything else (and posts without a language) is "other". */
export const LANGS = ['en', 'ja', 'pt', 'es', 'de', 'ko', 'fr'];
export const OTHER = LANGS.length;
export const SETTLE_HOURS = 48;
export const WINDOW_DAYS = 28;
const HOUR = 3600_000, DAY = 24 * HOUR, MINUTE = 60_000;

/** Index into LANGS for a post's first declared language ("en-US" counts as "en"). */
export function langIndex(langs) {
  const code = String((langs && langs[0]) || '').toLowerCase().split('-')[0];
  const i = LANGS.indexOf(code);
  return i === -1 ? OTHER : i;
}

/** Uniform random sample of at most `size` items from a stream (Algorithm R). */
export function reservoir(size, random = Math.random) {
  const items = [];
  let seen = 0;
  return {
    add(item) {
      seen++;
      if (items.length < size) items.push(item);
      else {
        const j = Math.floor(random() * seen);
        if (j < size) items[j] = item;
      }
    },
    get items() { return items; },
    get seen() { return seen; },
  };
}

/**
 * Per-minute counts for the activity view, as rows [timestampMs, total, ...perLanguage]. The
 * timestamp is the minute's midpoint clamped into the sample interval, so a count never lands in
 * an hour the sample didn't cover.
 */
export function minuteRows(counts, [start, end]) {
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minute, byLang]) => {
      const t = Math.min(end - 1, Math.max(start, minute * MINUTE + MINUTE / 2));
      return [t, byLang.reduce((a, b) => a + b, 0), ...byLang];
    });
}

/** Read Jetstream for `ms` milliseconds. */
export function sampleJetstream({ ms, keep, url = JETSTREAM, log = console.log }) {
  return new Promise((resolve, reject) => {
    const sample = reservoir(keep);
    const counts = new Map(); // minute -> per-language counts
    let start = null, end = null;
    const ws = new WebSocket(url);
    const finish = () => {
      ws.close();
      if (start === null) return reject(new Error('Jetstream sent no posts'));
      log(`Bluesky: saw ${sample.seen} top-level posts in ${Math.round((end - start) / 1000)}s, kept ${sample.items.length}`);
      resolve({ pending: sample.items, interval: [start, end], activity: minuteRows(counts, [start, end]) });
    };
    let timer = null;
    const connectTimer = setTimeout(() => { if (start === null) { ws.close(); reject(new Error('Jetstream did not connect within 30s')); } }, 30_000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      start = Date.now();
      timer = setTimeout(() => { end = Date.now(); finish(); }, ms);
    };
    ws.onmessage = (event) => {
      const m = JSON.parse(event.data);
      if (m.kind !== 'commit' || m.commit?.operation !== 'create' || m.commit.collection !== 'app.bsky.feed.post') return;
      const record = m.commit.record || {};
      if (record.reply) return; // replies ride on someone else's post; only top-level posts count
      // time_us is when the relay saw the post; createdAt is set by the client and can be anything.
      const t = Math.floor(m.time_us / 1000);
      const lang = langIndex(record.langs);
      const minute = Math.floor(t / MINUTE);
      if (!counts.has(minute)) counts.set(minute, new Array(LANGS.length + 1).fill(0));
      counts.get(minute)[lang]++;
      sample.add([`at://${m.did}/app.bsky.feed.post/${m.commit.rkey}`, t, lang]);
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      // Mid-sample drops keep what was collected; a failed connection has nothing to keep.
      if (start === null) { clearTimeout(connectTimer); reject(new Error(`Jetstream error: ${event.message || 'connection failed'}`)); }
      else if (end === null) { end = Date.now(); finish(); }
    };
    ws.onclose = () => { if (start !== null && end === null) { end = Date.now(); clearTimeout(timer); finish(); } };
  });
}

/**
 * Re-read pending posts that are old enough. Returns settled rows
 * [timestampMs, likes, reposts, replies, quotes, lang] and the posts still pending. Posts the
 * AppView no longer returns were deleted (or their account was) and are dropped; posts whose
 * request failed stay pending for the next run unless they're over a week old.
 */
export async function settle(pending, { now = Date.now(), fetchJSON = defaultFetchJSON, log = console.log } = {}) {
  const ready = pending.filter(([, t]) => now - t >= SETTLE_HOURS * HOUR);
  const waiting = pending.filter(([, t]) => now - t < SETTLE_HOURS * HOUR);
  const settled = [];
  let deleted = 0, failedBatches = 0;
  for (let i = 0; i < ready.length; i += 25) {
    const batch = ready.slice(i, i + 25);
    const qs = batch.map(([uri]) => `uris=${encodeURIComponent(uri)}`).join('&');
    try {
      const body = await fetchJSON(`${GET_POSTS}?${qs}`);
      const byUri = new Map((body.posts || []).map((p) => [p.uri, p]));
      for (const [uri, t, lang] of batch) {
        const p = byUri.get(uri);
        if (!p) { deleted++; continue; }
        settled.push([t, p.likeCount || 0, p.repostCount || 0, p.replyCount || 0, p.quoteCount || 0, lang]);
      }
    } catch (err) {
      failedBatches++;
      for (const item of batch) if (now - item[1] < 7 * DAY) waiting.push(item);
    }
  }
  log(`Bluesky: settled ${settled.length}, ${deleted} deleted, ${failedBatches} failed request(s), ${waiting.length} still pending`);
  return { settled, pending: waiting };
}

async function defaultFetchJSON(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
}

/** Merge new data into the published benchmark and drop everything older than the window. */
export function mergeBenchmark(prev, { settled = [], activity = [], interval = null }, now = Date.now()) {
  const cutoff = now - WINDOW_DAYS * DAY;
  return {
    version: 1,
    generatedAt: now,
    windowDays: WINDOW_DAYS,
    settleHours: SETTLE_HOURS,
    langs: LANGS,
    posts: [...(prev.posts || []), ...settled].filter((r) => r[0] >= cutoff).sort((a, b) => a[0] - b[0]),
    activity: [...(prev.activity || []), ...activity].filter((r) => r[0] >= cutoff),
    intervals: [...(prev.intervals || []), ...(interval ? [interval] : [])].filter(([, b]) => b >= cutoff),
  };
}

export async function runBenchmark(dataDir, { sampleMinutes = 5, keep = 100, log = console.log } = {}) {
  await mkdir(join(dataDir, 'state'), { recursive: true });
  await mkdir(join(dataDir, 'public'), { recursive: true });
  const pendingPath = join(dataDir, 'state', 'bluesky-pending.json');
  const publicPath = join(dataDir, 'public', 'bluesky.json');
  const state = await readJSON(pendingPath, { pending: [] });
  const prev = await readJSON(publicPath, {});

  const { settled, pending } = await settle(state.pending, { log });
  let sample = { pending: [], activity: [], interval: null };
  try {
    sample = await sampleJetstream({ ms: sampleMinutes * MINUTE, keep, log });
  } catch (err) {
    // Settled posts are still worth publishing when the stream is down.
    log(`Bluesky: sampling failed: ${err.message}`);
  }
  const bench = mergeBenchmark(prev, { settled, activity: sample.activity, interval: sample.interval });
  await writeFile(publicPath, JSON.stringify(bench));
  await writeFile(pendingPath, JSON.stringify({ pending: [...pending, ...sample.pending] }));
  log(`Bluesky: benchmark has ${bench.posts.length} settled posts and ${bench.intervals.length} sample windows`);
  return { bench, sampled: sample.pending.length };
}

if (isMain(import.meta.url)) {
  const dataDir = process.argv[2];
  if (!dataDir) { console.error('usage: node scripts/bluesky-benchmark.mjs <data-dir>'); process.exit(2); }
  identifyRequests();
  const { sampled } = await runBenchmark(dataDir, {
    sampleMinutes: Number(argValue('--sample-minutes', 5)),
    keep: Number(argValue('--keep', 100)),
  });
  // Settled posts were still published, so warn instead of failing the run.
  if (!sampled) console.log('::warning::Bluesky sample collected no posts this run');
}
