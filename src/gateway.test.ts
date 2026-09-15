import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findGroupApiKey,
  findGroupBaseUrl,
  findGroupMode,
  findGroupModels,
  findGroupProvider,
  lookupGroupApiKey,
  lookupGroupBaseUrl,
  lookupGroupMode,
  lookupGroupModels,
  lookupGroupProvider,
  normalizeGatewayUrl,
  parseGroupsConfig,
  readVendorGroups,
  resolveGroup,
  updateGroupModels,
} from './gateway.js';

test('normalizeGatewayUrl: trims whitespace and trailing slashes', () => {
  assert.equal(normalizeGatewayUrl('  http://127.0.0.1:20128/v1///  '), 'http://127.0.0.1:20128/v1');
});

test('normalizeGatewayUrl: empty/invalid values become empty string', () => {
  assert.equal(normalizeGatewayUrl(''), '');
  assert.equal(normalizeGatewayUrl('   '), '');
  assert.equal(normalizeGatewayUrl(undefined), '');
  assert.equal(normalizeGatewayUrl(42), '');
});

test('parseGroupsConfig: parses a JSON array of groups', () => {
  const groups = parseGroupsConfig(JSON.stringify([
    { name: '9Router', vendor: 'v', apiKey: 'k', baseUrl: 'http://127.0.0.1:20128/v1' },
  ]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, '9Router');
});

test('parseGroupsConfig: tolerates comments and trailing commas, else returns []', () => {
  const raw = `[
    // first group
    { "name": "a", "baseUrl": "http://a/v1", },
  ]`;
  const groups = parseGroupsConfig(raw);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'a');
  assert.deepEqual(parseGroupsConfig('not json'), []);
});

test('findGroupBaseUrl: matches by name and normalizes the URL', () => {
  const groups = [{ name: 'a', baseUrl: 'http://a/v1/' }, { name: 'b', baseUrl: '' }];
  assert.equal(findGroupBaseUrl(groups, 'a'), 'http://a/v1');
  assert.equal(findGroupBaseUrl(groups, 'b'), '');
  assert.equal(findGroupBaseUrl(groups, 'missing'), '');
});

test('findGroupBaseUrl: matches by raw apiKey when name is not forwarded', () => {
  const groups = [
    { name: 'direct', apiKey: 'sk-direct', baseUrl: '' },
    { name: '9Router', apiKey: 'sk-9router', baseUrl: 'http://127.0.0.1:20128/v1' },
  ];
  assert.equal(findGroupBaseUrl(groups, undefined, 'sk-9router'), 'http://127.0.0.1:20128/v1');
  assert.equal(findGroupBaseUrl(groups, undefined, 'sk-direct'), '');
  assert.equal(findGroupBaseUrl([{ apiKey: '${input:chat.lm.secret.abc}', baseUrl: 'http://x/v1' }], undefined, '${input:chat.lm.secret.abc}'), '');
});

test('findGroupApiKey: recovers a raw key by name or baseUrl, skips secrets', () => {
  const groups = [
    { name: 'secret group', apiKey: '${input:chat.lm.secret.abc}', baseUrl: 'http://secret/v1' },
    { name: '9Router', apiKey: 'sk-9router', baseUrl: 'http://127.0.0.1:20128/v1' },
  ];
  assert.equal(findGroupApiKey(groups, { name: '9Router' }), 'sk-9router');
  assert.equal(findGroupApiKey(groups, { baseUrl: 'http://127.0.0.1:20128/v1/' }), 'sk-9router');
  assert.equal(findGroupApiKey(groups, { name: 'secret group' }), '');
  assert.equal(findGroupApiKey(groups, { baseUrl: 'http://secret/v1' }), '');
  assert.equal(findGroupApiKey(groups, {}), '');
});

test('findGroupMode: resolves the group mode by name, then raw apiKey', () => {
  const groups = [
    { name: '9Router', apiKey: 'sk-a', mode: 'providers' },
    { name: '9Router combos', apiKey: 'sk-b', mode: 'combos' },
    { name: 'plain', apiKey: 'sk-c' },
  ];
  assert.equal(findGroupMode(groups, { name: '9Router' }), 'providers');
  assert.equal(findGroupMode(groups, { name: '9Router combos' }), 'combos');
  assert.equal(findGroupMode(groups, { name: 'plain' }), 'all');
  assert.equal(findGroupMode(groups, { apiKey: 'sk-b' }), 'combos');
  assert.equal(findGroupMode(groups, {}), 'all');
});

