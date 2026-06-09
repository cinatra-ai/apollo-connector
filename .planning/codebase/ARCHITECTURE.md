<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌──────────────────────────────────────────────────────────────────┐
│                   Host Application (Next.js)                      │
│   Setup Page (`src/setup-page.tsx`)                               │
│   Settings Page (`src/settings-page.tsx`)                         │
│   Client Form (`src/save-apollo-form.tsx`)                        │
│   Server Actions (`src/actions.ts`)                               │
└────────────┬──────────────────────────────────────────────────────┘
             │ imports
             ▼
┌──────────────────────────────────────────────────────────────────┐
│              Core Connector Logic (`src/index.ts`)                 │
│  getApolloAPISettings / saveApolloAPISettings                      │
│  validateApolloAPIKey / searchApolloPeople                         │
│  getApolloAPIStatus / clearApolloAPISettings                       │
│  syncApolloAPISettingsToNango / saveApolloConnectionPointer        │
└──────────┬─────────────────────────┬────────────────────────────┘
           │                         │
           ▼                         ▼
┌────────────────────┐   ┌───────────────────────────────────────┐
│  Deps Injection    │   │  MCP Tool Layer (`src/mcp/`)           │
│  (`src/deps.ts`)   │   │  handlers.ts → registry.ts → module.ts│
│  ApolloNangoCapability  └───────────────────────────────────────┘
│  emitUsage fn      │
└────────┬───────────┘
         │ runtime
         ▼
┌──────────────────────────────────────────────────────────────────┐
│   Host Services (injected at boot via registerApolloConnector)    │
│   - nango-connector (credential storage, Nango API)               │
│   - metric-usage-api (usage event emission)                       │
│   - @cinatra-ai/sdk-extensions (connector-config read/write)      │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│   External: Apollo.io REST API (api.apollo.io)                    │
│   - GET /v1/auth/health                                           │
│   - POST /api/v1/mixed_people/api_search                          │
└──────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Core connector | API key lifecycle, people search, status, logging | `src/index.ts` |
| Dependency injection | Injects Nango + emitUsage; globalThis Symbol slot | `src/deps.ts` |
| MCP handlers | Validates input schemas, delegates to core, derives agent label | `src/mcp/handlers.ts` |
| MCP registry | Registers handlers as MCP tools with descriptions | `src/mcp/registry.ts` |
| MCP module factory | Creates the module object consumed by the host's MCP server | `src/mcp/module.ts` |
| Server actions | Next.js "use server" actions for save/clear, auth-gated | `src/actions.ts` |
| Client form | React "use client" form wrapper; calls server action; shows notifications | `src/save-apollo-form.tsx` |
| Setup page | Host dispatch-route entry; delegates to settings-page | `src/setup-page.tsx` |
| Settings page | Full settings UI component | `src/settings-page.tsx` |
| Widget manifest | Declares the widget ID/description for the SDK-UI widget registry | `src/widgets/manifest.ts` |
| Widget entry | People-search widget component | `src/widgets/people-search-widget.tsx` |
| Log directory | Dependency-free leaf constant for the filesystem log path | `src/log-directory.ts` |
| UI components | Shared Radix/Tailwind-based primitives (button, input, table, etc.) | `src/components/ui/` |

## Pattern Overview

**Overall:** Dependency-injected connector with MCP tool exposure

**Key Characteristics:**
- The connector carries zero non-SDK `@cinatra-ai/*` code dependencies; host services are injected at boot via `registerApolloConnector(deps)` in `src/deps.ts`.
- Host deps are anchored to `globalThis` via a namespaced+versioned Symbol (`@cinatra-ai/apollo-connector:host-deps/v1`) so separately-compiled Next.js bundles resolve the same slot.
- Credential flow follows a strict validate-first, write-then-readback-then-save-pointer sequence to prevent stale or invalid credentials from appearing connected.
- MCP tools are registered through a registry pattern (`registry.ts` iterates over a handler map) separate from business logic.
- Connector-config (non-sensitive metadata) flows through the SDK generic accessor (`getExtensionConnectorConfig` / `setExtensionConnectorConfig`); sensitive credentials flow through Nango.

## Layers

**UI Layer:**
- Purpose: Connector setup and settings pages rendered inside the host Next.js app
- Location: `src/setup-page.tsx`, `src/settings-page.tsx`, `src/save-apollo-form.tsx`
- Contains: React server and client components, form handling, notifications
- Depends on: `src/actions.ts`, `@cinatra-ai/sdk-ui`
- Used by: Host app's /configuration/llm/apollo route

