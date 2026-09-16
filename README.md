# 9Router Provider Bridge

Brings a [9Router](https://github.com/decolua/9router) instance into VS Code
Copilot's model picker. Unlike a plain OpenAI-compatible BYOK entry, this bridge
understands 9Router's discovery surface, so it can display:

- **Providers** — every routable model, grouped per provider, and only from
  providers that currently have an active connection.
- **Combos** — configured combos as selectable models, with per-model
  availability.
- **Pools** — per-provider account pool health (counts only, never credentials).

Account selection, quota redirects and combo fallback stay server-side in
9Router; the extension only picks a model id and streams the response.

## Requirements

- VS Code 1.120+ with Copilot Chat (language model providers are stable).
- A running 9Router instance. The default is `http://127.0.0.1:20128/v1`.
- An API key from 9Router if `requireApiKey` is enabled.

## Install

Marketplace build:

```sh
npm install
npm run package
code-insiders --install-extension 9router-provider-bridge-0.1.0.vsix
```

Local build (installs a `-local` variant side-by-side with any marketplace
build, vendor id `9router-provider-bridge-local`):

```sh
npm install
npm run install:local
```

## Configure

The extension exposes **no models until you add a provider group**. Add one or
more groups from the Command Palette → **Chat: Manage Language Models**, or by
hand in `chatLanguageModels.json`. Each group is an independent provider
instance with its own key and base URL, and every model it discovers becomes
selectable.

```jsonc
[
  // Provider models + combos from a 9Router instance.
  {
    "name": "9Router",
    "vendor": "9router-provider-bridge",
    "baseUrl": "http://127.0.0.1:20128/v1",
    "apiKey": "sk-..." // optional for local instances
  },

  // Combos only.
  {
    "name": "9Router Combos",
    "vendor": "9router-provider-bridge",
    "baseUrl": "http://127.0.0.1:20128/v1",
    "mode": "combos"
  },

  // Display-only account pool health per provider.
  {
    "name": "9Router Pools",
    "vendor": "9router-provider-bridge",
    "baseUrl": "http://127.0.0.1:20128/v1",
    "mode": "pools"
  }
]
```

Add several groups (different names) to use several 9Router instances or
accounts side by side — each group keeps its own key and configuration. Remove
every group and the picker is empty again.

### Modes

| `mode`      | Picker content                                                            |
| ----------- | ------------------------------------------------------------------------- |
| `all`       | Provider models (active providers only) plus combos. Default.             |
| `providers` | Provider models only. Model names are prefixed with the provider name.   |
| `combos`    | Combos only, limits resolved from their member models.                    |
| `pools`     | One non-selectable entry per pool showing accounts/cooldowns/strategy.    |

Provider models carry `maxInputTokens`/`maxOutputTokens` from 9Router's
catalog and image/tool capabilities. Every model's tooltip shows its pool
health, so you can see cooling accounts before a request fails over.

## Commands

| Command                              | Description                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `9Router Bridge: Configure Provider` | Pick a group's mode, provider filter and model filter.             |
| `9Router Bridge: Refresh Models`     | Clears the cache and re-reads 9Router.                             |
| `9Router Bridge: Show Status`        | Catalog counts + per-pool summary.                                 |
| `9Router Bridge: Show Pools`         | Quick pick with full pool details.                                 |

### Filtering a provider group

`9Router Bridge: Configure Provider` edits the selected group entry in
`chatLanguageModels.json`:

1. **Content** — providers + combos, providers only, combos only, or pools.
2. **Providers** — *All providers* or *Choose providers…* (e.g. only
   `openrouter-free` or only `oc`); selecting every provider stores no filter.
3. **Models** — *All models* or *Choose models…*; selecting every model stores
   no filter.

Filters are stored as optional `providers` / `models` arrays on the group.
Leave them out and everything 9Router exposes is available. When a new provider
group is added (for example from *Add Model* in Manage Models), the bridge
offers to run the same configuration flow for it.

Providers that expose both free and paid models (OpenRouter) appear as two
picker groups — `OpenRouter` and `OpenRouter Free` — sharing the same routing
ids. Free/public providers (OpenCode Free, alias `oc`) appear without any
account and are labelled in their tooltip; models retired upstream (HTTP 410)
are removed from the picker automatically when a request hits them.

## Settings

| Setting                              | Default                        | Description                                    |
| ------------------------------------ | ------------------------------ | ---------------------------------------------- |
| `9router-provider-bridge.baseUrl`    | `http://127.0.0.1:20128/v1`    | Used when a group does not set its own `baseUrl`. |
| `9router-provider-bridge.logLevel`   | `info`                         | Output panel verbosity (`9Router Bridge`).     |

## Discovery endpoints

The bridge uses 9Router's read-only discovery API:

| Endpoint            | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `GET /v1/bridge`    | One-call manifest: modes + providers + combos + pools.      |
| `GET /v1/providers` | Active providers with their routable models.                |
| `GET /v1/combos`    | Combos with per-model availability.                         |
| `GET /v1/pools`     | Pool health as counts only.                                 |

Older 9Router builds without `/v1/bridge` fall back to `/v1/models`
(+ `/v1/pools` when present).

## Development

```sh
npm run compile      # type-check + lint + esbuild bundle
npm test             # node:test suite (pure modules)
npm run install:local
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map.

## License

MIT
