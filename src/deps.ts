// Host dependency injection for the apollo connector.
//
// Keeps the connector decoupled from sibling extensions and from host-internal
// services. The host binds concrete impls at boot via
// `registerApolloConnector(deps)`; runtime functions resolve them via
// `getApolloDeps()`. Two NON-config host surfaces are delivered here:
//   - `nango`     — Nango connection-storage (host-sourced from the
//                   nango-connector extension) so this connector carries NO
//                   non-SDK `@cinatra-ai/*` code dependency.
//   - `emitUsage` — usage-metric emission (host-sourced from metric-usage-api).
//
// Connector-config read/write is NOT in deps — it flows through the SDK's
// GENERIC `getExtensionConnectorConfig`/`setExtensionConnectorConfig` accessor
// (no per-connector host binding) per the extensibility rule.
//
// The deps slot is anchored on `globalThis` via a namespaced+versioned Symbol so
// the boot-time registration and the runtime callers — which live in
// SEPARATELY-COMPILED Next.js bundles (the /connectors page, the connector setup
// page, relocated "use server" actions) that do NOT import the registrar —
// resolve the SAME slot. A plain module-local binding would leave those bundles'
// instance unregistered → getApolloDeps() would throw. (Same reason as the SDK
// action-guard + apify/gemini deps + email-connector registry.)

/**
 * Structural shape of the Nango connection-storage surface apollo uses. Inlined
 * (NOT imported from `@cinatra-ai/nango-connector`) so the connector carries no
 * non-SDK `@cinatra-ai/*` code dependency — the host binds the concrete impls at
 * boot. Keys are literal-scoped to this connector's slug so an invalid key can't
 * compile here. Returns stay permissive (`unknown`); the connector reads
 * credentials defensively.
 */
export interface ApolloNangoCapability {
  /** True when the workspace has Nango configured (credentials present). */
  isConfigured(): boolean;
  /** The primary saved cinatra-side connection pointer for this connector, or
   *  null when none is saved. */
  getPrimarySavedConnection(
    connectorKey: "apollo",
  ): { providerConfigKey: string; connectionId: string; displayName?: string } | null;
  /** Ensure the provider-config (integration) row exists. */
  ensureIntegration(input: {
    provider: string;
    providerConfigKey: string;
    displayName: string;
  }): Promise<unknown>;
  /** Write the credential into Nango. Import WITHOUT `connectorKey` so the
   *  cinatra-side pointer is NOT auto-saved before verification — the caller
   *  saves it explicitly via `saveConnectionRecord` only after a verified readback. */
  importConnection(input: {
    providerConfigKey: string;
    connectionId: string;
    credentials: { type: string; apiKey: string };
  }): Promise<unknown>;
  /** Persist the cinatra-side pointer row AFTER a verified readback.
   *  `{ multiple: false }` enforces a single workspace-wide credential. */
  saveConnectionRecord(
    connectorKey: "apollo",
    record: { connectionId: string; providerConfigKey: string; metadata?: Record<string, unknown> },
    opts?: { multiple?: boolean },
  ): Promise<unknown>;
  /** Read back the stored credentials for a saved connection. */
  /** Read back the stored credentials. forceRefresh bypasses Nango's cache so
   *  write-then-read-back verification reads the just-written credential. */
  getCredentials(
    providerConfigKey: string,
    connectionId: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<unknown>;
  /** Delete the Nango connection (scrubs stored credentials). */
  deleteConnection(providerConfigKey: string, connectionId: string): Promise<unknown>;
  /** Clear the cinatra-side pointer rows for this connector. */
  clearConnectionRecords(connectorKey: "apollo"): Promise<unknown>;
  /** Provider-config-key bag — only this connector's slug is read. */
  providerConfigKeys: { apollo: string };
  /** Connection-id bag — only this connector's slug is read. */
  connectionIds: { apollo: string };
}

/**
 * Structural mirror of the `apollo` usage event apollo emits (1:1 with
 * `@cinatra-ai/metric-usage-api`'s `ApolloUsageEvent`). Inlined so the connector
 * carries no non-SDK `@cinatra-ai/*` code dependency.
 */
export interface ApolloUsageEventInput {
  source: "apollo";
  operation: string;
  agentLabel: string | null;
  requestCount: number;
  resultCount: number;
  creditsConsumed: number;
  idempotencyKey: string;
  occurredAt: string;
}

export interface ApolloConnectorDeps {
  /** Nango connection-storage surface (host-bound from the nango-connector extension). */
  nango: ApolloNangoCapability;
  /** Emit a usage-metric event (host-bound from metric-usage-api). */
  emitUsage: (event: ApolloUsageEventInput) => void;
}

const APOLLO_DEPS_KEY = Symbol.for("@cinatra-ai/apollo-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: ApolloConnectorDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

/**
 * Wire the host's runtime deps. Called once at boot
 * (src/lib/register-transport-connectors.ts). Re-calling replaces — tests swap stubs.
 */
export function registerApolloConnector(deps: ApolloConnectorDeps): void {
  _holder[APOLLO_DEPS_KEY] = deps;
}

export function getApolloDeps(): ApolloConnectorDeps {
  const deps = _holder[APOLLO_DEPS_KEY];
  if (!deps) {
    throw new Error(
      "@cinatra-ai/apollo-connector: host runtime deps not registered. " +
        "Call registerApolloConnector(deps) at boot.",
    );
  }
  return deps;
}

/** @internal test-only. */
export function _resetApolloDepsForTests(): void {
  _holder[APOLLO_DEPS_KEY] = null;
}
