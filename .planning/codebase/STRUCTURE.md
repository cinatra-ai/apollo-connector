# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
apollo-connector/
├── src/
│   ├── index.ts                    # Public API: core connector logic (entry point)
│   ├── deps.ts                     # Dependency injection: ApolloConnectorDeps, globalThis slot
│   ├── actions.ts                  # Next.js "use server" actions (save/clear)
│   ├── setup-page.tsx              # Host dispatch-route component (delegates to settings-page)
│   ├── settings-page.tsx           # Full settings UI (Apollo API key management)
│   ├── save-apollo-form.tsx        # "use client" form wrapper with notification handling
│   ├── log-directory.ts            # Dependency-free leaf: APOLLO_API_LOG_DIRECTORY constant
│   ├── mcp/
│   │   ├── module.ts               # createApolloModule() — MCP module factory
│   │   ├── registry.ts             # registerApolloPrimitives() — iterates handler map
│   │   └── handlers.ts             # createApolloPrimitiveHandlers() + Zod schemas
│   ├── widgets/
│   │   ├── manifest.ts             # connectorApolloManifest (SDK-UI widget descriptor)
│   │   ├── people-search-widget.tsx # People-search widget component
│   │   └── index.ts                # Barrel: re-exports manifest + widget
│   ├── components/
│   │   └── ui/
│   │       ├── button.tsx          # Button primitive (CVA + Radix)
│   │       ├── input.tsx           # Input primitive
│   │       ├── field.tsx           # Form field wrapper
│   │       ├── label.tsx           # Label primitive
│   │       ├── alert.tsx           # Alert/banner primitive
│   │       ├── table.tsx           # Table primitive
│   │       ├── paginated-table.tsx # Table with built-in pagination
│   │       ├── pagination.tsx      # Pagination controls
│   │       └── separator.tsx       # Horizontal separator
│   └── __tests__/
│       └── sync-and-readback.test.ts  # Vitest tests for credential write-readback chain
├── package.json                    # Package manifest (cinatra.ai/v1 connector descriptor)
├── tsconfig.json                   # TypeScript configuration
├── .npmrc                          # npm registry config
├── LICENSE                         # Apache-2.0
├── README.md                       # Connector documentation
└── .github/
    └── workflows/
        ├── ci.yml                  # CI pipeline
        └── release.yml             # Release pipeline
```

## Directory Purposes

**`src/` (root):**
- Purpose: All connector source; top-level files are the connector's public API and host-facing UI surface
- Contains: `index.ts` (public API), `deps.ts` (DI), `actions.ts` (server actions), React pages and forms
- Key files: `src/index.ts`, `src/deps.ts`, `src/actions.ts`

**`src/mcp/`:**
- Purpose: MCP (Model Context Protocol) tool registration layer
- Contains: Module factory, registry, typed handlers with Zod schemas
- Key files: `src/mcp/handlers.ts` (schemas + business delegation), `src/mcp/registry.ts` (registration loop), `src/mcp/module.ts` (factory)

**`src/widgets/`:**
- Purpose: SDK-UI widget declarations for the Cinatra workspace widget system
- Contains: Widget manifest and the people-search widget component
- Key files: `src/widgets/manifest.ts`, `src/widgets/people-search-widget.tsx`

**`src/components/ui/`:**
- Purpose: Shared Radix/Tailwind UI primitives used across settings and widget pages
- Contains: Headless-style components (button, input, table, pagination, alert, etc.)
- Generated: No — hand-authored

**`src/__tests__/`:**
- Purpose: Unit and integration tests (Vitest)
- Contains: `sync-and-readback.test.ts` — tests the credential save/verify/pointer chain with mocked Nango deps

## Key File Locations

**Entry Points:**
- `src/index.ts`: Connector public API — functions exported for use by host, agents, and actions
- `src/mcp/module.ts`: MCP module factory consumed by the host MCP server at boot
- `src/setup-page.tsx`: Next.js page component for the connector setup route

**Configuration:**
- `package.json`: Declares `cinatra.apiVersion`, `kind: connector`, `displayName: Apollo`
- `tsconfig.json`: TypeScript settings
- `.npmrc`: npm registry configuration

**Core Logic:**
- `src/index.ts`: All Apollo business logic (key lifecycle, search, logging, status)
- `src/deps.ts`: Dependency injection interfaces and globalThis registration

**Testing:**
- `src/__tests__/sync-and-readback.test.ts`: Vitest tests with mocked Nango capability

## Naming Conventions

**Files:**
- kebab-case for all source files: `save-apollo-form.tsx`, `log-directory.ts`, `people-search-widget.tsx`
- `setup-page.tsx` / `settings-page.tsx` — page-level React components
- `actions.ts` — Next.js server actions file
- `deps.ts` — dependency injection module
- `index.ts` — barrel/entry point files in each directory

**Directories:**
- lowercase, short nouns: `mcp/`, `widgets/`, `components/`, `ui/`
- `__tests__/` — test directory using Jest/Vitest convention

**Exports:**
- PascalCase for React components: `SaveApolloForm`, `ApolloConnectorSetupPage`, `ApolloSettingsPage`
- camelCase for functions: `registerApolloConnector`, `getApolloDeps`, `saveApolloAPISettings`, `searchApolloPeople`
- SCREAMING_SNAKE_CASE for constants: `APOLLO_API_LOG_DIRECTORY`, `APOLLO_PACKAGE_ID`, `APOLLO_CONFIG_KEY`
- PascalCase for interfaces and types: `ApolloConnectorDeps`, `ApolloNangoCapability`, `ApolloAPISettings`

## Where to Add New Code

**New Apollo API operation (e.g. company enrichment):**
- Core logic: `src/index.ts` — add the fetch function and export it
- MCP exposure: add Zod schema + handler to `src/mcp/handlers.ts`, add tool metadata to `TOOL_META` in `src/mcp/registry.ts`
- Usage emission: call `getApolloDeps().emitUsage(...)` with the appropriate operation string

**New UI component:**
- If shared/reusable: `src/components/ui/<component-name>.tsx`
- If connector-specific: directly in `src/settings-page.tsx` or a co-located file

**New widget:**
- Widget component: `src/widgets/<name>-widget.tsx`
- Manifest entry: add to or alongside `src/widgets/manifest.ts`
- Barrel export: add to `src/widgets/index.ts`

**New host dep surface:**
- Add method to `ApolloNangoCapability` or `ApolloConnectorDeps` in `src/deps.ts`
- Use via `getApolloDeps().<field>` in `src/index.ts`

**Tests:**
- Location: `src/__tests__/<describe-what-is-tested>.test.ts`
- Framework: Vitest with `vi.fn()` mocks; register deps via `registerApolloConnector` in `beforeEach`

## Special Directories

**`.github/workflows/`:**
- Purpose: CI and release automation
- Generated: No
- Committed: Yes

**`.planning/codebase/`:**
- Purpose: GSD codebase map documents for planning and execution guidance
- Generated: Yes (by gsd-map-codebase)
- Committed: Typically yes (project planning artifact)

---

*Structure analysis: 2026-06-09*
