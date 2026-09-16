// =============================================================================
// extension.ts  —  VS Code extension entry point & 9Router BridgeProvider
// =============================================================================
//
// ARCHITECTURE:
//
//   activate()
//     ├─ resolve the vendor id from this extension's own manifest
//     ├─ register the LanguageModelChatProvider (instantly)
//     ├─ warm the per-group model lists from 9Router /v1/bridge (background)
//     └─ register commands (refresh, status, pools)
//
//   provideLanguageModelChatInformation(configuration)
//     ├─ resolve the group (baseUrl / apiKey / mode) from VS Code's forwarded
//     │  configuration, falling back to chatLanguageModels.json and settings
//     ├─ fetch the 9Router catalog (cached with a short TTL, in-flight dedupe)
//     ├─ map it to picker entries for the group mode:
//     │     all/providers → provider models (active providers only)
//     │     combos        → combos as selectable models
//     │     pools         → non-selectable pool status entries
//     └─ attach the resolved group configuration to every model so it
//        round-trips into provideLanguageModelChatResponse
//
//   provideLanguageModelChatResponse()
//     └─ streamBridgeResponse() with the model id and resolved group
//
//   onDidChangeLanguageModelChatInformation fires when the catalog changed.
// =============================================================================

import * as vscode from "vscode";

import {
  applyGroupFilters,
  catalogModels,
  describePool,
  normalizeMode,
  poolOf,
  summarizeCatalog,
  DEFAULT_CONTEXT_LENGTH,
  type BridgeManifest,
  type BridgeModelEntry,
  type CatalogMode,
} from "./catalog.js";
import { fetchCatalog, normalizeBaseUrl } from "./client.js";
import {
  hasGroupConfiguration,
  readVendorGroups,
  resolveGroup,
  updateGroupConfig,
  type ResolvedGroup,
} from "./gateway.js";
import { initLogger, log } from "./logger.js";
import { createToolNameContext, streamBridgeResponse } from "./provider.js";

const PKG_NAME = "9router-provider-bridge";
const DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
const CATALOG_TTL_MS = 60_000;

/** Language-model vendor id this extension registers under. */
let VENDOR_ID = PKG_NAME;
let statusBarItem: vscode.StatusBarItem;

function settingBaseUrl(): string {
  return (
    normalizeBaseUrl(vscode.workspace.getConfiguration().get<string>(`${PKG_NAME}.baseUrl`)) ||
    DEFAULT_BASE_URL
  );
}

function formatNum(value: number): string {
  if (value >= 10000) {
    return `${(value / 1000).toFixed(0)}k`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return value.toString();
}

function toVSCodeModel(
  entry: BridgeModelEntry,
  group: ResolvedGroup,
  forwarded: Record<string, unknown> | undefined
): vscode.LanguageModelChatInformation {
  return {
    id: entry.id,
    name: entry.name,
    family: entry.family,
    version: "1.0.0",
    detail: entry.detail,
    tooltip: entry.tooltip,
    maxInputTokens: entry.contextLength || DEFAULT_CONTEXT_LENGTH,
    maxOutputTokens: entry.maxOutput,
    capabilities: {
      imageInput: entry.imageInput,
      toolCalling: entry.toolCalling,
    },
    isUserSelectable: entry.isUserSelectable,
    configuration: {
      ...(forwarded ?? {}),
      baseUrl: group.baseUrl,
      mode: group.mode,
      ...(group.name ? { name: group.name } : {}),
      ...(group.apiKey ? { apiKey: group.apiKey } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// ACTIVATION
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  initLogger();
  log("activate()", "info");

  const manifestVendor = vscode.extensions.getExtension(context.extension.id)?.packageJSON
    ?.contributes?.languageModelChatProviders?.[0]?.vendor;
  if (typeof manifestVendor === "string" && manifestVendor) {
    VENDOR_ID = manifestVendor;
  }
  log(`Vendor id: ${VENDOR_ID}`, "info");

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = `${PKG_NAME}.showStatus`;
  statusBarItem.tooltip = "9Router Provider Bridge";
  context.subscriptions.push(statusBarItem);

  const provider = new BridgeProvider();
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider));

  void provider.warmUp();

  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.refreshModels`, async () => {
      provider.clearAll();
      provider.fireChange();
      vscode.window.showInformationMessage("9Router Bridge: Refreshing…");
      await provider.warmUp();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.showStatus`, () => showStatus(provider))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.showPools`, () => showPools(provider))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${PKG_NAME}.configureProvider`, () =>
      configureProvider(provider)
    )
  );
}

