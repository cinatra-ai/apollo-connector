// Verifies the verified write-then-read-back + saved-pointer-gated chain in
// connector-apollo. The security property: Apollo must NOT report "connected"
// (nor expose a usable credential) unless the submitted key was BOTH persisted
// (readback-verified) AND accepted by Apollo (live /v1/auth/health). The
// cinatra-side pointer is the gate — getConfiguredApolloAPIKey requires it, and
// it is saved LAST, only after every check passes.
//
// The nango capability is host-INJECTED via deps.nango (not imported from the
// nango-connector sibling extension). Each method is a module-level mock fn
// wired into deps in beforeEach (boot does this in register-transport-connectors).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  setExtensionConnectorConfigStore,
  _resetExtensionConnectorConfigStoreForTests,
} from "@cinatra-ai/sdk-extensions";
import { registerApolloConnector, _resetApolloDepsForTests } from "../deps";
import {
  syncApolloAPISettingsToNango,
  getConfiguredApolloAPIKey,
  saveApolloAPISettings,
  getApolloAPIStatus,
} from "../index";

const APIKEY = "apollo-secret-key-123456";
const PROVIDER_CONFIG_KEY = "cinatra-apollo";
const CONNECTION_ID = "cinatra-apollo";

const isConfigured = vi.fn<() => boolean>();
const getPrimarySavedConnection = vi.fn(
  (): { providerConfigKey: string; connectionId: string; displayName?: string } | null => null,
);
const ensureIntegration = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const importConnection = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const getCredentials = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ apiKey: APIKEY }));
const saveConnectionRecord = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
const deleteConnection = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const clearConnectionRecords = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const emitUsage = vi.fn();

// In-memory connector-config store so readSettings/writeSettings work. Seed
// loggingEnabled:false so writeApolloLogFile (fs) is a no-op under test.
let CONFIG: Record<string, unknown> = {};
const storeKey = (packageId: string, key: string) => `${packageId}::${key}`;

beforeEach(() => {
  vi.resetAllMocks();
  CONFIG = { [storeKey("@cinatra-ai/apollo-connector", "apollo")]: { loggingEnabled: false } };
  setExtensionConnectorConfigStore({
    get: <T>(packageId: string, key: string, fallback: T): T =>
      (CONFIG[storeKey(packageId, key)] as T) ?? fallback,
    set: (packageId: string, key: string, value: unknown) => {
      CONFIG[storeKey(packageId, key)] = value;
    },
    delete: (packageId: string, key: string) => {
      delete CONFIG[storeKey(packageId, key)];
    },
  });
  registerApolloConnector({
    nango: {
      isConfigured,
      getPrimarySavedConnection,
      ensureIntegration,
      importConnection,
      getCredentials,
      saveConnectionRecord,
      deleteConnection,
      clearConnectionRecords,
      providerConfigKeys: { apollo: PROVIDER_CONFIG_KEY },
      connectionIds: { apollo: CONNECTION_ID },
    },
    emitUsage,
  });
  isConfigured.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetApolloDepsForTests();
  _resetExtensionConnectorConfigStoreForTests();
});

describe("syncApolloAPISettingsToNango — readback-safe (no pointer write)", () => {
  it("import (no connectorKey) → forceRefresh readback → compare; does NOT save the pointer", async () => {
    getCredentials.mockResolvedValueOnce({ apiKey: APIKEY });

    await syncApolloAPISettingsToNango({ apiKey: APIKEY });

    expect(importConnection).toHaveBeenCalledTimes(1);
    const importCall = importConnection.mock.calls[0][0] as Record<string, unknown>;
    expect(importCall).toMatchObject({
      providerConfigKey: PROVIDER_CONFIG_KEY,
      connectionId: CONNECTION_ID,
      credentials: { type: "API_KEY", apiKey: APIKEY },
    });
    // import must NOT carry a connectorKey (else the pointer is auto-saved pre-verify).
    expect(importCall.connectorKey).toBeUndefined();
    // forceRefresh readback against the same provider/connection.
    expect(getCredentials).toHaveBeenCalledWith(PROVIDER_CONFIG_KEY, CONNECTION_ID, {
      forceRefresh: true,
    });
    // sync does NOT persist the pointer — that is saveApolloAPISettings' job,
    // AFTER live validation.
    expect(saveConnectionRecord).not.toHaveBeenCalled();
    // Ordering: ensure < import < readback.
    expect(ensureIntegration.mock.invocationCallOrder[0]).toBeLessThan(
      importConnection.mock.invocationCallOrder[0],
    );
    expect(importConnection.mock.invocationCallOrder[0]).toBeLessThan(
      getCredentials.mock.invocationCallOrder[0],
    );
  });

  it("readback mismatch THROWS a generic error (no token in message)", async () => {
    getCredentials.mockResolvedValueOnce({ apiKey: "DIFFERENT_KEY" });
    let caught: unknown;
    await expect(
      syncApolloAPISettingsToNango({ apiKey: APIKEY }).catch((e) => {
        caught = e;
        throw e;
      }),
    ).rejects.toThrow(/verification failed/i);
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).not.toContain(APIKEY);
    expect(msg).not.toContain("DIFFERENT_KEY");
    expect(msg).not.toContain(APIKEY.slice(0, 6));
  });

  it("readback null THROWS the same generic error", async () => {
    getCredentials.mockResolvedValueOnce(null);
    await expect(syncApolloAPISettingsToNango({ apiKey: APIKEY })).rejects.toThrow(
      /verification failed/i,
    );
  });

  it("input apiKey is trimmed before import + compare (whitespace-tolerant)", async () => {
    getCredentials.mockResolvedValueOnce({ apiKey: APIKEY });
    await syncApolloAPISettingsToNango({ apiKey: `  ${APIKEY}  ` });
    const importCall = importConnection.mock.calls[0][0] as Record<string, unknown>;
    expect((importCall.credentials as Record<string, unknown>).apiKey).toBe(APIKEY);
  });

  it("isConfigured=false returns early (no Nango calls)", async () => {
    isConfigured.mockReturnValue(false);
    await syncApolloAPISettingsToNango({ apiKey: APIKEY });
    expect(ensureIntegration).not.toHaveBeenCalled();
    expect(importConnection).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
  });
});

