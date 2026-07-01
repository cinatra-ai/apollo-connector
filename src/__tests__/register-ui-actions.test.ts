// register(ctx) registers the schema-config named actions via `ctx.ui` so the
// declarative setup surface (cinatra.configSchema) can probe readiness/status
// and save/clear the Apollo connection WITHOUT shipping React (cinatra#782).
// The host dispatches these by id through
// `/api/extensions/{installId}/actions/{actionId}`, which authorizes the actor
// at the "use" tier host-side. Because a credential write is a MANAGE-tier
// mutation, the WRITE handlers (saveConnection/clearConnection) re-assert the
// manage gate via the host action-guard service — so a missing/denying guard
// FAILS CLOSED (the action throws; nothing executes ungated).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the mocks exist before vi.mock's hoisted factory runs (a plain
// top-level const is initialized AFTER the hoisted mock factory).
const mocks = vi.hoisted(() => ({
  saveApolloAPISettings: vi.fn(async () => ({})),
  clearApolloAPISettings: vi.fn(async () => undefined),
  getApolloAPIStatus: vi.fn(() => ({ status: "not_connected", detail: "Add a key." })),
}));

// Mock the index module the register(ctx) named-action handlers call into. The
// nango readiness probe (`connectionServiceReady`) does NOT go through index —
// it reads getApolloDeps().nango.isConfigured(), which register binds from the
// `nango-system` capability at activation (see NANGO_SYSTEM below).
vi.mock("../index", () => ({
  saveApolloAPISettings: mocks.saveApolloAPISettings,
  clearApolloAPISettings: mocks.clearApolloAPISettings,
  getApolloAPIStatus: mocks.getApolloAPIStatus,
  // register.ts also imports the llm-provider logging surface bits indirectly via
  // logging-settings-core; nothing else from index is referenced by register.
}));

import { register } from "../register";
import { _resetApolloDepsForTests } from "../deps";

type RegisteredProvider = { packageName: string; impl: unknown };
type UiAction = { id: string; handler: (input: unknown) => Promise<unknown> };

function makeCtx(services: Record<string, unknown>) {
  const uiActions: UiAction[] = [];
  return {
    ctx: {
      capabilities: {
        registerProvider: () => {},
        resolveProviders: (capability: string): RegisteredProvider[] => {
          const svc = services[capability];
          return svc ? [{ packageName: "host", impl: svc }] : [];
        },
      },
      telemetry: { emitUsage: () => {} },
      ui: {
        registerSetupSurface: () => {},
        registerSettingsSurface: () => {},
        registerAction: (action: UiAction) => {
          uiActions.push(action);
        },
      },
    } as unknown as Parameters<typeof register>[0],
    uiActions,
  };
}

function actionById(uiActions: UiAction[], id: string): UiAction {
  const a = uiActions.find((x) => x.id === id);
  if (!a) throw new Error(`action ${id} not registered`);
  return a;
}

// A minimal nango-system capability surface. register(ctx) always re-binds the
// deps slot (overwriting any pre-bound stub), and the deps' nango members
// resolve this capability LAZILY at call time — so the connectionServiceReady
// probe reaches isNangoConfigured() through the real activation path. The
// connector-config service is also resolved lazily; register binds
// read/write config through it — the named actions here never touch config
// directly, so a minimal stub suffices.
const NANGO_SYSTEM = {
  isNangoConfigured: () => true,
  providerConfigKeys: { apollo: "cinatra-apollo" },
  connectionIds: { apollo: "cinatra-apollo" },
};
const CONNECTOR_CONFIG = {
  read: <T,>(_k: string, fallback: T): T => fallback,
  write: () => {},
};

function baseServices(extra: Record<string, unknown> = {}) {
  return {
    "nango-system": NANGO_SYSTEM,
    "@cinatra-ai/host:connector-config": CONNECTOR_CONFIG,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetApolloDepsForTests();
});

afterEach(() => {
  _resetApolloDepsForTests();
});

