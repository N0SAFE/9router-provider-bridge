import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_TURN_FALLBACK_TEXT,
  isEmptyTurn,
  MAX_TURNS,
  runWithEmptyTurnRetry,
} from './turnGuard.js';

test('isEmptyTurn flags turns with no text and no tool calls', () => {
  assert.equal(isEmptyTurn({ hasText: false, hasToolCall: false }), true);
  assert.equal(isEmptyTurn({ hasText: true, hasToolCall: false }), false);
  assert.equal(isEmptyTurn({ hasText: false, hasToolCall: true }), false);
  assert.equal(isEmptyTurn({ hasText: true, hasToolCall: true }), false);
});

test('runWithEmptyTurnRetry retries an empty turn once and returns the good attempt', async () => {
  const calls: number[] = [];
  const { result, attempts } = await runWithEmptyTurnRetry(async (attempt) => {
    calls.push(attempt);
    return attempt === 1
      ? { hasText: false, hasToolCall: false }
      : { hasText: true, hasToolCall: false };
  }, (attempt) => calls.push(-attempt));
  assert.deepEqual(calls, [1, -1, 2]);
  assert.equal(attempts, 2);
  assert.equal(result.hasText, true);
  assert.equal(result.hasToolCall, false);
});

test('runWithEmptyTurnRetry does not retry a non-empty turn', async () => {
  const calls: number[] = [];
  const { attempts } = await runWithEmptyTurnRetry(async (attempt) => {
    calls.push(attempt);
    return { hasText: true, hasToolCall: false };
  });
  assert.deepEqual(calls, [1]);
  assert.equal(attempts, 1);
});

test('runWithEmptyTurnRetry gives up after MAX_TURNS empty attempts', async () => {
  const calls: number[] = [];
  const { result, attempts } = await runWithEmptyTurnRetry(async (attempt) => {
    calls.push(attempt);
    return { hasText: false, hasToolCall: false };
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(attempts, MAX_TURNS);
  assert.equal(isEmptyTurn(result), true);
});

test('runWithEmptyTurnRetry propagates errors without retrying', async () => {
  const calls: number[] = [];
  await assert.rejects(
    runWithEmptyTurnRetry(async (attempt) => {
      calls.push(attempt);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(calls, [1]);
});

test('fallback text is non-empty', () => {
  assert.ok(EMPTY_TURN_FALLBACK_TEXT.trim().length > 0);
});