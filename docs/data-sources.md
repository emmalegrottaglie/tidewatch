# Getting the data

Research notes from November 2026 on where Tidewatch can get engagement data, what each route
costs, and which ones a static site can use. Each claim marked "tested" was checked with a live
request from a non-GitHub origin; the rest come from documentation or secondary sources and are
linked.

## What works from the browser today (no server, no keys)

| Platform | Route | Tested | Notes |
| --- | --- | --- | --- |
| Reddit | Arctic Shift API | Yes, CORS `*` | Posts are re-read about 36 h after posting, so `score` and `num_comments` are real for posts older than 48 h (r/analog max 3,194, r/dataisbeautiful 9,190 in a 14-day sample). `fields=` accepts only a whitelist. The aggregate endpoint returned all-zero buckets and timed out on large subreddits, so it isn't used. |
| Bluesky | `public.api.bsky.app` | Yes | `getAuthorFeed` (100 per page), `getPosts` takes up to 25 URIs (26 returns 400). `searchPosts` returns 403 without auth. |
| Mastodon | each server's `/api/v1` | Yes | Account statuses and hashtag timelines; counts only reflect what that server has seen. |
| Lemmy | each server's `/api/v3` | Yes | |
| Hacker News | Algolia HN Search | Yes | 1,000 hits per query, so long windows are sliced. |
| YouTube | Data API v3 | CORS yes (origin echoed) | Needs an API key. 10,000 quota units a day per Google Cloud project; a channel's uploads cost about 1 unit per 50 videos. A visitor's own key keeps quota per person. |

Blocked from the browser: reddit.com JSON and RSS (403 "Blocked", no CORS headers), PullPush
(429, asks automated clients to pay), Telegram channel previews (`t.me/s/…` has no CORS header),
Threads, Instagram, TikTok, X and LinkedIn (no public unauthenticated API).

## Running our own analysis (GitHub Actions)

GitHub Actions is free for public repositories and can do what a browser can't: hold API secrets,
reach sites without CORS, run for hours, and commit results as JSON that the static site reads.
Scheduled workflows are paused after 60 days without repository activity, so a workflow that
commits its own output keeps itself alive.

Items 1 and 2 are built: see `.github/workflows/pipeline.yml` and the README's "Data pipeline"
section. The job runs hourly so the Bluesky sample covers every hour of the week; it samples five
minutes per run (about 23 new top-level posts a second were measured in November 2026, so roughly
7,000 per run) and keeps 100 of them to re-read.

1. **Precomputed popular subreddits.** A daily job runs the same analysis for the top few
   hundred subreddits from Arctic Shift and writes `site/data/reddit/<name>.json`. The page shows
   those instantly and falls back to a live fetch for everything else.
2. **Platform-wide benchmarks for Bluesky.** Jetstream (`wss://jetstream2.us-east.bsky.network`,
   tested reachable) streams every new post. A job samples posts for a few hours a day, stores
   their URIs, and two days later re-reads them with `getPosts` (25 per request) to get settled
   like, repost and reply counts. Aggregated by language and hour of the week, that gives a "best
   time to post on Bluesky" page built from measured data rather than a vendor survey. Rate limit
   reported at about 3,000 requests per 5 minutes per IP
   ([secondary source](https://forge.blacksky.community/natespilman.com/skyline/raw/main/README.md)),
   so about 75,000 posts can be re-read in under 10 minutes.
3. **Same idea for Mastodon** using the public streaming or local timelines of a few large
   servers, and for **Hacker News** across a full year.
4. **Telegram public channels** can be read by the job from `t.me/s/<channel>` (view counts are in
   the page), since the browser can't.

## Platforms that need the account owner or a paid provider

- **Reddit official API**: new credentials need manual approval under the Responsible Builder
  Policy, and several sources report new requests closed after 31 October 2026
  ([reduck.ai](https://reduck.ai/use-cases/reddit-bot-rules-ai-agents),
  [bigideasdb](https://bigideasdb.com/reddit-api-shutdown-2027)). Not worth building on.
- **Instagram**: the Graph API's Business Discovery endpoint returns `like_count` and
  `comments_count` for posts of *other* professional accounts, but it needs your own Instagram
  professional account and a Meta app token
  ([docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery)).
  Workable as a bring-your-own-token option.
- **X, TikTok, LinkedIn, Facebook, Threads**: analytics exports (already supported by the
  importer), or a paid data provider. Bright Data's CLI (`bdata`, installed) has pre-built
  scrapers for these sites, billed per record; it would run in a GitHub Action with an API key
  stored as a repository secret, never in the browser.

## Recommended order

1. ~~Daily precomputed subreddit snapshots~~ (done).
2. ~~Bluesky benchmark pipeline~~ (done).
3. YouTube with a bring-your-own key (small, browser-only).
4. Mastodon benchmark from a few large servers' public timelines.
5. Optional paid connectors only if someone funds the API key.
