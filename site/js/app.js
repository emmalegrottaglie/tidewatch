import { SOURCES, SourceError } from './sources.js';
import { analyze, DAYS, hourLabel as fmtHour, gridToCSV, rankSlots, metricValue } from './analysis.js';
import { renderHeatmap, renderArea, renderBars, legend, divergingLegend } from './charts.js';
import { readFile, rowsToPosts } from './importer.js';
import { initTheme } from './theme.js';

initTheme();

const $ = (id) => document.getElementById(id);
const PLATFORMS = [...Object.values(SOURCES), { id: 'import', label: 'Import a file' }];
const hour12 = !['h23', 'h24'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle);
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const state = {
  platform: 'reddit',
  data: null, // fetched source data
  source: null, // source descriptor for the data
  query: '',
  timeZone: localZone,
  metric: null,
  mode: null, // 'performance' | 'activity'
  controller: null,
  importTable: null,
};

/* ---------- tiny DOM helper (text only, never innerHTML with data) ---------- */
function h(tag, attrs = {}, ...children) {
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
const hourText = (hr) => fmtHour(hr, { hour12 });
const hourRange = (hr) => `${fmtHour(hr, { hour12, style: 'range' })} – ${fmtHour((hr + 1) % 24, { hour12, style: 'range' })}`;
const fmtPct = (v) => `${Math.round(v)}%`;
const fmtNum = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/* ---------- platform picker ---------- */
function buildPlatforms() {
  const fs = $('platforms');
  for (const p of PLATFORMS) {
    fs.append(h('label', {}, h('input', { type: 'radio', name: 'platform', value: p.id, checked: p.id === state.platform, onchange: () => setPlatform(p.id) }), h('span', {}, p.label)));
  }
}

function setPlatform(id, { focus = true } = {}) {
  state.platform = id;
  for (const input of document.querySelectorAll('input[name="platform"]')) input.checked = input.value === id;
  const isImport = id === 'import';
  $('query-panel').hidden = isImport;
  $('import-panel').hidden = !isImport;
  $('query-error').hidden = true;
  if (isImport) return;
  const s = SOURCES[id];
  $('query-prefix').textContent = s.prefix;
  $('query-prefix').hidden = !s.prefix;
  $('query').placeholder = s.placeholder;
  $('query-label').textContent = s.noun;
  const ex = $('examples');
  ex.replaceChildren(h('span', {}, 'Try'));
  for (const e of s.examples) ex.append(h('button', { type: 'button', onclick: () => { $('query').value = e; start(id, e); } }, s.prefix && !e.startsWith(s.prefix) ? `${s.prefix}${e}` : e));
  if (focus) $('query').focus();
}

/* ---------- running an analysis ---------- */
function setProgress(fraction, text) {
  $('progress').hidden = false;
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  $('progress-bar').style.transform = `scaleX(${pct / 100})`;
  $('progress-track').setAttribute('aria-valuenow', pct);
  if (text) $('progress-text').textContent = text;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

async function start(platform, raw) {
  const source = SOURCES[platform];
  const query = source.normalize(raw);
  const valid = source.validate(query);
  if (valid !== true) {
    $('query-error').textContent = valid;
    $('query-error').hidden = false;
    $('query').setAttribute('aria-invalid', 'true');
    return;
  }
  $('query-error').hidden = true;
  $('query').removeAttribute('aria-invalid');
  $('error').hidden = true;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  $('go').disabled = true;
  setProgress(0.02, `Looking up ${source.title(query)}`);
  const url = new URL(location.href);
  url.search = new URLSearchParams({ source: platform, q: query }).toString();
  history.replaceState(null, '', url);
  try {
    const data = await source.fetch(query, { signal: controller.signal, onProgress: (f, t) => setProgress(0.05 + f * 0.9, t) });
    if (!data.posts.length) throw new SourceError(`${source.title(query)} has no public posts to analyze.`);
    state.data = data;
    state.source = source;
    state.query = query;
    state.metric = source.defaultMetric;
    state.mode = null;
    render({ animate: true });
    document.title = `Best time to post on ${data.profile.name} — Tidewatch`;
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    showError(e instanceof SourceError ? e.message : `Something went wrong while reading ${source.title(query)}: ${e.message}`);
  } finally {
    if (state.controller === controller) {
      $('progress').hidden = true;
      $('go').disabled = false;
    }
  }
}

/* ---------- import ---------- */
function importSource(kind, metrics) {
  const labels = { likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', score: 'Score', engagements: 'Engagements column', clicks: 'Clicks', views: 'Views', upvotes: 'Upvotes', reposts: 'Reposts' };
  const list = metrics.filter((m) => m !== 'views').map((id) => ({ id, label: labels[id] || id }));
  const summable = metrics.filter((m) => !['views', 'clicks', 'engagements'].includes(m));
  if (summable.length > 1) list.unshift({ id: 'engagement', label: `All interactions (${summable.map((m) => labels[m] || m).join(' + ').toLowerCase()})` });
  if (!list.length && metrics.includes('views')) list.push({ id: 'views', label: 'Views' });
  return {
    id: 'import',
    label: kind,
    metrics: list,
    defaultMetric: metrics.includes('engagements') ? 'engagements' : list[0]?.id,
  };
}

async function handleFile(file) {
  $('import-error').hidden = true;
  $('mapping').hidden = true;
  $('mapping-actions').hidden = true;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('That file is over 50 MB. Export a shorter date range.');
    const text = await file.text();
    const r = readFile(file.name, text);
    if (r.posts) {
      if (!r.posts.length) throw new Error('No posts found in this file.');
      finishImport(r.posts, r.kind, r.profileName || file.name, r.metricsAvailable);
      return;
    }
    state.importTable = { ...r.table, fileName: file.name };
    showMapping(r.table.headers, r.mapping);
  } catch (e) {
    $('import-error').textContent = e instanceof SyntaxError ? `Couldn't read ${file.name}: it isn't valid JSON.` : e.message;
    $('import-error').hidden = false;
  }
}

const MAPPABLE = [['likes', 'Likes / reactions'], ['comments', 'Comments / replies'], ['shares', 'Shares / reposts'], ['saves', 'Saves'], ['score', 'Score / points'], ['engagements', 'Engagements (total)'], ['views', 'Views / impressions']];

function showMapping(headers, mapping) {
  const box = $('mapping');
  const select = (name, label, value, allowNone = true) => {
    const s = h('select', { name }, allowNone ? h('option', { value: '-1' }, '—') : null, headers.map((col, i) => h('option', { value: i, selected: i === value }, col || `Column ${i + 1}`)));
    return h('label', {}, label, s);
  };
  box.replaceChildren(
    select('date', 'Publish date and time', mapping.date, false),
    h('label', {}, 'Times in the file are in',
      h('select', { name: 'zone' }, h('option', { value: localZone }, `Your time zone (${localZone})`), h('option', { value: 'UTC' }, 'UTC'))),
    h('label', {}, 'Slash dates are',
      h('select', { name: 'order' }, h('option', { value: 'mdy', selected: mapping.order === 'mdy' }, 'Month/day/year'), h('option', { value: 'dmy', selected: mapping.order === 'dmy' }, 'Day/month/year'))),
    select('text', 'Post text or title', mapping.text),
    select('url', 'Post link', mapping.url),
    ...MAPPABLE.map(([k, label]) => select(`m_${k}`, label, mapping.metrics[k] ?? -1)),
  );
  box.hidden = false;
  $('mapping-actions').hidden = false;
}

function runMappedImport() {
  const t = state.importTable;
  const f = new FormData();
  for (const s of $('mapping').querySelectorAll('select')) f.set(s.name, s.value);
  const metrics = {};
  for (const [k] of MAPPABLE) { const v = Number(f.get(`m_${k}`)); if (v >= 0) metrics[k] = v; }
  if (!Object.keys(metrics).length) {
    $('import-error').textContent = 'Pick at least one number column, like likes or comments.';
    $('import-error').hidden = false;
    return;
  }
  const mapping = { date: Number(f.get('date')), text: Number(f.get('text')), url: Number(f.get('url')), order: f.get('order'), metrics };
  const posts = rowsToPosts(t.headers, t.rows, mapping, f.get('zone'));
  if (!posts.length) {
    $('import-error').textContent = `None of the dates in “${t.headers[mapping.date]}” could be read. Pick the column that holds each post's publish time.`;
    $('import-error').hidden = false;
    return;
  }
  $('import-error').hidden = true;
  finishImport(posts, 'File import', t.fileName, Object.keys(metrics));
}

function finishImport(posts, kind, name, metrics) {
  const source = importSource(kind, metrics);
  state.source = source;
  state.metric = source.defaultMetric;
  state.mode = null;
  state.query = name;
  const times = posts.map((p) => p.createdAt);
  state.data = {
    profile: { name, description: `${posts.length.toLocaleString()} posts from ${kind.toLowerCase()}, ${new Date(Math.min(...times)).toLocaleDateString()} to ${new Date(Math.max(...times)).toLocaleDateString()}.`, stats: [] },
    posts,
    activity: null,
    notes: ['Imported files are analyzed as exported, so posts from the last day count too if the export is older than that.'],
    method: 'Each post is scored by the metric you pick, as recorded in the file.',
    sourceCredit: null,
    minAgeHours: 0,
  };
  render({ animate: true });
}

/* ---------- rendering ---------- */
function timeZones() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.includes(localZone)) zones.unshift(localZone);
  if (!zones.includes('UTC')) zones.unshift('UTC');
  return zones;
}

