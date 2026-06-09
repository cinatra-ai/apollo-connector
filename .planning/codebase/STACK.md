# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- TypeScript (ES2023 target) — all source files under `src/` (.ts and .tsx)

**Secondary:**
- TSX (React JSX) — UI components under `src/components/ui/` and `src/widgets/`

## Runtime

**Environment:**
- Node.js 24 (pinned in `.github/workflows/ci.yml` via `setup-node`)

**Package Manager:**
- npm with corepack enabled (CI: `corepack enable`)
- Lockfile: `.npmrc` present (`auto-install-peers=false`); no lockfile committed (source-mirror repo)

## Frameworks

**Core:**
- React 19 (peerDependency `^19.2.3`) — UI rendering for settings pages and widgets

**Build/Dev:**
- TypeScript compiler — `tsconfig.json` configured with `outDir: dist`, `rootDir: src`, ESNext modules, bundler module resolution
- No bundler config detected in repo (bundler resolution delegated to host monorepo)

**Testing:**
- Not detected in this repo — CI explicitly skips install/typecheck/test for repos with first-party optional peerDependencies; tests run in the host monorepo
- One test file exists: `src/__tests__/sync-and-readback.test.ts` (runs in host context)

## Key Dependencies

**Critical (runtime `dependencies`):**
- `zod ^4.3.6` — schema validation for form data (`src/actions.ts`) and MCP tool input schemas (`src/mcp/registry.ts`, `src/mcp/handlers.ts`)
- `class-variance-authority ^0.7.1` — component variant styling (`src/components/ui/`)
- `clsx ^2.1.1` — conditional className composition (`src/lib/utils.ts`)
- `tailwind-merge ^3.5.0` — Tailwind class merging (`src/lib/utils.ts`)
- `radix-ui ^1.4.3` — headless UI primitives (used in UI components)
- `lucide-react ^1.7.0` — icon set for UI components

**Optional peerDependencies (host-provided):**
- `@cinatra-ai/sdk-extensions *` — connector config accessors (`getExtensionConnectorConfig`, `setExtensionConnectorConfig`, `requireExtensionAction`) and MCP types (`ExtensionMcpToolServer`); imported in `src/index.ts`, `src/actions.ts`, `src/mcp/registry.ts`
- `@cinatra-ai/sdk-ui *` — `WidgetManifest` type; imported in `src/widgets/manifest.ts`

**Required peerDependencies:**
- `react ^19.2.3`
- `react-dom ^19.2.3`

## Configuration

**Environment:**
- No `.env` files present in repo
- API key stored at runtime via Nango credential storage (not env vars); retrieved through `getApolloDeps().nango.getCredentials()`
- Connector configuration (logging enabled, validation timestamps) stored via SDK generic accessor `getExtensionConnectorConfig`/`setExtensionConnectorConfig`

**Build:**
- `tsconfig.json` — strict mode, `verbatimModuleSyntax`, `isolatedModules`, declarations + source maps emitted to `dist/`
- `package.json` — `"type": "module"` (ESM), entry: `src/index.ts` (types and main point directly to source; host monorepo compiles)

**Cinatra connector metadata** (in `package.json` under `"cinatra"` key):
- `apiVersion: cinatra.ai/v1`
- `kind: connector`
- `displayName: Apollo`

## Platform Requirements

**Development:**
- Node.js 24+
- corepack enabled
- Host monorepo workspace required for `@cinatra-ai/sdk-extensions` and `@cinatra-ai/sdk-ui` (not published to registry)

**Production:**
- Deployed as part of the Cinatra host monorepo (Next.js app)
- Server actions use `"use server"` directive (`src/actions.ts`) — requires Next.js runtime
- MCP module (`src/mcp/module.ts`) registers tools on an `ExtensionMcpToolServer` provided by the host

---

*Stack analysis: 2026-06-09*
