import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { jsonSchema, streamText, tool } from 'ai';

import { normalizeToolCallInput } from './toolInput.js';

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/**
 * Reproduces the failure that surfaced as:
 *   [400] Assistant tool call function.arguments must be a JSON object.
 *
 * The upstream streams tool-call arguments in chunks that never form a
 * complete, parsable JSON object before the stream ends. The AI SDK then
 * yields a `tool-call` stream part whose `input` is the raw JSON *string*.
 * The bridge must coerce it to an object before reporting it to Copilot,
 * otherwise Copilot round-trips the string and the next request body carries a
 * double-encoded `arguments` value that the upstream rejects.
 */
test('streamed partial tool-call arguments never reach the upstream double-encoded', async () => {
  const chunks = [
    sse({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    sse({ id: '1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
    sse({ id: '1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x}' } }] } }] }),
    sse({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ];

  const fetchMock = async (_input: unknown, init?: RequestInit) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {controller.enqueue(encoder.encode(c));}
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };

  const provider = createOpenAICompatible({
    name: 'opencode',
    apiKey: 'test',
    baseURL: 'https://example.invalid/v1',
    fetch: fetchMock,
  });

  const result = streamText({
    model: provider('deepseek'),
    messages: [{ role: 'user', content: 'do the task' }],
    tools: {
      read_file: tool({
        description: 'read a file',
        inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
      }),
    },
    toolChoice: 'auto',
  });

  // Capture what the bridge would report to Copilot for each tool call.
  const reported: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
  for await (const part of result.fullStream) {
    if (part.type === 'tool-call') {
      reported.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: normalizeToolCallInput(part.input),
      });
    }
  }

  assert.equal(reported.length, 1);
  const { input } = reported[0];
  assert.equal(typeof input, 'object');
  assert.ok(!Array.isArray(input));

  // The raw arguments were malformed JSON, so the bridge coerces them to a
  // plain object ({}). The critical property: the request body carries a JSON
  // *object* for `arguments`, never a (double-encoded) string.
  const serializedArguments = JSON.stringify(input);
  const body = JSON.parse(`{"arguments": ${serializedArguments}}`);
  assert.equal(typeof body.arguments, 'object');
  assert.deepEqual(body.arguments, {});
});

test('complete tool-call arguments keep their object shape end to end', async () => {
  const chunks = [
    sse({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    sse({ id: '1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/hostname"}' } }] } }] }),
    sse({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ];

  const fetchMock = async (_input: unknown, init?: RequestInit) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {controller.enqueue(encoder.encode(c));}
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };

  const provider = createOpenAICompatible({
    name: 'opencode',
    apiKey: 'test',
    baseURL: 'https://example.invalid/v1',
    fetch: fetchMock,
  });

  const result = streamText({
    model: provider('deepseek'),
    messages: [{ role: 'user', content: 'do the task' }],
    tools: {
      read_file: tool({
        description: 'read a file',
        inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
      }),
    },
    toolChoice: 'auto',
  });

  let reported: unknown = null;
  for await (const part of result.fullStream) {
    if (part.type === 'tool-call') {
      reported = normalizeToolCallInput(part.input);
    }
  }

  assert.deepEqual(reported, { path: '/etc/hostname' });
});