describe("apollo-connector register(ctx) — schema-config named actions", () => {
  it("registers the probe + write actions used by the configSchema", () => {
    const { ctx, uiActions } = makeCtx(baseServices());
    register(ctx);
    expect(uiActions.map((a) => a.id).sort()).toEqual(
      ["clearConnection", "connectionServiceReady", "connectionStatus", "saveConnection"].sort(),
    );
  });

  it("connectionServiceReady reports the nango readiness as data", async () => {
    const { ctx, uiActions } = makeCtx(baseServices());
    register(ctx);
    await expect(actionById(uiActions, "connectionServiceReady").handler({})).resolves.toEqual({
      ready: true,
    });
  });

  it("connectionStatus THROWS when not connected (so the probe pill shows error)", async () => {
    mocks.getApolloAPIStatus.mockReturnValueOnce({ status: "not_connected", detail: "Add a key." });
    const { ctx, uiActions } = makeCtx(baseServices());
    register(ctx);
    await expect(actionById(uiActions, "connectionStatus").handler({})).rejects.toThrow(/Add a key/);
  });

  it("connectionStatus returns the detail when connected", async () => {
    mocks.getApolloAPIStatus.mockReturnValueOnce({ status: "connected", detail: "Connected as Cinatra Apollo." });
    const { ctx, uiActions } = makeCtx(baseServices());
    register(ctx);
    await expect(actionById(uiActions, "connectionStatus").handler({})).resolves.toEqual({
      detail: "Connected as Cinatra Apollo.",
    });
  });

  it("saveConnection FAILS CLOSED when the action-guard service is missing (no write runs)", async () => {
    const { ctx, uiActions } = makeCtx(baseServices()); // no guard
    register(ctx);
    await expect(
      actionById(uiActions, "saveConnection").handler({ apiKey: "apollo-key-xyz" }),
    ).rejects.toThrow(/action-guard service is not registered/);
    expect(mocks.saveApolloAPISettings).not.toHaveBeenCalled();
  });

  it("saveConnection persists the trimmed key after the manage gate passes", async () => {
    const require = vi.fn(async () => {});
    const { ctx, uiActions } = makeCtx(
      baseServices({ "@cinatra-ai/host:extension-action-guard": { require } }),
    );
    register(ctx);
    const r = await actionById(uiActions, "saveConnection").handler({ apiKey: "  apollo-key-xyz  " });
    expect(require).toHaveBeenCalledWith("@cinatra-ai/apollo-connector", "manage");
    expect(mocks.saveApolloAPISettings).toHaveBeenCalledWith({ apiKey: "apollo-key-xyz" });
    expect(r).toEqual({ banner: "saved" });
  });

  it("saveConnection with a blank apiKey calls save with {} (keep-existing) after the gate", async () => {
    const { ctx, uiActions } = makeCtx(
      baseServices({ "@cinatra-ai/host:extension-action-guard": { require: vi.fn(async () => {}) } }),
    );
    register(ctx);
    await actionById(uiActions, "saveConnection").handler({ apiKey: "   " });
    expect(mocks.saveApolloAPISettings).toHaveBeenCalledWith({});
  });

  it("saveConnection propagates a save failure (renders the error banner)", async () => {
    mocks.saveApolloAPISettings.mockRejectedValueOnce(new Error("Apollo rejected the key."));
    const { ctx, uiActions } = makeCtx(
      baseServices({ "@cinatra-ai/host:extension-action-guard": { require: vi.fn(async () => {}) } }),
    );
    register(ctx);
    await expect(
      actionById(uiActions, "saveConnection").handler({ apiKey: "bad" }),
    ).rejects.toThrow(/Apollo rejected the key/);
  });

  it("clearConnection clears after the manage gate, and FAILS CLOSED without the guard", async () => {
    const noGuard = makeCtx(baseServices());
    register(noGuard.ctx);
    await expect(actionById(noGuard.uiActions, "clearConnection").handler({})).rejects.toThrow(
      /action-guard service is not registered/,
    );
    expect(mocks.clearApolloAPISettings).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const require = vi.fn(async () => {});
    const withGuard = makeCtx(
      baseServices({ "@cinatra-ai/host:extension-action-guard": { require } }),
    );
    register(withGuard.ctx);
    const r = await actionById(withGuard.uiActions, "clearConnection").handler({});
    expect(require).toHaveBeenCalledWith("@cinatra-ai/apollo-connector", "manage");
    expect(mocks.clearApolloAPISettings).toHaveBeenCalledOnce();
    expect(r).toEqual({ banner: "cleared" });
  });
});
