// Precomputes the Reddit fetch for a list of popular subreddits so the analyzer can show them
// instantly instead of making ~70 archive requests from each visitor's browser.
//
//   node scripts/reddit-snapshots.mjs <data-dir> [--max-age-hours 20] [--budget-minutes 45] [--only a,b]
//
// Writes <data-dir>/public/reddit/<name>.json (the same object SOURCES.reddit.fetch returns, plus
// fetchedAt) and <data-dir>/public/reddit/index.json. Subreddits whose snapshot is younger than
// --max-age-hours are skipped, so the job can run several times a day and only refresh what's due.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SOURCES } from '../site/js/sources.js';
import { identifyRequests, readJSON, argValue, isMain } from './util.mjs';

export const SUBREDDITS_FILE = new URL('./reddit-subreddits.txt', import.meta.url);

export async function loadSubreddits(file = SUBREDDITS_FILE) {
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

/** Which subreddits are due, oldest snapshot first so a short budget still rotates through all. */
export function dueSubreddits(subs, index, now, maxAgeMs) {
  return subs
    .map((name) => ({ name, fetchedAt: index.subs?.[name.toLowerCase()]?.fetchedAt ?? 0 }))
    .filter((s) => now - s.fetchedAt >= maxAgeMs)
    .sort((a, b) => a.fetchedAt - b.fetchedAt)
    .map((s) => s.name);
}

export async function updateRedditSnapshots(dataDir, { subs = null, maxAgeHours = 20, budgetMinutes = 45, log = console.log } = {}) {
  const dir = join(dataDir, 'public', 'reddit');
  await mkdir(dir, { recursive: true });
  const indexPath = join(dir, 'index.json');
  const index = await readJSON(indexPath, { subs: {} });
  const started = Date.now();
  const due = dueSubreddits(subs || await loadSubreddits(), index, started, maxAgeHours * 3600_000);
  log(`Reddit: ${due.length} subreddit(s) due`);
  let ok = 0, failed = 0;
  for (const name of due) {
    if (Date.now() - started > budgetMinutes * 60_000) { log('Reddit: time budget used, the rest wait for the next run'); break; }
    try {
      const result = await SOURCES.reddit.fetch(name, { live: true });
      const fetchedAt = Date.now();
      const key = result.profile.name.replace(/^r\//, '').toLowerCase();
      await writeFile(join(dir, `${key}.json`), JSON.stringify({ version: 1, fetchedAt, ...result }));
      index.subs[key] = { name: result.profile.name, fetchedAt, posts: result.posts.length };
      ok++;
      log(`Reddit: ${result.profile.name} ${result.posts.length} posts in ${Math.round((fetchedAt - started) / 1000)}s total`);
    } catch (err) {
      // Keep the previous snapshot; the archive has short outages and the next run retries.
      failed++;
      log(`Reddit: r/${name} failed: ${err.message}`);
    }
  }
  index.generatedAt = Date.now();
  await writeFile(indexPath, JSON.stringify(index));
  log(`Reddit: ${ok} updated, ${failed} failed`);
  return { ok, failed };
}

if (isMain(import.meta.url)) {
  const dataDir = process.argv[2];
  if (!dataDir) { console.error('usage: node scripts/reddit-snapshots.mjs <data-dir>'); process.exit(2); }
  identifyRequests();
  const { failed, ok } = await updateRedditSnapshots(dataDir, {
    subs: argValue('--only', null)?.split(','),
    maxAgeHours: Number(argValue('--max-age-hours', 20)),
    budgetMinutes: Number(argValue('--budget-minutes', 45)),
  });
  // Fail the step only when nothing worked, so one bad subreddit doesn't block the other data.
  if (failed && !ok) process.exit(1);
}
