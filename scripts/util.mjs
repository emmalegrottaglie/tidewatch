import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

/** Read a JSON file, or return `fallback` when it doesn't exist yet. */
export async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Value of a `--name value` command-line flag. */
export function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/**
 * Tell the APIs who is calling. Browsers set their own User-Agent, but Node's default ("node")
 * gives an archive operator no way to see where a burst of requests comes from.
 */
export function identifyRequests() {
  const base = globalThis.fetch;
  const agent = `Tidewatch-pipeline/1 (+https://github.com/${process.env.GITHUB_REPOSITORY || 'emmalegrottaglie/tidewatch'})`;
  globalThis.fetch = (url, opts = {}) => base(url, { ...opts, headers: { ...(opts.headers || {}), 'User-Agent': agent } });
}

/** True when the module at `url` is the script Node was started with (not imported by a test). */
export function isMain(url) {
  return Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;
}
