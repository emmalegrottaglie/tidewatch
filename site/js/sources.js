// Data sources. Each one turns a query into normalized posts (see analysis.js)
// using only public APIs that answer browser requests from any origin (CORS),
// so the whole site can run from GitHub Pages with no server and no keys.

const DAY = 86_400_000;

class SourceError extends Error {}

async function getJSON(url, { signal, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt < retries) { await sleep(800 * (attempt + 1), signal); continue; }
      throw new SourceError(`Couldn't reach ${new URL(url).host}. Check your connection, or try again in a minute.`);
    }
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset') || 5);
      await sleep(Math.min(wait, 30) * 1000, signal);
      continue;
    }
    if (res.status >= 500 && attempt < retries) { await sleep(1000 * (attempt + 1), signal); continue; }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    // Arctic Shift reports overload as an error body ("Timeout. Maybe slow down a bit"); back off and retry.
    if (body && typeof body.error === 'string' && /timeout|slow down/i.test(body.error) && attempt < retries + 2) {
      await sleep(1500 * (attempt + 1), signal);
      continue;
    }
    if (!res.ok || (body && body.data === null && body.error)) {
      const err = new SourceError((body && (body.error || body.message)) || `${new URL(url).host} answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return body;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function stripHTML(html) {
  if (!html) return '';
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html');
    return (doc.body.textContent || '').trim();
  }
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Run async jobs with a concurrency limit. */
async function pool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); }
  }));
  return results;
}

/* ------------------------------------------------------------------ Reddit */
// reddit.com no longer answers logged-out browser requests (403, no CORS
// headers), so subreddit data comes from the Arctic Shift archive
// (https://arctic-shift.photon-reddit.com). It records each post seconds after
// it appears, then fetches it again about 36 hours later and updates its score
// and comment count, so posts older than two days carry real upvote and
// comment totals.

const ARCTIC = 'https://arctic-shift.photon-reddit.com/api';
// Only posts this old are scored: the archive's second fetch happens around 36 hours.
const REDDIT_SETTLED_HOURS = 48;

/**
 * Fetch an archive endpoint backwards in time over several lanes at once.
 * The window is split into `lanes` equal slices; each lane pages back from its
 * slice end until it reaches the slice start or runs out of pages. Returns the
 * items and the time intervals that were fetched completely.
 */
async function fetchLanes({ path, params, start, end, lanes, pagesPerLane, signal, onPage }) {
  const span = (end - start) / lanes;
  const intervals = [];
  const items = [];
  const jobs = Array.from({ length: lanes }, (_, i) => async () => {
    const laneStart = start + i * span;
    const laneEnd = start + (i + 1) * span;
    let before = laneEnd;
    let reachedStart = false;
    for (let page = 0; page < pagesPerLane; page++) {
      const q = new URLSearchParams({ ...params, before: String(Math.floor(before / 1000)), after: String(Math.floor(laneStart / 1000)), sort: 'desc' });
      const body = await getJSON(`${ARCTIC}${path}?${q}`, { signal });
      const data = body.data || [];
      onPage?.();
      if (!data.length) { reachedStart = true; break; }
      for (const d of data) items.push(d);
      const oldest = Math.min(...data.map((d) => d.created_utc)) * 1000;
      if (oldest >= before) { reachedStart = true; break; } // no progress; treat as done
      before = oldest;
      if (before <= laneStart) { reachedStart = true; break; }
    }
    intervals.push([reachedStart ? laneStart : before, laneEnd]);
  });
  await pool(jobs, 3);
  return { items, intervals: mergeIntervals(intervals) };
}

/**
 * One page before each of `samples` moments, two hours apart, with consecutive
 * samples placed in different weeks so no single week dominates. Each page
 * covers a short stretch exactly, which is enough to estimate the rate at that
 * hour of the week and to collect posts published then.
 */
async function samplePages({ path, params, end, samples, signal, onPage }) {
  const items = [];
  const intervals = [];
  const hourAligned = Math.floor(end / 3600_000) * 3600_000;
  const jobs = Array.from({ length: samples }, (_, i) => async () => {
    const t = hourAligned - i * 2 * 3600_000 - (i % 4) * 7 * DAY + 50 * 60_000; // 50 minutes into the hour
    const q = new URLSearchParams({ ...params, before: String(Math.floor(t / 1000)), sort: 'desc' });
    const data = (await getJSON(`${ARCTIC}${path}?${q}`, { signal })).data || [];
    onPage?.();
    if (data.length < 2) return;
    for (const d of data) items.push(d);
    intervals.push([Math.min(...data.map((d) => d.created_utc)) * 1000, t]);
  });
  await pool(jobs, 3);
  return { items, intervals: mergeIntervals(intervals), sampled: true };
}

function mergeIntervals(list) {
  const s = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1000) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function formatCount(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}
export { formatCount };

/** How long one page of posts lasted just before the settled cutoff, from a single probe read. */
async function postPageSpan(params, signal) {
  const before = Math.floor((Date.now() - REDDIT_SETTLED_HOURS * 3600_000) / 1000);
  const probe = (await getJSON(`${ARCTIC}/posts/search?${new URLSearchParams({ ...params, sort: 'desc', before: String(before) })}`, { signal })).data || [];
  return { count: probe.length, span: probe.length > 1 ? (probe[0].created_utc - probe[probe.length - 1].created_utc) * 1000 : DAY };
}

/**
 * Popular subreddits are precomputed every day by the data pipeline (scripts/reddit-snapshots.mjs)
 * and served from this site, which spares the archive and the visitor ~70 requests. Returns null
 * when there is no snapshot or it is more than three days old, and the caller reads live instead.
 */
const SNAPSHOT_MAX_AGE = 3 * DAY;
let snapshotIndex = null;
async function redditSnapshot(name, signal) {
  try {
    snapshotIndex ??= fetch('data/reddit/index.json', { signal }).then((r) => (r.ok ? r.json() : { subs: {} }));
    const entry = (await snapshotIndex).subs?.[name.toLowerCase()];
    if (!entry || Date.now() - entry.fetchedAt > SNAPSHOT_MAX_AGE) return null;
    const res = await fetch(`data/reddit/${name.toLowerCase()}.json`, { signal });
    return res.ok ? { ...(await res.json()), snapshot: { fetchedAt: entry.fetchedAt } } : null;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    snapshotIndex = null;
    return null; // no data folder (local runs, forks without the pipeline): read live
  }
}

const reddit = {
  id: 'reddit',
  label: 'Reddit',
  noun: 'subreddit',
  tagNoun: 'flair',
  prefix: 'r/',
  placeholder: 'photography',
  examples: ['photography', 'gaming', 'technology', 'science', 'AskReddit', 'SideProject', 'analog', 'webdev'],
  metrics: [
    { id: 'upvotes', label: 'Upvotes', noun: 'upvotes' },
    { id: 'comments', label: 'Comments', noun: 'comments' },
    { id: 'engagement', label: 'Upvotes + comments' },
  ],
  defaultMetric: 'upvotes',
  normalize: (q) => q.trim().replace(/^https?:\/\/(www\.|old\.)?reddit\.com\//i, '').replace(/^\/?r\//i, '').replace(/\/.*$/, ''),
  validate: (q) => /^[A-Za-z0-9_]{2,21}$/.test(q) || 'Subreddit names are 2-21 letters, numbers or underscores.',
  title: (q) => `r/${q}`,
  async fetch(name, { signal, onProgress, days = 28, live = false }) {
    if (!live) {
      const snapshot = await redditSnapshot(name, signal);
      if (snapshot) return snapshot;
    }
    const end = Date.now();
    const start = end - days * DAY;
    const metaBody = await getJSON(`${ARCTIC}/subreddits/search?${new URLSearchParams({ subreddit: name, fields: 'display_name,subscribers,public_description,created_utc' })}`, { signal });
    const meta = (metaBody.data || []).find((d) => d.display_name.toLowerCase() === name.toLowerCase());
    if (!meta) throw new SourceError(`No subreddit called r/${name} in the archive. Check the spelling.`);

    const sub = meta.display_name;
    const postParams = { subreddit: sub, limit: '100', fields: 'id,created_utc,title,url,link_flair_text,author,over_18,score,num_comments' };
    const commentParams = { subreddit: sub, limit: 'auto', fields: 'created_utc' };
    const postLanes = 4, postPagesPerLane = 5, commentLanes = 4, commentPagesPerLane = 12, samples = 84;
    // Busy subreddits publish more posts than we can afford to read over four weeks, so they
    // get a spread-out sample instead: one page every two hours, rotated across the weeks.
    const probe = await postPageSpan(postParams, signal);
    const sampled = probe.count >= 50 && probe.span * postLanes * postPagesPerLane < (end - start) * 0.6;

    let pages = 0;
    const totalPages = sampled ? samples : postLanes * postPagesPerLane + commentLanes * commentPagesPerLane;
    const tick = () => onProgress?.(++pages / totalPages, `Reading r/${sub} from the archive`);
    // One endpoint at a time keeps us to three requests in flight, which the archive tolerates.
    const postsRes = sampled
      ? await samplePages({ path: '/posts/search', params: postParams, end: end - REDDIT_SETTLED_HOURS * 3600_000, samples, signal, onPage: tick })
      : await fetchLanes({ path: '/posts/search', params: postParams, start, end, lanes: postLanes, pagesPerLane: postPagesPerLane, signal, onPage: tick });
    // For subreddits small enough to read in full, comments show when people are around.
    const commentsRes = sampled ? null
      : await fetchLanes({ path: '/comments/search', params: commentParams, start, end, lanes: commentLanes, pagesPerLane: commentPagesPerLane, signal, onPage: tick });

    const seen = new Set();
    const posts = [];
    for (const p of postsRes.items) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const isSelf = !p.url || /reddit\.com\/r\/[^/]+\/comments\//.test(p.url);
      const host = isSelf ? 'Text post' : hostOf(p.url);
      posts.push({
        id: p.id,
        createdAt: p.created_utc * 1000,
        metrics: { upvotes: Math.max(0, p.score || 0), comments: p.num_comments || 0 },
        title: p.title,
        url: `https://www.reddit.com/r/${sub}/comments/${p.id}/`,
        domain: host === 'i.redd.it' || host === 'v.redd.it' || host === 'reddit.com' ? (host === 'v.redd.it' ? 'Reddit video' : host === 'i.redd.it' ? 'Reddit image' : 'Reddit gallery') : host,
        tags: p.link_flair_text ? [p.link_flair_text] : [],
        author: p.author,
        // Scheduled AutoModerator threads would teach us when the mods post, not when people engage.
        excludeFromPerformance: p.author === 'AutoModerator',
      });
    }
    const covered = (list) => list.reduce((s, [a, b]) => s + (b - a), 0);
    const notes = [];
    let activity;
    if (sampled) {
      notes.push(`r/${sub} posts too often to read four weeks in full, so these results come from ${postsRes.intervals.length} short samples taken every two hours across four weeks (${posts.length.toLocaleString()} posts).`);
      activity = { timestamps: posts.map((p) => p.createdAt), intervals: postsRes.intervals, label: 'posts per hour' };
    } else {
      const commentDays = covered(commentsRes.intervals) / DAY;
      if (commentDays < days * 0.9) notes.push(`The comment activity view covers ${commentDays < 1 ? `${Math.round(commentDays * 24)} hours` : `${commentDays.toFixed(1)} days`} of the last ${days}, because r/${sub} is busy. Hours outside it are left blank there.`);
      activity = { timestamps: commentsRes.items.map((c) => c.created_utc * 1000), intervals: commentsRes.intervals, label: 'comments per hour' };
    }
    return {
      profile: {
        name: `r/${sub}`,
        url: `https://www.reddit.com/r/${sub}/`,
        description: meta.public_description,
        stats: [
          { label: 'Members', value: formatCount(meta.subscribers) },
          { label: 'Created', value: new Date(meta.created_utc * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) },
        ],
      },
      posts,
      minAgeHours: REDDIT_SETTLED_HOURS,
      activity,
      notes,
      method: 'Each post is scored by its upvotes and comments as the archive recorded them on its second visit, about 36 hours after posting. Posts younger than two days are left out because they haven’t been re-read yet.',
      sourceCredit: { label: 'Arctic Shift archive', url: 'https://github.com/ArthurHeitmann/arctic_shift' },
    };
  },
};

