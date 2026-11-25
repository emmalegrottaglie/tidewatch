// Posting planner page: reads several subreddits, then lays out a week of posts at their best hours.
import { SOURCES } from './sources.js';
import { analyze, DAYS, hourLabel, dayHour } from './analysis.js';
import { buildSchedule, scheduleToCSV, scheduleToICS, parseSubreddits, redditLinks, MONDAY_FIRST } from './planner-core.js';
import { h, timeZones, download, localZone, hour12 } from './ui.js';
import { initTheme } from './theme.js';

initTheme();

const MAX_SUBS = 25;
const $ = (id) => document.getElementById(id);
const hourText = (hr) => hourLabel(hr, { hour12 });

const state = {
  subs: [],
  reads: new Map(), // lower-case name -> { name, data } or { name, error }
  perWeek: 3,
  metric: 'upvotes',
  timeZone: localZone,
  controller: null,
};

/* ---------- form ---------- */
const form = $('plan-form');
const subsInput = $('plan-subs');
const perSelect = $('plan-per');
const metricSelect = $('plan-metric');
const tzSelect = $('plan-tz');
for (const z of timeZones()) tzSelect.append(h('option', { value: z }, z === localZone ? `${z} (yours)` : z));

function syncURL() {
  const q = new URLSearchParams();
  if (state.subs.length) q.set('subs', state.subs.join(','));
  if (state.perWeek !== 3) q.set('per', state.perWeek);
  if (state.metric !== 'upvotes') q.set('metric', state.metric);
  if (state.timeZone !== localZone) q.set('tz', state.timeZone);
  history.replaceState(null, '', q.toString() ? `?${q}` : location.pathname);
}

function readForm() {
  state.perWeek = Number(perSelect.value);
  state.metric = metricSelect.value;
  state.timeZone = tzSelect.value;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const subs = parseSubreddits(subsInput.value);
  const error = $('plan-error');
  if (!subs.length) { error.textContent = 'Add at least one subreddit name, like photography or r/analog.'; error.hidden = false; return; }
  if (subs.length > MAX_SUBS) { error.textContent = `That's ${subs.length} subreddits. The planner reads up to ${MAX_SUBS} at a time.`; error.hidden = false; return; }
  error.hidden = true;
  readForm();
  state.subs = subs;
  syncURL();
  readAll();
});
// Changing an option after the reads only redraws the plan; nothing is read again.
for (const el of [perSelect, metricSelect, tzSelect]) {
  el.addEventListener('change', () => { readForm(); syncURL(); if (state.reads.size) render(); });
}

/* ---------- reading ---------- */
const progressHost = $('plan-progress');
const rows = new Map();

function progressRow(name) {
  const bar = h('i');
  const status = h('span', { class: 'status' }, 'Waiting');
  const row = h('li', {}, h('span', { class: 'name' }, `r/${name}`), h('span', { class: 'meter', 'aria-hidden': 'true' }, bar), status);
  rows.set(name.toLowerCase(), { row, bar, status });
  return row;
}

function setRow(name, { fraction, text, state: s }) {
  const r = rows.get(name.toLowerCase());
  if (!r) return;
  if (fraction !== undefined) r.bar.style.transform = `scaleX(${fraction})`;
  if (text) r.status.textContent = text;
  if (s) r.row.dataset.state = s;
}

