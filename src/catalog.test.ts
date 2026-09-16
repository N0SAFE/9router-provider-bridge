import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyGroupFilters,
  catalogModels,
  describePool,
  normalizeMode,
  poolOf,
  summarizeCatalog,
  type BridgeManifest,
} from './catalog.js';

const manifest: BridgeManifest = {
  object: '9router.bridge',
  version: 1,
  providers: [
    {
      object: 'provider',
      id: 'opencode-go',
      alias: 'ocg',
      name: 'OpenCode Go',
      pool: { connections: 5, ready: 2, cooling: 3, unavailable: 0, locks: 1, strategy: 'round-robin' },
      models: [
        {
          id: 'ocg/kimi-k2.7-code',
          name: 'Kimi K2.7 Code',
          capabilities: { vision: true, tools: true, contextWindow: 200000, maxOutput: 64000 },
          context_length: 200000,
          max_completion_tokens: 64000,
        },
        {
          id: 'ocg/deepseek-v4-flash',
          capabilities: { tools: true },
          context_length: 1000000,
          max_completion_tokens: 384000,
        },
      ],
    },
    {
      object: 'provider',
      id: 'ollama',
      alias: 'ollama',
      name: 'Ollama Cloud',
      pool: { connections: 4, ready: 4, cooling: 0, unavailable: 0, locks: 0, strategy: 'fill-first' },
      models: [
        {
          id: 'ollama/minimax-m3',
          capabilities: { tools: false },
          context_length: 128000,
          max_completion_tokens: 32000,
        },
      ],
    },
  ],
  pools: [
    {
      object: 'pool',
      provider: 'opencode-go',
      alias: 'ocg',
      name: 'OpenCode Go',
      connections: 5,
      ready: 2,
      cooling: 3,
      unavailable: 0,
      locks: 1,
      strategy: 'round-robin',
      last_activity: '2026-09-15T11:34:16.592Z',
    },
    {
      object: 'pool',
      provider: 'openrouter',
      alias: 'openrouter',
      name: 'OpenRouter',
      connections: 1,
      ready: 1,
      cooling: 0,
      unavailable: 0,
      locks: 0,
      strategy: 'fill-first',
    },
  ],
  combos: [
    {
      object: 'combo',
      id: 'combo-1',
      name: 'free',
      kind: null,
      models: [
        { id: 'ollama/minimax-m3', available: true },
        { id: 'oc/muse-spark-1.3-contributor-free', available: false },
      ],
      model_count: 2,
      available_model_count: 1,
    },
  ],
};

test('normalizeMode: only the four known modes pass, everything else is "all"', () => {
  assert.equal(normalizeMode('providers'), 'providers');
  assert.equal(normalizeMode('combos'), 'combos');
  assert.equal(normalizeMode('pools'), 'pools');
  assert.equal(normalizeMode('all'), 'all');
  assert.equal(normalizeMode('bogus'), 'all');
  assert.equal(normalizeMode(undefined), 'all');
});

test('poolOf: reads the nested provider pool and the flat pool row', () => {
  assert.equal(poolOf(manifest.providers[0]).ready, 2);
  assert.equal(poolOf(manifest.pools[0]).ready, 2);
  assert.deepEqual(poolOf(undefined), { connections: 0, ready: 0, cooling: 0, unavailable: 0, locks: 0 });
});

test('describePool: summarises counts, strategy and accounts', () => {
  assert.equal(
    describePool(poolOf(manifest.pools[0])),
    '2/5 ready · 3 cooling · 1 locked models · round-robin (5 accounts)',
  );
  assert.equal(describePool(poolOf(manifest.pools[1])), '1/1 ready · fill-first (1 account)');
});

