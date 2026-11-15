import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityRate, analyze } from '../site/js/analysis.js';
import {
  langIndex, reservoir, minuteRows, settle, mergeBenchmark, LANGS, OTHER, SETTLE_HOURS, WINDOW_DAYS,
} from '../scripts/bluesky-benchmark.mjs';
import { dueSubreddits } from '../scripts/reddit-snapshots.mjs';

const HOUR = 3600_000, DAY = 24 * HOUR, MINUTE = 60_000;
const SUNDAY = Date.UTC(2026, 10, 1);

test('activityRate counts weighted timestamps as that many events', () => {
  const interval = [[SUNDAY, SUNDAY + HOUR]];
  const plain = activityRate([SUNDAY + 1, SUNDAY + 2, SUNDAY + 3], interval, 'UTC');
  const weighted = activityRate([SUNDAY + 1], interval, 'UTC', [3]);
  assert.equal(weighted.counts[0], 3);
  assert.equal(weighted.rate[0], plain.rate[0]);
});

test('analyze reports the weighted total for pre-binned activity', () => {
  const r = analyze({ posts: [], activity: { timestamps: [SUNDAY + 1, SUNDAY + 2], weights: [40, 2], intervals: [[SUNDAY, SUNDAY + HOUR]], label: 'x' } }, { timeZone: 'UTC', now: SUNDAY + DAY });
  assert.equal(r.activity.total, 42);
});

test('langIndex groups regional codes and unknown languages', () => {
  assert.equal(langIndex(['en-US']), LANGS.indexOf('en'));
  assert.equal(langIndex(['JA']), LANGS.indexOf('ja'));
  assert.equal(langIndex(['tlh']), OTHER);
  assert.equal(langIndex(undefined), OTHER);
});

test('reservoir keeps a bounded, roughly uniform sample', () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r = reservoir(1000, random);
  for (let i = 0; i < 10_000; i++) r.add(i);
  assert.equal(r.items.length, 1000);
  assert.equal(r.seen, 10_000);
  // A uniform sample of 0..9999 has a mean near 5000; a "keep the first N" bug gives ~500.
  const mean = r.items.reduce((a, b) => a + b, 0) / r.items.length;
  assert.ok(Math.abs(mean - 5000) < 400, `mean ${mean}`);
});

test('minuteRows keeps counts inside the sample interval', () => {
  const start = SUNDAY + 59 * MINUTE + 40_000; // 00:59:40
  const end = start + 2 * MINUTE;
  const counts = new Map([[Math.floor(start / MINUTE), [2, 1, 0, 0, 0, 0, 0, 3]]]);
  const [row] = minuteRows(counts, [start, end]);
  assert.equal(row[0], start); // minute midpoint 00:59:30 is before the start, so it is clamped
  assert.equal(row[1], 6);
  assert.deepEqual(row.slice(2), [2, 1, 0, 0, 0, 0, 0, 3]);
});

test('settle re-reads only old posts, drops deleted ones and retries failures', async () => {
  const now = SUNDAY + 10 * DAY;
  const old = now - (SETTLE_HOURS + 1) * HOUR;
  const pending = [
    ['at://a/app.bsky.feed.post/1', old, 0],
    ['at://a/app.bsky.feed.post/2', old, 1], // deleted
    ['at://a/app.bsky.feed.post/3', now - HOUR, 0], // too young
  ];
  const requested = [];
  const fetchJSON = async (url) => {
    requested.push(url);
    return { posts: [{ uri: 'at://a/app.bsky.feed.post/1', likeCount: 5, repostCount: 1, replyCount: 2, quoteCount: 0 }] };
  };
  const r = await settle(pending, { now, fetchJSON, log: () => {} });
  assert.equal(requested.length, 1);
  assert.ok(!requested[0].includes('post%2F3'));
  assert.deepEqual(r.settled, [[old, 5, 1, 2, 0, 0]]);
  assert.deepEqual(r.pending.map((p) => p[0]), ['at://a/app.bsky.feed.post/3']);

  const failing = await settle(pending.slice(0, 1), { now, fetchJSON: async () => { throw new Error('HTTP 502'); }, log: () => {} });
  assert.equal(failing.pending.length, 1); // kept for the next run
  const stale = await settle([['at://x', now - 8 * DAY, 0]], { now, fetchJSON: async () => { throw new Error('HTTP 502'); }, log: () => {} });
  assert.equal(stale.pending.length, 0); // a week of failures is enough
});

test('settle batches 25 posts per request', async () => {
  const now = SUNDAY + 10 * DAY;
  const pending = Array.from({ length: 60 }, (_, i) => [`at://a/app.bsky.feed.post/${i}`, now - 3 * DAY, 0]);
  let calls = 0;
  await settle(pending, { now, fetchJSON: async () => { calls++; return { posts: [] }; }, log: () => {} });
  assert.equal(calls, 3);
});

test('mergeBenchmark appends new data and drops rows outside the window', () => {
  const now = SUNDAY + 40 * DAY;
  const tooOld = now - (WINDOW_DAYS + 1) * DAY;
  const prev = {
    posts: [[tooOld, 1, 0, 0, 0, 0], [now - 5 * DAY, 2, 0, 0, 0, 0]],
    activity: [[tooOld, 10, 10, 0, 0, 0, 0, 0, 0, 0]],
    intervals: [[tooOld, tooOld + MINUTE]],
  };
  const merged = mergeBenchmark(prev, { settled: [[now - 3 * DAY, 3, 0, 0, 0, 1]], activity: [[now - MINUTE, 5, 5, 0, 0, 0, 0, 0, 0, 0]], interval: [now - 2 * MINUTE, now] }, now);
  assert.deepEqual(merged.posts.map((r) => r[1]), [2, 3]);
  assert.equal(merged.activity.length, 1);
  assert.deepEqual(merged.intervals, [[now - 2 * MINUTE, now]]);
  assert.deepEqual(merged.langs, LANGS);
});

test('dueSubreddits refreshes missing and stale snapshots, oldest first', () => {
  const now = SUNDAY + 10 * DAY;
  const index = { subs: { a: { fetchedAt: now - 30 * HOUR }, b: { fetchedAt: now - HOUR }, c: { fetchedAt: now - 50 * HOUR } } };
  assert.deepEqual(dueSubreddits(['A', 'b', 'c', 'new'], index, now, 20 * HOUR), ['new', 'c', 'A']);
});
