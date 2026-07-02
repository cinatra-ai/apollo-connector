// Proves Apollo body logging is OPT-IN (default OFF everywhere): only an
// explicit `loggingEnabled: true` enables capture of the PII-bearing
// people-search request/response bodies.

import { describe, expect, it } from "vitest";

import {
  APOLLO_CONFIG_KEY,
  isApolloBodyLoggingEnabled,
  makeApolloLoggingSettings,
} from "../logging-settings-core";

describe("isApolloBodyLoggingEnabled (opt-in policy)", () => {
  it("is OFF when the preference is unset (the security default)", () => {
    expect(isApolloBodyLoggingEnabled(undefined)).toBe(false);
  });

  it("is OFF when explicitly disabled", () => {
    expect(isApolloBodyLoggingEnabled(false)).toBe(false);
  });

  it("is ON only when explicitly enabled", () => {
    expect(isApolloBodyLoggingEnabled(true)).toBe(true);
  });
});

describe("makeApolloLoggingSettings().get()", () => {
  function withStore(initial: Record<string, unknown>) {
    const store: Record<string, unknown> = { ...initial };
    return makeApolloLoggingSettings({
      read: <T>(key: string, fallback: T): T => (store[key] as T) ?? fallback,
      write: (key: string, value: unknown) => {
        store[key] = value;
      },
    });
  }

  it("reports disabled by default (no stored preference)", () => {
    expect(withStore({}).get().enabled).toBe(false);
  });

  it("reports disabled when explicitly opted out", () => {
    expect(withStore({ [APOLLO_CONFIG_KEY]: { loggingEnabled: false } }).get().enabled).toBe(false);
  });

  it("reports enabled only after an explicit opt-in", () => {
    expect(withStore({ [APOLLO_CONFIG_KEY]: { loggingEnabled: true } }).get().enabled).toBe(true);
  });
});