test('catalogModels(providers): active providers only, names prefixed, caps mapped', () => {
  const entries = catalogModels(manifest, 'providers');
  assert.deepEqual(entries.map((entry) => entry.id), [
    'ocg/kimi-k2.7-code',
    'ocg/deepseek-v4-flash',
    'ollama/minimax-m3',
  ]);
  assert.equal(entries[0].name, 'OpenCode Go · Kimi K2.7 Code');
  assert.equal(entries[0].family, 'ocg');
  assert.equal(entries[0].contextLength, 200000);
  assert.equal(entries[0].maxOutput, 64000);
  assert.equal(entries[0].imageInput, true);
  assert.equal(entries[0].toolCalling, true);
  assert.equal(entries[0].detail, '2/5 ready · 3 cooling · 1 locked models · round-robin (5 accounts)');
  assert.equal(entries[2].imageInput, false);
  assert.equal(entries[2].isUserSelectable, true);
});

test('catalogModels(all): providers plus combos', () => {
  const entries = catalogModels(manifest, 'all');
  assert.equal(entries.length, 4);
  const combo = entries.find((entry) => entry.kind === 'combo');
  assert.ok(combo);
  assert.equal(combo.id, 'free');
  assert.equal(combo.name, 'Combo · free');
  assert.equal(combo.family, 'combo');
  assert.equal(combo.detail, '1/2 models available');
  // Limits follow the narrowest resolvable member.
  assert.equal(combo.contextLength, 128000);
  assert.equal(combo.maxOutput, 32000);
  assert.equal(combo.toolCalling, false);
  assert.ok(combo.tooltip?.includes('- oc/muse-spark-1.3-contributor-free'));
});

test('catalogModels(combos): only combos', () => {
  const entries = catalogModels(manifest, 'combos');
  assert.deepEqual(entries.map((entry) => entry.kind), ['combo']);
});

test('catalogModels(pools): non-selectable status entries', () => {
  const entries = catalogModels(manifest, 'pools');
  assert.deepEqual(entries.map((entry) => entry.id), ['pool:ocg', 'pool:openrouter']);
  assert.equal(entries[0].name, 'OpenCode Go Pool');
  assert.equal(entries[0].family, 'pool:ocg');
  assert.equal(entries[0].isUserSelectable, false);
  assert.equal(entries[0].detail, '2/5 ready · 3 cooling · 1 locked models · round-robin (5 accounts)');
  assert.ok(entries[0].tooltip?.includes('2026-09-15T11:34:16.592Z'));
});

test('catalogModels: null manifest yields no entries', () => {
  assert.deepEqual(catalogModels(null, 'all'), []);
});

test('catalogModels: provider and combo entries are selectable, pools are not', () => {
  assert.ok(catalogModels(manifest, 'all').every((entry) => entry.isUserSelectable));
  assert.ok(catalogModels(manifest, 'pools').every((entry) => !entry.isUserSelectable));
});

test('applyGroupFilters: no filters keeps every entry', () => {
  const entries = catalogModels(manifest, 'all');
  assert.deepEqual(applyGroupFilters(entries, {}), entries);
  assert.deepEqual(applyGroupFilters(entries, { providers: [], models: [] }), entries);
});

test('applyGroupFilters: providers filter keeps only those provider models', () => {
  const entries = applyGroupFilters(catalogModels(manifest, 'all'), { providers: ['ollama'] });
  assert.deepEqual(entries.map((entry) => entry.id), ['ollama/minimax-m3', 'free']);
});

test('applyGroupFilters: models filter keeps only listed ids across providers and combos', () => {
  const entries = applyGroupFilters(catalogModels(manifest, 'all'), {
    models: ['ocg/kimi-k2.7-code', 'free'],
  });
  assert.deepEqual(entries.map((entry) => entry.id), ['ocg/kimi-k2.7-code', 'free']);
});

test('applyGroupFilters: providers and models combine', () => {
  const entries = applyGroupFilters(catalogModels(manifest, 'all'), {
    providers: ['ocg'],
    models: ['ocg/kimi-k2.7-code'],
  });
  assert.deepEqual(entries.map((entry) => entry.id), ['ocg/kimi-k2.7-code']);
});

test('summarizeCatalog: counts models, combos, pools and account readiness', () => {
  assert.deepEqual(summarizeCatalog(manifest), {
    providers: 2,
    combos: 1,
    pools: 2,
    models: 3,
    ready: 3,
    connections: 6,
  });
});
