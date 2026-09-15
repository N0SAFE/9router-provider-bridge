import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanUpstreamMessage } from './providerError.js';

test('cleanUpstreamMessage: extracts message from Console Go error envelope', () => {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'AuthError', message: 'Request blocked by upstream provider.' },
  });
  assert.equal(
    cleanUpstreamMessage(body),
    'Request blocked by upstream provider.',
  );
});

test('cleanUpstreamMessage: extracts "not supported" model errors', () => {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'ModelError', message: 'Model minimax-m2-7 not supported' },
  });
  assert.equal(cleanUpstreamMessage(body), 'Model minimax-m2-7 not supported');
});

test('cleanUpstreamMessage: passes plain text through with whitespace collapsed', () => {
  assert.equal(
    cleanUpstreamMessage('  Free usage exceeded,\n  add credits '),
    'Free usage exceeded, add credits',
  );
});

test('cleanUpstreamMessage: falls back for empty input', () => {
  assert.equal(cleanUpstreamMessage(''), 'request rejected by provider');
  assert.equal(cleanUpstreamMessage(undefined), 'request rejected by provider');
});