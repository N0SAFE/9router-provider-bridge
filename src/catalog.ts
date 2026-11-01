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
  tools?: boolean | { supported?: boolean; [key: string]: unknown };
  reasoning?: boolean | { supported?: boolean; [key: string]: unknown };
  thinkingFormat?: string;
  contextWindow?: number;
  maxOutput?: number;
  [key: string]: unknown;
}

/** 9Router publishes a capability either as a boolean or as `{ supported }`. */
function enabled(value: boolean | { supported?: boolean } | undefined): boolean {
  return value === true || (typeof value === "object" && value !== null && value.supported === true);
}

/** Per-parameter settings published by 9Router (reasoning levels, temp, …). */
export interface BridgeParameterSetting {
  supported?: boolean;
  type?: string;
  values?: string[] | null;
  range?: { min?: number; max?: number };
  max?: number;
  alias?: string[];
  default?: unknown;
  format?: string | null;
  canDisable?: boolean;
  budgetTokens?: { min?: number | null; max?: number | null } | null;
}

export interface BridgeModelInfo {
  id: string;
  name?: string;
  object?: string;
  owned_by?: string;
  kind?: string;
  capabilities?: BridgeCapabilities;
  /** Which request parameters the model accepts (from the listing). */
  parameters?: Record<string, BridgeParameterSetting>;
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
  /**
   * VS Code per-model configuration schema, derived from 9Router's published
   * request parameters. Drives the model picker's "Configure Model" action and
   * the per-model settings in chatLanguageModels.json.
   */
  configurationSchema?: Record<string, unknown>;
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
 * Human line describing the capabilities 9Router reported for a model. Built
 * purely from the model list payload — no model names are special-cased here.
 */
function describeCapabilities(caps: BridgeCapabilities | undefined): string | null {
  if (!caps) {
    return null;
  }
  const flags: string[] = [];
  if (caps.vision === true) flags.push("vision");
  if (caps.pdf === true) flags.push("pdf");
  if (caps.audioInput === true) flags.push("audio");
  if (caps.videoInput === true) flags.push("video");
  if (caps.imageOutput === true) flags.push("image-out");
  if (caps.audioOutput === true) flags.push("audio-out");
  if (caps.search === true) flags.push("search");
  if (enabled(caps.tools)) flags.push("tools");
  if (enabled(caps.reasoning)) flags.push("reasoning");
  return flags.length > 0 ? flags.join(" · ") : null;
}

/**
 * Human line describing the request settings 9Router published for a model
 * (reasoning levels, thinking budget, temperature support, output ceiling).
 * Purely data-driven — nothing is special-cased by model name.
 */
function describeModelSettings(parameters: Record<string, BridgeParameterSetting> | undefined): string | null {
  if (!parameters) {
    return null;
  }
  const parts: string[] = [];
  const effort = parameters.reasoning_effort;
  if (effort?.supported) {
    parts.push(effort.values?.length ? `effort: ${effort.values.join("·")}` : "effort: on");
  }
  const thinking = parameters.thinking;
  if (thinking?.supported && thinking.budgetTokens && (thinking.budgetTokens.min || thinking.budgetTokens.max)) {
    parts.push(`thinking ${thinking.budgetTokens.min ?? "?"}–${thinking.budgetTokens.max ?? "?"}`);
  }
  if (parameters.temperature?.supported === false) parts.push("temp ✕");
  if (typeof parameters.max_tokens?.max === "number") parts.push(`max out ${parameters.max_tokens.max}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Display labels for the reasoning levels 9Router uses. */
const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function levelLabel(value: string): string {
  return EFFORT_LABELS[value] ?? (value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value);
}

/**
 * Build a VS Code per-model configuration schema from the request parameters
 * 9Router publishes for a model (`parameters`). VS Code renders a "Configure
 * Model" action from this schema, persists the values in chatLanguageModels.json
 * and returns them in
 * ProvideLanguageModelChatResponseOptions.modelConfiguration, which provider.ts
 * forwards to the upstream request.
 *
 * Only parameters marked as supported are exposed. Purely data-driven — no
 * per-model special cases.
 */
export function configurationSchemaFor(
  parameters: Record<string, BridgeParameterSetting> | undefined,
): Record<string, unknown> | undefined {
  if (!parameters) {
    return undefined;
  }

  const properties: Record<string, unknown> = {};

  const effort = parameters.reasoning_effort;
  if (effort?.supported === true && Array.isArray(effort.values) && effort.values.length > 0) {
    const options = effort.values.map(String);
    // VS Code's BYOK convention names this property `reasoningEffort` (the
    // agent-host BYOK bridge reads `configurationSchema.properties.reasoningEffort`
    // to build the per-model reasoning levels). `group: "navigation"` surfaces
    // it as a quick action in the model picker.
    properties.reasoningEffort = {
      type: "string",
      title: "Reasoning effort",
      markdownDescription: "Reasoning effort forwarded to the upstream model (`reasoning_effort`).",
      enum: options,
      enumItemLabels: options.map(levelLabel),
      group: "navigation",
      ...(typeof effort.default === "string" && options.includes(effort.default)
        ? { default: effort.default }
        : {}),
    };
  }

  const addNumber = (
    key: string,
    title: string,
    markdownDescription: string,
    extra: Record<string, unknown> = {},
  ): void => {
    const setting = parameters[key];
    if (setting?.supported !== true) {
      return;
    }
    if (setting.type !== undefined && setting.type !== "number") {
      return;
    }
    properties[key] = {
      type: "number",
      title,
      markdownDescription,
      ...(typeof setting.range?.min === "number" ? { minimum: setting.range.min } : {}),
      ...(typeof setting.range?.max === "number" ? { maximum: setting.range.max } : {}),
      ...(typeof setting.max === "number" ? { maximum: setting.max } : {}),
      ...(typeof setting.default === "number" ? { default: setting.default } : {}),
      ...extra,
    };
  };

  addNumber("temperature", "Temperature", "Sampling temperature forwarded to the upstream model.");
  addNumber("top_p", "Top P", "Nucleus sampling cutoff forwarded to the upstream model.");
  addNumber("top_k", "Top K", "Top-K sampling cutoff forwarded to the upstream model (`top_k`).");
  addNumber("max_tokens", "Max output tokens", "Upper bound for generated tokens (`max_tokens`).");
  addNumber("frequency_penalty", "Frequency penalty", "Penalty for repeated tokens (`frequency_penalty`).");
  addNumber("presence_penalty", "Presence penalty", "Penalty for tokens already present (`presence_penalty`).");
  addNumber("seed", "Seed", "Deterministic sampling seed (`seed`).");

  return Object.keys(properties).length > 0 ? { type: "object", properties } : undefined;
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
      // Never surface an empty picker label: fall back to the model id and the
      // provider alias when the catalog has no (or a blank) display name.
      const providerLabel = partition.name?.trim() || provider.name?.trim() || provider.alias;
      for (const model of partition.models) {
        const caps = model.capabilities ?? {};
        const capabilitiesLine = describeCapabilities(caps);
        const settingsLine = describeModelSettings(model.parameters);
        const tooltipLines = [poolTip, capabilitiesLine, settingsLine].filter(Boolean);
        const entry: BridgeModelEntry = {
          id: model.id,
          name: `${providerLabel} · ${model.name?.trim() || model.id}`,
          family: partition.alias,
          // No inline `detail`: VS Code lays the picker row out with the label
          // at `flex: 1` (basis 0) and the description taking its content width
          // first, so a long pool summary squeezes the label to zero width and
          // the row looks nameless. Pool health stays in the tooltip.
          tooltip: tooltipLines.join("\n\n"),
          contextLength: positiveNumber(
            model.context_length,
            positiveNumber(caps.contextWindow, DEFAULT_CONTEXT_LENGTH)
          ),
          maxOutput: positiveNumber(
            model.max_completion_tokens,
            positiveNumber(caps.maxOutput, DEFAULT_MAX_OUTPUT)
          ),
          // `vision`/`tools` are the names 9Router uses; accept the VS Code
          // capability spellings too so either payload shape works.
          imageInput: caps.vision === true || caps.imageInput === true,
          toolCalling: enabled(caps.tools) || caps.toolCalling === true,
          isUserSelectable: true,
          configurationSchema: configurationSchemaFor(model.parameters),
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
