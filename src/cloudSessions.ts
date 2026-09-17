// =============================================================================
// cloudSessions.ts — 9Router cloud agent sessions as a VS Code chat session type
// =============================================================================
//
// Registers a "9router" chat session type through the proposed
// chatSessionsProvider API. Sessions live on the 9Router host (workspace-bound,
// harness CLI, models from 9Router), so they keep running when the window
// closes, appear in the native session list, support fork and resume, and can
// be driven from the Chat view or the Agents window.
//
// The provider degrades silently when the proposed API is unavailable.

import * as vscode from "vscode";

import type { RemoteEndpoint } from "./remote.js";
import { log } from "./logger.js";

const SESSION_TYPE = "agent-host-9router";
const SCHEME = "agent-host-9router";
const POLL_MS = 15000;

interface CloudSessionSummary {
  id: string;
  title?: string;
  workspace?: string;
  model?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  turns?: number;
}

interface CloudSession extends CloudSessionSummary {
  messages?: Array<{ role: string; content: string; ts?: string }>;
}

interface ChatSessionsApi {
  createChatSessionItemController?: (
    type: string,
    refresh: (token: vscode.CancellationToken) => Thenable<void>
  ) => vscode.ChatSessionItemController;
  registerChatSessionContentProvider?: (
    scheme: string,
    provider: vscode.ChatSessionContentProvider,
    participant: vscode.ChatParticipant,
    capabilities?: vscode.ChatSessionCapabilities
  ) => vscode.Disposable;
}

function idFromResource(resource: vscode.Uri): string {
  return resource.path.replace(/^\/+/, "") || resource.fragment;
}

function resourceFor(id: string): vscode.Uri {
  return vscode.Uri.parse(`${SCHEME}:/${id}`);
}

async function api(
  endpoint: RemoteEndpoint,
  path: string,
  init: RequestInit = {},
  timeoutMs = 20000
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.root}/api/v1/agent${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function listRemoteModels(endpoint: RemoteEndpoint): Promise<Array<{ id: string; name?: string }>> {
  try {
    const response = await fetch(`${endpoint.root}/v1/models`, {
      headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {},
    });
    const data = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
    return Array.isArray(data.data) ? data.data.slice(0, 200) : [];
  } catch {
    return [];
  }
}

/** Default session model: configured model → first catalog entry (combos first). */
async function pickModel(
  endpoint: RemoteEndpoint,
  resolveDefaultModel: () => string | undefined,
  fallback?: string
): Promise<string | undefined> {
  const configured = resolveDefaultModel();
  if (fallback) {
    return fallback;
  }
  if (configured) {
    return configured;
  }
  const models = await listRemoteModels(endpoint);
  return models[0]?.id;
}

function makeRequestTurn(prompt: string): vscode.ChatRequestTurn {
  const Ctor = (vscode as unknown as { ChatRequestTurn: new (...args: unknown[]) => vscode.ChatRequestTurn })
    .ChatRequestTurn;
  return new Ctor(prompt, undefined, [], SESSION_TYPE, []);
}

function makeResponseTurn(markdown: string): vscode.ChatResponseTurn2 {
  const Ctor = (vscode as unknown as { ChatResponseTurn2: new (...args: unknown[]) => vscode.ChatResponseTurn2 })
    .ChatResponseTurn2;
  return new Ctor([new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(markdown))], {}, SESSION_TYPE);
}

function buildHistory(session: CloudSession): Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> {
  const history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
  for (const message of session.messages || []) {
    if (!message?.content) {
      continue;
    }
    if (message.role === "user") {
      history.push(makeRequestTurn(message.content));
    } else if (message.role === "assistant") {
      history.push(makeResponseTurn(message.content));
    }
  }
  return history;
}

function modelFromInputState(
  inputState: { readonly groups: ReadonlyArray<{ id: string; selected?: { id: string } }> } | undefined
): string | undefined {
  return inputState?.groups?.find((group) => group.id === "models")?.selected?.id;
}

