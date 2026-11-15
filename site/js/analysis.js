// Pure analysis functions. No DOM access, so the same module runs in the
// browser and under `node --test`.
//
// A "post" is the shape every source normalizes to:
//   { id, createdAt (ms epoch), metrics: { [metricId]: number },
//     title, text, url, domain, tags: string[], author, permalink }
//
// The weekly grid has 168 slots: slot = day * 24 + hour, day 0 = Sunday.

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const SLOTS = 168;
const HOUR = 3600_000;

const formatterCache = new Map();
function partsFormatter(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    formatterCache.set(timeZone, f);
  }
  return f;
}
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Day of week (0 = Sunday) and hour (0-23) of a timestamp in a time zone. */
export function dayHour(ms, timeZone) {
  let day = 0, hour = 0;
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type === 'weekday') day = WEEKDAY_INDEX[p.value];
    else if (p.type === 'hour') hour = Number(p.value) % 24;
  }
  return { day, hour };
}

export function slotOf(ms, timeZone) {
  const { day, hour } = dayHour(ms, timeZone);
  return day * 24 + hour;
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Circular [1, 2, 1] / 4 smoothing over the hour-of-week ring (Saturday 23:00 sits next to Sunday 00:00). */
export function smoothRing(values) {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.25 * values[(i - 1 + n) % n] + 0.5 * values[i] + 0.25 * values[(i + 1) % n];
  }
  return out;
}

/**
 * How many hours of each weekly slot fall inside the given time intervals.
 * Used to turn raw activity counts into a rate, so a window that covers two
 * Tuesdays but one Wednesday doesn't make Tuesday look twice as busy.
 */
export function exposureHours(intervals, timeZone) {
  const exposure = new Array(SLOTS).fill(0);
  for (const [start, end] of intervals) {
    // Walk hour by hour; each step adds the part of that clock hour inside [start, end].
    let t = start;
    while (t < end) {
      const next = Math.min(end, Math.floor(t / HOUR) * HOUR + HOUR);
      exposure[slotOf(t, timeZone)] += (next - t) / HOUR;
      t = next;
    }
  }
  return exposure;
}

function covers(intervals, start, end) {
  return intervals.some(([a, b]) => a <= start && end <= b);
}

const NOT_SUMMED = new Set(['views', 'clicks', 'engagements']);

/** The value of a metric for a post; "engagement" sums every interaction count the source reported. */
export function metricValue(post, metric) {
  const m = post.metrics || {};
  if (metric === 'engagement') {
    let total = 0;
    // Views, clicks and pre-summed "engagements" columns aren't interactions to add up.
    for (const [k, v] of Object.entries(m)) if (!NOT_SUMMED.has(k) && Number.isFinite(v)) total += v;
    return total;
  }
  const v = m[metric];
  return Number.isFinite(v) ? v : 0;
}

/**
 * Percentile rank of every value: the share of the other posts it beat, with
 * ties counted as half. Returns numbers in [0, 1]; their mean is always 0.5.
 */
