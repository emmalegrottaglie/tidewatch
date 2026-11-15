import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, parseDate, wallToUTC, detectColumns, rowsToPosts, readFile } from '../site/js/importer.js';

test('parseCSV handles quotes, escaped quotes, newlines in fields and semicolons', () => {
  assert.deepEqual(parseCSV('a,b\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.deepEqual(parseCSV('a;b;c\r\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseCSV('t,n\n"line1\nline2",5'), [['t', 'n'], ['line1\nline2', '5']]);
});

test('wallToUTC converts wall time across DST', () => {
  // 2026-07-01 12:00 in New York (EDT, UTC-4) is 16:00 UTC.
  assert.equal(wallToUTC(2026, 7, 1, 12, 0, 0, 'America/New_York'), Date.UTC(2026, 6, 1, 16));
  // 2026-12-01 12:00 in New York (EST, UTC-5) is 17:00 UTC.
  assert.equal(wallToUTC(2026, 12, 1, 12, 0, 0, 'America/New_York'), Date.UTC(2026, 11, 1, 17));
  assert.equal(wallToUTC(2026, 3, 5, 9, 30, 0, 'UTC'), Date.UTC(2026, 2, 5, 9, 30));
});

test('parseDate reads ISO, offsets, epochs, slash dates and X archive dates', () => {
  assert.equal(parseDate('2026-11-15T14:05:00Z'), Date.UTC(2026, 10, 15, 14, 5));
  assert.equal(parseDate('2026-11-15T14:05:00+0200'), Date.UTC(2026, 10, 15, 12, 5));
  assert.equal(parseDate('2026-11-15 14:05', { timeZone: 'UTC' }), Date.UTC(2026, 10, 15, 14, 5));
  assert.equal(parseDate('1794742560'), 1794742560000);
  assert.equal(parseDate(1794742560000), 1794742560000);
  assert.equal(parseDate('11/15/2026 2:05 PM', { timeZone: 'UTC' }), Date.UTC(2026, 10, 15, 14, 5));
  assert.equal(parseDate('15/11/2026 14:05', { timeZone: 'UTC', order: 'dmy' }), Date.UTC(2026, 10, 15, 14, 5));
  assert.equal(parseDate('Wed Oct 10 20:19:24 +0000 2018'), Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.ok(Number.isNaN(parseDate('not a date')));
});

test('detectColumns finds date, metrics and text in a typical analytics export', () => {
  const headers = ['Post ID', 'Publish time', 'Description', 'Reactions', 'Comments', 'Shares', 'Impressions', 'Permalink'];
  const rows = [
    ['1', '11/02/2026 09:15', 'Hello #launch', '120', '4', '2', '3,400', 'https://example.com/p/1'],
    ['2', '11/14/2026 18:40', 'Second post', '80', '1', '0', '2100', 'https://example.com/p/2'],
  ];
  const m = detectColumns(headers, rows);
  assert.equal(m.date, 1);
  assert.equal(m.text, 2);
  assert.equal(m.url, 7);
  assert.deepEqual(m.metrics, { likes: 3, comments: 4, shares: 5, views: 6 });
  const posts = rowsToPosts(headers, rows, m, 'UTC');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].createdAt, Date.UTC(2026, 10, 2, 9, 15));
  assert.equal(posts[0].metrics.views, 3400);
  assert.deepEqual(posts[0].tags, ['#launch']);
  assert.equal(posts[1].domain, 'example.com');
});

test('readFile recognizes an X archive and skips retweets and replies', () => {
  const text = 'window.YTD.tweets.part0 = ' + JSON.stringify([
    { tweet: { id_str: '1', created_at: 'Wed Oct 10 20:19:24 +0000 2018', favorite_count: '5', retweet_count: '2', full_text: 'hi #a', entities: { hashtags: [{ text: 'A' }], urls: [] } } },
    { tweet: { id_str: '2', created_at: 'Wed Oct 10 21:19:24 +0000 2018', favorite_count: '0', retweet_count: '0', full_text: 'RT @x: copy', entities: {} } },
    { tweet: { id_str: '3', created_at: 'Wed Oct 10 22:19:24 +0000 2018', favorite_count: '1', retweet_count: '0', full_text: '@y reply', in_reply_to_status_id_str: '9', entities: {} } },
  ]);
  const r = readFile('tweets.js', text);
  assert.equal(r.kind, 'X archive');
  assert.equal(r.posts.length, 1);
  assert.deepEqual(r.posts[0].metrics, { likes: 5, reposts: 2 });
  assert.deepEqual(r.posts[0].tags, ['#a']);
});

test('readFile recognizes a saved Reddit listing', () => {
  const listing = { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'a', created_utc: 1794700000, score: 250, num_comments: 12, title: 'T', permalink: '/r/x/comments/a/t/', is_self: false, domain: 'i.redd.it', subreddit: 'x', link_flair_text: 'OC' } }] } };
  const r = readFile('top.json', JSON.stringify(listing));
  assert.equal(r.kind, 'Reddit listing');
  assert.equal(r.profileName, 'r/x');
  assert.deepEqual(r.posts[0].metrics, { upvotes: 250, comments: 12 });
});

test('readFile skips a title line above the CSV header', () => {
  const r = readFile('export.csv', 'My page export\nDate,Likes,Comments,Text\n2026-11-01 10:00,5,1,hello\n');
  assert.deepEqual(r.table.headers, ['Date', 'Likes', 'Comments', 'Text']);
  assert.equal(r.mapping.date, 0);
});
