// =============================================================================
// client.ts  —  9Router discovery HTTP client
// =============================================================================
//
// Prefers the one-call `/v1/bridge` manifest. Older 9Router builds without it
// fall back to `/v1/models` (providers + combos, names unknown) plus
// `/v1/pools` when available. No vscode dependency: fetch is injectable so the
// module is unit tested with node:test.
// =============================================================================

import type {
  BridgeComboInfo,
  BridgeManifest,
  BridgeModelInfo,
  BridgePoolInfo,
  BridgeProviderInfo,
  PoolSummary,
} from "./catalog.js";

export const DEFAULT_TIMEOUT_MS = 8_000;

export interface CatalogFetchOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function normalizeBaseUrl(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
}

export function joinEndpoint(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return `${base}/${String(path).replace(/^\/+/, "")}`;
}

function emptyPool(): PoolSummary {
  return { connections: 0, ready: 0, cooling: 0, unavailable: 0, locks: 0 };
}

async function getJson(
  url: string,
  apiKey: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const data = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/**
 * Synthesize a manifest-shaped catalog from `/v1/models` (+ optional
 * `/v1/pools`) so the rest of the bridge works against older 9Router builds.
 */
export function manifestFromModels(modelsPayload: unknown, poolsPayload?: unknown): BridgeManifest {
  const models = listOf(modelsPayload) as BridgeModelInfo[];
  const pools = listOf(poolsPayload) as BridgePoolInfo[];
  const providers = new Map<string, BridgeProviderInfo>();
  const combos: BridgeComboInfo[] = [];

  for (const model of models) {
    if (!model?.id) {
      continue;
    }
    if (model.owned_by === "combo") {
      combos.push({
        object: "combo",
        id: model.id,
        name: model.id,
        kind: model.kind ?? null,
        models: [],
        model_count: 0,
        available_model_count: 0,
      });
      continue;
    }
    const alias = String(model.owned_by || "unknown");
    let provider = providers.get(alias);
    if (!provider) {
      provider = {
        object: "provider",
        id: alias,
        alias,
        name: alias,
        pool: emptyPool(),
        models: [],
      };
      providers.set(alias, provider);
    }
    provider.models.push(model);
  }

  return {
    object: "9router.bridge",
    version: 0,
    counts: {
      providers: providers.size,
      pools: pools.length,
      combos: combos.length,
      models: models.length,
    },
    providers: [...providers.values()],
    pools,
    combos,
  };
}

/**
 * Fetch the discovery catalog. Returns null when 9Router is unreachable or
 * answers with something that is not a catalog.
 */
export async function fetchCatalog(options: CatalogFetchOptions): Promise<BridgeManifest | null> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = options.apiKey ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const payload = await getJson(joinEndpoint(baseUrl, "bridge"), apiKey, fetchImpl, timeoutMs);
    const manifest = payload as BridgeManifest | null;
    if (manifest && typeof manifest === "object" && Array.isArray(manifest.providers)) {
      return manifest;
    }
  } catch {
    // Older 9Router (or a non-9Router gateway) — try the fallback below.
  }

  try {
    const models = await getJson(joinEndpoint(baseUrl, "models"), apiKey, fetchImpl, timeoutMs);
    let pools: unknown;
    try {
      pools = await getJson(joinEndpoint(baseUrl, "pools"), apiKey, fetchImpl, timeoutMs);
    } catch {
      pools = undefined;
    }
    return manifestFromModels(models, pools);
  } catch {
    return null;
  }
}