describe("getConfiguredApolloAPIKey — requires a verified saved pointer", () => {
  it("returns null and does NOT read credentials when no saved pointer exists", async () => {
    getPrimarySavedConnection.mockReturnValue(null);
    const key = await getConfiguredApolloAPIKey();
    expect(key).toBeNull();
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it("reads ONLY the saved provider/connection when a pointer exists", async () => {
    getPrimarySavedConnection.mockReturnValue({
      providerConfigKey: "saved-pck",
      connectionId: "saved-cid",
    });
    getCredentials.mockResolvedValueOnce({ apiKey: APIKEY });
    const key = await getConfiguredApolloAPIKey();
    expect(getCredentials).toHaveBeenCalledWith("saved-pck", "saved-cid", undefined);
    expect(key).toBe(APIKEY);
  });
});

describe("saveApolloAPISettings — validate-first, pointer saved LAST", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(opts: { authHealthOk: boolean }) {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      const ok = url.includes("/v1/auth/health") ? opts.authHealthOk : true;
      return {
        ok,
        status: ok ? 200 : 401,
        text: async () => "{}",
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("happy path: live validation FIRST → import → saveConnectionRecord LAST (in that order)", async () => {
    getCredentials.mockResolvedValue({ apiKey: APIKEY });
    mockFetch({ authHealthOk: true });

    await saveApolloAPISettings({ apiKey: APIKEY });

    expect(saveConnectionRecord).toHaveBeenCalledTimes(1);
    expect(saveConnectionRecord).toHaveBeenCalledWith(
      "apollo",
      expect.objectContaining({ connectionId: CONNECTION_ID, providerConfigKey: PROVIDER_CONFIG_KEY }),
      { multiple: false },
    );
    // Order: the live auth/health fetch runs BEFORE the Nango import, which runs
    // before the pointer save. (Nango is never written until the key is valid.)
    const fetchOrder = (globalThis.fetch as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(importConnection.mock.invocationCallOrder[0]);
    expect(importConnection.mock.invocationCallOrder[0]).toBeLessThan(
      saveConnectionRecord.mock.invocationCallOrder[0],
    );
  });

  it("first-time save, INVALID key → throws BEFORE any Nango write; stays not-connected", async () => {
    getPrimarySavedConnection.mockReturnValue(null); // not connected yet
    mockFetch({ authHealthOk: false });

    await expect(saveApolloAPISettings({ apiKey: APIKEY })).rejects.toThrow();

    // validate-first: a bad key never reaches importConnection / saveConnectionRecord.
    expect(importConnection).not.toHaveBeenCalled();
    expect(saveConnectionRecord).not.toHaveBeenCalled();
    expect(getApolloAPIStatus().status).toBe("not_connected");
  });

  it("ROTATION: invalid NEW key with an EXISTING connection does NOT overwrite the stored credential", async () => {
    // Apollo already connected (pointer + a valid old key live in Nango).
    getPrimarySavedConnection.mockReturnValue({
      providerConfigKey: PROVIDER_CONFIG_KEY,
      connectionId: CONNECTION_ID,
      displayName: "Cinatra Apollo",
    });
    mockFetch({ authHealthOk: false }); // the submitted NEW key is rejected by Apollo

    await expect(saveApolloAPISettings({ apiKey: "rotated-but-invalid-key" })).rejects.toThrow();

    // The Nango credential is NEVER overwritten (no import) — the old valid
    // connection survives, so "connected" remains accurate (not a stale/invalid key).
    expect(importConnection).not.toHaveBeenCalled();
    expect(saveConnectionRecord).not.toHaveBeenCalled();
    expect(getApolloAPIStatus().status).toBe("connected");
  });
});
