import assert from 'node:assert/strict';
import test from 'node:test';
import {
  palestineLocalFromUtc,
  palestineLocalToUtc,
  palestineMonthBounds,
  palestineMonthKey,
} from '../lib/palestine-time.js';

test('converts Palestine wall time to UTC and back across winter and summer', () => {
  for (const localValue of ['2026-01-01T00:30', '2026-06-01T00:30']) {
    const utcValue = palestineLocalToUtc(localValue);
    assert.equal(palestineLocalFromUtc(utcValue), localValue);
  }
});

test('assigns dates near UTC midnight to the correct Palestine month', () => {
  assert.equal(palestineMonthKey('2026-12-31T22:30:00.000Z'), '2027-01');
  assert.equal(palestineMonthKey('2026-05-31T21:30:00.000Z'), '2026-06');
});

test('returns monthly UTC ranges that begin and end at Palestine midnight', () => {
  const bounds = palestineMonthBounds('2026-06');
  assert.equal(palestineLocalFromUtc(bounds.start), '2026-06-01T00:00');
  assert.equal(palestineLocalFromUtc(bounds.end), '2026-07-01T00:00');
});