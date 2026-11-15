import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayHour, slotOf, median, smoothRing, exposureHours, scoreSlots, activityRate,
  rankSlots, bestPerDay, phrases, groupBy, analyze, metricValue, hourLabel, tokenize, gridToCSV, percentileRanks,
} from '../site/js/analysis.js';

const HOUR = 3600_000;
// 2026-11-01 00:00 UTC is a Sunday.
const SUNDAY = Date.UTC(2026, 10, 1);
const at = (day, hour, week = 0) => SUNDAY + (week * 7 + day) * 24 * HOUR + hour * HOUR + 60_000;
const post = (createdAt, likes, extra = {}) => ({ id: String(createdAt) + likes, createdAt, metrics: { likes }, ...extra });

test('dayHour resolves weekday and hour in UTC and other zones', () => {
  assert.deepEqual(dayHour(SUNDAY, 'UTC'), { day: 0, hour: 0 });
  // Sunday 00:00 UTC is Saturday 20:00 in New York (EDT ended 2026-11-01 06:00 UTC, so it's still EDT, UTC-4).
  assert.deepEqual(dayHour(SUNDAY, 'America/New_York'), { day: 6, hour: 20 });
  // Tokyo is UTC+9.
  assert.deepEqual(dayHour(SUNDAY, 'Asia/Tokyo'), { day: 0, hour: 9 });
  assert.equal(slotOf(at(2, 17), 'UTC'), 2 * 24 + 17);
});

test('median handles odd, even and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('smoothRing wraps Saturday night into Sunday morning and keeps the total', () => {
  const v = new Array(168).fill(0);
  v[0] = 4;
  const s = smoothRing(v);
  assert.equal(s[0], 2);
  assert.equal(s[1], 1);
  assert.equal(s[167], 1);
  assert.equal(s.reduce((a, b) => a + b, 0), 4);
});

test('exposureHours counts partial hours and full weeks', () => {
  const e = exposureHours([[SUNDAY, SUNDAY + 7 * 24 * HOUR]], 'UTC');
  assert.ok(e.every((x) => Math.abs(x - 1) < 1e-9));
  const half = exposureHours([[SUNDAY + 30 * 60_000, SUNDAY + HOUR]], 'UTC');
  assert.equal(half[0], 0.5);
  assert.equal(half.reduce((a, b) => a + b, 0), 0.5);
});

test('scoreSlots finds the hour where posts do better, not the hour with most posts', () => {
  const posts = [];
  // 20 ordinary posts on Monday 09:00 with 10 likes each.
  for (let w = 0; w < 20; w++) posts.push(post(at(1, 9, w % 4) + w, 10));
  // 8 strong posts on Thursday 18:00 with 40 likes each.
  for (let w = 0; w < 8; w++) posts.push(post(at(4, 18, w % 4) + w, 40));
  const g = scoreSlots(posts, { timeZone: 'UTC', metric: 'likes' });
  assert.ok(g.valid);
  const best = rankSlots(g.score, 1)[0];
  assert.equal(best.day, 4);
  assert.equal(best.hour, 18);
  // Monday 09:00 is busier but below average.
  assert.ok(g.score[1 * 24 + 9] < 50);
  assert.ok(g.score[4 * 24 + 18] > 50);
});

test('a single viral post cannot win alone', () => {
  const posts = [];
  for (let w = 0; w < 12; w++) posts.push(post(at(3, 12, w % 4) + w, 30)); // steady strong Wednesday noon
  for (let w = 0; w < 30; w++) posts.push(post(at(w % 7, (w * 5) % 24, 1) + w, 10)); // background
  posts.push(post(at(6, 3), 100000)); // one viral post Saturday 03:00
  const g = scoreSlots(posts, { timeZone: 'UTC', metric: 'likes' });
  const best = rankSlots(g.score, 1)[0];
  assert.equal(best.slot, 3 * 24 + 12);
});

test('scoreSlots reports invalid when every post has zero engagement', () => {
  const g = scoreSlots([post(at(1, 1), 0), post(at(2, 2), 0)], { timeZone: 'UTC', metric: 'likes' });
  assert.equal(g.valid, false);
});

test('activityRate divides by exposure and leaves uncovered hours empty', () => {
  const interval = [[at(1, 0), at(1, 0) + 24 * HOUR]]; // only Monday covered
  const ts = [at(1, 10), at(1, 10) + 5, at(1, 11)];
  const a = activityRate(ts, interval, 'UTC');
  assert.equal(a.rate[0], null); // Sunday 00:00 not covered
  assert.ok(a.rate[24 + 10] > a.rate[24 + 3]);
  assert.equal(a.counts[24 + 10], 2);
});

test('bestPerDay returns the top hour for each weekday', () => {
  const scores = new Array(168).fill(1);
  scores[2 * 24 + 7] = 3;
  const per = bestPerDay(scores);
  assert.equal(per.length, 7);
  assert.equal(per[2].hour, 7);
  assert.equal(per[0].hour, 0); // ties resolve to the earliest hour
});

