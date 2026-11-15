// Live smoke test against the real public APIs (needs network).
// Run: node tests/sources.live.mjs [sourceId query]
import { SOURCES } from '../site/js/sources.js';
import { analyze, DAYS, hourLabel } from '../site/js/analysis.js';

const cases = process.argv[2]
  ? [[process.argv[2], process.argv[3]]]
  : [['bluesky', 'bsky.app'], ['mastodon', '@Gargron@mastodon.social'], ['mastodon', '#photography@mastodon.social'], ['hackernews', 'show'], ['hackernews', 'pg'], ['lemmy', 'technology@lemmy.world'], ['reddit', 'photography']];

let failed = 0;
for (const [id, raw] of cases) {
  const src = SOURCES[id];
  const q = src.normalize(raw);
  const t0 = Date.now();
  try {
    const ok = src.validate(q);
    if (ok !== true) throw new Error(`validate: ${ok}`);
    const data = await src.fetch(q, { onProgress: () => {} });
    const r = analyze(data, { timeZone: 'UTC', metric: src.defaultMetric });
    const top = r.top[0];
    const sample = data.posts[0];
    console.log(`OK ${id} ${q}: ${data.posts.length} posts, ${r.counts.eligible} scored, basis=${r.basis}, best=${top ? `${DAYS[top.day]} ${hourLabel(top.hour)} (${top.score.toFixed(2)})` : 'none'}, activity=${data.activity ? data.activity.timestamps.length : 0}, ${Date.now() - t0}ms`);
    console.log('   sample:', JSON.stringify({ ...sample, text: (sample?.text || '').slice(0, 60) }).slice(0, 300));
    console.log('   profile:', JSON.stringify(data.profile.stats), data.notes.join(' | '));
    if (!data.posts.length) throw new Error('no posts');
  } catch (e) {
    failed++;
    console.log(`FAIL ${id} ${q}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
