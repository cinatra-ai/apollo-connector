// The apollo connector's `register(ctx)` server entry.
//
// Transport-registration cutover: the host no longer statically imports `registerApolloConnector` — this
// entry binds the connector's host deps AT ACTIVATION by adapting the
// per-concern host services published in the capability registry
// (`@cinatra-ai/host:connector-config`) plus the connector-authored
// `nango-system` surface (the legacy `@cinatra-ai/host:nango-connection-storage`
// adapter id is retired — cinatra#151 Stage 3) and the granted
// `ctx.telemetry` port for usage emission. Every adapter field resolves the
// host service LAZILY at call time, so activation order against the host's
// boot imports never matters.
//
// SDK imports here are TYPE-ONLY (host-peer value-import gate): the host
// services arrive as DATA through `ctx.capabilities`.

import type {
  ExtensionHostContext,
  HostConnectorConfigService,
  NangoSystemSurface,
} from "@cinatra-ai/sdk-extensions";
import { registerApolloConnector, type ApolloConnectorDeps } from "./deps";
import { makeApolloLoggingSettings } from "./logging-settings-core";
import { APOLLO_API_LOG_DIRECTORY } from "./log-directory";

const PACKAGE_NAME = "@cinatra-ai/apollo-connector";

function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const provider = ctx.capabilities.resolveProviders(capability)[0];
  if (!provider) {
    throw new Error(
      `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
        `the host boot wiring (register-host-connector-services) must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

export function register(ctx: ExtensionHostContext): void {
  const config = () =>
    hostService<HostConnectorConfigService>(ctx, "@cinatra-ai/host:connector-config");
  // The connector-authored nango-system surface (registered by the nango
  // gateway's own register(ctx) — a systemExtension, required at boot).
  const nango = (): NangoSystemSurface => {
    const provider = ctx.capabilities.resolveProviders("nango-system")[0];
    const surface = provider?.impl as NangoSystemSurface | undefined;
    if (!surface || typeof surface.isNangoConfigured !== "function") {
      throw new Error(
        `${PACKAGE_NAME}: the "nango-system" capability surface is not registered — ` +
          `resolve at call time (post-activation), never at module eval.`,
      );
    }
    return surface;
  };

  const deps: ApolloConnectorDeps = {
    // Members delegate to the nango-system surface at CALL time (key maps are
    // getters for the same reason). Inputs are cast at this boundary where the
    // surface owns the wider shape (required displayName / NangoConnectorKey
    // union / record shape) — this connector only ever passes valid values.
    nango: {
      isConfigured: () => nango().isNangoConfigured(),
      getPrimarySavedConnection: (connectorKey) =>
        nango().getPrimarySavedNangoConnection(connectorKey),
      ensureIntegration: (input) =>
        nango().ensureNangoIntegration(input as Parameters<NangoSystemSurface["ensureNangoIntegration"]>[0]),
      // Apollo imports WITHOUT `connectorKey` (verified write-then-read-back),
      // then saves the pointer explicitly — matching the previous host binding.
      importConnection: (input) =>
        nango().importNangoConnection(input as Parameters<NangoSystemSurface["importNangoConnection"]>[0]),
      saveConnectionRecord: (connectorKey, record, opts) =>
        nango().saveNangoConnectionRecord(
          connectorKey,
          record as Parameters<NangoSystemSurface["saveNangoConnectionRecord"]>[1],
          opts,
        ),
      getCredentials: (providerConfigKey, connectionId, opts) =>
        nango().getNangoCredentials(providerConfigKey, connectionId, opts),
      deleteConnection: (providerConfigKey, connectionId) =>
        nango().deleteNangoConnection(providerConfigKey, connectionId),
      clearConnectionRecords: (connectorKey) => nango().clearNangoConnectionRecords(connectorKey),
      // Vendor identity is OPEN at the SDK (#12): the surface's key maps are
      // `Record<string, string>` (no SDK-frozen union), so this connector
      // projects ITS OWN key out of the open map at the boundary.
      get providerConfigKeys() {
        return { apollo: nango().providerConfigKeys.apollo };
      },
      get connectionIds() {
        return { apollo: nango().connectionIds.apollo };
      },
    },
    // Fire-and-forget by the telemetry port contract — matches the previous
    // host binding's `emitUsageEvent` semantics for the apollo source.
    emitUsage: (event) => ctx.telemetry.emitUsage(event),
  };

  registerApolloConnector(deps);

  // Lazy/guarded host-access cutover: the host's telemetry/
  // logging surfaces (campaign actions, telemetry page, log clearing) resolve
  // this connector's logging settings through the `llm-provider-surface`
  // capability instead of value-importing the package. Built on the shared
  // leaf core with the ctx-resolved connector-config service (same KV row as
  // the SDK-backed build site). Provider absence degrades per call.
  const loggingSettings = makeApolloLoggingSettings({
    read: (key, fallback) => config().read(key, fallback),
    write: (key, value) => config().write(key, value),
  });
  ctx.capabilities.registerProvider("llm-provider-surface", {
    packageName: PACKAGE_NAME,
    impl: {
      providerId: "apollo",
      getLoggingSettings: () => loggingSettings.get(),
      saveLoggingSettings: (enabled: boolean) => loggingSettings.save(enabled),
      logDirectory: APOLLO_API_LOG_DIRECTORY,
    },
  });
}
