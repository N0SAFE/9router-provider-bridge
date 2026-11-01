// =============================================================================
// modelOptions.ts  —  per-model configuration → AI SDK call options
// =============================================================================
//
// VS Code stores per-model settings in chatLanguageModels.json (the group's
// `settings` map) and passes the resolved values back to the provider in
// ProvideLanguageModelChatResponseOptions.modelConfiguration. The keys exposed
// to the user come from the model's configurationSchema (see catalog.ts).
//
// This module maps those keys onto the AI SDK call:
//   - standardized settings (temperature, topP, maxOutputTokens, …)
//   - provider-specific request-body fields, namespaced under the provider
//     name (reasoningEffort → `reasoning_effort`, top_k → `top_k`, …)
//
// Only whitelisted keys are forwarded. modelConfiguration can also carry the
// provider group's apiKey, which must never leak into the request body.
// =============================================================================

import type { CallSettings, JSONValue } from "ai";

/**
 * AI SDK provider name. It is also the `providerOptions` namespace, so it must
 * stay in sync with the provider created in provider.ts.
 */
export const BRIDGE_PROVIDER_NAME = "9router";

export interface ResolvedModelOptions {
  /** Standardized AI SDK call settings (temperature, topP, maxOutputTokens, …). */
  standardized: CallSettings;
  /** Provider-specific body fields, namespaced under the bridge provider name. */
  providerOptions: Record<string, Record<string, JSONValue>>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Translate the resolved per-model configuration into AI SDK call options.
 * Unknown keys are ignored (and never forwarded).
 */
export function resolveModelOptions(
  modelConfiguration?: Record<string, unknown> | null,
): ResolvedModelOptions {
  const standardized: CallSettings = {};
  const body: Record<string, JSONValue> = {};

  if (modelConfiguration) {
    const temperature = asFiniteNumber(modelConfiguration.temperature);
    if (temperature !== undefined) {
      standardized.temperature = temperature;
    }

    // VS Code's BYOK convention is camelCase; the snake_case spellings are
    // accepted for settings written by earlier bridge versions.
    const topP = asFiniteNumber(modelConfiguration.topP) ?? asFiniteNumber(modelConfiguration.top_p);
    if (topP !== undefined) {
      standardized.topP = topP;
    }

    const maxTokens =
      asFiniteNumber(modelConfiguration.maxOutputTokens) ?? asFiniteNumber(modelConfiguration.max_tokens);
    if (maxTokens !== undefined) {
      standardized.maxOutputTokens = maxTokens;
    }

    const frequencyPenalty =
      asFiniteNumber(modelConfiguration.frequencyPenalty) ?? asFiniteNumber(modelConfiguration.frequency_penalty);
    if (frequencyPenalty !== undefined) {
      standardized.frequencyPenalty = frequencyPenalty;
    }

    const presencePenalty =
      asFiniteNumber(modelConfiguration.presencePenalty) ?? asFiniteNumber(modelConfiguration.presence_penalty);
    if (presencePenalty !== undefined) {
      standardized.presencePenalty = presencePenalty;
    }

    const seed = asFiniteNumber(modelConfiguration.seed);
    if (seed !== undefined) {
      standardized.seed = seed;
    }

    // `reasoningEffort` is the property VS Code exposes in the configuration
    // schema; agent-host sessions send their own `thinkingLevel` name, and the
    // first bridge version stored `reasoning_effort`.
    // @ai-sdk/openai-compatible parses `reasoningEffort` and re-emits it as
    // `reasoning_effort` in the request body.
    const reasoningEffort =
      asNonEmptyString(modelConfiguration.reasoningEffort) ??
      asNonEmptyString(modelConfiguration.thinkingLevel) ??
      asNonEmptyString(modelConfiguration.reasoning_effort);
    if (reasoningEffort !== undefined) {
      body.reasoningEffort = reasoningEffort;
    }

    // `top_k` is not a standardized option of the OpenAI-compatible provider;
    // unknown providerOptions keys are spread into the request body as-is.
    const topK = asFiniteNumber(modelConfiguration.topK) ?? asFiniteNumber(modelConfiguration.top_k);
    if (topK !== undefined) {
      body.top_k = topK;
    }
  }

  return {
    standardized,
    providerOptions: Object.keys(body).length > 0 ? { [BRIDGE_PROVIDER_NAME]: body } : {},
  };
}
