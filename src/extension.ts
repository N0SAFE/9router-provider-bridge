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
    });
  }

  private resolve(config?: Record<string, unknown> | null): ResolvedGroup {
    return resolveGroup(
      {
        baseUrl: config?.baseUrl,
        mode: config?.mode,
        groupName: config?.name,
        apiKey: config?.apiKey,
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
   * Discovered entries for a group, mapped for the group's mode.
   */
  async entriesForGroup(
    config?: Record<string, unknown> | null
  ): Promise<{ group: ResolvedGroup; entries: BridgeModelEntry[] }> {
    const group = this.resolve(config);
    const manifest = await this.getCatalog(group);
    if (manifest) {
      this.lastManifest = manifest;
      setIdleStatus(manifest);
    }
    const entries = catalogModels(manifest, group.mode);
    return { group, entries };
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
      if (err instanceof vscode.LanguageModelError) {
        throw err;
      }
      throw new vscode.LanguageModelError(`9Router error: ${(err as Error).message}`);
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