export function deactivate(): void {
  log("deactivated", "info");
}

// ---------------------------------------------------------------------------
// COMMANDS
// ---------------------------------------------------------------------------

function showStatus(provider: BridgeProvider): void {
  const manifest = provider.lastManifest;
  if (!manifest) {
    vscode.window.showWarningMessage(
      `9Router Bridge: no catalog. Is 9Router running at ${settingBaseUrl()}?`
    );
    return;
  }
  const summary = summarizeCatalog(manifest);
  const lines = [
    `${summary.models} models · ${summary.providers} active providers · ${summary.combos} combos`,
    `${summary.pools} pools · ${summary.ready}/${summary.connections} accounts ready`,
  ];
  for (const pool of manifest.pools.slice(0, 6)) {
    lines.push(`· ${pool.name}: ${describePool(poolOf(pool))}`);
  }
  vscode.window.showInformationMessage(`9Router Bridge\n${lines.join("\n")}`, { modal: true });
}

async function showPools(provider: BridgeProvider): Promise<void> {
  const pools = provider.lastManifest?.pools ?? [];
  if (pools.length === 0) {
    vscode.window.showWarningMessage(
      `9Router Bridge: no pools. Is 9Router running at ${settingBaseUrl()}?`
    );
    return;
  }
  const items = pools.map((pool) => {
    const summary = poolOf(pool);
    return {
      label: `$(server) ${pool.name}`,
      description: describePool(summary),
      detail: `strategy: ${summary.strategy ?? "default"} · last activity: ${summary.last_activity ?? "never"}`,
    };
  });
  await vscode.window.showQuickPick(items, {
    title: "9Router Account Pools",
    placeHolder: "Account pool health (counts only, no credentials)",
  });
}

interface ModeQuickPick extends vscode.QuickPickItem {
  mode: CatalogMode;
}

interface AliasQuickPick extends vscode.QuickPickItem {
  alias: string;
  picked: boolean;
}

interface ModelQuickPick extends vscode.QuickPickItem {
  modelId: string;
  picked: boolean;
}

/**
 * "9Router Bridge: Configure Provider" — pick a group and choose what it
 * exposes: content mode (providers/combos/both/pools), an optional provider
 * filter and an optional model filter. Choices are persisted into the group
 * entry in chatLanguageModels.json (empty filters = show everything).
 */
