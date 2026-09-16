// =============================================================================
// catalog.ts  —  9Router discovery payload types and pure mapping
// =============================================================================
//
// 9Router exposes three read-only views for bridge clients:
//
//   GET /v1/providers  providers with >=1 active connection + their models
//   GET /v1/combos     configured combos with per-model availability
//   GET /v1/pools      per-provider account pool health (counts only)
//   GET /v1/bridge     one-call manifest with all three inline
//
// This module turns those payloads into the flat model entries the VS Code
// model picker needs, and keeps pool/health formatting in one place. It has no
// vscode dependency so it can be unit tested with node:test.
// =============================================================================

export type CatalogMode = "all" | "providers" | "combos" | "pools";

export const CATALOG_MODES: CatalogMode[] = ["all", "providers", "combos", "pools"];

export const DEFAULT_CONTEXT_LENGTH = 128_000;
export const DEFAULT_MAX_OUTPUT = 16_384;

export interface BridgeCapabilities {
  vision?: boolean;
  pdf?: boolean;
  audioInput?: boolean;
  videoInput?: boolean;
  imageOutput?: boolean;
  audioOutput?: boolean;
  search?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  thinkingFormat?: string;
  contextWindow?: number;
  maxOutput?: number;
  [key: string]: unknown;
}

export interface BridgeModelInfo {
  id: string;
  name?: string;
  object?: string;
  owned_by?: string;
  kind?: string;
  capabilities?: BridgeCapabilities;
  context_length?: number;
  max_completion_tokens?: number;
  /** Upstream marks the model as free (OpenRouter pricing 0/0). */
  free?: boolean;
}

export interface PoolSummary {
  connections: number;
  ready: number;
  cooling: number;
  unavailable: number;
  locks: number;
  last_activity?: string | null;
  strategy?: string;
}

export interface BridgeProviderInfo {
  object?: string;
  id: string;
  alias: string;
  name: string;
  color?: string | null;
  text_icon?: string | null;
  no_auth?: boolean;
  pool: PoolSummary;
  models: BridgeModelInfo[];
}

export interface BridgePoolInfo extends PoolSummary {
  object?: string;
  provider: string;
  alias: string;
  name: string;
  color?: string | null;
  text_icon?: string | null;
  no_auth?: boolean;
  model_count?: number;
}

export interface BridgeComboModel {
  id: string;
  available: boolean;
}

export interface BridgeComboInfo {
  object?: string;
  id: string;
  name: string;
  kind?: string | null;
  models: BridgeComboModel[];
  model_count: number;
  available_model_count: number;
}

export interface BridgeManifest {
  object?: string;
  version?: number;
  modes?: Array<{ id: string; label: string; endpoint: string; description?: string }>;
  counts?: Record<string, number>;
  providers: BridgeProviderInfo[];
  pools: BridgePoolInfo[];
  combos: BridgeComboInfo[];
}

export interface BridgeModelEntry {
  /** Model id sent to 9Router (already provider-prefixed, or a combo name). */
  id: string;
  /** Name shown in the VS Code model picker. */
  name: string;
  /** Picker grouping: provider alias, "combo", or "pool:<alias>". */
  family: string;
  detail?: string;
  tooltip?: string;
  contextLength: number;
  maxOutput: number;
  imageInput: boolean;
  toolCalling: boolean;
  isUserSelectable: boolean;
  kind: "provider" | "combo" | "pool";
  alias: string;
}

export function normalizeMode(value: unknown): CatalogMode {
  return value === "providers" || value === "combos" || value === "pools" ? value : "all";
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface GroupFilters {
  /** Provider aliases to include (empty/absent = all providers). */
  providers?: unknown;
  /** Model ids to include (empty/absent = all models). */
  models?: unknown;
}

export function stringListFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
}

/**
 * Apply the optional per-group filters set from
 * "9Router Bridge: Configure Provider":
 * - `providers` keeps only provider models whose alias is listed (combos are
 *   unaffected; use the `combos`/`providers` mode to include or exclude them),
 * - `models` keeps only the listed model ids (provider models and combos).
 * Empty or absent lists mean "no filter" — every discovered model is exposed.
 */
