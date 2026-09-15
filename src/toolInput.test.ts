import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeToolCallInput, normalizeToolName } from './toolInput.js';

test('normalizeToolCallInput: passthrough plain objects', () => {
  const input = { path: '/etc/hostname' };
  assert.deepEqual(normalizeToolCallInput(input), { path: '/etc/hostname' });
});

test('normalizeToolCallInput: parses JSON strings into objects', () => {
  assert.deepEqual(
    normalizeToolCallInput('{"path":"/etc/hostname"}'),
    { path: '/etc/hostname' },
  );
});

test('normalizeToolCallInput: empty string becomes {}', () => {
  assert.deepEqual(normalizeToolCallInput(''), {});
  assert.deepEqual(normalizeToolCallInput('   '), {});
});

test('normalizeToolCallInput: malformed JSON string becomes {}', () => {
  assert.deepEqual(normalizeToolCallInput('{"path":"x}'), {});
});

test('normalizeToolCallInput: JSON string value becomes {}', () => {
  assert.deepEqual(normalizeToolCallInput('"hello"'), {});
  assert.deepEqual(normalizeToolCallInput('42'), {});
});

test('normalizeToolCallInput: arrays become {}', () => {
  assert.deepEqual(normalizeToolCallInput(['a']), {});
  assert.deepEqual(normalizeToolCallInput('["a"]'), {});
});

test('normalizeToolCallInput: null/undefined become {}', () => {
  assert.deepEqual(normalizeToolCallInput(null), {});
  assert.deepEqual(normalizeToolCallInput(undefined), {});
});

test('normalizeToolCallInput: nested valid JSON with whitespace', () => {
  assert.deepEqual(
    normalizeToolCallInput('  {"a": {"b": [1, 2]}}  '),
    { a: { b: [1, 2] } },
  );
});

test('normalizeToolName: leaves short plain names untouched', () => {
  assert.equal(normalizeToolName('list_files'), 'list_files');
  assert.equal(normalizeToolName('vscode_openai_create'), 'vscode_openai_create');
});

test('normalizeToolName: truncates names over 64 chars', () => {
  const long = 'a'.repeat(80);
  const out = normalizeToolName(long);
  assert.equal(out.length, 64);
  assert.equal(out, 'a'.repeat(64));
});

test('normalizeToolName: replaces characters outside [a-zA-Z0-9_-]', () => {
  assert.equal(normalizeToolName('github.pullRequest'), 'github_pullRequest');
  assert.equal(normalizeToolName('server/tool:do'), 'server_tool_do');
  assert.equal(normalizeToolName('espaces à'), 'espaces__');
});

test('normalizeToolName: never returns an empty name', () => {
  assert.equal(normalizeToolName(''), 'tool');
  assert.equal(normalizeToolName('   '), 'tool');
  // Fully non-alphanumeric names become underscores (still a valid name).
  assert.equal(normalizeToolName('!!!'), '___');
});