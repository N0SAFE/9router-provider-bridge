// =============================================================================
// provider.ts  —  chat request execution against a 9Router instance
// =============================================================================
//
// 9Router exposes one OpenAI-compatible surface (`/v1/chat/completions`), so a
// single `@ai-sdk/openai-compatible` client per base URL is enough. Account
// pool selection, quota redirects and combo fallback all happen server-side;
// this module only converts VS Code messages/tools, streams the result back as
// VS Code response parts, and classifies upstream errors for the UI.
// =============================================================================

import * as vscode from "vscode";

import type { ModelMessage, ToolSet } from "ai";
import { jsonSchema, streamText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { cleanUpstreamMessage } from "./providerError.js";
import { extractTextFromToolResult, simplifySchema } from "./providerUtils.js";
import { normalizeToolCallInput, normalizeToolName } from "./toolInput.js";
import {
  EMPTY_TURN_FALLBACK_TEXT,
  isEmptyTurn,
  MAX_TURNS,
  runWithEmptyTurnRetry,
} from "./turnGuard.js";
import { createVerboseFetch } from "./verboseFetch.js";
import { log } from "./logger.js";

const VERBOSE_FETCH = createVerboseFetch(globalThis.fetch);

/** State that survives across turns of a conversation. */
export interface ToolNameContext {
  /** toolCallId → original VS Code tool name (LanguageModelToolResultPart has no name). */
  toolCallNameCache: Map<string, string>;
  /** normalized upstream tool name → original VS Code tool name. */
  toolNameMap: Map<string, string>;
  /** simplified tool schemas keyed by original tool name. */
  toolSchemaCache: Map<string, Record<string, unknown>>;
}

export function createToolNameContext(): ToolNameContext {
  return {
    toolCallNameCache: new Map(),
    toolNameMap: new Map(),
    toolSchemaCache: new Map(),
  };
}

export interface BridgeStreamRequest {
  modelId: string;
  baseUrl: string;
  apiKey: string;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  options: vscode.ProvideLanguageModelChatResponseOptions;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  toolContext: ToolNameContext;
}

export interface BridgeUsage {
  prompt: number;
  completion: number;
}

function withThinkingMetadata(
  part: vscode.LanguageModelThinkingPart,
  metadata: Record<string, unknown>
): vscode.LanguageModelThinkingPart {
  (part as { metadata?: Record<string, unknown> }).metadata = metadata;
  return part;
}

/**
 * Execute one model turn through 9Router and report the streamed response to
 * VS Code. Returns token usage when the upstream reported it.
 */
export async function streamBridgeResponse(request: BridgeStreamRequest): Promise<BridgeUsage | null> {
  const { modelId, baseUrl, apiKey, messages, options, progress, token, toolContext } = request;

  const provider = createOpenAICompatible({
    name: "9router",
    baseURL: baseUrl,
    ...(apiKey ? { apiKey } : {}),
    fetch: VERBOSE_FETCH,
  });

  const coreMessages = toModelMessages(messages, toolContext);
  log(`[9router-provider-bridge] Converted ${coreMessages.length} messages for model=${modelId}`, "debug");

  const tools: ToolSet = {};
  for (const registered of options.tools ?? []) {
    const normalized = normalizeToolName(registered.name);
    if (normalized !== registered.name) {
      log(`[9router-provider-bridge] Tool name normalized "${registered.name}" → "${normalized}"`, "debug");
    }
    toolContext.toolNameMap.set(normalized, registered.name);

    let params = toolContext.toolSchemaCache.get(registered.name);
    if (!params) {
      params = simplifySchema(registered.inputSchema, registered.name);
      toolContext.toolSchemaCache.set(registered.name, params);
    }

    tools[normalized] = tool({
      description: registered.description ?? "",
      inputSchema: jsonSchema(params),
    });
  }

  const abortController = new AbortController();
  token.onCancellationRequested(() => abortController.abort());

  const toolChoice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
  let currentReasoning = "";
  let reasoningEnded = false;

  const report = progress.report.bind(progress) as (part: unknown) => void;

  try {
    const { result: turn, attempts } = await runWithEmptyTurnRetry(
      async () => {
        const result = streamText({
          model: provider(modelId),
          messages: coreMessages as ModelMessage[],
          tools: Object.keys(tools).length > 0 ? tools : undefined,
          toolChoice: Object.keys(tools).length > 0 ? toolChoice : undefined,
          abortSignal: abortController.signal,
          // The 9Router account pool owns retries/fallback; an SDK retry would
          // double-consume accounts and bypass the pool's quota handling.
          maxRetries: 0,
        });

        let hasText = false;
        let hasToolCall = false;
        let attemptUsage: BridgeUsage | null = null;

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              hasText = true;
              report(new vscode.LanguageModelTextPart(part.text));
              break;

            case "reasoning-delta":
              currentReasoning += part.text;
              report(new vscode.LanguageModelThinkingPart(part.text));
              break;

            case "reasoning-start":
              report(new vscode.LanguageModelThinkingPart(""));
              break;

            case "reasoning-end":
              reasoningEnded = true;
              report(
                withThinkingMetadata(new vscode.LanguageModelThinkingPart(""), {
                  vscode_reasoning_done: true,
                })
              );
              break;

            case "tool-call":
              hasToolCall = true;
              report(
                new vscode.LanguageModelToolCallPart(
                  part.toolCallId,
                  toolContext.toolNameMap.get(part.toolName) ?? part.toolName,
                  normalizeToolCallInput(part.input)
                )
              );
              break;

            case "tool-result":
              if (part.output) {
                const resultText = extractTextFromToolResult(part.output);
                if (resultText) {
                  report(
                    new vscode.LanguageModelToolResultPart(part.toolCallId, [
                      new vscode.LanguageModelTextPart(resultText),
                    ])
                  );
                }
              }
              break;

            case "finish": {
              const totalUsage = part.totalUsage;
              if (totalUsage) {
                attemptUsage = {
                  prompt: totalUsage.inputTokens ?? 0,
                  completion: totalUsage.outputTokens ?? 0,
                };
              }
              break;
            }

            case "error":
              log(`[9router-provider-bridge] Stream error: ${part.error}`, "error");
              throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }

        return { hasText, hasToolCall, usage: attemptUsage };
      },
      (attempt) => {
        log(
          `[9router-provider-bridge] Empty turn (no text, no tool calls) — retrying attempt ${attempt + 1}/${MAX_TURNS} for model=${modelId}`,
          "warn"
        );
      }
    );
    const usage = turn.usage;

    // VS Code persists completed thinking only from metadata; streamed deltas
    // render live but are not kept in history.
    if (currentReasoning) {
      report(
        withThinkingMetadata(new vscode.LanguageModelThinkingPart(""), {
          _completeThinking: currentReasoning,
          ...(reasoningEnded ? {} : { vscode_reasoning_done: true }),
        })
      );
    }

    if (usage) {
      report(
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode(
            JSON.stringify({
              prompt_tokens: usage.prompt,
              completion_tokens: usage.completion,
              total_tokens: usage.prompt + usage.completion,
            })
          ),
          "usage"
        )
      );
    }

    if (isEmptyTurn(turn)) {
      log(
        `[9router-provider-bridge] Empty response after ${attempts} attempt(s) — reporting fallback text for model=${modelId}`,
        "warn"
      );
      report(new vscode.LanguageModelTextPart(EMPTY_TURN_FALLBACK_TEXT));
    }

    return usage;
  } catch (err) {
    throw classifyError(err);
  }
}