test('lookupGroupBaseUrl / lookupGroupApiKey: read the group from chatLanguageModels.json files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-gateway-'));
  const first = join(dir, 'missing.json');
  const second = join(dir, 'chatLanguageModels.json');
  try {
    writeFileSync(second, JSON.stringify([
      { name: '9Router direct', vendor: 'v', apiKey: 'sk-direct' },
      { name: '9Router', vendor: 'v', apiKey: 'sk-9router', baseUrl: 'http://127.0.0.1:20128/v1', mode: 'combos' },
    ]));
    assert.equal(lookupGroupBaseUrl('9Router', undefined, [first, second]), 'http://127.0.0.1:20128/v1');
    assert.equal(lookupGroupBaseUrl('9Router direct', undefined, [first, second]), '');
    assert.equal(lookupGroupBaseUrl(undefined, 'sk-9router', [first, second]), 'http://127.0.0.1:20128/v1');
    assert.equal(lookupGroupApiKey({ name: '9Router' }, [second]), 'sk-9router');
    assert.equal(lookupGroupApiKey({ baseUrl: 'http://127.0.0.1:20128/v1' }, [second]), 'sk-9router');
    assert.equal(lookupGroupMode({ name: '9Router' }, [second]), 'combos');
    assert.equal(lookupGroupMode({ name: '9Router direct' }, [second]), 'all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveGroup: forwarded values win over the file lookup', () => {
  const group = resolveGroup(
    { baseUrl: 'http://forwarded/v1/', mode: 'pools', groupName: '9Router', apiKey: 'sk-x' },
    'http://default/v1'
  );
  assert.deepEqual(group, {
    name: '9Router',
    baseUrl: 'http://forwarded/v1',
    apiKey: 'sk-x',
    mode: 'pools',
    models: [],
    provider: undefined,
  });
});

test('resolveGroup: falls back to the provided default base URL', () => {
  const group = resolveGroup({}, 'http://127.0.0.1:20128/v1/');
  assert.equal(group.baseUrl, 'http://127.0.0.1:20128/v1');
  assert.equal(group.mode, 'all');
  assert.equal(group.apiKey, '');
});

test('readVendorGroups: filters by vendor and normalizes fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-gateway-'));
  const file = join(dir, 'chatLanguageModels.json');
  try {
    writeFileSync(file, JSON.stringify([
      {
        name: '9Router',
        vendor: '9router-provider-bridge',
        baseUrl: 'http://127.0.0.1:20128/v1/',
        mode: 'providers',
        provider: 'ocg',
        models: ['ocg/kimi-k2.7-code', 42],
      },
      { name: 'combos', vendor: '9router-provider-bridge', apiKey: 'sk-raw', mode: 'combos' },
      { name: 'other', vendor: 'opencode-provider-bridge', baseUrl: 'http://other/v1' },
      { name: 'secret', vendor: '9router-provider-bridge', apiKey: '${input:chat.lm.secret.x}' },
    ]));
    const groups = readVendorGroups('9router-provider-bridge', [file]);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0], {
      name: '9Router',
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: '',
      mode: 'providers',
      models: ['ocg/kimi-k2.7-code'],
      provider: 'ocg',
    });
    assert.deepEqual(groups[1], {
      name: 'combos',
      baseUrl: '',
      apiKey: 'sk-raw',
      mode: 'combos',
      models: [],
      provider: undefined,
    });
    // ${input:...} placeholders are never treated as concrete keys.
    assert.equal(groups[2].apiKey, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findGroupModels / findGroupProvider: resolve by name, then raw apiKey', () => {
  const groups = [
    { name: 'providers', apiKey: 'sk-a', models: ['a', 'b'], provider: 'ocg' },
    { name: 'combos', apiKey: 'sk-b', models: ['*'] },
  ];
  assert.deepEqual(findGroupModels(groups, { name: 'providers' }), ['a', 'b']);
  assert.deepEqual(findGroupModels(groups, { apiKey: 'sk-b' }), ['*']);
  assert.deepEqual(findGroupModels(groups, {}), []);
  assert.equal(findGroupProvider(groups, { name: 'providers' }), 'ocg');
  assert.equal(findGroupProvider(groups, { apiKey: 'sk-a' }), 'ocg');
  assert.equal(findGroupProvider(groups, {}), '');
});

test('lookupGroupModels / lookupGroupProvider: read from chatLanguageModels.json files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-gateway-'));
  const file = join(dir, 'chatLanguageModels.json');
  try {
    writeFileSync(file, JSON.stringify([
      { name: '9Router', vendor: 'v', apiKey: 'sk-9router', models: ['ocg/x'], provider: 'ocg' },
    ]));
    assert.deepEqual(lookupGroupModels({ name: '9Router' }, [file]), ['ocg/x']);
    assert.equal(lookupGroupProvider({ name: '9Router' }, [file]), 'ocg');
    assert.deepEqual(lookupGroupModels({ name: 'missing' }, [file]), []);
    assert.equal(lookupGroupProvider({ name: 'missing' }, [file]), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveGroup: forwarded models/provider pass through', () => {
  const group = resolveGroup(
    { groupName: 'g', models: ['a', 42, 'b'], provider: 'ocg' },
    'http://x/v1'
  );
  assert.deepEqual(group.models, ['a', 'b']);
  assert.equal(group.provider, 'ocg');
});

test('updateGroupModels: persists the allowlist into the matching group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-gateway-'));
  const file = join(dir, 'chatLanguageModels.json');
  try {
    writeFileSync(file, JSON.stringify([
      { name: '9Router Providers', vendor: 'v', models: ['old'], baseUrl: 'http://x/v1' },
      { name: '9Router Combos', vendor: 'v', baseUrl: 'http://y/v1' },
      { name: 'other', vendor: 'other-vendor' },
    ]));

    assert.equal(
      updateGroupModels({ vendor: 'v', name: '9Router Providers' }, ['new-1', 'new-2'], [file]),
      true
    );
    let groups = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(groups[0].models, ['new-1', 'new-2']);
    assert.equal(groups[1].models, undefined);

    // Falls back to baseUrl matching when the group name is not known.
    assert.equal(
      updateGroupModels({ vendor: 'v', baseUrl: 'http://y/v1/' }, ['combo-1'], [file]),
      true
    );
    groups = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(groups[1].models, ['combo-1']);

    assert.equal(updateGroupModels({ vendor: 'v', name: 'missing' }, ['x'], [file]), false);
    assert.equal(updateGroupModels({ vendor: '', name: '9Router Providers' }, ['x'], [file]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
