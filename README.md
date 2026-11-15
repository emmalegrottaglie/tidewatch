# Tidewatch

Find the best time to post in any community or on any account. Tidewatch reads recent posts from a
subreddit, a Bluesky or Mastodon account, a Mastodon hashtag, a Lemmy community or Hacker News, works
out which hours of the week those posts did best, and shows it as a heatmap, hourly and daily
charts, ranked recommendations, top sites, flair or hashtags, common phrases and top posts.

It is a free, open-source alternative to hosted "best time to post" tools. There is no server: the
site is static HTML, CSS and JavaScript, requests go from your browser straight to the platform's
public API, and nothing is stored or tracked. A scheduled GitHub Actions job adds what a browser
can't do on its own: a platform-wide Bluesky benchmark and daily snapshots of popular subreddits
(see [Data pipeline](#data-pipeline)).

**Live site:** https://emmalegrottaglie.github.io/tidewatch/

## What it can analyze

| Platform | Input | Data source | Score |
| --- | --- | --- | --- |
| Reddit | `photography` | [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift) archive, last 28 days | Upvotes and comments |
| Bluesky | `name.bsky.social` or a profile link | `public.api.bsky.app` | Likes, reposts, replies, quotes |
| Mastodon | `@user@server` or `#tag@server` | The account's own server | Favourites, boosts, replies |
| Lemmy | `community@server` | The community's server | Score and comments |
| Hacker News | `stories`, `show`, `ask` or a username | HN Search by Algolia | Points and comments |
| All of Bluesky | `all` or a language code (`en`, `ja`, `pt`, `es`, `de`, `ko`, `fr`) | The data pipeline's Bluesky benchmark | Likes, reposts, replies, quotes |
| Anything else | CSV or JSON export | Your file, read locally | Any number columns in it |

The importer recognizes an X/Twitter archive (`data/tweets.js`), a Reddit listing saved from a
signed-in browser (`top.json`), and analytics CSVs from Meta Business Suite, TikTok Studio,
LinkedIn, YouTube Studio and similar tools. Columns are detected automatically and can be changed
before analyzing.

### Why Reddit goes through an archive

reddit.com refuses requests from signed-out browsers (HTTP 403, no CORS headers), so a static site
can't read it directly. Arctic Shift captures each post seconds after it appears and fetches it again
about 36 hours later, updating its score and comment count. Tidewatch only scores posts older than 48
hours, so the numbers come from that second fetch. For very busy subreddits it reads one page of posts
every two hours across four weeks instead of everything, and the results page says so.

## How the scoring works

1. Posts younger than 24 hours (48 on Reddit) are excluded; they are still collecting interactions.
2. Each post gets its percentile rank among all posts read (the share of posts it beat, ties split),
   which is graded but bounded and indifferent to how skewed the platform's numbers are.
3. Ranks and counts are summed for each of the 168 hours of the week, in the chosen time zone, and
   smoothed with neighbouring hours.
4. Each hour's score is the mean rank, shrunk toward 50% by three imaginary average posts. 50% is a
   typical hour; 65% means posts published then beat 65% of the others on average.

The full explanation is on the site's [How it works](site/method.html) page, and the code is in
[`site/js/analysis.js`](site/js/analysis.js).

## Data pipeline

`.github/workflows/pipeline.yml` runs every hour:

1. **Bluesky benchmark** ([`scripts/bluesky-benchmark.mjs`](scripts/bluesky-benchmark.mjs)). Listens to
   [Jetstream](https://github.com/bluesky-social/jetstream) for five minutes, counts every new
   top-level post per minute and language, and keeps a uniform random sample of 100. Two days later
   it re-reads the sampled posts with `app.bsky.feed.getPosts` (25 per request) to get their settled
   counts. Because the job runs hourly, every hour of the week gets sampled on several days. The
   last 28 days are published as `data/bluesky.json` and shown under **All of Bluesky** on the
   analyzer, using the same scoring as everything else.
2. **Reddit snapshots** ([`scripts/reddit-snapshots.mjs`](scripts/reddit-snapshots.mjs)). Refreshes
   any subreddit in [`scripts/reddit-subreddits.txt`](scripts/reddit-subreddits.txt) whose snapshot is
   older than 20 hours, using the same code the browser runs. The analyzer loads a snapshot when one
   exists and is under three days old, and offers to read the subreddit live instead.

Results are force-pushed to the `data` branch as a single commit (so history doesn't grow), and
the Pages workflow copies its `public/` folder into the site as `data/`. The `state/` folder (posts
waiting to be re-read) is only used by the pipeline.

Run the steps locally into any folder:

```sh
node scripts/bluesky-benchmark.mjs ./data --sample-minutes 1
node scripts/reddit-snapshots.mjs ./data --only analog
```

Copy `./data/public` to `site/data` to see the results in a local server.

## Other tools

The [Tools](site/tools.html) page has a character counter that checks a post against 13 platform
limits at once (X uses the weighted rules from
[twitter-text v3](https://github.com/twitter/twitter-text/blob/master/config/v3.json); Bluesky counts
graphemes), a UTM link builder and Unicode font styles.

Limits used, checked November 2026: X 280 (weighted), Bluesky 300 graphemes, Threads 500, Mastodon
500 (server default), Reddit title 300, Instagram caption 2,200, TikTok caption 4,000 in the app
(2,200 through the posting API), LinkedIn post 3,000, Facebook 63,206, YouTube title 100 and
description 5,000, Pinterest title 100 and description 800.

## Running it locally

No build step and no dependencies.

```sh
npm start          # serves site/ on http://localhost:8765
npm test           # unit tests (Node 22+ for the pipeline scripts, which use the built-in WebSocket)
npm run test:live  # hits the real APIs once per source
```

Any static file server works; the site must be served over HTTP rather than opened as a file,
because it uses ES modules.

## Deploying

`.github/workflows/pages.yml` runs the tests and publishes `site/` (plus the pipeline's data) to
GitHub Pages on every push to `main` and after every pipeline run. To use it in a fork, set
**Settings → Pages → Source** to **GitHub Actions**, then run **Data pipeline** once from the
Actions tab to create the `data` branch. Scheduled workflows don't run in forks until you enable
them.

## Project layout

```
site/
  index.html, tools.html, method.html
  css/main.css          design tokens, layout, motion
  js/analysis.js        scoring (pure, tested)
  js/sources.js         one adapter per platform
  js/importer.js        CSV/JSON/X archive/Reddit listing import
  js/charts.js          heatmap, hourly area chart, daily bars
  js/app.js             analyzer page
  js/tools.js           counters, UTM builder, font styles
scripts/                data pipeline (Bluesky benchmark, Reddit snapshots)
tests/                  node --test suites and a live smoke test
```

## Credits

Data from Arctic Shift, the Bluesky AppView and Jetstream, Mastodon and Lemmy servers, and HN Search
by Algolia.
Fonts: Big Shoulders Display and IBM Plex Sans (SIL Open Font License), served by Google Fonts.

## License

MIT. See [LICENSE](LICENSE).
