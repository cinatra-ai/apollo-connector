// The apollo connector's `register(ctx)` server entry.
//
// Transport-registration cutover: the host no longer statically imports `registerApolloConnector` — this
// entry binds the connector's host deps AT ACTIVATION by adapting the
// per-concern host services published in the capability registry
// (`@cinatra-ai/host:nango-connection-storage`) plus the granted
// `ctx.telemetry` port for usage emission. Every adapter field resolves the
// host service LAZILY at call time, so activation order against the host's
// boot imports never matters.
//
// SDK imports here are TYPE-ONLY (host-peer value-import gate): the host
// services arrive as DATA through `ctx.capabilities`.

import type {
  ExtensionHostContext,
  HostNangoConnectionStorageService,
  HostConnectorConfigService,
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
        `the host boot wiring (register-transport-connectors) must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

export function register(ctx: ExtensionHostContext): void {
  const config = () =>
    hostService<HostConnectorConfigService>(ctx, "@cinatra-ai/host:connector-config");
  const nango = () =>
    hostService<HostNangoConnectionStorageService>(
      ctx,
      "@cinatra-ai/host:nango-connection-storage",
    );

  const deps: ApolloConnectorDeps = {
    nango: {
      isConfigured: () => nango().isConfigured(),
      getPrimarySavedConnection: (connectorKey) =>
        nango().getPrimarySavedConnection(connectorKey) as ReturnType<
          ApolloConnectorDeps["nango"]["getPrimarySavedConnection"]
        >,
      ensureIntegration: (input) => nango().ensureIntegration(input),
      // Apollo imports WITHOUT `connectorKey` (verified write-then-read-back),
      // then saves the pointer explicitly — matching the previous host binding.
      importConnection: (input) => nango().importConnection(input),
      saveConnectionRecord: (connectorKey, record, opts) =>
        nango().saveConnectionRecord(connectorKey, record, opts),
      getCredentials: (providerConfigKey, connectionId, opts) =>
        nango().getCredentials(providerConfigKey, connectionId, opts),
      deleteConnection: (providerConfigKey, connectionId) =>
        nango().deleteConnection(providerConfigKey, connectionId),
      clearConnectionRecords: (connectorKey) => nango().clearConnectionRecords(connectorKey),
      get providerConfigKeys() {
        return nango().providerConfigKeys as ApolloConnectorDeps["nango"]["providerConfigKeys"];
      },
      get connectionIds() {
        return nango().connectionIds as ApolloConnectorDeps["nango"]["connectionIds"];
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
