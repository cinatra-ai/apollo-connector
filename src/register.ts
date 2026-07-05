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
import { registerApolloConnector, getApolloDeps, type ApolloConnectorDeps } from "./deps";
import { makeApolloLoggingSettings } from "./logging-settings-core";
import { APOLLO_LOG_CAPTURE_CHANNEL } from "./log-capture-channel";
import {
  getApolloAPIStatus,
  saveApolloAPISettings,
  clearApolloAPISettings,
} from "./index";

const PACKAGE_NAME = "@cinatra-ai/apollo-connector";

/** The host-published action-guard service (value, NOT the SDK
 *  `requireExtensionAction` import — a runtime serverEntry graph rejects SDK
 *  value imports). `require(packageId, mode)` resolves the actor from the
 *  request session and enforces the per-install extension access policy,
 *  failing closed (throw/redirect) on denial. Mirrors anthropic/openai. */
type HostActionGuard = {
  require: (packageId: string, mode: "read" | "manage") => Promise<void>;
};

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
    // Connector-config KV, resolved LAZILY through the host connector-config
    // service (same KV row the retired SDK generic accessor addressed —
    // cinatra#782). Constructing this object does no resolution; each call
    // resolves + reads/writes at call time.
    readConnectorConfigFromDatabase: <T,>(configKey: string, fallback: T): T =>
      config().read(configKey, fallback),
    writeConnectorConfigToDatabase: (configKey, value) => config().write(configKey, value),
    // Host-owned capture (cinatra#981) — `ctx.logger.capture`/`captureDirectory`
    // are ADDITIVE OPTIONAL minimum-minor methods (>=2.3.0); feature-detected so
    // this connector still activates (logging degrades to a no-op) against an
    // older host pinned below the 2.3.0 floor.
    captureLog: async (channel, entry) => {
      await ctx.logger.capture?.(channel, entry);
    },
    captureLogDirectory: (channel) => ctx.logger.captureDirectory?.(channel) ?? "",
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
    captureDirectory: (channel) => ctx.logger.captureDirectory?.(channel) ?? "",
  });
  ctx.capabilities.registerProvider("llm-provider-surface", {
    packageName: PACKAGE_NAME,
    impl: {
      providerId: "apollo",
      getLoggingSettings: () => loggingSettings.get(),
      saveLoggingSettings: (enabled: boolean) => loggingSettings.save(enabled),
      // Host-resolved (cinatra#981) — was a connector-owned `node:fs` path.
      logDirectory: ctx.logger.captureDirectory?.(APOLLO_LOG_CAPTURE_CHANNEL) ?? "",
    },
  });

  // ---- schema-config named actions (cinatra#782) ----
  //
  // The declarative setup surface (cinatra.configSchema) renders WITHOUT
  // shipping React. Its advisory/probe/named-action fields reference these
  // host-registered actions BY ID; the host dispatches them through the single
  // endpoint `/api/extensions/{installId}/actions/{actionId}`, which resolves +
  // authorizes the actor at the "use" tier BEFORE calling the handler. Because
  // saving/clearing a credential is a MANAGE-tier mutation (the prior
  // saveApolloConnectionAction gated "manage"), the WRITE handlers re-assert the
  // manage gate via the host action-guard service — the "use"-tier endpoint check
  // alone would be a regression. Requires the "ui" host port (declared in
  // cinatra.requestedHostPorts).

  // Resolve the host's action-guard service LAZILY at action-call time (the same
  // value the SDK `requireExtensionAction` slot binds), so activation order never
  // matters and a missing guard FAILS CLOSED. Imported as a VALUE through the
  // capability registry — NEVER as an SDK value import (a runtime serverEntry
  // graph rejects those). Mirrors anthropic-connector.
  const requireManage = async (): Promise<void> => {
    const provider = ctx.capabilities.resolveProviders(
      "@cinatra-ai/host:extension-action-guard",
    )[0];
    const guard = provider?.impl as HostActionGuard | undefined;
    if (!guard || typeof guard.require !== "function") {
      throw new Error(
        `${PACKAGE_NAME}: host action-guard service is not registered — refusing the ungated action.`,
      );
    }
    await guard.require(PACKAGE_NAME, "manage");
  };

  // READ/PROBE: whether the connection (Nango) service is configured for API-key
  // storage — drives the `advisory` field's copy. Boolean data only.
  ctx.ui.registerAction({
    id: "connectionServiceReady",
    handler: async (): Promise<{ ready: boolean }> => ({
      ready: getApolloDeps().nango.isConfigured(),
    }),
  });

  // PROBE: connection status. THROWS when not connected/incomplete so the
  // status-probe pill renders "error" (any 2xx renders OK); a connected status
  // returns its detail.
  ctx.ui.registerAction({
    id: "connectionStatus",
    handler: async (): Promise<{ detail: string }> => {
      const status = getApolloAPIStatus();
      if (status.status !== "connected") {
        throw new Error(status.detail);
      }
      return { detail: status.detail };
    },
  });

  // WRITE (manage-gated): validate the submitted key against Apollo, persist it
  // to Nango (verified write-then-read-back), and save the cinatra-side pointer.
  // The schema-config form posts the flat secret input as JSON. A blank apiKey
  // is treated as ABSENT (no overwrite): saveApolloAPISettings falls back to the
  // currently-stored key. saveApolloAPISettings throws on an invalid/absent key —
  // that surfaces as the "error" banner (no partial write; the prior valid
  // connection survives a failed rotation).
  ctx.ui.registerAction({
    id: "saveConnection",
    handler: async (input: unknown): Promise<{ banner: string }> => {
      await requireManage();
      const fields =
        input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const rawApiKey = typeof fields.apiKey === "string" ? fields.apiKey.trim() : "";
      await saveApolloAPISettings(rawApiKey ? { apiKey: rawApiKey } : {});
      return { banner: "saved" };
    },
  });

  // WRITE (manage-gated): clear the stored connection (scrubs the Nango
  // credential + cinatra-side pointer rows; preserves the logging preference).
  ctx.ui.registerAction({
    id: "clearConnection",
    handler: async (): Promise<{ banner: string }> => {
      await requireManage();
      await clearApolloAPISettings();
      return { banner: "cleared" };
    },
  });
}
