import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchCatalog, joinEndpoint, manifestFromModels, normalizeBaseUrl } from './client.js';

const bridgePayload = {
  object: '9router.bridge',
  version: 1,
  providers: [
    {
      id: 'opencode-go',
      alias: 'ocg',
      name: 'OpenCode Go',
      pool: { connections: 5, ready: 2, cooling: 3, unavailable: 0, locks: 1, strategy: 'round-robin' },
      models: [{ id: 'ocg/kimi-k2.7-code', context_length: 200000, max_completion_tokens: 64000 }],
    },
  ],
  pools: [],
  combos: [{ id: 'combo-1', name: 'free', models: [], model_count: 1, available_model_count: 1 }],
};

test('normalizeBaseUrl: trims whitespace and trailing slashes', () => {
  assert.equal(normalizeBaseUrl('  http://127.0.0.1:20128/v1///  '), 'http://127.0.0.1:20128/v1');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(42), '');
});

test('joinEndpoint: joins without duplicating slashes', () => {
  assert.equal(joinEndpoint('http://127.0.0.1:20128/v1/', 'bridge'), 'http://127.0.0.1:20128/v1/bridge');
  assert.equal(joinEndpoint('http://127.0.0.1:20128/v1', '/pools'), 'http://127.0.0.1:20128/v1/pools');
});

test('manifestFromModels: groups provider models and extracts combos', () => {
  const manifest = manifestFromModels(
    {
      object: 'list',
      data: [
        { id: 'ocg/kimi-k2.7-code', owned_by: 'ocg', context_length: 200000 },
        { id: 'ocg/deepseek-v4-flash', owned_by: 'ocg' },
        { id: 'ollama/minimax-m3', owned_by: 'ollama' },
        { id: 'free', owned_by: 'combo' },
      ],
    },
    { object: 'list', data: [{ provider: 'opencode-go', alias: 'ocg', name: 'OpenCode Go', connections: 5, ready: 2, cooling: 3, unavailable: 0, locks: 1 }] }
  );

  assert.equal(manifest.providers.length, 2);
  assert.equal(manifest.providers.find((provider) => provider.alias === 'ocg')?.models.length, 2);
  assert.equal(manifest.combos.length, 1);
  assert.equal(manifest.combos[0].name, 'free');
  assert.equal(manifest.pools.length, 1);
});

test('fetchCatalog: prefers /v1/bridge and sends the API key', async () => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return new Response(JSON.stringify(bridgePayload), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;

  const manifest = await fetchCatalog({
    baseUrl: 'http://127.0.0.1:20128/v1',
    apiKey: 'sk-test',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:20128/v1/bridge');
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.equal(manifest?.object, '9router.bridge');
  assert.equal(manifest?.providers[0].alias, 'ocg');
});

test('fetchCatalog: falls back to /v1/models (+ /v1/pools) when /bridge is missing', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith('/bridge')) {
      return new Response('not found', { status: 404 });
    }
    if (url.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'ocg/kimi-k2.7-code', owned_by: 'ocg' }] }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  const manifest = await fetchCatalog({ baseUrl: 'http://127.0.0.1:20128/v1', fetchImpl });

  assert.deepEqual(calls, [
    'http://127.0.0.1:20128/v1/bridge',
    'http://127.0.0.1:20128/v1/models',
    'http://127.0.0.1:20128/v1/pools',
  ]);
  assert.equal(manifest?.version, 0);
  assert.equal(manifest?.providers[0].alias, 'ocg');
});

test('fetchCatalog: returns null when 9Router is unreachable', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof globalThis.fetch;

  assert.equal(await fetchCatalog({ baseUrl: 'http://127.0.0.1:20128/v1', fetchImpl }), null);
  assert.equal(await fetchCatalog({ baseUrl: '', fetchImpl }), null);
});