function panel(title, desc, body, foot) {
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', {}, title), desc ? h('p', {}, desc) : null),
    body,
    foot ? h('div', { class: 'panel-foot' }, foot) : null);
}

function tableView(caption, head, rows) {
  return h('details', { class: 'table-view' }, h('summary', {}, 'Show as table'),
    h('div', { class: 'table-scroll', tabindex: 0, role: 'region', 'aria-label': caption }, h('table', { class: 'data' }, h('caption', { class: 'visually-hidden' }, caption),
      h('thead', {}, h('tr', {}, head.map((c, i) => h('th', { class: i ? 'num' : null, scope: 'col' }, c)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h(i ? 'td' : 'th', { class: i ? 'num' : null, scope: i ? null : 'row' }, c))))))));
}

function render({ animate = false } = {}) {
  const { data, source } = state;
  const metricDef = source.metrics.find((m) => m.id === state.metric) || source.metrics[0] || { label: 'Interactions' };
  const metricLabel = metricDef.label;
  const metricNoun = metricDef.noun || (metricDef.id === 'engagement' ? 'interactions' : metricLabel.toLowerCase());
  const r = analyze(data, { timeZone: state.timeZone, metric: state.metric, minAgeHours: data.minAgeHours ?? 24 });
  const canPerf = r.grid.valid && r.counts.eligible > 0;
  if (!state.mode || (state.mode === 'performance' && !canPerf) || (state.mode === 'activity' && !r.activity)) {
    state.mode = r.basis === 'activity' || !canPerf ? 'activity' : 'performance';
  }
  const perf = state.mode === 'performance';
  const name = data.profile.name;
  const activityLabel = r.activity?.label || 'posts per hour';

  const out = $('results');
  out.replaceChildren();
  // Only a new analysis gets the entrance; changing time zone or metric just redraws.
  if (animate) out.dataset.enter = ''; else delete out.dataset.enter;
  $('intro').hidden = true;
  out.hidden = false;

  /* profile */
  const facts = [
    ...data.profile.stats,
    { label: 'Posts read', value: r.counts.fetched.toLocaleString() },
    { label: 'Posts scored', value: r.counts.eligible.toLocaleString() },
  ];
  if (r.window) facts.push({ label: 'Covering', value: spanText(r.window) });
  out.append(h('div', { class: 'profile' },
    data.profile.avatar ? h('img', { src: data.profile.avatar, alt: '', width: 64, height: 64, loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'no-avatar' }),
    h('div', { class: 'profile-main' },
      h('h2', {}, data.profile.url ? h('a', { href: data.profile.url, target: '_blank', rel: 'noopener noreferrer' }, name) : name),
      data.profile.handle ? h('p', { class: 'handle' }, data.profile.handle) : null,
      data.profile.description ? h('p', { class: 'desc' }, data.profile.description) : null,
      h('dl', { class: 'facts' }, facts.map((f) => h('div', {}, h('dt', {}, f.label), h('dd', {}, f.value)))))));

  /* controls */
  const tzSelect = h('select', { onchange: (e) => { state.timeZone = e.target.value; render(); } }, timeZones().map((z) => h('option', { value: z, selected: z === state.timeZone }, z === localZone ? `${z} (yours)` : z)));
  const metricSelect = source.metrics.length > 1
    ? h('label', {}, 'Score posts by', h('select', { onchange: (e) => { state.metric = e.target.value; render(); } }, source.metrics.map((m) => h('option', { value: m.id, selected: m.id === state.metric }, m.label))))
    : null;
  out.append(h('div', { class: 'controls' },
    h('label', {}, 'Time zone', tzSelect),
    metricSelect,
    h('div', { class: 'actions' },
      state.source.id !== 'import' ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: (e) => copyLink(e.currentTarget) }, 'Copy link') : null,
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => download(`${slug(name)}-week.csv`, gridToCSV(r), 'text/csv') }, 'Download grid (CSV)'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => download(`${slug(name)}-posts.json`, JSON.stringify(data.posts, null, 1), 'application/json') }, 'Download posts (JSON)'))));

  /* verdict */
  const best = r.top[0];
  const verdict = h('div', { class: 'verdict' });
  if (best) {
    verdict.append(h('p', { class: 'verdict-time' }, `${DAYS[best.day]}, ${hourText(best.hour)}`, h('small', {}, `Best time to post on ${name}`)));
    if (r.basis === 'performance') {
      verdict.append(h('p', {}, `Posts published around ${DAYS[best.day]} at ${hourText(best.hour)} beat ${fmtPct(best.score)} of ${name}'s other posts on ${metricNoun}, on average, where a typical hour scores 50%. Based on ${r.counts.eligible.toLocaleString()} posts; times are in ${state.timeZone}.`));
    } else {
      const rates = r.activity.rate.filter((x) => x !== null);
      const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
      verdict.append(h('p', {}, `${name} is busiest around ${DAYS[best.day]} at ${hourText(best.hour)}, with ${fmtNum(best.score)} ${activityLabel} against ${fmtNum(avg)} on average. Times are in ${state.timeZone}.`));
    }
  } else {
    verdict.append(h('p', { class: 'verdict-time' }, 'Not enough data', h('small', {}, name)),
      h('p', {}, 'None of the posts read had any interactions yet, so there is nothing to compare. Try a busier account or community.'));
  }
  const notes = [...(data.notes || [])];
  if (r.lowSample && r.basis === 'performance') notes.push(`Only ${r.counts.eligible} posts could be scored, so treat these times as a rough guide.`);
  const minAge = data.minAgeHours ?? 24;
  if (minAge > 0 && r.counts.fetched > r.counts.eligible) notes.push(`Posts from the last ${minAge === 24 ? '24 hours' : `${minAge / 24} days`} are still collecting interactions, so they are left out of the scores.`);
  if (notes.length) verdict.append(h('div', { class: 'notes' }, notes.map((n) => h('p', {}, n))));
  out.append(verdict);

  /* heatmap */
  const values = perf ? r.grid.score.map((v, i) => (r.grid.counts[i] > 0 ? v : null)) : r.activity.rate;
  const ranked = rankSlots(values, 3);
  const ranks = new Map(ranked.map((s, i) => [s.slot, i + 1]));
  const heatHost = h('div', { class: 'heat-container' });
  const modeSwitch = canPerf && r.activity
    ? h('div', { class: 'segmented', role: 'group', 'aria-label': 'Heatmap shows' },
      h('button', { type: 'button', 'aria-pressed': String(perf), onclick: () => { state.mode = 'performance'; render(); } }, 'How posts did'),
      h('button', { type: 'button', 'aria-pressed': String(!perf), onclick: () => { state.mode = 'activity'; render(); } }, activityLabel === 'comments per hour' ? 'When people comment' : 'When posts go up'))
    : null;
  const heatPanel = panel(`Best times to post on ${name}`,
    perf ? `How posts published in each hour ranked on ${metricNoun}: the share of other posts they beat, on average. Blue hours beat the typical 50%, pink hours fall short.` : `How many ${activityLabel.replace(' per hour', '')} appear in each hour of the week. Darker is busier.`,
    heatHost,
    [perf ? divergingLegend() : legend(), modeSwitch, h('span', {}, `Time zone: ${state.timeZone}`)]);
  heatPanel.querySelector('.panel-head').append(tableView('Weekly grid', ['Day', ...Array.from({ length: 24 }, (_, i) => hourText(i))],
    DAYS.map((d, di) => [d, ...Array.from({ length: 24 }, (_, hr) => { const v = values[di * 24 + hr]; return v === null ? '—' : perf ? fmtPct(v) : fmtNum(v); })])));
  out.append(heatPanel);
  renderHeatmap(heatHost, {
    values,
    ranks,
    center: perf ? 50 : null,
    dayNames: DAYS,
    hourLabel: (hr) => hourText(hr),
    label: `Heatmap of ${perf ? 'post performance' : activityLabel} by day and hour`,
    tipLines: (slot) => {
      const d = Math.floor(slot / 24), hr = slot % 24;
      const v = values[slot];
      const head = `${DAYS[d]} ${hourRange(hr)}${ranks.get(slot) ? ` · #${ranks.get(slot)}` : ''}`;
      if (v === null) return [head, 'No data for this hour'];
      if (perf) {
        const n = r.grid.rawCounts[slot];
        return [head, `Beat ${fmtPct(v)} of posts on ${metricNoun}`, n ? `${n} post${n === 1 ? '' : 's'} published in this hour` : 'No posts in this exact hour; estimated from the hours next to it'];
      }
      return [head, `${fmtNum(v)} ${activityLabel}`];
    },
  });

  /* hour + day charts */
  const hourVals = perf ? r.byHour.score.map((v, i) => (r.byHour.counts[i] ? v : null)) : collapseActivity(r.activity.rate, 'hour');
  const dayVals = perf ? r.byDay.score.map((v, i) => (r.byDay.counts[i] ? v : null)) : collapseActivity(r.activity.rate, 'day');
  const fmtVal = perf ? fmtPct : fmtNum;
  const hourHost = h('div', { class: 'chart' });
  const dayHost = h('div', { class: 'chart' });
  const bestHour = argmax(hourVals);
  const bestDay = argmax(dayVals);
  const hourPanel = panel(`Best hour to post on ${name}`,
    perf ? `How posts ranked on ${metricNoun} by the hour they went up (50% is typical).` : `${capitalize(activityLabel)} by hour of day, all days together.`,
    hourHost,
    bestHour >= 0 ? h('span', {}, `Peak: ${hourText(bestHour)}, ${fmtVal(hourVals[bestHour])}`) : null);
  hourPanel.querySelector('.panel-head').append(tableView('By hour', ['Hour', perf ? 'Beat on average' : capitalize(activityLabel), perf ? 'Posts' : null].filter(Boolean),
    hourVals.map((v, i) => [hourRange(i), v === null ? '—' : fmtVal(v), perf ? String(r.byHour.counts[i]) : null].filter((x) => x !== null))));
  const dayPanel = panel(`Best day to post on ${name}`,
    perf ? `How posts ranked on ${metricNoun} by the day they went up (50% is typical).` : `${capitalize(activityLabel)} by day of week.`,
    dayHost,
    bestDay >= 0 ? h('span', {}, `Best day: ${DAYS[bestDay]}, ${fmtVal(dayVals[bestDay])}`) : null);
  dayPanel.querySelector('.panel-head').append(tableView('By day', ['Day', perf ? 'Beat on average' : capitalize(activityLabel), perf ? 'Posts' : null].filter(Boolean),
    dayVals.map((v, i) => [DAYS[i], v === null ? '—' : fmtVal(v), perf ? String(r.byDay.counts[i]) : null].filter((x) => x !== null))));
  out.append(h('div', { class: 'grid-2' }, hourPanel, dayPanel));
  renderArea(hourHost, {
    values: hourVals, xLabel: hourText, yFormat: perf ? (v) => `${v}%` : fmtNum,
    reference: perf ? 50 : null, referenceLabel: 'typical',
    label: `Line chart of ${perf ? 'performance' : activityLabel} by hour of day`,
    tipLines: (i) => [hourRange(i), hourVals[i] === null ? 'No data' : perf ? `Beat ${fmtPct(hourVals[i])} of posts` : `${fmtNum(hourVals[i])} ${activityLabel}`, perf ? `${r.byHour.counts[i]} posts` : ''].filter(Boolean),
  });
  renderBars(dayHost, {
    values: dayVals, labels: DAYS.map((d) => d.slice(0, 3)), yFormat: perf ? (v) => `${Math.round(v)}%` : fmtNum, best: bestDay,
    reference: perf ? 50 : null, referenceLabel: 'typical',
    label: `Bar chart of ${perf ? 'performance' : activityLabel} by day of week`,
    tipLines: (i) => [DAYS[i], dayVals[i] === null ? 'No data' : perf ? `Beat ${fmtPct(dayVals[i])} of posts` : `${fmtNum(dayVals[i])} ${activityLabel}`, perf ? `${r.byDay.counts[i]} posts` : ''].filter(Boolean),
  });

  /* recommendations */
  const scoreText = (s) => (r.basis === 'performance' ? fmtPct(s) : `${fmtNum(s)} ${activityLabel.replace(' per hour', '/h')}`);
  const perDayMax = Math.max(...r.perDay.filter(Boolean).map((p) => p.score));
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first reads like a planner
  const perDayList = h('ol', { class: 'ranked plain' }, order.map((d) => {
    const p = r.perDay[d];
    return h('li', {},
      h('div', {}, h('div', { class: 'when' }, DAYS[d]), h('div', { class: 'sub' }, p ? hourRange(p.hour) : 'No data'),
        p ? h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: `width:${(p.score / perDayMax) * 100}%` })) : null),
      h('span', { class: 'score' }, p ? scoreText(p.score) : '—'));
  }));
  const topList = h('ol', { class: 'ranked' }, r.top.map((s, i) => h('li', { class: i < 3 ? 'podium' : null },
    h('span', { class: 'badge' }, `#${i + 1}`),
    h('div', {}, h('div', { class: 'when' }, DAYS[s.day]), h('div', { class: 'sub' }, hourRange(s.hour))),
    h('span', { class: 'score' }, scoreText(s.score)))));
  out.append(h('div', { class: 'grid-2' },
    panel(`Best time to post on ${name} each day`, 'The strongest hour on each day of the week.', perDayList),
    panel(`Top 5 times to post on ${name}`, 'The five best hours of the week, ranked.', topList)));

  /* sites + tags */
  const tagNoun = source.tagNoun || (data.posts.some((p) => p.tags?.length && !String(p.tags[0]).startsWith('#')) ? 'flair' : 'hashtags');
  const groupPanels = [];
  if (r.sites.length) groupPanels.push(groupTable(`Most shared sites on ${name}`, `Where posts link to, by share of posts and average ${metricLabel.toLowerCase()}.`, 'Site', r.sites, metricLabel));
  if (r.tags.length) groupPanels.push(groupTable(`Most popular ${tagNoun} on ${name}`, `The ${tagNoun} posts use most, by share of posts and average ${metricLabel.toLowerCase()}.`, capitalize(tagNoun.replace(/s$/, '')), r.tags, metricLabel));
  if (groupPanels.length) out.append(h('div', { class: 'grid-2' }, groupPanels));

  /* phrases + top posts */
  const lower = [];
  const phraseHost = h('div', {});
  const phraseSizes = [1, 2, 3, 4, 5].filter((n) => r.phrases[n].length);
  if (phraseSizes.length) {
    let size = phraseSizes[0];
    const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Phrase length' });
    const draw = () => {
      for (const b of seg.children) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === size));
      phraseHost.replaceChildren(h('ul', { class: 'phrases' }, r.phrases[size].map((p) => h('li', {}, p.text, h('span', {}, `${p.count}`)))));
    };
    for (const n of phraseSizes) seg.append(h('button', { type: 'button', 'data-n': n, onclick: () => { size = n; draw(); } }, n === 1 ? 'Words' : `${n}-word`));
    draw();
    const p = panel(`Popular words and phrases on ${name}`, 'What posts talk about, counted once per post.', phraseHost);
    p.querySelector('.panel-head').append(seg);
    lower.push(p);
  }
  if (r.topPosts.length) {
    lower.push(panel(`Top posts on ${name}`, `Highest ${metricLabel.toLowerCase()} among the posts scored.`,
      h('ol', { class: 'posts' }, r.topPosts.map((p) => h('li', {},
        h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, (p.title || p.text || '(no text)').slice(0, 160)),
        h('span', { class: 'meta' }, `${new Date(p.createdAt).toLocaleString(undefined, { timeZone: state.timeZone, weekday: 'short', month: 'short', day: 'numeric', year: new Date(p.createdAt).getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' })}${p.domain ? `, ${p.domain}` : ''}`),
        h('span', { class: 'num' }, fmtCount(metricValue(p, state.metric)), h('small', {}, metricLabel.toLowerCase())))))));
  }
  if (lower.length) out.append(h('div', { class: 'grid-2' }, lower));

  /* method (last section) */
  out.append(h('div', { class: 'grid-2' }, panel('How this was worked out', null,
    h('div', { class: 'notes' },
      h('p', {}, data.method),
      h('p', {}, 'Each post is ranked against all the others: a post that beat 90% of them scores 90%. An hour’s score is the average for posts published then, so one viral post can only move it so far. Hours are smoothed with their neighbours, and hours with few posts are pulled toward 50%.'),
      h('p', {}, h('a', { href: 'method.html' }, 'Read the full method')),
      data.sourceCredit ? h('p', {}, 'Data: ', h('a', { href: data.sourceCredit.url, target: '_blank', rel: 'noopener noreferrer' }, data.sourceCredit.label), `, read ${new Date().toLocaleString()}.`) : null))));
  [...out.children].forEach((child, i) => child.style.setProperty('--i', i));
  perDayList.querySelectorAll('.meter i').forEach((m, i) => m.style.setProperty('--i', i));
}

