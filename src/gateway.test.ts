import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findGroupApiKey,
  findGroupBaseUrl,
  findGroupMode,
  hasGroupConfiguration,
  lookupGroupApiKey,
  lookupGroupBaseUrl,
  lookupGroupMode,
  normalizeGatewayUrl,
  parseGroupsConfig,
  readVendorGroups,
  resolveGroup,
  updateGroupConfig,
} from './gateway.js';

test('hasGroupConfiguration: only non-empty group objects pass the gate', () => {
  assert.equal(hasGroupConfiguration(undefined), false);
  assert.equal(hasGroupConfiguration(null), false);
  assert.equal(hasGroupConfiguration('x'), false);
  assert.equal(hasGroupConfiguration([]), false);
  assert.equal(hasGroupConfiguration({}), false);
  assert.equal(hasGroupConfiguration({ baseUrl: 'http://127.0.0.1:20128/v1' }), true);
});

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
    providers: [],
    models: [],
  });
});

test('resolveGroup: falls back to the provided default base URL', () => {
  const group = resolveGroup({}, 'http://127.0.0.1:20128/v1/');
  assert.equal(group.baseUrl, 'http://127.0.0.1:20128/v1');
  assert.equal(group.mode, 'all');
  assert.equal(group.apiKey, '');
  assert.deepEqual(group.providers, []);
  assert.deepEqual(group.models, []);
});

test('resolveGroup: forwarded filters win, stored filters are recovered otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-gateway-'));
  const file = join(dir, 'chatLanguageModels.json');
  try {
    writeFileSync(file, JSON.stringify([
      {
        name: '9Router',
        vendor: '9router-provider-bridge',
        providers: ['ocg', 'oc'],
        models: ['ocg/kimi-k2.7-code'],
      },
    ]));

    const forwarded = resolveGroup(
      { groupName: '9Router', providers: ['ollama'], models: [] },
      '',
      [file]
    );
    assert.deepEqual(forwarded.providers, ['ollama']);
    assert.deepEqual(forwarded.models, []);

    const stored = resolveGroup({ groupName: '9Router' }, '', [file]);
    assert.deepEqual(stored.providers, ['ocg', 'oc']);
    assert.deepEqual(stored.models, ['ocg/kimi-k2.7-code']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateGroupConfig: persists mode and filters, clears empty filters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-gateway-'));
  const file = join(dir, 'chatLanguageModels.json');
  try {
    writeFileSync(file, JSON.stringify([
      { name: '9Router', vendor: '9router-provider-bridge', baseUrl: 'http://127.0.0.1:20128/v1' },
      { name: 'other', vendor: 'other-vendor' },
    ]));

    assert.equal(
      updateGroupConfig(
        { vendor: '9router-provider-bridge', name: '9Router' },
        { mode: 'combos', providers: ['oc', 'ocg'], models: ['free', 'ocg/kimi-k2.7-code'] },
        [file]
      ),
      true
    );
    let groups = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(groups[0].mode, 'combos');
    assert.deepEqual(groups[0].providers, ['oc', 'ocg']);
    assert.deepEqual(groups[0].models, ['free', 'ocg/kimi-k2.7-code']);

    // Empty filters and mode "all" remove the properties again.
    assert.equal(
      updateGroupConfig(
        { vendor: '9router-provider-bridge', name: '9Router' },
        { mode: 'all', providers: [], models: [] },
        [file]
      ),
      true
    );
    groups = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(groups[0].mode, undefined);
    assert.equal(groups[0].providers, undefined);
    assert.equal(groups[0].models, undefined);

    assert.equal(
      updateGroupConfig({ vendor: '9router-provider-bridge', name: 'missing' }, { mode: 'providers' }, [file]),
      false
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
        providers: ['ocg'],
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
      providers: ['ocg'],
      models: ['ocg/kimi-k2.7-code'],
    });
    assert.deepEqual(groups[1], {
      name: 'combos',
      baseUrl: '',
      apiKey: 'sk-raw',
      mode: 'combos',
      providers: [],
      models: [],
    });
    // ${input:...} placeholders are never treated as concrete keys.
    assert.equal(groups[2].apiKey, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
