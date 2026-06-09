# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Vitest (inferred from `import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"` in `src/__tests__/sync-and-readback.test.ts`)
- No vitest config file detected in the repo root; configuration is expected to be provided by the host monorepo at runtime
- The connector is a source mirror — CI explicitly skips standalone test execution when host-internal `@cinatra-ai/*` peers are declared (see `.github/workflows/ci.yml`). Tests run inside the host monorepo workspace.

**Assertion Library:**
- Vitest built-in (`expect`, matchers from `vitest`)

**Run Commands:**
```bash
# These run in the host monorepo workspace, not standalone:
pnpm test                 # Run all tests (via host monorepo)
pnpm test --if-present    # CI invocation (standalone, skipped for source mirrors)
```

## Test File Organization

**Location:**
- Separate `src/__tests__/` directory (not co-located with source files)

**Naming:**
- `<description>.test.ts` pattern: `sync-and-readback.test.ts`
- Test file name describes the security/behavioral property being verified, not just the module name

**Structure:**
```
src/
└── __tests__/
    └── sync-and-readback.test.ts   # Integration-style tests for credential write-then-readback chain
```

## Test Structure

**Suite Organization:**
```typescript
describe("syncApolloAPISettingsToNango — readback-safe (no pointer write)", () => {
  it("import (no connectorKey) → forceRefresh readback → compare; does NOT save the pointer", async () => { ... });
  it("readback mismatch THROWS a generic error (no token in message)", async () => { ... });
  it("readback null THROWS the same generic error", async () => { ... });
  it("input apiKey is trimmed before import + compare (whitespace-tolerant)", async () => { ... });
  it("isConfigured=false returns early (no Nango calls)", async () => { ... });
});

describe("getConfiguredApolloAPIKey — requires a verified saved pointer", () => { ... });

describe("saveApolloAPISettings — validate-first, pointer saved LAST", () => { ... });
```

**Patterns:**
- Describe blocks name the function under test plus the invariant being asserted (e.g., `"— validate-first, pointer saved LAST"`)
- Test names are written as behavioral sentences describing observable outcomes
- `beforeEach` wires all mock functions and resets state — no shared mutable state leaks between tests
- `afterEach` restores all mocks and resets DI slots: `_resetApolloDepsForTests()`, `_resetExtensionConnectorConfigStoreForTests()`

## Mocking

**Framework:** `vi` from Vitest (`vi.fn`, `vi.resetAllMocks`, `vi.restoreAllMocks`)

**Patterns:**
```typescript
// Module-level typed mock fns — all Nango capability methods mocked individually
const isConfigured = vi.fn<() => boolean>();
const getPrimarySavedConnection = vi.fn(
  (): { providerConfigKey: string; connectionId: string; displayName?: string } | null => null,
);
const ensureIntegration = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const importConnection = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const getCredentials = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ apiKey: APIKEY }));

// Injected via DI registration in beforeEach:
registerApolloConnector({
  nango: { isConfigured, getPrimarySavedConnection, ... },
  emitUsage,
});

// Per-test overrides:
getCredentials.mockResolvedValueOnce({ apiKey: "DIFFERENT_KEY" });
isConfigured.mockReturnValue(false);
```

**`fetch` mocking:**
```typescript
// globalThis.fetch replaced inline within a describe block:
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(opts: { authHealthOk: boolean }) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const ok = url.includes("/v1/auth/health") ? opts.authHealthOk : true;
    return { ok, status: ok ? 200 : 401, text: async () => "{}" } as unknown as Response;
  }) as unknown as typeof fetch;
}
```

**What to Mock:**
- ALL external I/O: Nango capability methods, `fetch`, filesystem operations (disabled via `loggingEnabled: false`)
- Host DI dependencies (`nango.*`, `emitUsage`) — injected via `registerApolloConnector`
- SDK config store — replaced with an in-memory `Record<string, unknown>` via `setExtensionConnectorConfigStore`

**What NOT to Mock:**
- Business logic in `src/index.ts` — tested through real function calls, not mocked
- Pure utility functions in `src/lib/utils.ts` — not unit-tested in this file; covered implicitly

## Fixtures and Factories

**Test Data:**
```typescript
const APIKEY = "apollo-secret-key-123456";
const PROVIDER_CONFIG_KEY = "cinatra-apollo";
const CONNECTION_ID = "cinatra-apollo";

// In-memory config store seeded in beforeEach:
let CONFIG: Record<string, unknown> = {};
CONFIG = { [storeKey("@cinatra-ai/apollo-connector", "apollo")]: { loggingEnabled: false } };
```

**Location:**
- Constants defined at the top of the test file (no separate fixtures directory)
- No factory functions — test data is simple enough for inline construction

## Coverage

**Requirements:** Not enforced standalone (tests run in the host monorepo which owns coverage configuration)

**View Coverage:**
```bash
# Run in host monorepo context — command varies by host config
```

## Test Types

**Unit Tests:**
- Not applicable as a separate layer. The single test file is integration-style: it exercises multiple real functions end-to-end within an in-memory harness.

**Integration Tests:**
- `src/__tests__/sync-and-readback.test.ts` is the primary test — verifies the complete credential write-then-readback + pointer-gating chain across `syncApolloAPISettingsToNango`, `saveApolloAPISettings`, `getConfiguredApolloAPIKey`, and `getApolloAPIStatus` using real implementations with mocked I/O boundaries (Nango, fetch).
- Security property focus: tests assert that a failed/aborted save never leaves a connected-looking pointer, that error messages never leak credential values, and that the validate-first ordering is preserved.

**E2E Tests:**
- Not detected in this repo.

## Common Patterns

**Async Testing:**
```typescript
// await directly in async it():
it("happy path: ...", async () => {
  await saveApolloAPISettings({ apiKey: APIKEY });
  expect(saveConnectionRecord).toHaveBeenCalledTimes(1);
});

// Expect rejection:
await expect(syncApolloAPISettingsToNango({ apiKey: APIKEY })).rejects.toThrow(/verification failed/i);

// Catch + inspect error without losing the rejection:
await expect(
  syncApolloAPISettingsToNango({ apiKey: APIKEY }).catch((e) => { caught = e; throw e; }),
).rejects.toThrow(/verification failed/i);
```

**Invocation Order Testing:**
```typescript
// Assert that step A ran before step B using Vitest invocationCallOrder:
expect(ensureIntegration.mock.invocationCallOrder[0]).toBeLessThan(
  importConnection.mock.invocationCallOrder[0],
);
expect(importConnection.mock.invocationCallOrder[0]).toBeLessThan(
  getCredentials.mock.invocationCallOrder[0],
);
```

**Security Assertion Pattern:**
```typescript
// Assert error messages do NOT contain sensitive values:
const msg = caught instanceof Error ? caught.message : String(caught);
expect(msg).not.toContain(APIKEY);
expect(msg).not.toContain("DIFFERENT_KEY");
expect(msg).not.toContain(APIKEY.slice(0, 6));
```

**Error Testing:**
```typescript
// Verify call counts are zero after expected failure:
await expect(saveApolloAPISettings({ apiKey: APIKEY })).rejects.toThrow();
expect(importConnection).not.toHaveBeenCalled();
expect(saveConnectionRecord).not.toHaveBeenCalled();
expect(getApolloAPIStatus().status).toBe("not_connected");
```

---

*Testing analysis: 2026-06-09*
