import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

import { BRIDGE_PROVIDER_NAME, resolveModelOptions } from './modelOptions.js';

test('resolveModelOptions: reasoning effort travels as a provider body field', () => {
  assert.deepEqual(resolveModelOptions({ reasoningEffort: 'high' }), {
    standardized: {},
    providerOptions: { [BRIDGE_PROVIDER_NAME]: { reasoningEffort: 'high' } },
  });
});

test('resolveModelOptions: accepts the agent-host thinking level and the legacy snake_case key', () => {
  const expected = {
    standardized: {},
    providerOptions: { [BRIDGE_PROVIDER_NAME]: { reasoningEffort: 'max' } },
  };
  assert.deepEqual(resolveModelOptions({ thinkingLevel: 'max' }), expected);
  assert.deepEqual(resolveModelOptions({ reasoning_effort: 'max' }), expected);
  // The VS Code property wins when several are present.
  assert.deepEqual(
    resolveModelOptions({ reasoningEffort: 'high', thinkingLevel: 'max', reasoning_effort: 'none' }),
    { standardized: {}, providerOptions: { [BRIDGE_PROVIDER_NAME]: { reasoningEffort: 'high' } } },
  );
});

test('resolveModelOptions: numeric parameters map to standardized call settings', () => {
  const { standardized } = resolveModelOptions({
    temperature: 0.4,
    top_p: 0.9,
    max_tokens: 2048,
    frequency_penalty: 0.2,
    presence_penalty: -0.1,
    seed: 7,
  });
  assert.deepEqual(standardized, {
    temperature: 0.4,
    topP: 0.9,
    maxOutputTokens: 2048,
    frequencyPenalty: 0.2,
    presencePenalty: -0.1,
    seed: 7,
  });

  // camelCase spellings are accepted as well.
  assert.deepEqual(
    resolveModelOptions({ topP: 0.5, maxOutputTokens: 512, frequencyPenalty: 0.1, presencePenalty: 0.2 }).standardized,
    { topP: 0.5, maxOutputTokens: 512, frequencyPenalty: 0.1, presencePenalty: 0.2 },
  );
});

test('resolveModelOptions: top_k travels as a provider body field', () => {
  const { standardized, providerOptions } = resolveModelOptions({ top_k: 5 });
  assert.deepEqual(standardized, {});
  assert.deepEqual(providerOptions, { [BRIDGE_PROVIDER_NAME]: { top_k: 5 } });
});

test('resolveModelOptions: unknown keys, group config and invalid values are never forwarded', () => {
  const resolved = resolveModelOptions({
    apiKey: 'sk-secret',
    baseUrl: 'http://127.0.0.1:20128/v1',
    name: '9Router',
    reasoningEffort: '',
    thinkingLevel: 42,
    reasoning_effort: 42,
    temperature: 'hot',
    top_k: Number.NaN,
    seed: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(resolved.standardized, {});
  assert.deepEqual(resolved.providerOptions, {});
});

test('resolveModelOptions: resolves to empty options without configuration', () => {
  assert.deepEqual(resolveModelOptions(undefined), { standardized: {}, providerOptions: {} });
  assert.deepEqual(resolveModelOptions(null), { standardized: {}, providerOptions: {} });
  assert.deepEqual(resolveModelOptions({}), { standardized: {}, providerOptions: {} });
});

test('resolved options reach the upstream request body', async () => {
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const chunks = [
    sse({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] }),
    sse({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ];

  let captured: Record<string, unknown> | undefined;
  const fetchMock = async (_input: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {controller.enqueue(encoder.encode(chunk));}
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };

  const provider = createOpenAICompatible({
    name: BRIDGE_PROVIDER_NAME,
    baseURL: 'https://example.invalid/v1',
    fetch: fetchMock,
  });

  const resolved = resolveModelOptions({ reasoningEffort: 'max', top_k: 5, temperature: 0.3 });
  const result = streamText({
    model: provider('ocg/deepseek-v4.1-flash'),
    messages: [{ role: 'user', content: 'hi' }],
    ...resolved.standardized,
    providerOptions: resolved.providerOptions,
  });
  for await (const _part of result.fullStream) { /* drain */ }

  assert.ok(captured, 'expected the request body to be captured');
  assert.equal(captured.reasoning_effort, 'max');
  assert.equal(captured.top_k, 5);
  assert.equal(captured.temperature, 0.3);
  assert.equal('apiKey' in captured, false);
});