function groupTable(title, desc, colName, rows, metricLabel) {
  const pageSize = 10;
  let page = 0;
  let sortKey = 'share';
  const body = h('tbody');
  const pager = h('div', { class: 'pager' });
  const sorted = () => [...rows].sort((a, b) => (sortKey === 'share' ? b.n - a.n : b.avg - a.avg));
  const maxShare = Math.max(...rows.map((x) => x.share));
  const sortBtn = (key, label) => h('button', { type: 'button', onclick: () => { sortKey = key; page = 0; draw(); } }, label);
  const shareBtn = sortBtn('share', '% of posts');
  const avgBtn = sortBtn('avg', 'Average');
  avgBtn.setAttribute('aria-label', `Average ${metricLabel.toLowerCase()}`);
  const draw = () => {
    const list = sorted();
    const pages = Math.ceil(list.length / pageSize);
    shareBtn.toggleAttribute('aria-sort', sortKey === 'share'); shareBtn.closest('th')?.setAttribute('aria-sort', sortKey === 'share' ? 'descending' : 'none');
    avgBtn.toggleAttribute('aria-sort', sortKey === 'avg'); avgBtn.closest('th')?.setAttribute('aria-sort', sortKey === 'avg' ? 'descending' : 'none');
    body.replaceChildren(...list.slice(page * pageSize, page * pageSize + pageSize).map((g) => h('tr', {},
      h('td', {}, g.name),
      h('td', { class: 'num' }, h('span', { class: 'share-cell' }, h('i', { style: `width:${Math.max(2, (g.share / maxShare) * 48)}px`, 'aria-hidden': 'true' }), g.share < 0.01 ? '<1%' : `${Math.round(g.share * 100)}%`)),
      h('td', { class: 'num' }, fmtCount(g.avg)))));
    pager.replaceChildren(
      h('button', { class: 'btn btn-quiet', type: 'button', disabled: page === 0, onclick: () => { page--; draw(); }, 'aria-label': 'Previous page' }, '‹'),
      h('span', {}, `Page ${page + 1} of ${pages}`),
      h('button', { class: 'btn btn-quiet', type: 'button', disabled: page >= pages - 1, onclick: () => { page++; draw(); }, 'aria-label': 'Next page' }, '›'));
  };
  const table = h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, colName), h('th', { scope: 'col', class: 'num' }, shareBtn), h('th', { scope: 'col', class: 'num' }, avgBtn))),
    body);
  draw();
  return panel(title, desc, table, rows.length > pageSize ? pager : null);
}