test('metricValue sums interactions for engagement but ignores views', () => {
  const p = { metrics: { likes: 3, comments: 2, views: 1000 } };
  assert.equal(metricValue(p, 'engagement'), 5);
  assert.equal(metricValue(p, 'comments'), 2);
  assert.equal(metricValue(p, 'missing'), 0);
});

test('phrases counts each phrase once per post and drops stopwords from single words', () => {
  const posts = [
    { title: 'How do you edit film photos' },
    { title: 'How do you store film negatives? film film' },
    { title: 'Best film stock' },
  ];
  const p = phrases(posts, { minCount: 2 });
  assert.deepEqual(p[1][0], { text: 'film', count: 3 });
  assert.ok(p[3].some((x) => x.text === 'how do you' && x.count === 2));
  assert.ok(!p[1].some((x) => x.text === 'you'));
});

test('tokenize strips links and keeps apostrophes', () => {
  assert.deepEqual(tokenize("Don't miss https://x.com/a it's fine"), ["don't", 'miss', "it's", 'fine']);
});

test('groupBy computes share and average', () => {
  const posts = [post(1, 10, { domain: 'a.com' }), post(2, 20, { domain: 'a.com' }), post(3, 30, { domain: 'b.com' })];
  const g = groupBy(posts, (p) => p.domain, 'likes');
  assert.equal(g[0].name, 'a.com');
  assert.equal(g[0].avg, 15);
  assert.ok(Math.abs(g[0].share - 2 / 3) < 1e-9);
});

test('analyze excludes posts younger than the minimum age and falls back to activity', () => {
  const now = at(0, 0, 4);
  const posts = [post(now - 2 * HOUR, 500), post(now - 30 * HOUR, 5)];
  const r = analyze({
    posts,
    activity: { timestamps: [at(2, 20, 1), at(2, 20, 2), at(2, 21, 2)], intervals: [[at(0, 0, 0), now]], label: 'comments' },
  }, { timeZone: 'UTC', metric: 'likes', now });
  assert.equal(r.counts.eligible, 1);
  assert.equal(r.basis, 'activity');
  assert.equal(r.top[0].day, 2);
  assert.equal(r.top[0].hour, 20);
});

test('analyze only scores posts whose first day is inside the covered interval', () => {
  const now = at(0, 0, 3);
  const posts = [];
  for (let i = 0; i < 20; i++) posts.push(post(at(1, 10, 1) + i, 10));
  for (let i = 0; i < 20; i++) posts.push(post(at(1, 10, 0) + i, 10));
  const r = analyze({ posts, perfIntervals: [[at(0, 0, 1), now]] }, { timeZone: 'UTC', metric: 'likes', now });
  assert.equal(r.counts.eligible, 20);
});

test('hourLabel and CSV output', () => {
  assert.equal(hourLabel(0), '12 am');
  assert.equal(hourLabel(13), '1 pm');
  assert.equal(hourLabel(12, { style: 'range' }), '12:00 pm');
  assert.equal(hourLabel(7, { hour12: false }), '07:00');
  const posts = [];
  for (let i = 0; i < 20; i++) posts.push(post(at(i % 7, i % 24, 1), 5 + i));
  const r = analyze({ posts }, { timeZone: 'UTC', metric: 'likes', now: at(0, 0, 5) });
  const csv = gridToCSV(r).split('\n');
  assert.equal(csv.length, 169);
  assert.equal(csv[0], 'day,hour,avg_percentile_rank,posts_smoothed,activity_per_hour');
});

test('percentileRanks splits ties and averages to one half', () => {
  assert.deepEqual(percentileRanks([10, 20, 30]), [0, 0.5, 1]);
  assert.deepEqual(percentileRanks([1, 1, 5]), [0.25, 0.25, 1]);
  const r = percentileRanks([1, 1, 1, 1, 3000, 7, 2]);
  assert.ok(Math.abs(r.reduce((a, b) => a + b, 0) / r.length - 0.5) < 1e-9);
});

test('scores are graded on skewed data, unlike a capped ratio', () => {
  // Typical Reddit shape: most posts get 1 upvote. Hour A's posts get 3000, hour B's get 5.
  const posts = [];
  for (let i = 0; i < 40; i++) posts.push(post(at(i % 7, (i * 7) % 24, 2) + i, 1));
  for (let i = 0; i < 6; i++) posts.push(post(at(2, 9, i % 4) + i, 3000));
  for (let i = 0; i < 6; i++) posts.push(post(at(5, 15, i % 4) + i, 5));
  const g = scoreSlots(posts, { timeZone: 'UTC', metric: 'likes' });
  assert.ok(g.score[2 * 24 + 9] > g.score[5 * 24 + 15]);
  assert.ok(g.score[5 * 24 + 15] > 50);
});
