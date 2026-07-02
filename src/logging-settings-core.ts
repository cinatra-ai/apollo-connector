// Apollo logging-settings CORE — a dependency-free LEAF module shared by:
//   - `./index.ts` (getApolloLoggingSettings / saveApolloLoggingSettings):
//     reads/writes through the SDK's generic connector-config accessor;
//   - `./register.ts` (the `llm-provider-surface` capability impl): reads/
//     writes through the host's `@cinatra-ai/host:connector-config` service —
//     the serverEntry graph must keep SDK peers type-only
//     (host-peer-value-import ban).
// Both back ends address the SAME host KV row (key "apollo"), so the two
// build sites can never drift on the settings shape.

import { APOLLO_API_LOG_DIRECTORY } from "./log-directory";

/** The connector-config access both build sites inject (key-scoped KV). */
export type ApolloConfigAccess = {
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
};

export const APOLLO_CONFIG_KEY = "apollo";

/**
 * Apollo people-search request/response bodies carry third-party PII (names,
 * emails, LinkedIn URLs). On-disk body logging is therefore OPT-IN: it is OFF
 * unless the operator has EXPLICITLY enabled it — in EVERY environment (no
 * dev-only default-on). An unset/absent preference is treated as OFF.
 */
export function isApolloBodyLoggingEnabled(explicitPreference: boolean | undefined): boolean {
  return explicitPreference === true;
}

export function makeApolloLoggingSettings(config: ApolloConfigAccess) {
  return {
    get: () => {
      const settings = config.read<{ loggingEnabled?: boolean }>(APOLLO_CONFIG_KEY, {});
      return {
        enabled: isApolloBodyLoggingEnabled(settings.loggingEnabled),
        directory: APOLLO_API_LOG_DIRECTORY,
      };
    },
    save: async (enabled: boolean) => {
      const settings = config.read<Record<string, unknown>>(APOLLO_CONFIG_KEY, {});
      config.write(APOLLO_CONFIG_KEY, { ...settings, loggingEnabled: enabled });
    },
  };
}
