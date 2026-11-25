// Posting planner logic with no DOM, so it can be tested in Node: turns each subreddit's
// best-time scores into a weekly schedule, and the schedule into a spreadsheet or a calendar.

import { DAYS, dayHour } from './analysis.js';

export const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

export const redditLinks = (name) => ({
  open: `https://www.reddit.com/r/${name}/`,
  post: `https://www.reddit.com/r/${name}/submit`,
  rules: `https://www.reddit.com/r/${name}/about/rules`,
});

/** How a slot compares with that subreddit's own best hour of the week. */
export function strengthOf(relative) {
  return relative >= 90 ? 'Peak' : relative >= 70 ? 'Strong' : 'Good';
}

/**
 * Pick posting slots for every subreddit.
 * subs: [{ name, scores }], scores being 168 numbers (slot = day * 24 + hour) or nulls.
 * Each subreddit gets up to `perWeek` slots, at most one per day (most subreddits limit how often
 * one account can post), and no two subreddits share an hour, so the week is spread out instead
 * of bunching every post into the same evening. Slots are handed out best first across all
 * subreddits, using each one's score relative to its own best hour so busy and quiet
 * subreddits compete fairly.
 */
export function buildSchedule(subs, { perWeek = 3 } = {}) {
  const candidates = [];
  for (const sub of subs) {
    const max = Math.max(...sub.scores.filter((v) => Number.isFinite(v)));
    if (!(max > 0)) continue;
    sub.scores.forEach((v, slot) => {
      if (Number.isFinite(v)) candidates.push({ name: sub.name, slot, relative: (v / max) * 100 });
    });
  }
  candidates.sort((a, b) => b.relative - a.relative || a.slot - b.slot);
  const taken = new Set();
  const used = new Map(); // name -> { count, days: Set }
  const entries = [];
  for (const c of candidates) {
    const u = used.get(c.name) || { count: 0, days: new Set() };
    const day = Math.floor(c.slot / 24);
    if (u.count >= perWeek || u.days.has(day) || taken.has(c.slot)) continue;
    u.count++;
    u.days.add(day);
    used.set(c.name, u);
    taken.add(c.slot);
    entries.push({ name: c.name, day, hour: c.slot % 24, slot: c.slot, relative: Math.round(c.relative), strength: strengthOf(c.relative) });
  }
  return entries.sort((a, b) => MONDAY_FIRST.indexOf(a.day) - MONDAY_FIRST.indexOf(b.day) || a.hour - b.hour);
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Spreadsheet of the schedule. The byte-order mark makes Excel read it as UTF-8. */
export function scheduleToCSV(entries, { timeZone, hourText }) {
  const rows = [['Day', `Time (${timeZone})`, 'Subreddit', 'Strength', 'Score vs its best hour', 'Post link', 'Subreddit', 'Rules']];
  for (const e of entries) {
    const l = redditLinks(e.name);
    rows.push([DAYS[e.day], hourText(e.hour), `r/${e.name}`, e.strength, e.relative, l.post, l.open, l.rules]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
const pad = (n) => String(n).padStart(2, '0');

/** Calendar date (y, m, d) of a moment in a time zone. */
function localDate(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

/** The next time the weekly slot comes round, as an iCalendar local date-time. */
export function nextOccurrence(day, hour, timeZone, now = Date.now()) {
  const today = dayHour(now, timeZone);
  let ahead = (day - today.day + 7) % 7;
  if (ahead === 0 && hour <= today.hour) ahead = 7;
  const { y, m, d } = localDate(now, timeZone);
  const date = new Date(Date.UTC(y, m - 1, d + ahead));
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(hour)}0000`;
}

/**
 * Weekly repeating calendar reminders, one per scheduled post, with the post link attached.
 * Times are written in the chosen IANA zone (TZID), which Google, Apple and Outlook calendars
 * resolve themselves, so the reminders stay at the same local hour across daylight saving.
 */
export function scheduleToICS(entries, { timeZone, now = Date.now() }) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tidewatch//Posting planner//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Posting plan'];
  for (const e of entries) {
    const l = redditLinks(e.name);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.name.toLowerCase()}-${e.slot}@tidewatch`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${timeZone}:${nextOccurrence(e.day, e.hour, timeZone, now)}`,
      'DURATION:PT30M',
      'RRULE:FREQ=WEEKLY',
      `SUMMARY:${icsText(`Post to r/${e.name}`)}`,
      `DESCRIPTION:${icsText(`${e.strength} time for r/${e.name}. Post: ${l.post}\nRules: ${l.rules}`)}`,
      `URL:${l.post}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Post to r/${e.name}`)}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** Subreddit names from free text: commas, spaces or new lines; r/ prefixes and reddit links work. */
export function parseSubreddits(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text).split(/[\s,;]+/)) {
    const name = raw.replace(/^https?:\/\/(www\.|old\.)?reddit\.com\//i, '').replace(/^\/?r\//i, '').replace(/\/.*$/, '');
    if (!/^[A-Za-z0-9_]{2,21}$/.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}
