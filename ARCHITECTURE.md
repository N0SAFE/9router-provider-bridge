# Architecture

## Flow

```
VS Code Copilot Chat
        │  model picker / chat request
        ▼
BridgeProvider (src/extension.ts)
        │  resolve group: baseUrl + apiKey + mode
        │  (forwarded configuration → chatLanguageModels.json → settings)
        ▼
client.ts  fetchCatalog()
        │  GET /v1/bridge   (fallback: /v1/models + /v1/pools)
        ▼
catalog.ts  catalogModels(manifest, mode)
        │  provider models / combos / pool status → picker entries
        ▼
VS Code LanguageModelChatInformation[]
        │  user picks a model
        ▼
provider.ts  streamBridgeResponse()
        │  @ai-sdk/openai-compatible → POST /v1/chat/completions
        ▼
9Router  account pool → provider → upstream SSE
```

## Modules

| Module              | Responsibility                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `src/extension.ts`  | Activation, vendor id, status bar, commands, `BridgeProvider`, catalog cache.   |
| `src/catalog.ts`    | Discovery payload types and pure mapping to picker entries (no vscode).         |
| `src/client.ts`     | HTTP client for `/v1/bridge` and the `/v1/models` fallback (fetch injectable).  |
| `src/provider.ts`   | Message/tool conversion, streaming, usage and error classification.             |
| `src/gateway.ts`    | chatLanguageModels.json group resolution (baseUrl/apiKey/mode).                 |
| `src/logger.ts`     | Output panel logging, `logLevel` setting.                                       |
| `src/providerError.ts` | Upstream error body → readable single-line message.                         |
| `src/providerUtils.ts` | JSON schema simplification + tool result text extraction.                    |
| `src/toolInput.ts`  | Tool-call input/name normalization for Copilot's protocol.                      |
| `src/turnGuard.ts`  | Empty-turn retry policy (reasoning-only turns).                                 |
| `src/verboseFetch.ts` | Debug-level SSE logging fetch wrapper.                                        |

## Cache and refresh

- Catalogs are cached per `baseUrl + key-presence` with a 60s TTL and in-flight
  de-duplication. A failed refresh keeps the last good catalog.
- `warmUp()` runs at activation: it reads every group with this extension's
  vendor from `chatLanguageModels.json`, fetches each catalog and pre-builds the
  per-group model lists, then fires `onDidChangeLanguageModelChatInformation`
  only when the model ids changed.
- `provideLanguageModelChatInformation` returns the cached list immediately in
  `silent` mode and triggers a background refresh otherwise.

## No models without a provider group

VS Code asks every vendor for models twice: once without a configuration
(the vendor-wide query) and once per group configured in
`chatLanguageModels.json`. The bridge answers the vendor-wide query with an
empty list, so nothing appears and no credential is used until the user adds a
provider group from *Chat: Manage Language Models*.

Every group is an independent instance: its own `baseUrl`, `apiKey` and `mode`.
VS Code builds model identifiers as `vendor/group/modelId`, so several groups
can expose the same models with different keys/instances without colliding.
All models of a group are selectable; there is no allowlist and no global or
fallback API key.

## Why one AI SDK client

9Router exposes a single OpenAI-compatible endpoint and does its own
translation (Anthropic/Google/Responses inputs and outputs). The bridge always
speaks OpenAI chat completions with the model id exactly as the catalog
returned it (`<provider-alias>/<model>`, or a combo name). SDK retries are
disabled (`maxRetries: 0`) so the 9Router account pool owns fallback and
quota handling.

## Pools

Pools are not callable models. In `pools` mode the provider registers
non-selectable entries (id `pool:<alias>`) so they appear in the model
management UI, and pool health is additionally surfaced in:

- every provider model's `detail`/`tooltip`,
- the status bar,
- the `Show Pools` command.

The bridge never receives account ids, names or credentials — only counts.
