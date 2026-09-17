// =============================================================================
// remote.ts  —  9Router remote agent host client (no vscode dependency)
// =============================================================================
//
// The bridge drives the remote agent host through the API-key authenticated
// endpoints:
//
//   GET    {dashboardRoot}/api/v1/remote/agent         status + sessions
//   POST   {dashboardRoot}/api/v1/remote/agent         { action: "start" }
//   DELETE {dashboardRoot}/api/v1/remote/agent         stop
//   GET    {dashboardRoot}/api/v1/remote/agent/logs    CLI log tail
//
// The dashboard root is derived from a configured group baseUrl (which points
// at /v1) by stripping the /v1 suffix.

import { normalizeGatewayUrl, type ResolvedGroup } from "./gateway.js";

export interface RemoteEndpoint {
  root: string;
  apiKey: string;
  name?: string;
}

/** Derive the dashboard root from an OpenAI-compatible base URL. */
export function dashboardRoot(baseUrl: string): string {
  return normalizeGatewayUrl(baseUrl).replace(/\/v1$/, "");
}

/**
 * Pick the 9Router instance that owns the remote agent: the first configured
 * group (or the provided fallback base URL when no group exists).
 */
export function resolveRemoteEndpoint(
  groups: ResolvedGroup[],
  fallbackBaseUrl: string
): RemoteEndpoint | null {
  const group = groups.find((entry) => entry.baseUrl) || null;
  const root = dashboardRoot(group?.baseUrl || fallbackBaseUrl);
  if (!root) {
    return null;
  }
  return { root, apiKey: group?.apiKey || "", name: group?.name };
}

async function request(
  endpoint: RemoteEndpoint,
  path: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.root}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export interface RemoteStatus {
  state?: { running?: boolean; pid?: number | null; name?: string | null; cli?: string | null };
  endpoints?: Array<{ type?: string; protocolVersion?: string | null; pid?: number | null }>;
  sessions?: unknown[];
  workspaces?: Array<{ name?: string; path?: string }>;
}

export async function fetchRemoteStatus(endpoint: RemoteEndpoint): Promise<RemoteStatus> {
  const { ok, status, data } = await request(endpoint, "/api/v1/remote/agent");
  if (!ok) {
    throw new Error(`9Router remote status failed (HTTP ${status})`);
  }
  return (data || {}) as RemoteStatus;
}

export async function startRemoteAgent(endpoint: RemoteEndpoint, name?: string): Promise<RemoteStatus> {
  const { ok, status, data } = await request(endpoint, "/api/v1/remote/agent", {
    method: "POST",
    body: JSON.stringify({ action: "start", name }),
  });
  if (!ok) {
    const message = (data as { error?: string } | null)?.error;
    throw new Error(message || `Failed to start the remote agent (HTTP ${status})`);
  }
  return (data || {}) as RemoteStatus;
}

export async function stopRemoteAgent(endpoint: RemoteEndpoint): Promise<RemoteStatus> {
  const { ok, status, data } = await request(endpoint, "/api/v1/remote/agent", { method: "DELETE" });
  if (!ok) {
    throw new Error(`Failed to stop the remote agent (HTTP ${status})`);
  }
  return (data || {}) as RemoteStatus;
}

export async function fetchRemoteLogs(endpoint: RemoteEndpoint, lines = 200): Promise<string> {
  const { ok, data } = await request(endpoint, `/api/v1/remote/agent/logs?lines=${lines}`);
  return ok ? String((data as { logs?: string } | null)?.logs || "") : "";
}

/** Human-readable connect instructions for the tunnel host. */
export function connectSteps(status: RemoteStatus): string {
  const name = status.state?.name || "<host>";
  return [
    `Agents window → New session → Remote → Tunnels → ${name}`,
    "Browser: https://insiders.vscode.dev/agents",
    "Remote sessions use this machine's workspace copies and model config.",
  ].join("\n");
}