export function registerCloudAgentSessions(
  context: vscode.ExtensionContext,
  resolveEndpoint: () => RemoteEndpoint | null,
  resolveDefaultModel: () => string | undefined
): void {
  const chat = vscode.chat as unknown as ChatSessionsApi & typeof vscode.chat;
  if (typeof chat.createChatSessionItemController !== "function") {
    log("Chat sessions proposed API unavailable — cloud sessions disabled", "warn");
    return;
  }

  const modelByResource = new Map<string, string>();

  const controller = chat.createChatSessionItemController(SESSION_TYPE, async () => {
    await refreshItems();
  });

  const refreshItems = async (): Promise<void> => {
    const endpoint = resolveEndpoint();
    if (!endpoint) {
      return;
    }
    try {
      const data = await api(endpoint, "/sessions");
      const sessions = Array.isArray(data.sessions) ? (data.sessions as CloudSessionSummary[]) : [];
      const items = sessions.map((session) => {
        const item = controller.createChatSessionItem(resourceFor(session.id), session.title || session.id);
        item.description = [session.status, session.workspace].filter(Boolean).join(" · ");
        item.status =
          session.status === "running"
            ? vscode.ChatSessionStatus.InProgress
            : session.status === "failed"
              ? vscode.ChatSessionStatus.Failed
              : vscode.ChatSessionStatus.Completed;
        const created = Date.parse(session.createdAt || "");
        const updated = Date.parse(session.updatedAt || "");
        item.timing = {
          created: Number.isFinite(created) ? created : Date.now(),
          ...(Number.isFinite(updated) ? { lastRequestEnded: updated } : {}),
        };
        return item;
      });
      controller.items.replace(items);
    } catch (error) {
      log(`Cloud session refresh failed: ${(error as Error).message}`, "debug");
    }
  };

  controller.newChatSessionItemHandler = async (context) => {
    const endpoint = resolveEndpoint();
    if (!endpoint) {
      throw new Error("No 9Router instance configured");
    }
    const model = await pickModel(endpoint, resolveDefaultModel);
    const title = context.request.prompt.trim().slice(0, 60) || "New session";
    const data = await api(endpoint, "/sessions", {
      method: "POST",
      body: JSON.stringify({ title, model }),
    });
    const session = data.session as CloudSessionSummary | undefined;
    if (!session?.id) {
      throw new Error(String(data.error || "Failed to create the cloud session"));
    }
    const item = controller.createChatSessionItem(resourceFor(session.id), session.title || title);
    controller.items.add(item);
    return item;
  };

  controller.forkHandler = async (resource) => {
    const endpoint = resolveEndpoint();
    if (!endpoint) {
      throw new Error("No 9Router instance configured");
    }
    const data = await api(endpoint, `/sessions/${idFromResource(resource)}/fork`, {
      method: "POST",
      body: "{}",
    });
    const session = data.session as CloudSessionSummary | undefined;
    if (!session?.id) {
      throw new Error(String(data.error || "Fork failed"));
    }
    const item = controller.createChatSessionItem(resourceFor(session.id), session.title || "Fork");
    controller.items.add(item);
    return item;
  };

  const participant = vscode.chat.createChatParticipant(SESSION_TYPE, async () => {
    // Session turns are driven by the content provider's requestHandler.
  });

  const provider: vscode.ChatSessionContentProvider = {
    provideChatSessionContent: async (resource, _token, chatContext) => {
      const endpoint = resolveEndpoint();
      if (!endpoint) {
        throw new Error("No 9Router instance configured");
      }
      const id = idFromResource(resource);
      const selected = modelFromInputState(chatContext?.inputState);
      if (selected) {
        modelByResource.set(id, selected);
      }
      const data = await api(endpoint, `/sessions/${id}`);
      const session = (data.session || {}) as CloudSession;

      return {
        title: session.title,
        history: buildHistory(session),
        requestHandler: async (request, _context, stream, requestToken) => {
          const model =
            modelByResource.get(id) ||
            session.model ||
            (await pickModel(endpoint, resolveDefaultModel));
          const controllerAbort = new AbortController();
          requestToken.onCancellationRequested(() => controllerAbort.abort());
          try {
            const response = await fetch(`${endpoint.root}/api/v1/agent/sessions/${id}/messages`, {
              method: "POST",
              headers: {
                Accept: "text/event-stream",
                "Content-Type": "application/json",
                ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
              },
              body: JSON.stringify({ prompt: request.prompt, model }),
              signal: controllerAbort.signal,
            });
            if (!response.ok || !response.body) {
              stream.markdown(`\n\n> Cloud session failed (HTTP ${response.status}).`);
              return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) {
                  continue;
                }
                let event: {
                  type?: string;
                  text?: string;
                  name?: string;
                  input?: unknown;
                  error?: string;
                  exitCode?: number;
                  isError?: boolean;
                  costUsd?: number;
                };
                try {
                  event = JSON.parse(line.slice(6));
                } catch {
                  continue;
                }
                if (event.type === "text" && event.text) {
                  stream.markdown(event.text);
                } else if (event.type === "thinking" && event.text) {
                  stream.progress(event.text.slice(0, 120));
                } else if (event.type === "tool" && event.name) {
                  stream.progress(`Running ${event.name}…`);
                } else if (event.type === "stderr" && event.text) {
                  log(`[cloud session] ${event.text}`, "debug");
                } else if (event.type === "error") {
                  stream.markdown(`\n\n> ${event.error || "Agent run failed"}`);
                } else if (event.type === "done" && typeof event.exitCode === "number" && event.exitCode !== 0) {
                  stream.markdown(`\n\n> Harness exited with code ${event.exitCode}.`);
                }
              }
            }
            void refreshItems();
          } catch (error) {
            if ((error as Error)?.name !== "AbortError") {
              stream.markdown(`\n\n> ${(error as Error).message}`);
            }
          }
        },
        forkHandler: async () => {
          const forkData = await api(endpoint, `/sessions/${id}/fork`, { method: "POST", body: "{}" });
          const forked = forkData.session as CloudSessionSummary | undefined;
          if (!forked?.id) {
            throw new Error(String(forkData.error || "Fork failed"));
          }
          const item = controller.createChatSessionItem(resourceFor(forked.id), forked.title || "Fork");
          controller.items.add(item);
          return item;
        },
      };
    },
    provideHandleOptionsChange: (resource, updates) => {
      for (const update of updates) {
        if (update.optionId === "models" && update.value) {
          modelByResource.set(idFromResource(resource), update.value);
        }
      }
    },
    provideChatSessionProviderOptions: async () => {
      const endpoint = resolveEndpoint();
      if (!endpoint) {
        return { optionGroups: [] };
      }
      const models = await listRemoteModels(endpoint);
      if (models.length === 0) {
        return { optionGroups: [] };
      }
      const defaultModel = resolveDefaultModel() || models[0].id;
      return {
        optionGroups: [
          {
            id: "models",
            name: "Model",
            description: "Model or combo used by this cloud session",
            selected: { id: defaultModel, name: defaultModel },
            items: models.map((model) => ({ id: model.id, name: model.name || model.id })),
          },
        ],
      };
    },
  };

  context.subscriptions.push(
    chat.registerChatSessionContentProvider?.(SCHEME, provider, participant, {
      supportsInterruptions: true,
    }) ?? { dispose: () => undefined }
  );
  log(`Cloud sessions registered (type ${SESSION_TYPE})`, "info");

  void refreshItems();
  const timer = setInterval(() => void refreshItems(), POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
