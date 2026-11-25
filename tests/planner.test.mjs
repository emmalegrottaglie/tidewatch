import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, scheduleToCSV, scheduleToICS, nextOccurrence, parseSubreddits, strengthOf } from '../site/js/planner-core.js';

const flat = (fill = 10) => new Array(168).fill(fill);

test('parseSubreddits accepts names, r/ prefixes and links, and drops duplicates and junk', () => {
  assert.deepEqual(
    parseSubreddits('transbbws, r/ThiccTransWomen\nhttps://www.reddit.com/r/venustrans/ x transbbws'),
    ['transbbws', 'ThiccTransWomen', 'venustrans'],
  );
});

test('each subreddit gets its best slots, one per day at most', () => {
  const a = flat();
  a[1 * 24 + 21] = 100; // Mon 21:00
  a[1 * 24 + 22] = 99; // Mon 22:00, same day: skipped
  a[3 * 24 + 20] = 90; // Wed 20:00
  const plan = buildSchedule([{ name: 'a', scores: a }], { perWeek: 2 });
  assert.deepEqual(plan.map((e) => [e.day, e.hour]), [[1, 21], [3, 20]]);
  assert.equal(plan[0].strength, 'Peak');
});

test('two subreddits never share an hour', () => {
  const a = flat(), b = flat();
  a[5 * 24 + 21] = 100;
  b[5 * 24 + 21] = 100;
  b[5 * 24 + 22] = 95;
  const plan = buildSchedule([{ name: 'a', scores: a }, { name: 'b', scores: b }], { perWeek: 1 });
  const slots = plan.map((e) => e.slot);
  assert.equal(new Set(slots).size, slots.length);
  assert.ok(plan.find((e) => e.name === 'b' && e.hour === 22));
});

test('subreddits with no usable scores are left out', () => {
  assert.deepEqual(buildSchedule([{ name: 'x', scores: new Array(168).fill(null) }]), []);
});

test('strength labels', () => {
  assert.equal(strengthOf(95), 'Peak');
  assert.equal(strengthOf(75), 'Strong');
  assert.equal(strengthOf(40), 'Good');
});

test('CSV has a header, one row per post and quick-post links', () => {
  const plan = buildSchedule([{ name: 'transbbws', scores: flat() }], { perWeek: 2 });
  const csv = scheduleToCSV(plan, { timeZone: 'UTC', hourText: (h) => `${h}:00` });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /https:\/\/www\.reddit\.com\/r\/transbbws\/submit/);
});

test('next occurrence is later this week, or next week once the hour has passed', () => {
  const wedNoonUTC = Date.UTC(2026, 10, 25, 12); // Wednesday 25 Nov 2026
  assert.equal(nextOccurrence(3, 18, 'UTC', wedNoonUTC), '20261125T180000');
  assert.equal(nextOccurrence(3, 9, 'UTC', wedNoonUTC), '20261202T090000');
  assert.equal(nextOccurrence(5, 21, 'Europe/Madrid', wedNoonUTC), '20261127T210000');
});

test('calendar has one weekly event per post in the chosen zone', () => {
  const plan = buildSchedule([{ name: 'a', scores: flat() }], { perWeek: 3 });
  const ics = scheduleToICS(plan, { timeZone: 'Europe/Madrid', now: Date.UTC(2026, 10, 25, 12) });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.match(ics, /DTSTART;TZID=Europe\/Madrid:\d{8}T\d{6}/);
  assert.match(ics, /RRULE:FREQ=WEEKLY/);
});
