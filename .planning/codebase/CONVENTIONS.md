# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- `kebab-case` for all source files: `src/log-directory.ts`, `src/save-apollo-form.tsx`, `src/settings-page.tsx`
- `kebab-case` for directories: `src/components/ui/`, `src/mcp/`, `src/widgets/`
- Test files placed under `src/__tests__/` with suffix `.test.ts`: `src/__tests__/sync-and-readback.test.ts`

**Functions:**
- `camelCase` for all exported and internal functions: `getApolloAPISettings`, `saveApolloAPISettings`, `syncApolloAPISettingsToNango`, `registerApolloConnector`, `createApolloPrimitiveHandlers`
- Prefix `get` for read operations: `getApolloAPIStatus`, `getConfiguredApolloAPIKey`, `getApolloDeps`
- Prefix `save`/`write`/`set` for write operations: `saveApolloAPISettings`, `saveConnectionRecord`, `writeSettings`
- Prefix `clear`/`delete` for removal operations: `clearApolloAPISettings`, `deleteConnection`
- `_` prefix for test-only reset helpers to signal internals: `_resetApolloDepsForTests`, `_resetExtensionConnectorConfigStoreForTests`

**Variables:**
- `SCREAMING_SNAKE_CASE` for module-level constants: `APOLLO_PACKAGE_ID`, `APOLLO_CONFIG_KEY`, `PROVIDER_CONFIG_KEY`, `CONNECTION_ID`
- `camelCase` for local variables: `trimmedKey`, `readbackKey`, `savedConnection`, `nextSettings`

**Types/Interfaces:**
- `PascalCase` for exported types and interfaces: `ApolloAPISettings`, `ApolloConnectorDeps`, `ApolloNangoCapability`, `ApolloUsageEventInput`
- Type aliases preferred for simple object shapes: `ApolloAPISettings` is a `type`, not `interface`
- Interfaces used for structural capability shapes: `ApolloNangoCapability`, `ApolloConnectorDeps`

**Zod Schemas:**
- `camelCase` + `Schema` suffix: `apolloConnectorSchema`, `validateKeySchema`, `peopleSearchSchema` in `src/mcp/handlers.ts`, `src/actions.ts`

## Code Style

**Formatting:**
- No Prettier or ESLint config file detected in repo root (the connector is a source mirror; the host monorepo owns formatting tooling)
- TypeScript `strict: true` enforced in `tsconfig.json`
- `noImplicitAny: false` (relaxed from strict default)
- `verbatimModuleSyntax: true` — `import type` used consistently for type-only imports: `import type { HostRequiredPackageDefinition }`, `import type { ExtensionPrimitiveRequest }`
- `isolatedModules: true` — all files are self-contained modules

**Linting:**
- Not detected as a standalone config; CI enforces TypeScript compile correctness via `tsc --noEmit`

## Import Organization

**Order (observed in `src/index.ts`):**
1. Node built-ins: `import { mkdir, writeFile } from "node:fs/promises"`, `import path from "node:path"`
2. Internal relative imports: `import { APOLLO_API_LOG_DIRECTORY } from "./log-directory"`, `import { getApolloDeps } from "./deps"`
3. External SDK peer imports: `import type { HostRequiredPackageDefinition } from "@cinatra-ai/sdk-extensions"`

**Path Aliases:**
- None detected. All imports use relative paths (`./`, `../`) or bare specifiers for packages.

**`node:` Protocol:**
- Node built-ins always use explicit `node:` prefix: `node:fs/promises`, `node:crypto`, `node:path`

## Error Handling

**Patterns:**
- Functions throw `new Error(message)` on failure; callers are expected to catch or let it propagate
- Error messages are user-readable prose, never include raw secret values — enforced by design (test `src/__tests__/sync-and-readback.test.ts` asserts error messages do NOT contain the API key)
- Generic error messages used for security-sensitive failures: `"Nango credential verification failed: the readback value did not match the saved Apollo API key."` (no token included)
- Server actions re-wrap errors: `catch (error) { const message = error instanceof Error ? error.message : "Unable to save the Apollo API connection."; throw new Error(message); }` — see `src/actions.ts`
- Defensive type narrowing before credential access: `credentials && typeof credentials === "object" && "apiKey" in credentials && typeof credentials.apiKey === "string"` in `src/index.ts`
- `parseJsonResponseBody` returns `null` on parse failure instead of throwing, letting callers use `??` fallbacks

## Logging

**Framework:** `node:fs/promises` — writes JSON log files to filesystem

**Patterns:**
- Gated by `isApolloLoggingEnabled()` (reads `loggingEnabled` from connector config)
- Helper `writeApolloLogFile({ label, kind: "request" | "response", body })` in `src/index.ts`
- Log files named by ISO timestamp + sanitized label + kind: `2026-06-09T...--apollo-auth-health--request.json`
- `sanitizeLogLabel` strips non-alphanumeric characters, limits to 80 chars
- Logging is a no-op under tests (seed `loggingEnabled: false` in `beforeEach`)

## Comments

**When to Comment:**
- Inline comments explain security-critical invariants and non-obvious ordering constraints — e.g., the 3-step save sequence in `src/index.ts` lines 287–302
- Comment blocks at the top of files describe module purpose, host-coupling rationale, and what is NOT imported: `src/deps.ts` header, `src/__tests__/sync-and-readback.test.ts` header
- JSDoc `/** */` used for exported functions where the contract is non-obvious: `saveApolloConnectionPointer`, `searchApolloPeople`
- In-test comments explain the security property being verified

**JSDoc/TSDoc:**
- Used selectively on non-obvious public functions, not on every export
- `@internal` tag used to mark test-only exports: `/** @internal test-only. */` on `_resetApolloDepsForTests`

## Function Design

**Size:** Functions are kept focused; the longest (`saveApolloAPISettings`, `searchApolloPeople`) are well-commented multi-step operations with clear sequential structure

**Parameters:** Input objects preferred over positional params for any function with 2+ logical inputs: `saveApolloAPISettings({ apiKey, loggingEnabled })`, `searchApolloPeople({ organizationDomains, personTitles, ... })`

**Return Values:**
- Async functions return `Promise<T>` explicitly typed via inference
- Status functions return discriminated union objects with a `status` literal: `{ status: "connected" | "incomplete" | "not_connected", detail: string }`
- Nullable returns are `null` (not `undefined`) when a value is expected but absent

## Module Design

**Exports:**
- `src/index.ts` is the public API surface; internal helpers (`readSettings`, `writeSettings`, `sanitizeLogLabel`, `buildLogTimestamp`, etc.) are NOT exported
- Dependency injection surface (`registerApolloConnector`, `getApolloDeps`) re-exported from `src/index.ts` for host consumption
- `src/deps.ts` exports interfaces and the DI registration functions; never exports runtime business logic

**Dependency Injection Pattern:**
- Host-coupled services (Nango, usage emission) are injected via `registerApolloConnector(deps)` and stored on `globalThis` via a namespaced `Symbol.for(...)` key (versioned: `@cinatra-ai/apollo-connector:host-deps/v1`)
- This allows separately-compiled Next.js bundles to resolve the same dep slot — see `src/deps.ts` for full rationale
- Connector-config read/write uses the SDK generic accessor (`getExtensionConnectorConfig`/`setExtensionConnectorConfig`), NOT injected deps

**Barrel Files:**
- `src/widgets/index.ts` used as a barrel for the widgets subtree
- `src/index.ts` is the connector's main public barrel

---

*Convention analysis: 2026-06-09*