function collapseActivity(rate, by) {
  const size = by === 'hour' ? 24 : 7;
  const sums = new Array(size).fill(0), counts = new Array(size).fill(0);
  rate.forEach((v, slot) => {
    if (v === null) return;
    const k = by === 'hour' ? slot % 24 : Math.floor(slot / 24);
    sums[k] += v; counts[k] += 1;
  });
  return sums.map((s, i) => (counts[i] ? s / counts[i] : null));
}

function argmax(values) {
  let best = -1;
  values.forEach((v, i) => { if (v !== null && (best < 0 || v > values[best])) best = i; });
  return best;
}

function spanText([a, b]) {
  const days = (b - a) / 86_400_000;
  if (days < 2) return `${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30.4)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

function fmtCount(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'analysis';

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyLink(button) {
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = 'Link copied';
  } catch {
    button.textContent = 'Copy failed — use the address bar';
  }
  setTimeout(() => { button.textContent = 'Copy link'; }, 2500);
}

/* ---------- wiring ---------- */
// Charts are drawn at their real width, so redraw (without the entrance) when it changes a lot.
let lastWidth = innerWidth;
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.data && Math.abs(innerWidth - lastWidth) > 40) { lastWidth = innerWidth; render(); }
  }, 150);
});
buildPlatforms();
$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.platform !== 'import') start(state.platform, $('query').value);
});
$('cancel').addEventListener('click', () => {
  state.controller?.abort();
  $('progress').hidden = true;
  $('go').disabled = false;
});
$('file').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
$('import-go').addEventListener('click', runMappedImport);
const dz = $('dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragging'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

const params = new URLSearchParams(location.search);
const initial = params.get('source');
if (initial && (SOURCES[initial] || initial === 'import')) {
  setPlatform(initial, { focus: false });
  if (SOURCES[initial] && params.get('q')) {
    $('query').value = params.get('q');
    start(initial, params.get('q'));
  }
} else {
  setPlatform(state.platform, { focus: false });
}