/* ----------------------------------------------------------------- Bluesky */
const BSKY = 'https://public.api.bsky.app/xrpc';

const bluesky = {
  id: 'bluesky',
  label: 'Bluesky',
  noun: 'account',
  prefix: '@',
  placeholder: 'bsky.app',
  examples: ['bsky.app', 'atproto.com', 'pfrazee.com', 'nytimes.com', 'theonion.com', 'npr.org'],
  metrics: [
    { id: 'engagement', label: 'All interactions' },
    { id: 'likes', label: 'Likes' },
    { id: 'reposts', label: 'Reposts' },
    { id: 'replies', label: 'Replies' },
    { id: 'quotes', label: 'Quotes' },
  ],
  defaultMetric: 'engagement',
  normalize: (q) => {
    let s = q.trim().replace(/^@/, '');
    const m = s.match(/bsky\.app\/profile\/([^/?#]+)/i);
    if (m) s = decodeURIComponent(m[1]);
    if (!s.includes('.') && !s.startsWith('did:')) s += '.bsky.social';
    return s.toLowerCase();
  },
  validate: (q) => /^(did:[a-z]+:[A-Za-z0-9._:%-]+|[a-z0-9.-]+\.[a-z]{2,})$/i.test(q) || 'Enter a Bluesky handle like name.bsky.social, or a profile link.',
  title: (q) => `@${q}`,
  async fetch(actor, { signal, onProgress, maxPages = 10, days = 365 }) {
    const profile = await getJSON(`${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, { signal }).catch((e) => {
      throw new SourceError(e.status === 400 ? `No Bluesky account @${actor}. Check the handle.` : e.message);
    });
    const posts = [];
    const stopAt = Date.now() - days * DAY;
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ actor: profile.did, limit: '100', filter: 'posts_no_replies' });
      if (cursor) q.set('cursor', cursor);
      const body = await getJSON(`${BSKY}/app.bsky.feed.getAuthorFeed?${q}`, { signal });
      onProgress?.((page + 1) / maxPages, `Reading posts by @${profile.handle}`);
      let oldest = Infinity;
      for (const item of body.feed || []) {
        if (item.reason) continue; // reposts of other people's posts
        const p = item.post;
        if (p.author.did !== profile.did) continue;
        const rec = p.record || {};
        const createdAt = Date.parse(rec.createdAt || p.indexedAt);
        oldest = Math.min(oldest, createdAt);
        const link = rec.embed?.external?.uri || p.embed?.external?.uri || rec.facets?.flatMap((f) => f.features || []).find((f) => f.uri)?.uri;
        const tags = [
          ...(rec.facets || []).flatMap((f) => f.features || []).filter((f) => f.tag).map((f) => `#${f.tag}`),
          ...(rec.tags || []).map((t) => `#${t}`),
        ];
        const embedType = (p.embed?.$type || '').split('.').pop().replace('#view', '');
        posts.push({
          id: p.uri,
          createdAt,
          metrics: { likes: p.likeCount || 0, reposts: p.repostCount || 0, replies: p.replyCount || 0, quotes: p.quoteCount || 0 },
          text: rec.text || '',
          url: `https://bsky.app/profile/${profile.handle}/post/${p.uri.split('/').pop()}`,
          domain: link ? hostOf(link) : { images: 'Image post', video: 'Video post', record: 'Quote post', recordWithMedia: 'Quote post' }[embedType] || 'Text post',
          tags,
        });
      }
      cursor = body.cursor;
      if (!cursor || oldest < stopAt) break;
    }
    return {
      profile: {
        name: profile.displayName || `@${profile.handle}`,
        handle: `@${profile.handle}`,
        url: `https://bsky.app/profile/${profile.handle}`,
        avatar: profile.avatar,
        description: profile.description,
        stats: [
          { label: 'Followers', value: formatCount(profile.followersCount) },
          { label: 'Posts', value: formatCount(profile.postsCount) },
        ],
      },
      posts,
      activity: null,
      notes: [],
      method: 'Each post is scored by its likes, reposts, replies and quotes as Bluesky reports them now. Replies and reposts of other accounts are left out.',
      sourceCredit: { label: 'Bluesky public API', url: 'https://docs.bsky.app/' },
    };
  },
};

/* ---------------------------------------------------------------- Mastodon */
const mastodon = {
  id: 'mastodon',
  label: 'Mastodon',
  noun: 'account or #hashtag',
  prefix: '',
  placeholder: '@Gargron@mastodon.social',
  examples: ['@Gargron@mastodon.social', '@ProPublica@newsie.social', '#photography@mastodon.social', '#gamedev@mastodon.social'],
  metrics: [
    { id: 'engagement', label: 'All interactions' },
    { id: 'favourites', label: 'Favourites' },
    { id: 'boosts', label: 'Boosts' },
    { id: 'replies', label: 'Replies' },
  ],
  defaultMetric: 'engagement',
  normalize: (q) => {
    let s = q.trim();
    const url = s.match(/^https?:\/\/([^/]+)\/@([^/?#]+)/i);
    if (url) s = `@${url[2]}@${url[1]}`;
    const tagUrl = s.match(/^https?:\/\/([^/]+)\/tags\/([^/?#]+)/i);
    if (tagUrl) s = `#${tagUrl[2]}@${tagUrl[1]}`;
    if (s.startsWith('#') && !s.includes('@')) s += '@mastodon.social';
    if (!s.startsWith('#') && !s.startsWith('@')) s = `@${s}`;
    return s;
  },
  validate: (q) => /^[@#][\p{L}\p{N}_.]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(q) || 'Use @user@instance (like @Gargron@mastodon.social) or #tag@instance.',
  title: (q) => q,
  async fetch(query, { signal, onProgress, days = 365 }) {
    const [, kind, name, instance] = query.match(/^([@#])([^@]+)@(.+)$/);
    // Busy hashtags fill 40 posts in minutes, so they get more pages to reach past the first day.
    const maxPages = kind === '#' ? 30 : 20;
    const base = `https://${instance}/api/v1`;
    let profile;
    let path;
    if (kind === '@') {
      const acct = await getJSON(`${base}/accounts/lookup?acct=${encodeURIComponent(name)}`, { signal }).catch((e) => {
        throw new SourceError(e.status === 404 ? `No account ${query}. Use the server the account lives on.` : e.message);
      });
      profile = {
        name: acct.display_name || acct.username,
        handle: `@${acct.username}@${instance}`,
        url: acct.url,
        avatar: acct.avatar_static,
        description: stripHTML(acct.note),
        stats: [
          { label: 'Followers', value: formatCount(acct.followers_count) },
          { label: 'Posts', value: formatCount(acct.statuses_count) },
        ],
      };
      path = `${base}/accounts/${acct.id}/statuses?exclude_reblogs=true&exclude_replies=true&limit=40`;
    } else {
      profile = { name: `#${name}`, handle: `on ${instance}`, url: `https://${instance}/tags/${encodeURIComponent(name)}`, description: `Public posts tagged #${name} as seen from ${instance}.`, stats: [] };
      path = `${base}/timelines/tag/${encodeURIComponent(name)}?limit=40`;
    }
    const posts = [];
    const stopAt = Date.now() - days * DAY;
    let maxId = '';
    for (let page = 0; page < maxPages; page++) {
      const list = await getJSON(path + (maxId ? `&max_id=${maxId}` : ''), { signal });
      onProgress?.((page + 1) / maxPages, `Reading ${query}`);
      if (!list.length) break;
      for (const s of list) {
        posts.push({
          id: s.id,
          createdAt: Date.parse(s.created_at),
          metrics: { favourites: s.favourites_count || 0, boosts: s.reblogs_count || 0, replies: s.replies_count || 0 },
          text: stripHTML(s.content),
          url: s.url || s.uri,
          domain: s.card?.url ? hostOf(s.card.url) : s.media_attachments?.length ? `${s.media_attachments[0].type === 'image' ? 'Image' : 'Media'} post` : 'Text post',
          tags: (s.tags || []).map((t) => `#${t.name.toLowerCase()}`),
          author: s.account?.acct,
        });
      }
      maxId = list[list.length - 1].id;
      if (Date.parse(list[list.length - 1].created_at) < stopAt) break;
    }
    const notes = kind === '#'
      ? [`Counts come from ${instance}. Interactions that happened on other servers may not have reached it, so popular posts can read lower than they are.`]
      : [];
    return {
      profile, posts, activity: null, notes,
      method: 'Each post is scored by favourites, boosts and replies as its server reports them now. Boosts of other accounts and replies are left out.',
      sourceCredit: { label: `${instance} public API`, url: 'https://docs.joinmastodon.org/api/' },
    };
  },
};

/* ------------------------------------------------------------- Hacker News */
const HN = 'https://hn.algolia.com/api/v1';

const hackernews = {
  id: 'hackernews',
  label: 'Hacker News',
  noun: 'feed or user',
  tagNoun: 'post types',
  prefix: '',
  placeholder: 'show',
  examples: ['stories', 'show', 'ask', 'pg', 'dang'],
  metrics: [
    { id: 'engagement', label: 'Points + comments' },
    { id: 'points', label: 'Points' },
    { id: 'comments', label: 'Comments' },
  ],
  defaultMetric: 'points',
  normalize: (q) => q.trim().replace(/^https?:\/\/news\.ycombinator\.com\/user\?id=/i, '').toLowerCase(),
  validate: (q) => /^[a-z0-9_-]{2,20}$/i.test(q) || 'Enter stories, show, ask, or a Hacker News username.',
  title: (q) => ({ stories: 'Hacker News stories', show: 'Show HN', ask: 'Ask HN' }[q] || `HN user ${q}`),
  async fetch(query, { signal, onProgress, days = 30 }) {
    const feeds = { stories: 'story', show: 'show_hn', ask: 'ask_hn' };
    const end = Math.floor(Date.now() / 1000);
    const hits = [];
    if (feeds[query]) {
      // Algolia returns at most 1000 hits per query, so walk the window in slices.
      const slice = query === 'stories' ? 86400 : 7 * 86400;
      const jobs = [];
      let done = 0;
      for (let t = end - days * 86400; t < end; t += slice) {
        const a = t, b = Math.min(end, t + slice);
        jobs.push(async () => {
          const q = new URLSearchParams({ tags: feeds[query], numericFilters: `created_at_i>=${a},created_at_i<${b}`, hitsPerPage: '1000' });
          const body = await getJSON(`${HN}/search_by_date?${q}`, { signal });
          onProgress?.(++done / jobs.length, `Reading ${this.title(query)}`);
          return body.hits || [];
        });
      }
      for (const list of await pool(jobs, 4)) hits.push(...list);
    } else {
      const user = await getJSON(`${HN}/users/${encodeURIComponent(query)}`, { signal }).catch(() => null);
      if (!user) throw new SourceError(`No Hacker News user called ${query}.`);
      for (let page = 0; page < 5; page++) {
        const q = new URLSearchParams({ tags: `story,author_${query}`, hitsPerPage: '1000', page: String(page) });
        const body = await getJSON(`${HN}/search_by_date?${q}`, { signal });
        onProgress?.((page + 1) / 5, `Reading stories by ${query}`);
        hits.push(...(body.hits || []));
        if (page + 1 >= body.nbPages) break;
      }
    }
    const posts = hits.map((h) => ({
      id: h.objectID,
      createdAt: h.created_at_i * 1000,
      metrics: { points: h.points || 0, comments: h.num_comments || 0 },
      title: h.title || h.story_title || '',
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      domain: h.url ? hostOf(h.url) : 'Text post',
      tags: (h._tags || []).filter((t) => t === 'show_hn' || t === 'ask_hn').map((t) => (t === 'show_hn' ? 'Show HN' : 'Ask HN')),
      author: h.author,
    }));
    return {
      profile: {
        name: this.title(query),
        url: feeds[query] ? `https://news.ycombinator.com/${query === 'stories' ? 'newest' : query}` : `https://news.ycombinator.com/user?id=${query}`,
        description: feeds[query] ? `Every ${feeds[query] === 'story' ? 'story' : this.title(query) + ' post'} submitted in the last ${days} days.` : '',
        stats: [{ label: 'Stories', value: formatCount(posts.length) }],
      },
      posts, activity: null, notes: [],
      method: 'Each story is scored by its points (or comments) as Hacker News reports them now.',
      sourceCredit: { label: 'HN Search by Algolia', url: 'https://hn.algolia.com/api' },
    };
  },
};

/* ------------------------------------------------------------------- Lemmy */
const lemmy = {
  id: 'lemmy',
  label: 'Lemmy',
  noun: 'community',
  prefix: '!',
  placeholder: 'technology@lemmy.world',
  examples: ['technology@lemmy.world', 'worldnews@lemmy.world', 'linux@lemmy.ml', 'photography@lemmy.world'],
  metrics: [
    { id: 'engagement', label: 'Score + comments' },
    { id: 'score', label: 'Score' },
    { id: 'comments', label: 'Comments' },
  ],
  defaultMetric: 'engagement',
  normalize: (q) => {
    let s = q.trim().replace(/^!/, '');
    const url = s.match(/^https?:\/\/([^/]+)\/c\/([^/?#@]+)(?:@([^/?#]+))?/i);
    if (url) s = `${url[2]}@${url[3] || url[1]}`;
    return s.toLowerCase();
  },
  validate: (q) => /^[a-z0-9_]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(q) || 'Use community@instance, like technology@lemmy.world.',
  title: (q) => `!${q}`,
  async fetch(query, { signal, onProgress, maxPages = 20, days = 90 }) {
    const [name, instance] = query.split('@');
    const base = `https://${instance}/api/v3`;
    const info = await getJSON(`${base}/community?name=${encodeURIComponent(query)}`, { signal }).catch((e) => {
      throw new SourceError(e.status === 404 || e.status === 400 ? `No community !${query}.` : e.message);
    });
    const c = info.community_view;
    const posts = [];
    const stopAt = Date.now() - days * DAY;
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({ community_name: query, sort: 'New', limit: '50', page: String(page) });
      const body = await getJSON(`${base}/post/list?${q}`, { signal });
      onProgress?.(page / maxPages, `Reading !${query}`);
      const list = body.posts || [];
      if (!list.length) break;
      for (const v of list) {
        posts.push({
          id: String(v.post.id),
          createdAt: Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v.post.published) ? v.post.published : `${v.post.published}Z`),
          metrics: { score: v.counts.score || 0, comments: v.counts.comments || 0 },
          title: v.post.name,
          url: v.post.ap_id || `https://${instance}/post/${v.post.id}`,
          domain: v.post.url ? hostOf(v.post.url) : 'Text post',
          tags: [],
          author: v.creator?.name,
        });
      }
      if (posts[posts.length - 1].createdAt < stopAt) break;
    }
    return {
      profile: {
        name: c.community.title || `!${name}`,
        handle: `!${query}`,
        url: c.community.actor_id,
        avatar: c.community.icon,
        description: (c.community.description || '').split('\n')[0].slice(0, 280),
        stats: [
          { label: 'Subscribers', value: formatCount(c.counts.subscribers) },
          { label: 'Posts', value: formatCount(c.counts.posts) },
        ],
      },
      posts, activity: null,
      notes: [`Counts come from ${instance}; votes cast on other servers may arrive late or not at all.`],
      method: 'Each post is scored by its score and comment count as reported by the community’s server.',
      sourceCredit: { label: `${instance} Lemmy API`, url: 'https://join-lemmy.org/docs/' },
    };
  },
};

/* ------------------------------------------------------ Platform-wide benchmarks */
// Built by the data pipeline (scripts/bluesky-benchmark.mjs): a random sample of every new
// top-level Bluesky post, re-read two days later for its settled counts. Rows are
// [timestampMs, likes, reposts, replies, quotes, languageIndex]; activity rows are
// [timestampMs, totalPosts, ...postsPerLanguage] counted over the sampled minutes.
const LANGUAGE_NAMES = { en: 'English', ja: 'Japanese', pt: 'Portuguese', es: 'Spanish', de: 'German', ko: 'Korean', fr: 'French' };

const benchmark = {
  id: 'benchmark',
  label: 'All of Bluesky',
  noun: 'language',
  prefix: '',
  placeholder: 'all, or a language code like en',
  examples: ['all', 'en', 'ja', 'pt', 'es', 'de'],
  metrics: bluesky.metrics,
  defaultMetric: 'likes',
  normalize: (q) => q.trim().toLowerCase().replace(/^bluesky:?/, '') || 'all',
  validate: (q) => q === 'all' || q in LANGUAGE_NAMES || `Pick all, or one of: ${Object.keys(LANGUAGE_NAMES).join(', ')}.`,
  title: (q) => (q === 'all' ? 'all of Bluesky' : `${LANGUAGE_NAMES[q]} posts on Bluesky`),
  async fetch(lang, { signal, onProgress }) {
    onProgress?.(0.3, 'Loading the Bluesky benchmark');
    let res;
    try {
      res = await fetch('data/bluesky.json', { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      res = null;
    }
    if (!res || !res.ok) throw new SourceError('The Bluesky benchmark isn’t available yet. It is rebuilt every hour by the data pipeline; try again later.');
    const bench = await res.json();
    const li = lang === 'all' ? -1 : bench.langs.indexOf(lang);
    const rows = bench.posts.filter((r) => li === -1 || r[5] === li);
    const act = bench.activity.filter((r) => (li === -1 ? r[1] : r[2 + li]) > 0);
    const days = bench.intervals.length ? (Date.now() - bench.intervals[0][0]) / DAY : 0;
    const sampledHours = bench.intervals.reduce((s, [a, b]) => s + (b - a), 0) / 3600_000;
    const name = lang === 'all' ? 'Bluesky' : `Bluesky (${LANGUAGE_NAMES[lang]})`;
    return {
      profile: {
        name,
        url: 'https://bsky.app/',
        description: `A random sample of new ${lang === 'all' ? '' : `${LANGUAGE_NAMES[lang]} `}top-level posts from across Bluesky, each re-read two days after it went up. Updated every hour.`,
        stats: [{ label: 'Hours sampled', value: sampledHours.toFixed(1) }],
      },
      posts: rows.map(([t, likes, reposts, replies, quotes], i) => ({ id: String(i), createdAt: t, metrics: { likes, reposts, replies, quotes } })),
      activity: {
        timestamps: act.map((r) => r[0]),
        weights: act.map((r) => (li === -1 ? r[1] : r[2 + li])),
        intervals: bench.intervals,
        label: 'new posts per hour',
      },
      minAgeHours: bench.settleHours,
      notes: [
        `Built from ${sampledHours.toFixed(1)} hours of samples over the last ${Math.round(Math.min(days, bench.windowDays))} days, last updated ${new Date(bench.generatedAt).toLocaleString()}.${days < 14 ? ' The benchmark is still filling in, so hours of the week that haven’t been sampled yet are blank.' : ''}`,
        'This compares posts from everyone, so it mostly reflects when engaged audiences are online, not what would work for one account. Analyze your own account for that.',
      ],
      method: 'Every hour, Tidewatch listens to the Bluesky firehose (Jetstream) for five minutes, counts every new top-level post for the activity view, and keeps a random sample of 100. Two days later it re-reads those posts through the public Bluesky API to get their settled likes, reposts, replies and quotes. Posts deleted in the meantime drop out.',
      sourceCredit: { label: 'Bluesky Jetstream and AppView', url: 'https://github.com/bluesky-social/jetstream' },
    };
  },
};

export const SOURCES = { reddit, bluesky, mastodon, hackernews, lemmy, benchmark };
export { SourceError };
