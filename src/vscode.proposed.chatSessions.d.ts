// =============================================================================
// vscode.proposed.chatSessionsProvider.d.ts — minimal subset of the proposed
// chat session provider API used by the 9Router cloud sessions.
// Requires "enabledApiProposals": ["chatSessionsProvider"] in package.json.
// =============================================================================

import type * as vscode from 'vscode';

declare module 'vscode' {
  export enum ChatSessionStatus {
    Failed = 0,
    Completed = 1,
    InProgress = 2,
    NeedsInput = 3,
  }

  export interface ChatSessionItem {
    readonly resource: Uri;
    label: string;
    description?: string | MarkdownString;
    badge?: string | MarkdownString;
    status?: ChatSessionStatus;
    tooltip?: string | MarkdownString;
    archived?: boolean;
    timing?: {
      readonly created: number;
      readonly lastRequestStarted?: number;
      readonly lastRequestEnded?: number;
    };
  }

  export interface ChatSessionItemCollection extends Iterable<[Uri, ChatSessionItem]> {
    readonly size: number;
    replace(items: readonly ChatSessionItem[]): void;
    forEach(callback: (item: ChatSessionItem, collection: ChatSessionItemCollection) => unknown, thisArg?: unknown): void;
    add(item: ChatSessionItem): void;
    delete(resource: Uri): void;
    get(resource: Uri): ChatSessionItem | undefined;
  }

  export interface ChatSessionItemController {
    readonly id: string;
    dispose(): void;
    readonly items: ChatSessionItemCollection;
    createChatSessionItem(resource: Uri, label: string): ChatSessionItem;
    readonly refreshHandler: (token: CancellationToken) => Thenable<void>;
    newChatSessionItemHandler?: (context: {
      readonly request: { readonly prompt: string; readonly command?: string };
    }, token: CancellationToken) => Thenable<ChatSessionItem>;
    forkHandler?: (resource: Uri, request: unknown, token: CancellationToken) => Thenable<ChatSessionItem>;
  }

  export interface ChatSession {
    readonly title?: string;
    readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn2>;
    readonly requestHandler: ChatRequestHandler | undefined;
    readonly forkHandler?: (resource: Uri, request: unknown, token: CancellationToken) => Thenable<ChatSessionItem>;
  }

  export interface ChatSessionContentProvider {
    provideChatSessionContent(
      resource: Uri,
      token: CancellationToken,
      context: { readonly inputState?: { readonly groups: ReadonlyArray<{ id: string; selected?: { id: string } }> } }
    ): Thenable<ChatSession> | ChatSession;
    provideHandleOptionsChange?(
      resource: Uri,
      updates: ReadonlyArray<{ optionId: string; value: string | undefined }>,
      token: CancellationToken
    ): void;
    provideChatSessionProviderOptions?(token: CancellationToken): Thenable<ChatSessionProviderOptions>;
  }

  export interface ChatSessionProviderOptions {
    readonly optionGroups?: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly description?: string;
      readonly selected?: { readonly id: string; readonly name: string };
      readonly items: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description?: string }>;
    }>;
    readonly newSessionOptions?: Record<string, string>;
  }

  export interface ChatSessionCapabilities {
    supportsInterruptions?: boolean;
  }

  export class ChatResponseTurn2 {
    constructor(
      response: ReadonlyArray<ChatResponseMarkdownPart | ChatResponseFileTreePart | ChatResponseAnchorPart | ChatResponseCommandButtonPart>,
      result: ChatResult,
      participant: string,
      command?: string
    );
    readonly response: ReadonlyArray<unknown>;
    readonly result: ChatResult;
    readonly participant: string;
  }

  export namespace chat {
    export function createChatSessionItemController(
      chatSessionType: string,
      refreshHandler: (token: CancellationToken) => Thenable<void>
    ): ChatSessionItemController;

    export function registerChatSessionContentProvider(
      scheme: string,
      provider: ChatSessionContentProvider,
      chatParticipant: ChatParticipant,
      capabilities?: ChatSessionCapabilities
    ): Disposable;
  }
}