export function applyGroupFilters(
  entries: BridgeModelEntry[],
  filters: GroupFilters = {}
): BridgeModelEntry[] {
  const providers = stringListFrom(filters.providers);
  const models = stringListFrom(filters.models);
  if (providers.length === 0 && models.length === 0) {
    return entries;
  }
  return entries.filter((entry) => {
    if (models.length > 0 && !models.includes(entry.id)) {
      return false;
    }
    if (providers.length > 0 && entry.kind === "provider" && !providers.includes(entry.alias)) {
      return false;
    }
    return true;
  });
}

/** A provider carries its pool nested; a pool row is flat. Normalize both. */
export function poolOf(entity: BridgeProviderInfo | BridgePoolInfo | undefined): PoolSummary {
  if (!entity) {
    return { connections: 0, ready: 0, cooling: 0, unavailable: 0, locks: 0 };
  }
  if ("pool" in entity && entity.pool) {
    return entity.pool;
  }
  const flat = entity as BridgePoolInfo;
  return {
    connections: flat.connections ?? 0,
    ready: flat.ready ?? 0,
    cooling: flat.cooling ?? 0,
    unavailable: flat.unavailable ?? 0,
    locks: flat.locks ?? 0,
    last_activity: flat.last_activity ?? null,
    strategy: flat.strategy,
  };
}

export function describePool(pool: PoolSummary | undefined): string {
  if (!pool) {
    return "pool unknown";
  }
  const accounts = pool.connections === 1 ? "1 account" : `${pool.connections} accounts`;
  const parts = [`${pool.ready}/${pool.connections} ready`];
  if (pool.cooling > 0) {
    parts.push(`${pool.cooling} cooling`);
  }
  if (pool.unavailable > 0) {
    parts.push(`${pool.unavailable} unavailable`);
  }
  if (pool.locks > 0) {
    parts.push(`${pool.locks} locked models`);
  }
  if (pool.strategy) {
    parts.push(pool.strategy);
  }
  return `${parts.join(" · ")} (${accounts})`;
}

export function poolTooltip(entity: BridgeProviderInfo | BridgePoolInfo): string {
  const pool = poolOf(entity);
  const lines = [entity.name];
  if (entity.no_auth === true) {
    lines.push("free/public provider — no account required");
  } else {
    lines.push(describePool(pool));
  }
  if (pool.last_activity) {
    lines.push(`last activity: ${pool.last_activity}`);
  }
  if (entity.no_auth !== true) {
    lines.push("accounts are selected server-side by the 9Router pool");
  }
  return lines.join("\n");
}

function comboDetail(combo: BridgeComboInfo): string {
  const total = combo.model_count ?? combo.models?.length ?? 0;
  const available = combo.available_model_count
    ?? (combo.models ?? []).filter((model) => model.available).length;
  return `${available}/${total} models available`;
}

function comboLines(combo: BridgeComboInfo): string {
  const members = (combo.models ?? []).map(
    (model) => `${model.available ? "+" : "-"} ${model.id}`
  );
  return members.length > 0 ? members.join("\n") : "(models unknown)";
}

interface ComboLimits {
  contextLength: number;
  maxOutput: number;
  imageInput: boolean;
  toolCalling: boolean;
}

/**
 * Combos route to their member models, so limits follow the narrowest member
 * (early compaction beats an upstream context overflow). When no member can be
 * resolved, conservative defaults are used.
 */
function resolveComboLimits(
  combo: BridgeComboInfo,
  modelsById: Map<string, BridgeModelEntry>
): ComboLimits {
  let contextLength = Number.POSITIVE_INFINITY;
  let maxOutput = 0;
  let imageInput = false;
  let toolCalling = false;
  let resolved = false;

  for (const member of combo.models ?? []) {
    const entry = modelsById.get(member.id);
    if (!entry) {
      continue;
    }
    resolved = true;
    contextLength = Math.min(contextLength, entry.contextLength);
    maxOutput = Math.max(maxOutput, entry.maxOutput);
    imageInput = imageInput || entry.imageInput;
    toolCalling = toolCalling || entry.toolCalling;
  }

  if (!resolved) {
    return {
      contextLength: DEFAULT_CONTEXT_LENGTH,
      maxOutput: DEFAULT_MAX_OUTPUT,
      imageInput: false,
      toolCalling: true,
    };
  }
  return {
    contextLength,
    maxOutput: maxOutput > 0 ? maxOutput : DEFAULT_MAX_OUTPUT,
    imageInput,
    toolCalling,
  };
}