function classifyError(err: unknown): Error {
  if (err instanceof vscode.LanguageModelError) {
    return err;
  }

  const rawMessage = (err as Error)?.message ?? "";
  const message = rawMessage.toLowerCase();
  const statusCode = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { status?: number; statusCode?: number })?.statusCode
    ?? 0;
  const rawBody = String((err as { responseBody?: unknown })?.responseBody ?? "");
  const body = rawBody.toLowerCase();
  const upstream = `${message} ${body}`;
  const detail = cleanUpstreamMessage(rawBody || rawMessage);

  if (statusCode === 429 || upstream.includes("rate limit") || upstream.includes("too many")) {
    return vscode.LanguageModelError.Blocked(`9Router: rate limited. ${detail}`);
  }
  if (statusCode === 402 || upstream.includes("insufficient_quota") || upstream.includes("quota exceeded")) {
    return new vscode.LanguageModelError(`9Router: quota exceeded. ${detail}`);
  }
  if (statusCode === 401 || statusCode === 403) {
    return vscode.LanguageModelError.NotFound(`9Router: unauthorized. ${detail}`);
  }
  if (statusCode === 404) {
    return vscode.LanguageModelError.NotFound(`9Router: model not found. ${detail}`);
  }
  return new vscode.LanguageModelError(`9Router request failed: ${detail}`);
}

/** Convert VS Code chat messages to AI SDK model messages. */
export function toModelMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  toolContext: ToolNameContext
): ModelMessage[] {
  const result: ModelMessage[] = [];
  const SystemRole = (vscode.LanguageModelChatMessageRole as unknown as { System?: vscode.LanguageModelChatMessageRole }).System;

  for (const msg of messages) {
    const textParts: string[] = [];
    const toolCallParts: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
    let toolCallId: string | undefined;
    let toolResultContent: string | undefined;
    let toolResultName: string | undefined;

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolContext.toolCallNameCache.set(part.callId, part.name);
        const normalized = normalizeToolName(part.name);
        toolContext.toolNameMap.set(normalized, part.name);
        toolCallParts.push({
          toolCallId: part.callId,
          toolName: normalized,
          input: normalizeToolCallInput(part.input),
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolCallId = part.callId;
        toolResultName = toolContext.toolCallNameCache.get(part.callId) ?? (part as { name?: string }).name;
        const isStringContent = typeof (part.content as unknown) === "string";
        toolResultContent = isStringContent
          ? (part.content as unknown as string)
          : (part.content as Array<unknown>)
              .filter((content): content is vscode.LanguageModelTextPart => content instanceof vscode.LanguageModelTextPart)
              .map((content) => content.value)
              .join("\n");
      }
    }

    if (msg.role === vscode.LanguageModelChatMessageRole.User) {
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      if (toolCallId && toolResultContent !== undefined) {
        const resolvedName = toolResultName ?? "unknown";
        if (resolvedName === "unknown") {
          log(`[9router-provider-bridge] WARNING: toolName for callId=${toolCallId} is unknown — cache miss`, "warn");
        }
        const normalizedName = normalizeToolName(resolvedName);
        toolContext.toolNameMap.set(normalizedName, resolvedName);
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: normalizedName,
              output: { type: "text", value: toolResultContent },
            },
          ],
        });
      }
    } else if (SystemRole !== undefined && msg.role === SystemRole) {
      const text = textParts.join("\n");
      if (text) {
        result.push({ role: "system", content: text });
      }
    } else {
      const text = textParts.join("\n");
      const contentParts: Array<Record<string, unknown>> = [];
      if (text) {
        contentParts.push({ type: "text", text });
      }
      for (const toolCall of toolCallParts) {
        contentParts.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        });
      }
      result.push({
        role: "assistant",
        content: contentParts.length > 0 ? contentParts : text,
      } as ModelMessage);
    }
  }

  return result;
}