async function readAll() {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  rows.clear();
  const cancel = h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => controller.abort() }, 'Stop reading');
  progressHost.replaceChildren(
    h('div', { class: 'planner-progress-head' }, h('h2', {}, 'Reading subreddits'), cancel),
    h('p', { class: 'planner-hint' }, 'Popular subreddits load at once from the daily update; others take up to a minute each, one at a time so the archive keeps up. Results appear as each one finishes.'),
    h('ol', { class: 'progress-list' }, state.subs.map(progressRow)));
  progressHost.hidden = false;
  $('plan-go').disabled = true;
  try {
    // Saved copies are plain files, so fetch them all at once; only the archive needs one at a time.
    await Promise.all(state.subs.map(async (name) => {
      const key = name.toLowerCase();
      if (state.reads.get(key)?.data) { setRow(name, { fraction: 1, text: 'Ready', state: 'done' }); return; }
      // A browser can briefly hold an older sources.js without cached() after a deploy; then
      // every subreddit goes through the one-at-a-time loop below, which still uses saved copies.
      const data = SOURCES.reddit.cached ? await SOURCES.reddit.cached(name, { signal: controller.signal }) : null;
      if (!data) return;
      state.reads.set(key, { name: data.profile.name.replace(/^r\//, ''), data });
      setRow(name, { fraction: 1, text: 'Ready (saved copy)', state: 'done' });
    }));
    render();
    for (const name of state.subs) {
      const key = name.toLowerCase();
      if (state.reads.get(key)?.data) continue;
      setRow(name, { fraction: 0.02, text: 'Reading…', state: 'busy' });
      try {
        const data = await SOURCES.reddit.fetch(name, {
          signal: controller.signal,
          onProgress: (f) => setRow(name, { fraction: Math.max(0.02, f), text: `Reading… ${Math.round(f * 100)}%` }),
        });
        state.reads.set(key, { name: data.profile.name.replace(/^r\//, ''), data });
        setRow(name, { fraction: 1, text: data.snapshot ? 'Ready (saved copy)' : 'Ready', state: 'done' });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        state.reads.set(key, { name, error: err.message });
        setRow(name, { fraction: 1, text: err.message, state: 'failed' });
      }
      render();
    }
    cancel.remove();
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    for (const name of state.subs) if (!state.reads.has(name.toLowerCase())) setRow(name, { text: 'Stopped', state: 'failed' });
    cancel.remove();
  } finally {
    if (state.controller === controller) $('plan-go').disabled = false;
  }
}

/* ---------- plan ---------- */
function confidence(r) {
  if (r.lowSample) return 'Low: few posts to go on';
  if (r.basis !== 'best') return 'Follows when people are active';
  if (r.reliability >= 0.5) return 'High: a clear pattern';
  if (r.reliability >= 0.25) return 'Medium';
  return 'Follows when people are active';
}

function render() {
  const analyzed = [];
  const failed = [];
  for (const name of state.subs) {
    const read = state.reads.get(name.toLowerCase());
    if (!read) continue;
    if (read.error) { failed.push(read); continue; }
    const r = analyze(read.data, { timeZone: state.timeZone, metric: state.metric, minAgeHours: read.data.minAgeHours ?? 24 });
    if (r.basis === 'none') { failed.push({ name: read.name, error: 'Not enough posts to find a pattern.' }); continue; }
    analyzed.push({ name: read.name, data: read.data, r, scores: r.rankingScores });
  }
  const host = $('plan-results');
  if (!analyzed.length && !failed.length) { host.hidden = true; return; }
  host.hidden = false;

  const plan = buildSchedule(analyzed, { perWeek: state.perWeek });
  const now = dayHour(Date.now(), state.timeZone);
  const nowKey = (MONDAY_FIRST.indexOf(now.day) * 24) + now.hour;
  const upcoming = plan.find((e) => MONDAY_FIRST.indexOf(e.day) * 24 + e.hour >= nowKey) || plan[0];
  const fileBase = `posting-plan-${new Date().toISOString().slice(0, 10)}`;

  const actions = h('div', { class: 'planner-actions' },
    h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => download(`${fileBase}.csv`, scheduleToCSV(plan, { timeZone: state.timeZone, hourText }), 'text/csv;charset=utf-8') }, 'Download spreadsheet'),
    h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => download(`${fileBase}.ics`, scheduleToICS(plan, { timeZone: state.timeZone }), 'text/calendar;charset=utf-8') }, 'Add reminders to calendar'),
    h('button', { type: 'button', class: 'btn btn-quiet', onclick: (e) => copyLink(e.currentTarget) }, 'Copy link to this plan'));

  const days = MONDAY_FIRST.map((d) => {
    const items = plan.filter((e) => e.day === d);
    const isToday = d === now.day;
    return h('section', { class: `plan-day${isToday ? ' today' : ''}` },
      h('h3', {}, DAYS[d], isToday ? h('span', { class: 'today-tag' }, 'Today') : null),
      items.length
        ? h('ol', { class: 'plan-list' }, items.map((e) => {
          const l = redditLinks(e.name);
          return h('li', { class: e === upcoming ? 'next' : null },
            h('span', { class: 'time' }, hourText(e.hour)),
            h('span', { class: 'sub' }, h('a', { href: l.open, target: '_blank', rel: 'noopener noreferrer' }, `r/${e.name}`),
              h('span', { class: `strength ${e.strength.toLowerCase()}` }, e.strength),
              e === upcoming ? h('span', { class: 'next-tag' }, 'Next') : null),
            h('span', { class: 'links' },
              h('a', { class: 'post-link', href: l.post, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Post to r/${e.name}` }, 'Post'),
              h('a', { href: l.rules, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Rules of r/${e.name}` }, 'Rules')));
        }))
        : h('p', { class: 'plan-empty' }, 'No posts planned'));
  });

  const summaryRows = analyzed.map(({ name, data, r }) => {
    const l = redditLinks(name);
    const members = data.profile.stats?.find((s) => s.label === 'Members')?.value ?? '—';
    return h('tr', {},
      h('th', { scope: 'row' }, h('a', { href: l.open, target: '_blank', rel: 'noopener noreferrer' }, `r/${name}`)),
      h('td', {}, r.top.slice(0, 3).map((s) => `${DAYS[s.day].slice(0, 3)} ${hourText(s.hour)}`).join(', ')),
      h('td', { class: 'num' }, members),
      h('td', { class: 'num' }, r.counts.eligible.toLocaleString()),
      h('td', {}, confidence(r)),
      h('td', {}, h('a', { href: `./?source=reddit&q=${encodeURIComponent(name)}` }, 'Full analysis')));
  });

  host.replaceChildren(...[
    h('div', { class: 'planner-head' },
      h('div', {}, h('h2', {}, 'Your week'),
        h('p', {}, `${plan.length} posts across ${analyzed.length} subreddit${analyzed.length === 1 ? '' : 's'}, each at one of its strongest hours, no more than one a day per subreddit and never two at the same hour. Times are in ${state.timeZone}.`)),
      actions),
    h('div', { class: 'plan-week' }, days),
    h('p', { class: 'planner-hint' }, 'Peak is within 10% of that subreddit’s best hour of the week, Strong within 30%. Check each subreddit’s rules before posting: many allow one post a day, and some need verification first.'),
    h('section', { class: 'panel planner-summary' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Best times by subreddit'), h('p', {}, 'The three strongest hours of the week for each subreddit, and how sure the pattern is.')),
      h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Subreddit', 'Best times', 'Members', 'Posts read', 'Confidence', ''].map((c, i) => h('th', { scope: 'col', class: i === 2 || i === 3 ? 'num' : null }, c)))),
        h('tbody', {}, summaryRows)))),
    failed.length ? h('div', { class: 'notice' }, h('strong', {}, 'Left out of the plan: '),
      failed.map((f, i) => [i ? '; ' : '', `r/${f.name} (${f.error})`])) : null].filter(Boolean));
}

async function copyLink(button) {
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = 'Link copied';
  } catch {
    button.textContent = 'Copy failed — use the address bar';
  }
  setTimeout(() => { button.textContent = 'Copy link to this plan'; }, 2500);
}

/* ---------- start from a shared link ---------- */
const params = new URLSearchParams(location.search);
const sharedSubs = parseSubreddits(params.get('subs') || '').slice(0, MAX_SUBS);
if (params.get('per') && [...perSelect.options].some((o) => o.value === params.get('per'))) perSelect.value = params.get('per');
if (params.get('metric') && [...metricSelect.options].some((o) => o.value === params.get('metric'))) metricSelect.value = params.get('metric');
tzSelect.value = [...tzSelect.options].some((o) => o.value === params.get('tz')) ? params.get('tz') : localZone;
readForm();
if (sharedSubs.length) {
  subsInput.value = sharedSubs.join(', ');
  state.subs = sharedSubs;
  readAll();
}