export function percentileRanks(values) {
  const n = values.length;
  if (n < 2) return values.map(() => 0.5);
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    // Posts i..j tie: each beat i others and tied with (j - i) others.
    const r = (i + (j - i) / 2) / (n - 1);
    for (let k = i; k <= j; k++) ranks[order[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

/**
 * Score every hour of the week by how well posts published then ranked.
 *
 * 1. Each post's result is turned into its percentile rank among all posts
 *    read: 0.9 means it beat 90% of them. Ranks are graded (a huge post beats
 *    more than a decent one) but bounded, so one viral post can't decide the
 *    answer, and they work the same whether typical posts get 1 like or 10,000.
 * 2. Ranks and post counts are summed per slot, then smoothed over neighbouring
 *    hours.
 * 3. Each slot's average rank is shrunk toward 50% by `prior` imaginary average
 *    posts, so an hour with one lucky post doesn't outrank an hour with twenty
 *    good ones.
 * 4. `score` is that average as a percentage: 50 is a typical hour, 65 means
 *    posts published then beat 65% of posts on average.
 */
export function scoreSlots(posts, { timeZone, metric = 'engagement', prior = 3 } = {}) {
  const values = posts.map((p) => metricValue(p, metric));
  const sums = new Array(SLOTS).fill(0);
  const counts = new Array(SLOTS).fill(0);
  const valid = posts.length >= 2 && values.some((v) => v !== values[0]);
  if (!valid) return { score: new Array(SLOTS).fill(null), counts, rawCounts: counts.slice(), valid: false };
  const ranks = percentileRanks(values);
  posts.forEach((p, i) => {
    const s = slotOf(p.createdAt, timeZone);
    sums[s] += ranks[i];
    counts[s] += 1;
  });
  const sSums = smoothRing(sums);
  const sCounts = smoothRing(counts);
  const score = sSums.map((s, i) => ((s + prior * 0.5) / (sCounts[i] + prior)) * 100);
  return { score, counts: sCounts, rawCounts: counts, valid: true };
}

/** Collapse the grid to one score per hour of day or per weekday, using the same shrinkage. */
export function collapse(posts, { timeZone, metric = 'engagement', prior = 3, by }) {
  const size = by === 'hour' ? 24 : 7;
  const values = posts.map((p) => metricValue(p, metric));
  const sums = new Array(size).fill(0);
  const counts = new Array(size).fill(0);
  if (posts.length < 2 || values.every((v) => v === values[0])) return { score: new Array(size).fill(null), counts };
  const ranks = percentileRanks(values);
  posts.forEach((p, i) => {
    const { day, hour } = dayHour(p.createdAt, timeZone);
    const k = by === 'hour' ? hour : day;
    sums[k] += ranks[i];
    counts[k] += 1;
  });
  return { score: sums.map((s, i) => ((s + prior * 0.5) / (counts[i] + prior)) * 100), counts };
}

/** Activity rate (events per hour) for each weekly slot, from raw timestamps and the intervals they cover. */
export function activityRate(timestamps, intervals, timeZone) {
  const counts = new Array(SLOTS).fill(0);
  for (const t of timestamps) counts[slotOf(t, timeZone)] += 1;
  const exposure = exposureHours(intervals, timeZone);
  const measured = counts.map((c, i) => (exposure[i] > 0 ? c / exposure[i] : null));
  // A single empty hour between two measured hours (sampled sources read every other hour)
  // is filled with their average; longer gaps stay empty.
  const rate = measured.map((r, i) => {
    if (r !== null) return r;
    const a = measured[(i + 167) % 168], b = measured[(i + 1) % 168];
    return a !== null && b !== null ? (a + b) / 2 : null;
  });
  // Smooth only where neighbours have data; empty slots stay empty.
  const filled = rate.map((r) => r ?? 0);
  const has = rate.map((r) => (r === null ? 0 : 1));
  const sf = smoothRing(filled);
  const sh = smoothRing(has);
  const smoothed = rate.map((r, i) => (r === null ? null : sf[i] / sh[i]));
  return { rate: smoothed, counts, exposure };
}

/** Rank the best distinct slots by score. */
export function rankSlots(scores, n = 5) {
  return scores
    .map((score, slot) => ({ slot, day: Math.floor(slot / 24), hour: slot % 24, score }))
    .filter((s) => s.score !== null && Number.isFinite(s.score))
    .sort((a, b) => b.score - a.score || a.slot - b.slot)
    .slice(0, n);
}

export function bestPerDay(scores) {
  return DAYS.map((name, day) => {
    let best = null;
    for (let hour = 0; hour < 24; hour++) {
      const score = scores[day * 24 + hour];
      if (score !== null && Number.isFinite(score) && (!best || score > best.score)) best = { day, hour, score, slot: day * 24 + hour };
    }
    return best;
  });
}

const STOPWORDS = new Set(('a an and are as at be but by for from has have i if in into is it its me my of on or our so ' +
  'that the their them then there these they this to was we were what when where which who why will with you your ' +
  'just not no do does did can could would should how all any about up out more most some than too very also been ' +
  'being he she his her him us am get got im dont ive id youre its it\'s i\'m don\'t can\'t isn\'t one new via amp ' +
  'http https www com').split(/\s+/));

export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[’‘]/g, "'")
    .match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [];
}

/** Most common words and 2-5 word phrases, counted once per post. */
export function phrases(posts, { top = 12, minCount = 2 } = {}) {
  const tables = { 1: new Map(), 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  for (const p of posts) {
    const tokens = tokenize(`${p.title || ''} ${p.title ? '' : p.text || ''}`).map((t) => t.replace(/^'+|'+$/g, '')).filter(Boolean);
    const seen = new Set();
    for (let n = 1; n <= 5; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n);
        if (n === 1 && (STOPWORDS.has(gram[0]) || gram[0].length < 3 || /^\d+$/.test(gram[0]))) continue;
        if (n > 1 && gram.every((t) => STOPWORDS.has(t)) && n < 3) continue;
        const key = gram.join(' ');
        const id = `${n}:${key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        tables[n].set(key, (tables[n].get(key) || 0) + 1);
      }
    }
  }
  const out = {};
  for (const n of [1, 2, 3, 4, 5]) {
    out[n] = [...tables[n].entries()]
      .filter(([, c]) => c >= minCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([text, count]) => ({ text, count }));
  }
  return out;
}

/** Group posts by a key (site, flair, hashtag) with share of posts and average metric. */
export function groupBy(posts, keyFn, metric = 'engagement') {
  const groups = new Map();
  for (const p of posts) {
    const keys = [].concat(keyFn(p) || []).filter(Boolean);
    for (const key of new Set(keys)) {
      const g = groups.get(key) || { name: key, n: 0, total: 0 };
      g.n += 1;
      g.total += metricValue(p, metric);
      groups.set(key, g);
    }
  }
  return [...groups.values()]
    .map((g) => ({ name: g.name, n: g.n, share: g.n / (posts.length || 1), avg: g.total / g.n }))
    .sort((a, b) => b.n - a.n || b.avg - a.avg);
}

/**
 * Full analysis of a source result.
 * @param {object} data  { posts, activity?: { timestamps, intervals }, perfIntervals?, minAgeHours? }
 */
export function analyze(data, { timeZone, metric = 'engagement', now = Date.now(), minAgeHours = 24 } = {}) {
  const all = (data.posts || []).filter((p) => Number.isFinite(p.createdAt));
  const cutoff = now - minAgeHours * HOUR;
  // Posts younger than minAgeHours are still collecting interactions, so they would look worse than they are.
  let eligible = all.filter((p) => p.createdAt <= cutoff && !p.excludeFromPerformance);
  if (data.perfIntervals) {
    eligible = eligible.filter((p) => covers(data.perfIntervals, p.createdAt, p.createdAt + minAgeHours * HOUR));
  }
  const grid = scoreSlots(eligible, { timeZone, metric });
  const byHour = collapse(eligible, { timeZone, metric, by: 'hour' });
  const byDay = collapse(eligible, { timeZone, metric, by: 'day' });

  // Activity: the source's own signal (Reddit comments), or else when posts were published.
  let act = data.activity && data.activity.timestamps.length ? data.activity : null;
  if (!act && all.length >= 2) {
    const ts = all.map((p) => p.createdAt);
    act = { timestamps: ts, intervals: [[Math.min(...ts), Math.max(...ts) + 1]], label: 'posts per hour' };
  }
  let activity = null;
  if (act) {
    activity = activityRate(act.timestamps, act.intervals, timeZone);
    activity.label = act.label;
    activity.total = act.timestamps.length;
  }
  // When there aren't enough scored posts, recommendations come from activity instead.
  const minPosts = 15;
  const usePerformance = grid.valid && eligible.length >= minPosts;
  const rankingScores = usePerformance ? grid.score : activity ? activity.rate : grid.score;
  const basis = usePerformance ? 'performance' : activity ? 'activity' : grid.valid ? 'performance' : 'none';

  const sorted = [...eligible].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  const times = all.map((p) => p.createdAt);
  return {
    timeZone,
    metric,
    basis,
    lowSample: eligible.length < minPosts,
    counts: { fetched: all.length, eligible: eligible.length },
    window: times.length ? [Math.min(...times), Math.max(...times)] : null,
    grid,
    byHour,
    byDay,
    activity,
    top: rankSlots(rankingScores, 5),
    perDay: bestPerDay(rankingScores),
    rankingScores,
    medianValue: median(eligible.map((p) => metricValue(p, metric))),
    sites: groupBy(eligible, (p) => p.domain, metric).slice(0, 50),
    tags: groupBy(eligible, (p) => p.tags, metric).slice(0, 50),
    phrases: phrases(eligible.length ? eligible : all),
    topPosts: sorted.slice(0, 10),
    eligible,
  };
}

/** "5 pm" / "17:00" style hour label. */
export function hourLabel(hour, { hour12 = true, style = 'short' } = {}) {
  if (!hour12) return `${String(hour).padStart(2, '0')}:00`;
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const ap = hour < 12 ? 'am' : 'pm';
  return style === 'range' ? `${h}:00 ${ap}` : `${h} ${ap}`;
}

/** CSV export of the weekly grid. */
export function gridToCSV(result) {
  const rows = [['day', 'hour', 'avg_percentile_rank', 'posts_smoothed', 'activity_per_hour']];
  for (let s = 0; s < SLOTS; s++) {
    const l = result.grid.score[s];
    const a = result.activity ? result.activity.rate[s] : null;
    rows.push([DAYS[Math.floor(s / 24)], s % 24, l == null ? '' : l.toFixed(1), result.grid.counts[s].toFixed(2), a == null ? '' : a.toFixed(3)]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}
