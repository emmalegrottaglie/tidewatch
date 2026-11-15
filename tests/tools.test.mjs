import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xWeightedLength, mastodonLength, graphemes, buildUTM, STYLES } from '../site/js/tools.js';

test('X weighted length follows twitter-text v3', () => {
  assert.equal(xWeightedLength('hello'), 5);
  assert.equal(xWeightedLength('a'.repeat(280)), 280);
  // Any URL counts 23 regardless of length.
  assert.equal(xWeightedLength('see https://example.com/a/very/long/path?with=query'), 4 + 23);
  // Emoji count 2, including ZWJ sequences and skin tones.
  assert.equal(xWeightedLength('👍'), 2);
  assert.equal(xWeightedLength('👍🏽'), 2);
  assert.equal(xWeightedLength('👩‍👩‍👧'), 2);
  // CJK counts 2 per character.
  assert.equal(xWeightedLength('日本'), 4);
  // General punctuation in the light range (en dash U+2013) counts 1.
  assert.equal(xWeightedLength('–'), 1);
});

test('graphemes count emoji sequences once (Bluesky)', () => {
  assert.equal(graphemes('👩‍👩‍👧 ok').length, 4);
});

test('Mastodon counts links as 23 and remote mentions by username', () => {
  assert.equal(mastodonLength('hi @alice@example.social https://x.org/long'), 'hi @alice '.length + 23);
});

test('buildUTM sets and removes parameters and rejects bad input', () => {
  assert.equal(buildUTM('https://example.com/p?x=1', { utm_source: 'reddit', utm_medium: 'social', utm_campaign: '' }).url, 'https://example.com/p?x=1&utm_source=reddit&utm_medium=social');
  assert.ok(buildUTM('example.com', {}).error);
  assert.ok(buildUTM('javascript:alert(1)', {}).error);
});

test('font styles map letters including Letterlike exceptions', () => {
  const style = (n) => STYLES.find((s) => s.name === n).fn;
  assert.equal(style('Bold')('Ab1'), '𝐀𝐛𝟏');
  assert.equal(style('Italic')('h'), 'ℎ');
  assert.equal(style('Double-struck')('RZ'), 'ℝℤ');
  assert.equal(style('Fraktur')('C'), 'ℭ');
  assert.equal(style('Small caps')('Hi!'), 'ʜɪ!');
});
