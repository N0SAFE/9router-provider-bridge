// =============================================================================
// gateway.ts  —  chatLanguageModels.json group resolution
// =============================================================================
//
// Each 9Router entry in chatLanguageModels.json (vendor
// "9router-provider-bridge") is an independent group with its own baseUrl,
// optional apiKey and mode (all/providers/combos/pools). VS Code forwards the
// group configuration to the provider, but only properties declared in the
// extension manifest schema are guaranteed to round-trip; this module also
// reads the user's chatLanguageModels.json directly as a fallback, keyed by
// group name and — when the name is dropped — by raw apiKey.
//
// The module avoids vscode imports so it can be unit tested with node:test.
// =============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { normalizeMode, type CatalogMode } from "./catalog.js";

export function filterListFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
}

export interface GroupConfigEntry {
  name?: unknown;
  vendor?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  mode?: unknown;
  providers?: unknown;
  models?: unknown;
}

export interface ResolvedGroup {
  name?: string;
  baseUrl: string;
  apiKey: string;
  mode: CatalogMode;
  /** Provider aliases to expose (empty = all). Set from Configure Provider. */
  providers: string[];
  /** Model ids to expose (empty = all). Set from Configure Provider. */
  models: string[];
}

/**
 * Whether VS Code passed a usable provider group configuration. The groupless
 * vendor query passes `undefined`; every group added from Chat: Manage
 * Language Models passes an object with at least one resolved value (an empty
 * object means the group has no usable config, e.g. an unresolved secret).
 * Models are only ever exposed for such groups.
 */
export function hasGroupConfiguration(
  configuration: unknown
): configuration is Record<string, unknown> {
  return (
    !!configuration &&
    typeof configuration === "object" &&
    !Array.isArray(configuration) &&
    Object.keys(configuration).length > 0
  );
}

/** Trim whitespace and trailing slashes from a configured base URL. */
export function normalizeGatewayUrl(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
}

/**
 * Parse a chatLanguageModels.json file. Returns [] when unreadable/invalid.
 * Tolerates // line comments and trailing commas (JSONC-ish) so a hand-edited
 * file still yields the group config.
 */
export function parseGroupsConfig(raw: string): GroupConfigEntry[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      const stripped = raw
        .split("\n")
        .map((line) => line.replace(/^\s*\/\/.*$/, ""))
        .join("\n")
        .replace(/,(\s*[}\]])/g, "$1");
      const parsed = JSON.parse(stripped);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

/**
 * Find the base URL configured for a group by `name`, falling back to an exact
 * `apiKey` match. VS Code always forwards the group apiKey (it is used for
 * auth) but does not necessarily forward `name`/`baseUrl`; matching the
 * delivered key against chatLanguageModels.json recovers the group's baseUrl.
 * Unresolved `${input:...}` secret placeholders are ignored.
 */
export function findGroupBaseUrl(
  groups: GroupConfigEntry[],
  groupName: unknown,
  apiKey?: unknown
): string {
  if (!Array.isArray(groups)) {
    return "";
  }
  if (typeof groupName === "string" && groupName) {
    const byName = groups.find((group) => group && group.name === groupName);
    if (byName) {
      return normalizeGatewayUrl(byName.baseUrl);
    }
  }
  if (typeof apiKey === "string" && apiKey && !apiKey.includes("${input:")) {
    const byKey = groups.find((group) => group && group.apiKey === apiKey);
    if (byKey) {
      return normalizeGatewayUrl(byKey.baseUrl);
    }
  }
  return "";
}

/**
 * Find a group's raw (concrete) apiKey by name or baseUrl.
 *
 * VS Code's configuration resolver drops values for properties declared
 * `secret: true` unless they are `${input:...}` secret references — a raw key
 * pasted into chatLanguageModels.json arrives as `undefined`. The raw value is
 * still in the user's file, so recover it. `${input:...}` placeholders are
 * never returned (VS Code resolves those itself).
 */
export function findGroupApiKey(
  groups: GroupConfigEntry[],
  { name, baseUrl }: { name?: unknown; baseUrl?: unknown } = {}
): string {
  if (!Array.isArray(groups)) {
    return "";
  }
  const concrete = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && !value.includes("${input:");
  const wantedBaseUrl = normalizeGatewayUrl(baseUrl);

  if (typeof name === "string" && name) {
    const byName = groups.find((group) => group && group.name === name);
    if (byName && concrete(byName.apiKey)) {
      return byName.apiKey;
    }
  }
  if (wantedBaseUrl) {
    const byBaseUrl = groups.find(
      (group) => group && normalizeGatewayUrl(group.baseUrl) === wantedBaseUrl
    );
    if (byBaseUrl && concrete(byBaseUrl.apiKey)) {
      return byBaseUrl.apiKey;
    }
  }
  return "";
}