**Action Layer:**
- Purpose: Next.js "use server" actions that authorize and delegate to core
- Location: `src/actions.ts`
- Contains: `saveApolloConnectionAction`, `clearApolloConnectionAction`
- Depends on: `src/index.ts`, `@cinatra-ai/sdk-extensions` (requireExtensionAction)
- Used by: `src/save-apollo-form.tsx`

**Core Connector Layer:**
- Purpose: All Apollo business logic — key lifecycle, people search, logging, status
- Location: `src/index.ts`
- Contains: Exported functions for settings, validation, search, sync, pointer save
- Depends on: `src/deps.ts`, `src/log-directory.ts`, `@cinatra-ai/sdk-extensions`
- Used by: `src/actions.ts`, `src/mcp/handlers.ts`, host agents

**MCP Tool Layer:**
- Purpose: Exposes connector capabilities as MCP tools for agent/LLM consumption
- Location: `src/mcp/handlers.ts`, `src/mcp/registry.ts`, `src/mcp/module.ts`
- Contains: Zod input schemas, handler functions, tool registration, module factory
- Depends on: `src/index.ts`, `@cinatra-ai/sdk-extensions`
- Used by: Host MCP server at boot

**Dependency Injection Layer:**
- Purpose: Decouples connector from host internals; provides the Nango and emitUsage surfaces
- Location: `src/deps.ts`
- Contains: `ApolloConnectorDeps` interface, `registerApolloConnector`, `getApolloDeps`, globalThis slot
- Depends on: Nothing (types only)
- Used by: `src/index.ts` (runtime), host boot code (registration)

**Widget Layer:**
- Purpose: SDK-UI widget for people-search, declarable in the workspace UI
- Location: `src/widgets/`
- Contains: `connectorApolloManifest`, `people-search-widget.tsx`, barrel `index.ts`
- Depends on: `@cinatra-ai/sdk-ui`

**UI Primitives:**
- Purpose: Reusable Radix/Tailwind components used by settings and widget pages
- Location: `src/components/ui/`
- Contains: button, input, field, label, alert, table, paginated-table, pagination, separator

## Data Flow

### API Key Save (Primary Path)

1. User submits form in `src/save-apollo-form.tsx` (`handleSubmit`)
2. `saveApolloConnectionAction(formData)` in `src/actions.ts` — authorizes via `requireExtensionAction`
3. `saveApolloAPISettings({ apiKey })` in `src/index.ts`
4. `validateApolloAPIKey(apiKey)` — live GET `https://api.apollo.io/v1/auth/health`
5. `probeApolloPeopleSearch(apiKey)` — live POST `https://api.apollo.io/api/v1/mixed_people/api_search`
6. `syncApolloAPISettingsToNango({ apiKey })` — `ensureIntegration` → `importConnection` → forceRefresh readback → verify match
7. `saveApolloConnectionPointer()` — `nango.saveConnectionRecord("apollo", ...)` — pointer saved LAST
8. `writeSettings(nextSettings)` — persists metadata (no raw apiKey) via SDK config accessor

### People Search (Agent/MCP Path)

1. MCP tool call `apollo_people_search` arrives at `src/mcp/registry.ts`
2. `createApolloPrimitiveHandlers()["apollo_people_search"]` in `src/mcp/handlers.ts`
3. Input validated via `peopleSearchSchema` (Zod)
4. `searchApolloPeople(input)` in `src/index.ts`
5. `getConfiguredApolloAPIKey()` — checks saved pointer → reads from Nango
6. POST `https://api.apollo.io/api/v1/mixed_people/api_search`
7. `getApolloDeps().emitUsage(...)` — usage event emitted to metric-usage-api
8. Result returned to MCP caller as structured JSON

**State Management:**
- Sensitive credentials: stored exclusively in Nango (via `ApolloNangoCapability`)
- Non-sensitive metadata (lastValidatedAt, peopleSearchAvailable, loggingEnabled): stored via SDK generic config accessor (`getExtensionConnectorConfig` / `setExtensionConnectorConfig`)
- Runtime deps: stored on `globalThis` via Symbol key

## Key Abstractions

**ApolloConnectorDeps:**
- Purpose: Structural interface that decouples the connector from host internals
- Examples: `src/deps.ts`
- Pattern: Dependency injection via `registerApolloConnector(deps)` at host boot; runtime access via `getApolloDeps()`

**ApolloNangoCapability:**
- Purpose: Inlined structural mirror of the Nango surface the connector requires; avoids a code dependency on `@cinatra-ai/nango-connector`
- Examples: `src/deps.ts`
- Pattern: Structural typing — host passes any object that satisfies the interface