async function configureProvider(provider: BridgeProvider): Promise<void> {
  const groups = readVendorGroups(VENDOR_ID);
  if (groups.length === 0) {
    vscode.window.showWarningMessage(
      `9Router Bridge: no "${VENDOR_ID}" provider added yet. ` +
        `Add one from Chat: Manage Language Models first.`
    );
    return;
  }

  let target: ResolvedGroup;
  if (groups.length === 1) {
    target = groups[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: group.name ?? group.baseUrl ?? "(unnamed)",
        description: [
          group.mode,
          group.providers.length > 0 ? `providers: ${group.providers.join(", ")}` : "",
          group.models.length > 0 ? `${group.models.length} models` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        group,
      })),
      { title: "9Router Bridge: select the provider to configure" }
    );
    if (!picked) {
      return;
    }
    target = picked.group;
  }

  const modePick = await vscode.window.showQuickPick<ModeQuickPick>(
    [
      {
        label: "$(server) Providers + combos",
        description: "Everything 9Router exposes",
        mode: "all",
      },
      {
        label: "$(server) Providers only",
        description: "No combos",
        mode: "providers",
      },
      {
        label: "$(symbol-misc) Combos only",
        description: "Combos as selectable models",
        mode: "combos",
      },
      {
        label: "$(pulse) Pools",
        description: "Display-only account pool status",
        mode: "pools",
      },
    ],
    {
      title: `9Router · ${target.name ?? target.baseUrl}: content`,
      placeHolder: `current: ${target.mode}`,
    }
  );
  if (!modePick) {
    return;
  }
  const mode = modePick.mode;

  let providers = mode === "all" || mode === "providers" ? [...target.providers] : [];
  if (mode === "all" || mode === "providers") {
    const { entries } = await provider.entriesForGroup(
      { name: target.name, baseUrl: target.baseUrl, mode },
      { ignoreStoredFilters: true }
    );
    const aliases = [
      ...new Set(
        entries.filter((entry) => entry.kind === "provider").map((entry) => entry.alias)
      ),
    ].sort();
    if (aliases.length > 0) {
      const picked = await vscode.window.showQuickPick<AliasQuickPick>(
        aliases.map((alias) => ({
          label: alias,
          description: `${entries.filter((entry) => entry.alias === alias).length} models`,
          picked: target.providers.length === 0 || target.providers.includes(alias),
          alias,
        })),
        {
          canPickMany: true,
          title: "Provider filter",
          placeHolder: "Select providers to expose — none selected = all providers",
        }
      );
      if (!picked) {
        return;
      }
      providers = picked.map((item) => item.alias);
    }
  }

  const scopePick = await vscode.window.showQuickPick(
    [
      {
        label: "$(list-unordered) All models",
        description: "No model filter",
        filter: false,
      },
      {
        label: "$(checklist) Choose models…",
        description: "Pick exactly which models appear",
        filter: true,
      },
    ],
    {
      title: "Model filter",
      placeHolder:
        target.models.length > 0 ? `current: ${target.models.length} selected` : "current: all models",
    }
  );
  if (!scopePick) {
    return;
  }

  let models = scopePick.filter ? [...target.models] : [];
  if (scopePick.filter) {
    const { entries } = await provider.entriesForGroup(
      { name: target.name, baseUrl: target.baseUrl, mode },
      { ignoreStoredFilters: true }
    );
    const selectable = entries.filter((entry) => entry.kind !== "pool");
    if (selectable.length === 0) {
      vscode.window.showWarningMessage(
        `9Router Bridge: no models discovered for ${target.name ?? target.baseUrl}. Is 9Router running?`
      );
      return;
    }
    const chosen = await vscode.window.showQuickPick<ModelQuickPick>(
      selectable.map((entry) => ({
        label: entry.name,
        description: entry.id,
        picked: target.models.length === 0 || target.models.includes(entry.id),
        modelId: entry.id,
      })),
      {
        canPickMany: true,
        title: `Models to expose · ${target.name ?? target.baseUrl}`,
        placeHolder: "Select models to expose — none selected = all models",
      }
    );
    if (!chosen) {
      return;
    }
    models = chosen.map((item) => item.modelId);
  }

  const updated = updateGroupConfig(
    { vendor: VENDOR_ID, name: target.name, baseUrl: target.baseUrl },
    { mode, providers, models }
  );
  if (!updated) {
    vscode.window.showErrorMessage(
      "9Router Bridge: could not update chatLanguageModels.json (group entry not found)."
    );
    return;
  }

  provider.clearAll();
  await provider.warmUp();

  const summary = [`mode: ${mode}`];
  if (providers.length > 0) {
    summary.push(`providers: ${providers.join(", ")}`);
  }
  if (models.length > 0) {
    summary.push(`${models.length} models`);
  }
  vscode.window.showInformationMessage(
    `9Router Bridge: ${target.name ?? target.baseUrl} configured (${summary.join(" · ")}).`
  );
}

function setIdleStatus(manifest: BridgeManifest | null): void {
  if (!manifest) {
    statusBarItem.text = "$(error) 9Router: offline";
    statusBarItem.tooltip = `No catalog from ${settingBaseUrl()}`;
  } else {
    const summary = summarizeCatalog(manifest);
    statusBarItem.text = `$(server) 9Router: ${summary.models} models`;
    statusBarItem.tooltip =
      `${summary.providers} providers · ${summary.combos} combos · ` +
      `${summary.pools} pools (${summary.ready}/${summary.connections} accounts ready)`;
  }
  statusBarItem.show();
}

// ---------------------------------------------------------------------------
// BRIDGE PROVIDER — implements vscode.LanguageModelChatProvider
// ---------------------------------------------------------------------------

class BridgeProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  /** Model lists keyed by resolved group (baseUrl/apiKey/mode). */
  private groupLists = new Map<string, vscode.LanguageModelChatInformation[]>();
  /** Catalog cache keyed by baseUrl + key presence, with TTL. */
  private catalogs = new Map<string, { manifest: BridgeManifest | null; fetchedAt: number }>();
  private inFlight = new Map<string, Promise<BridgeManifest | null>>();
  private lastSignature = "";
  /** Models 9Router reported as retired upstream (410) — hidden for the session. */
  private readonly retiredModels = new Set<string>();
  private readonly toolContext = createToolNameContext();

  /** Last fetched catalog, used by status/pools commands. */
  lastManifest: BridgeManifest | null = null;

  fireChange(): void {
    this.onDidChangeEmitter.fire();
  }

  clearAll(): void {
    this.groupLists.clear();
    this.catalogs.clear();
    this.inFlight.clear();
    this.lastSignature = "";
  }

  private groupKey(group: ResolvedGroup): string {
    return JSON.stringify({
      name: group.name ?? null,
      baseUrl: group.baseUrl,
      apiKey: group.apiKey ? "key" : "",
      mode: group.mode,
      providers: group.providers,
      models: group.models,
    });
  }

  private resolve(config?: Record<string, unknown> | null): ResolvedGroup {
    return resolveGroup(
      {
        baseUrl: config?.baseUrl,
        mode: config?.mode,
        groupName: config?.name,
        apiKey: config?.apiKey,
        providers: config?.providers,
        models: config?.models,
      },
      settingBaseUrl()
    );
  }

  private async getCatalog(group: ResolvedGroup): Promise<BridgeManifest | null> {
    const key = `${group.baseUrl}|${group.apiKey ? "key" : ""}`;
    const cached = this.catalogs.get(key);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return cached.manifest;
    }
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }

    const request = fetchCatalog({ baseUrl: group.baseUrl, apiKey: group.apiKey })
      .then((manifest) => {
        if (manifest) {
          this.catalogs.set(key, { manifest, fetchedAt: Date.now() });
          return manifest;
        }
        // Keep the stale catalog (if any) when 9Router is temporarily down.
        return cached?.manifest ?? null;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  /**
   * Discovered entries for a group with the Configure Provider filters and
   * locally-retired (upstream 410) models applied.
   */
  async entriesForGroup(
    config?: Record<string, unknown> | null,
    options: { ignoreStoredFilters?: boolean } = {}
  ): Promise<{ group: ResolvedGroup; entries: BridgeModelEntry[] }> {
    const group = this.resolve(config);
    const manifest = await this.getCatalog(group);
    if (manifest) {
      this.lastManifest = manifest;
      setIdleStatus(manifest);
    }
    const filtered = options.ignoreStoredFilters
      ? catalogModels(manifest, group.mode)
      : applyGroupFilters(catalogModels(manifest, group.mode), {
          providers: group.providers,
          models: group.models,
        });
    const entries = filtered.filter((entry) => !this.retiredModels.has(entry.id));
    return { group, entries };
  }

  /**
   * Drop a model from every group list after 9Router reported it as retired
   * upstream. Session-scoped: `/v1/bridge` still lists it, so the filter stays
   * applied until the extension restarts (or 9Router removes it).
   */
  retireModel(modelId: string): void {
    if (this.retiredModels.has(modelId)) {
      return;
    }
    this.retiredModels.add(modelId);
    for (const [key, list] of this.groupLists) {
      this.groupLists.set(
        key,
        list.filter((model) => model.id !== modelId)
      );
    }
    log(`[9router-provider-bridge] retired model hidden: ${modelId}`, "warn");
    this.fireChange();
  }

  async listForGroup(config?: Record<string, unknown> | null): Promise<vscode.LanguageModelChatInformation[]> {
    const { group, entries } = await this.entriesForGroup(config);
    log(
      `[9router-provider-bridge] group=${group.name ?? "(default)"} mode=${group.mode} ` +
        `baseUrl=${group.baseUrl} enabled=${entries.filter((entry) => entry.isUserSelectable).length}/${entries.length}`,
      "info"
    );
    return entries.map((entry) => toVSCodeModel(entry, group, config ?? undefined));
  }

  /**
   * Warm the per-group model lists at activation so the picker has models
   * before VS Code asks. Fires a change event when the catalog differs.
   */
  async warmUp(): Promise<void> {
    try {
      const groups = readVendorGroups(VENDOR_ID);
      if (groups.length === 0) {
        // No provider group added yet: expose nothing. Adding a group from
        // Chat: Manage Language Models is what turns models on.
        this.groupLists.clear();
        this.lastManifest = null;
        statusBarItem.text = "$(server) 9Router: no providers";
        statusBarItem.tooltip =
          "Add a 9Router provider group from Chat: Manage Language Models to expose models.";
        statusBarItem.show();
        log("[9router-provider-bridge] no provider groups configured — no models exposed", "info");
        this.fireChange();
        return;
      }

      for (const group of groups) {
        const config: Record<string, unknown> = {
          vendor: VENDOR_ID,
          ...(group.name ? { name: group.name } : {}),
          ...(group.baseUrl ? { baseUrl: group.baseUrl } : {}),
          ...(group.apiKey ? { apiKey: group.apiKey } : {}),
          mode: group.mode,
          ...(group.providers.length > 0 ? { providers: group.providers } : {}),
          ...(group.models.length > 0 ? { models: group.models } : {}),
        };
        const list = await this.listForGroup(config);
        this.groupLists.set(this.groupKey(this.resolve(config)), list);
      }

      const signature = JSON.stringify(
        [...this.groupLists.entries()].map(([key, list]) => [key, list.map((model) => model.id)])
      );
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        log(`[9router-provider-bridge] catalog changed — firing model change`, "info");
        this.fireChange();
      }
    } catch (err) {
      log(`[9router-provider-bridge] warm-up failed: ${(err as Error).message}`, "error");
    }
  }

  private async refreshGroup(key: string, config?: Record<string, unknown> | null): Promise<void> {
    try {
      const list = await this.listForGroup(config);
      const previous = this.groupLists.get(key);
      this.groupLists.set(key, list);
      if (JSON.stringify(previous?.map((model) => model.id)) !== JSON.stringify(list.map((model) => model.id))) {
        log(`[9router-provider-bridge] group ${key} changed — firing model change`, "info");
        this.fireChange();
      }
    } catch (err) {
      log(`[9router-provider-bridge] refresh failed: ${(err as Error).message}`, "error");
    }
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = options.configuration as Record<string, unknown> | undefined;
    // No provider group configured (VS Code queries the vendor directly while
    // building the model management view) -> expose nothing. Groups added from
    // Chat: Manage Language Models are the only source of models; there is no
    // global/default group and no global API key.
    if (!hasGroupConfiguration(config)) {
      return [];
    }
    const group = this.resolve(config);
    const key = this.groupKey(group);

    let list = this.groupLists.get(key);
    if (!list) {
      list = await this.listForGroup(config);
      this.groupLists.set(key, list);
    } else if (!options.silent) {
      void this.refreshGroup(key, config);
    }
    return list;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const forwarded = {
      ...((model.configuration ?? {}) as Record<string, unknown>),
      ...((options.modelConfiguration ?? {}) as Record<string, unknown>),
    };
    const group = this.resolve(forwarded);

    if (String(model.family).startsWith("pool:")) {
      throw new vscode.LanguageModelError(
        `${model.name} is a pool status entry, not a callable model. ` +
          `Pick a model from a providers or combos group (or switch the group mode).`
      );
    }

    try {
      const usage = await streamBridgeResponse(
        {
          modelId: model.id,
          baseUrl: group.baseUrl,
          apiKey: group.apiKey,
          messages,
          options,
          progress,
          token,
          toolContext: this.toolContext,
        }
      );
      if (usage) {
        statusBarItem.text = `$(server) 9R ${formatNum(usage.prompt)}→${formatNum(usage.completion)} (${formatNum(usage.prompt + usage.completion)}) tok`;
        statusBarItem.tooltip = `Model: ${model.id}\nPrompt: ${usage.prompt} tokens\nOutput: ${usage.completion} tokens`;
        statusBarItem.show();
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      // 9Router reports upstream retirements as 410 Gone. Hide the model from
      // the picker so it cannot be selected again this session, and surface a
      // clear reason instead of the raw router error.
      if (/(^|\D)410(\D|$)|retired/i.test(message)) {
        this.retireModel(model.id);
        throw new vscode.LanguageModelError(
          `9Router: "${model.id}" was retired upstream and has been removed from the model picker. ${message}`
        );
      }
      if (err instanceof vscode.LanguageModelError) {
        throw err;
      }
      throw new vscode.LanguageModelError(`9Router error: ${message}`);
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const serialized = typeof text === "string" ? text : JSON.stringify(text.content);
    return Math.max(1, Math.ceil(serialized.length / 4));
  }
}