/** Find a group's configured mode by name, then by raw apiKey. */
export function findGroupMode(
  groups: GroupConfigEntry[],
  { name, apiKey }: { name?: unknown; apiKey?: unknown } = {}
): CatalogMode {
  if (!Array.isArray(groups)) {
    return "all";
  }
  if (typeof name === "string" && name) {
    const byName = groups.find((group) => group && group.name === name);
    if (byName && byName.mode !== undefined) {
      return normalizeMode(byName.mode);
    }
  }
  if (typeof apiKey === "string" && apiKey && !apiKey.includes("${input:")) {
    const byKey = groups.find((group) => group && group.apiKey === apiKey);
    if (byKey && byKey.mode !== undefined) {
      return normalizeMode(byKey.mode);
    }
  }
  return "all";
}

/** Find a matching group by name, then by raw apiKey, then by baseUrl. */
function findGroup(
  groups: GroupConfigEntry[],
  { name, apiKey, baseUrl }: { name?: unknown; apiKey?: unknown; baseUrl?: unknown } = {}
): GroupConfigEntry | undefined {
  if (!Array.isArray(groups)) {
    return undefined;
  }
  if (typeof name === "string" && name) {
    const byName = groups.find((group) => group && group.name === name);
    if (byName) {
      return byName;
    }
  }
  if (typeof apiKey === "string" && apiKey && !apiKey.includes("${input:")) {
    const byKey = groups.find((group) => group && group.apiKey === apiKey);
    if (byKey) {
      return byKey;
    }
  }
  const wantedBaseUrl = normalizeGatewayUrl(baseUrl);
  if (wantedBaseUrl) {
    return groups.find(
      (group) => group && normalizeGatewayUrl(group.baseUrl) === wantedBaseUrl
    );
  }
  return undefined;
}

/** Look a group's optional filters up directly from chatLanguageModels.json. */
export function lookupGroupFilters(
  match: { name?: unknown; apiKey?: unknown; baseUrl?: unknown } = {},
  files: string[] = defaultGroupConfigPaths()
): { providers: string[]; models: string[] } {
  for (const file of files) {
    try {
      const groups = parseGroupsConfig(fs.readFileSync(file, "utf8"));
      const group = findGroup(groups, match);
      if (group) {
        return {
          providers: filterListFrom(group.providers),
          models: filterListFrom(group.models),
        };
      }
    } catch {
      continue;
    }
  }
  return { providers: [], models: [] };
}

/** Default chatLanguageModels.json locations across OSes. */
export function defaultGroupConfigPaths(): string[] {
  const home = os.homedir();
  const paths = [
    path.join(home, ".config", "Code - Insiders", "User", "chatLanguageModels.json"),
    path.join(home, ".config", "Code", "User", "chatLanguageModels.json"),
    path.join(home, "Library", "Application Support", "Code - Insiders", "User", "chatLanguageModels.json"),
    path.join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json"),
  ];
  if (process.env.APPDATA) {
    paths.push(
      path.join(process.env.APPDATA, "Code - Insiders", "User", "chatLanguageModels.json"),
      path.join(process.env.APPDATA, "Code", "User", "chatLanguageModels.json")
    );
  }
  return paths;
}

/** Look the group's raw apiKey up directly from chatLanguageModels.json. */
export function lookupGroupApiKey(
  match: { name?: unknown; baseUrl?: unknown } = {},
  files: string[] = defaultGroupConfigPaths()
): string {
  const hasName = typeof match.name === "string" && match.name.length > 0;
  const hasBaseUrl = !!normalizeGatewayUrl(match.baseUrl);
  if (!hasName && !hasBaseUrl) {
    return "";
  }
  for (const file of files) {
    try {
      const groups = parseGroupsConfig(fs.readFileSync(file, "utf8"));
      const apiKey = findGroupApiKey(groups, match);
      if (apiKey) {
        return apiKey;
      }
    } catch {
      continue;
    }
  }
  return "";
}

/** Look the group's `baseUrl` up directly from chatLanguageModels.json. */
export function lookupGroupBaseUrl(
  groupName: unknown,
  apiKey?: unknown,
  files: string[] = defaultGroupConfigPaths()
): string {
  if ((typeof groupName !== "string" || !groupName) && (typeof apiKey !== "string" || !apiKey)) {
    return "";
  }
  for (const file of files) {
    try {
      const groups = parseGroupsConfig(fs.readFileSync(file, "utf8"));
      const baseUrl = findGroupBaseUrl(groups, groupName, apiKey);
      if (baseUrl) {
        return baseUrl;
      }
    } catch {
      continue;
    }
  }
  return "";
}

/** Look the group's `mode` up directly from chatLanguageModels.json. */
export function lookupGroupMode(
  match: { name?: unknown; apiKey?: unknown } = {},
  files: string[] = defaultGroupConfigPaths()
): CatalogMode {
  for (const file of files) {
    try {
      const groups = parseGroupsConfig(fs.readFileSync(file, "utf8"));
      const mode = findGroupMode(groups, match);
      if (mode !== "all") {
        return mode;
      }
    } catch {
      continue;
    }
  }
  return "all";
}

