# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**Apollo.io People API:**
- Apollo.io REST API — contact enrichment; search for people at a company by domain or name; returns verified emails, names, titles, and LinkedIn URLs
  - SDK/Client: native `fetch` (no Apollo SDK package)
  - Auth: `x-api-key` header using API key retrieved from Nango credential store
  - Endpoints used:
    - `GET https://api.apollo.io/v1/auth/health` — key validation (`src/index.ts` `validateApolloAPIKey`)
    - `POST https://api.apollo.io/api/v1/mixed_people/api_search` — people search (`src/index.ts` `searchApolloPeople`, `probeApolloPeopleSearch`)
  - Pagination: `page` / `per_page` (max 25 per request)
  - Plan guard: connector checks `peopleSearchAvailable` flag; blocks search if Apollo plan does not include People API Search

## Data Storage

**Databases:**
- Not applicable — this connector does not write to any database directly; results are returned to the caller without persistence

**Credential Storage:**
- Nango — stores the Apollo API key credential; accessed via injected `ApolloNangoCapability` dependency (`src/deps.ts`)
  - Provider slug: `"apollo"`
  - Connection: identified by `nango.providerConfigKeys.apollo` and `nango.connectionIds.apollo`
  - Operations: `ensureIntegration`, `importConnection`, `saveConnectionRecord`, `getCredentials`, `deleteConnection`, `clearConnectionRecords`
  - Concrete Nango impl is host-bound at boot via `registerApolloConnector(deps)` (`src/deps.ts`); connector carries no direct Nango package dependency

**Connector Config Storage:**
- Cinatra SDK generic config accessor — stores non-secret settings (logging flag, validation timestamps, people-search availability)
  - Read: `getExtensionConnectorConfig("@cinatra-ai/apollo-connector", "apollo", {})` (`src/index.ts`)
  - Write: `setExtensionConnectorConfig("@cinatra-ai/apollo-connector", "apollo", value)` (`src/index.ts`)

**File Storage:**
- Local filesystem — optional request/response API call logging to `APOLLO_API_LOG_DIRECTORY` (`src/log-directory.ts`)
  - Written via `node:fs/promises` (`mkdir`, `writeFile`)
  - Controlled by `loggingEnabled` setting (default: true)
  - Files named: `{ISO-timestamp}__{sanitized-label}__{request|response}.json`

**Caching:**
- None — all Apollo API calls use `cache: "no-store"`

## Authentication & Identity

**Auth Provider:**
- Nango (host-provided via dependency injection)
  - Implementation: API key stored in Nango as `{ type: "API_KEY", apiKey: string }`; connector retrieves it via `nango.getCredentials()` with optional `forceRefresh`
  - Save flow: key validated live against Apollo `/v1/auth/health` BEFORE writing to Nango; readback-verified after write; cinatra-side pointer saved only after successful round-trip
  - Auth guard on actions: `requireExtensionAction("@cinatra-ai/apollo-connector", "manage")` from `@cinatra-ai/sdk-extensions` (`src/actions.ts`) — restricts save/clear to org_owner/org_admin/platform_admin roles

## Monitoring & Observability

**Usage Metrics:**
- Cinatra `metric-usage-api` — usage events emitted via injected `emitUsage` dep (`src/deps.ts`)
  - Event shape: `{ source: "apollo", operation: "people_search", agentLabel, requestCount, resultCount, creditsConsumed, idempotencyKey, occurredAt }`
  - People API Search emits `creditsConsumed: 0` (api_search does not consume credits)
  - Concrete impl is host-bound at boot via `registerApolloConnector(deps)`

**Error Tracking:**
- Not detected — errors propagate as thrown `Error` instances to the host/caller

**Logs:**
- Optional filesystem logs of raw Apollo API request/response bodies (see File Storage above)

## CI/CD & Deployment

**Hosting:**
- Cinatra host monorepo (Next.js) — this repo is a source mirror extracted from the monorepo

**CI Pipeline:**
- GitHub Actions (`.github/workflows/ci.yml`, `.github/workflows/release.yml`)
  - CI validates that no first-party `@cinatra-ai/*` packages leaked into `dependencies`/`devDependencies`
  - Skips install/typecheck/test when first-party optional peerDeps are present (host monorepo owns those gates)
  - Node 24, corepack enabled

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None — all external calls are synchronous request/response fetch calls to Apollo.io REST API

## MCP Tool Surface

**MCP Tools registered** (`src/mcp/registry.ts`):
- `apollo_status` — connection status
- `apollo_administration_get` — admin info + feature availability
- `apollo_administration_logging` — logging settings
- `apollo_validate` — validate API key
- `apollo_people_search` — contact enrichment search (primary agent-facing tool)
- `apollo_jobs_execution_run` — worker: execute Ross Index import job
- `apollo_jobs_optimization_run` — worker: execute Ross Index optimization job

Registration: `createApolloModule()` (`src/mcp/module.ts`) returns `{ registerCapabilities }` which the host calls with an `ExtensionMcpToolServer` instance.

## Environment Configuration

**Required env vars:**
- None declared in this repo — all secrets flow through Nango credential storage (host-managed)

**Secrets location:**
- Apollo API key stored in Nango (host-managed external credential store); never persisted to connector config or env vars

---

*Integration audit: 2026-06-09*