/**
 * Map a bridge manifest to picker entries for the requested mode.
 *
 * - `providers`/`all`: provider models, active providers only (the manifest
 *   already excludes providers without an active connection).
 * - `combos`/`all`: combos as selectable models with resolved limits.
 * - `pools`: one non-selectable status entry per provider pool.
 */
export function catalogModels(
  manifest: BridgeManifest | null | undefined,
  mode: CatalogMode
): BridgeModelEntry[] {
  if (!manifest) {
    return [];
  }

  const entries: BridgeModelEntry[] = [];
  const modelsById = new Map<string, BridgeModelEntry>();

  for (const provider of manifest.providers ?? []) {
    const pool = poolOf(provider);
    const poolDetail = describePool(pool);
    const poolTip = poolTooltip(provider);
    const models = provider.models ?? [];
    // Some providers expose both free and paid models (OpenRouter). The bridge
    // shows them as two picker groups — "<Provider>" and "<Provider> Free" —
    // while the model id stays the same so routing is unchanged.
    const hasFreeSplit = models.some((model) => model.free === true);
    const partitions = hasFreeSplit
      ? [
          { alias: provider.alias, name: provider.name, models: models.filter((model) => model.free !== true) },
          { alias: `${provider.alias}-free`, name: `${provider.name} Free`, models: models.filter((model) => model.free === true) },
        ].filter((partition) => partition.models.length > 0)
      : [{ alias: provider.alias, name: provider.name, models }];

    for (const partition of partitions) {
      for (const model of partition.models) {
        const caps = model.capabilities ?? {};
        const entry: BridgeModelEntry = {
          id: model.id,
          name: `${partition.name} · ${model.name || model.id}`,
          family: partition.alias,
          detail: poolDetail,
          tooltip: poolTip,
          contextLength: positiveNumber(
            model.context_length,
            positiveNumber(caps.contextWindow, DEFAULT_CONTEXT_LENGTH)
          ),
          maxOutput: positiveNumber(
            model.max_completion_tokens,
            positiveNumber(caps.maxOutput, DEFAULT_MAX_OUTPUT)
          ),
          imageInput: caps.vision === true,
          toolCalling: caps.tools === true,
          isUserSelectable: true,
          kind: "provider",
          alias: partition.alias,
        };
        modelsById.set(entry.id, entry);
        if (mode === "all" || mode === "providers") {
          entries.push(entry);
        }
      }
    }
  }

  if (mode === "all" || mode === "combos") {
    for (const combo of manifest.combos ?? []) {
      const limits = resolveComboLimits(combo, modelsById);
      entries.push({
        id: combo.name,
        name: `Combo · ${combo.name}`,
        family: "combo",
        detail: comboDetail(combo),
        tooltip: comboLines(combo),
        ...limits,
        isUserSelectable: true,
        kind: "combo",
        alias: "combo",
      });
    }
  }

  if (mode === "pools") {
    for (const pool of manifest.pools ?? []) {
      const summary = poolOf(pool);
      entries.push({
        id: `pool:${pool.alias}`,
        name: `${pool.name} Pool`,
        family: `pool:${pool.alias}`,
        detail: describePool(summary),
        tooltip: poolTooltip(pool),
        contextLength: DEFAULT_CONTEXT_LENGTH,
        maxOutput: DEFAULT_MAX_OUTPUT,
        imageInput: false,
        toolCalling: false,
        isUserSelectable: false,
        kind: "pool",
        alias: pool.alias,
      });
    }
  }

  return entries;
}

export interface CatalogSummary {
  providers: number;
  combos: number;
  pools: number;
  models: number;
  ready: number;
  connections: number;
}

export function summarizeCatalog(manifest: BridgeManifest | null | undefined): CatalogSummary {
  const providers = manifest?.providers?.length ?? 0;
  const combos = manifest?.combos?.length ?? 0;
  const pools = manifest?.pools ?? [];
  return {
    providers,
    combos,
    pools: pools.length,
    models:
      (manifest?.providers ?? []).reduce(
        (total, provider) => total + (provider.models?.length ?? 0),
        0
      ),
    ready: pools.reduce((total, pool) => total + poolOf(pool).ready, 0),
    connections: pools.reduce((total, pool) => total + poolOf(pool).connections, 0),
  };
}