/**
 * Resolve the effective group settings for a request:
 *   1. values VS Code forwarded (model or model configuration), else
 *   2. the same group read straight from chatLanguageModels.json, matched by
 *      name or — when VS Code drops the name — by apiKey/baseUrl.
 */
export function resolveGroup(
  config: {
    baseUrl?: unknown;
    mode?: unknown;
    groupName?: unknown;
    apiKey?: unknown;
    providers?: unknown;
    models?: unknown;
  } = {},
  defaultBaseUrl = "",
  files?: string[]
): ResolvedGroup {
  const forwardedBaseUrl = normalizeGatewayUrl(config.baseUrl);
  const forwardedKey = typeof config.apiKey === "string" && config.apiKey ? config.apiKey : "";
  const name = typeof config.groupName === "string" && config.groupName ? config.groupName : undefined;
  const forwardedProviders = filterListFrom(config.providers);
  const forwardedModels = filterListFrom(config.models);
  const storedFilters =
    forwardedProviders.length === 0 && forwardedModels.length === 0
      ? lookupGroupFilters(
          { name: config.groupName, apiKey: forwardedKey, baseUrl: forwardedBaseUrl },
          files
        )
      : { providers: [], models: [] };
  return {
    name,
    baseUrl:
      forwardedBaseUrl ||
      lookupGroupBaseUrl(config.groupName, forwardedKey, files) ||
      normalizeGatewayUrl(defaultBaseUrl),
    apiKey:
      forwardedKey ||
      lookupGroupApiKey({ name: config.groupName, baseUrl: forwardedBaseUrl }, files),
    mode:
      config.mode !== undefined
        ? normalizeMode(config.mode)
        : lookupGroupMode({ name: config.groupName, apiKey: forwardedKey }, files),
    providers: forwardedProviders.length > 0 ? forwardedProviders : storedFilters.providers,
    models: forwardedModels.length > 0 ? forwardedModels : storedFilters.models,
  };
}

/**
 * All groups in chatLanguageModels.json that target this vendor. Used at
 * activation to warm the per-group model lists before VS Code asks for them.
 */
export function readVendorGroups(
  vendor: string,
  files: string[] = defaultGroupConfigPaths()
): ResolvedGroup[] {
  if (!vendor) {
    return [];
  }
  const groups: ResolvedGroup[] = [];
  for (const file of files) {
    try {
      for (const group of parseGroupsConfig(fs.readFileSync(file, "utf8"))) {
        if (!group || group.vendor !== vendor) {
          continue;
        }
        groups.push({
          name: typeof group.name === "string" ? group.name : undefined,
          baseUrl: normalizeGatewayUrl(group.baseUrl),
          apiKey:
            typeof group.apiKey === "string" && group.apiKey && !group.apiKey.includes("${input:")
              ? group.apiKey
              : "",
          mode: normalizeMode(group.mode),
          providers: filterListFrom(group.providers),
          models: filterListFrom(group.models),
        });
      }
    } catch {
      continue;
    }
  }
  return groups;
}

export interface GroupConfigPatch {
  mode?: CatalogMode;
  providers?: string[];
  models?: string[];
}

/**
 * Persist the Configure Provider choices into the matching group entry in
 * chatLanguageModels.json: `mode` plus optional `providers`/`models` filters.
 * Empty filters and mode "all" remove the property so files stay clean.
 * Matching is by group name first, then by normalized baseUrl.
 * Returns false when no matching file/entry exists.
 */
export function updateGroupConfig(
  match: { vendor: string; name?: string; baseUrl?: string },
  patch: GroupConfigPatch,
  files: string[] = defaultGroupConfigPaths()
): boolean {
  if (!match.vendor) {
    return false;
  }
  const wantedBaseUrl = normalizeGatewayUrl(match.baseUrl);
  for (const file of files) {
    try {
      const groups = parseGroupsConfig(fs.readFileSync(file, "utf8"));
      const index = groups.findIndex((group) => {
        if (!group || group.vendor !== match.vendor) {
          return false;
        }
        if (match.name) {
          return group.name === match.name;
        }
        return !!wantedBaseUrl && normalizeGatewayUrl(group.baseUrl) === wantedBaseUrl;
      });
      if (index === -1) {
        continue;
      }

      const next: GroupConfigEntry = { ...groups[index] };
      if (patch.mode !== undefined) {
        if (patch.mode === "all") {
          delete next.mode;
        } else {
          next.mode = patch.mode;
        }
      }
      if (patch.providers !== undefined) {
        const providers = filterListFrom(patch.providers);
        if (providers.length === 0) {
          delete next.providers;
        } else {
          next.providers = providers;
        }
      }
      if (patch.models !== undefined) {
        const models = filterListFrom(patch.models);
        if (models.length === 0) {
          delete next.models;
        } else {
          next.models = models;
        }
      }

      groups[index] = next;
      fs.writeFileSync(file, JSON.stringify(groups, null, 2) + "\n");
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