**MCP Tool Handler Map:**
- Purpose: Named handler functions keyed by tool name, separate from registration metadata
- Examples: `src/mcp/handlers.ts` (`createApolloPrimitiveHandlers`)
- Pattern: Factory function returns a const map; `registry.ts` iterates and registers each

## Entry Points

**Connector Registration (host boot):**
- Location: `src/index.ts` (re-exports `registerApolloConnector` from `src/deps.ts`)
- Triggers: Host calls `registerApolloConnector(deps)` once at startup
- Responsibilities: Wires Nango + emitUsage into the globalThis slot

**MCP Module (host MCP server):**
- Location: `src/mcp/module.ts` (`createApolloModule`)
- Triggers: Host MCP server calls `module.registerCapabilities(server)`
- Responsibilities: Registers all Apollo MCP tools on the server instance

**Setup Page (Next.js route):**
- Location: `src/setup-page.tsx`
- Triggers: Host routes /connectors/cinatra-ai/apollo-connector/setup here
- Responsibilities: Renders the settings UI for API key entry/management

**Public API (package consumers):**
- Location: `src/index.ts`
- Triggers: Import by host or agents
- Responsibilities: Exposes `searchApolloPeople`, `getApolloAPIStatus`, settings functions, `apolloAPIConnectionPackage` descriptor

## Architectural Constraints

- **No sibling extension imports:** The connector must never import from `@cinatra-ai/nango-connector` or other non-SDK `@cinatra-ai/*` packages. All host surfaces are injected via `src/deps.ts`.
- **Credential pointer gate:** `getConfiguredApolloAPIKey` requires a saved cinatra-side pointer (`getPrimarySavedConnection`). Credentials are never read off deterministic IDs without a verified pointer.
- **Validate-before-write ordering:** Apollo live validation (`/v1/auth/health`) must run before any Nango write so a bad key never overwrites a valid existing credential.
- **Global state:** One globalThis Symbol slot in `src/deps.ts` holds the host deps. All other state is in the SDK config store or Nango.
- **ESM module:** `"type": "module"` in `package.json`; all imports use ESM syntax.
- **Circular imports:** `src/log-directory.ts` is a dependency-free leaf specifically to break potential ESM init-order cycles.

## Anti-Patterns

### Importing @cinatra-ai/* siblings directly

**What happens:** Adding `import { something } from "@cinatra-ai/nango-connector"` in any connector file.
**Why it's wrong:** Creates a hard code dependency; the connector must work without the sibling being present. Host injects the capability at boot.
**Do this instead:** Add the needed surface to `ApolloNangoCapability` in `src/deps.ts` and read it via `getApolloDeps().nango`.

### Saving the Nango pointer before readback verification

**What happens:** Calling `nango.saveConnectionRecord` inside `syncApolloAPISettingsToNango` before comparing the readback value.
**Why it's wrong:** A no-op Nango write (key silently unchanged) or mismatch leaves a pointer pointing to an invalid credential, making Apollo appear connected with a stale key.
**Do this instead:** Save the pointer in `saveApolloConnectionPointer()` called from `saveApolloAPISettings`, only after `syncApolloAPISettingsToNango` completes successfully and live Apollo validation passes.

## Error Handling

**Strategy:** Throw `Error` with human-readable messages; callers catch and surface to the UI via `useNotify` (client) or re-throw (server actions).

**Patterns:**
- Apollo API errors: parse JSON body candidates via `parseJsonResponseBody`, extract `message`/`error` field, fall back to generic strings
- Nango readback mismatch: throw generic "verification failed" message with no credential values in the message text
- Deps not registered: `getApolloDeps()` throws with an explicit boot instruction message
- Feature gating: `searchApolloPeople` throws if `peopleSearchAvailable === false` (plan restriction)

## Cross-Cutting Concerns

**Logging:** Optional file-based logging to `data/logs/apollo-api/` (configurable via `loggingEnabled` setting). Each request/response pair is written as timestamped JSON files via `writeApolloLogFile`. Controlled by `src/log-directory.ts` (leaf constant) and `isApolloLoggingEnabled()` in `src/index.ts`.
**Validation:** All MCP tool inputs validated with Zod schemas defined in `src/mcp/handlers.ts`. Form data in server actions validated with Zod in `src/actions.ts`.
**Authentication:** Server actions gated by `requireExtensionAction(APOLLO_PACKAGE_ID, "manage")` from `@cinatra-ai/sdk-extensions`. API key stored in Nango, never in plain connector config.

---

*Architecture analysis: 2026-06-09*
