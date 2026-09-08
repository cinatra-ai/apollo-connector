// The host-owned capture port (cinatra#981) is ADDITIVE and OPTIONAL, so this
// connector feature-detects it and still activates against a host pinned below
// the 2.3.0 SDK-extensions ABI. Degrading must not be SILENT: body logging is
// opt-in and the settings surface keeps reading the stored preference back as
// enabled, so an operator who turned it on would otherwise watch entries vanish
// with no diagnostic. These tests pin the fallback contract — one warning per
// activation naming the dropped channel, and the real port used when present.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveApolloAPISettings: vi.fn(async () => ({})),
  clearApolloAPISettings: vi.fn(async () => undefined),
  getApolloAPIStatus: vi.fn(() => ({ status: "not_connected", detail: "Add a key." })),
}));

vi.mock("../index", () => ({
  saveApolloAPISettings: mocks.saveApolloAPISettings,
  clearApolloAPISettings: mocks.clearApolloAPISettings,
  getApolloAPIStatus: mocks.getApolloAPIStatus,
}));

import { register } from "../register";
import { getApolloDeps, _resetApolloDepsForTests } from "../deps";
import { APOLLO_LOG_CAPTURE_CHANNEL } from "../log-capture-channel";

const NANGO_SYSTEM = {
  isNangoConfigured: () => true,
  providerConfigKeys: { apollo: "cinatra-apollo" },
  connectionIds: { apollo: "cinatra-apollo" },
};
const CONNECTOR_CONFIG = {
  read: <T,>(_k: string, fallback: T): T => fallback,
  write: () => {},
};

type Provider = { packageName: string; impl: unknown };

/** A host ctx whose ambient logger carries only the members `logger` names. */
function makeCtx(logger: Record<string, unknown>) {
  const providers: Provider[] = [];
  const services: Record<string, unknown> = {
    "nango-system": NANGO_SYSTEM,
    "@cinatra-ai/host:connector-config": CONNECTOR_CONFIG,
  };
  return {
    providers,
    ctx: {
      capabilities: {
        registerProvider: (_capability: string, provider: Provider) => {
          providers.push(provider);
        },
        resolveProviders: (capability: string): Provider[] => {
          const svc = services[capability];
          return svc ? [{ packageName: "host", impl: svc }] : [];
        },
      },
      telemetry: { emitUsage: () => {} },
      ui: {
        registerSetupSurface: () => {},
        registerSettingsSurface: () => {},
        registerAction: () => {},
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, ...logger },
    } as unknown as Parameters<typeof register>[0],
  };
}

const ENTRY = { label: "people-search", kind: "request" as const, body: { q: "x" } };

beforeEach(() => {
  vi.clearAllMocks();
  _resetApolloDepsForTests();
});

afterEach(() => {
  _resetApolloDepsForTests();
});

describe("register(ctx) capture-port fallback (cinatra#981)", () => {
  it("activates and says so ONCE when the host has no logger.capture port", async () => {
    const warn = vi.fn();
    const { ctx } = makeCtx({ warn });
    register(ctx);

    await expect(getApolloDeps().captureLog(APOLLO_LOG_CAPTURE_CHANNEL, ENTRY)).resolves.toBeUndefined();
    await getApolloDeps().captureLog(APOLLO_LOG_CAPTURE_CHANNEL, ENTRY);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("@cinatra-ai/apollo-connector");
    expect(message).toContain(APOLLO_LOG_CAPTURE_CHANNEL);
    expect(message).toContain("2.3.0");
  });

  it("reports an empty log directory (never a connector-owned fs path) on such a host", () => {
    const { ctx, providers } = makeCtx({ warn: vi.fn() });
    register(ctx);
    const surface = providers[0]?.impl as { logDirectory: string };
    expect(surface.logDirectory).toBe("");
    expect(getApolloDeps().captureLogDirectory(APOLLO_LOG_CAPTURE_CHANNEL)).toBe("");
  });

  it("uses the host port, bound to the logger, when it is present — and never warns", async () => {
    const warn = vi.fn();
    const capture = vi.fn(async function (this: unknown) {
      expect(this).toBeDefined();
    });
    const { ctx } = makeCtx({
      warn,
      capture,
      captureDirectory: (channel: string) => `/host-owned/${channel}`,
    });
    register(ctx);

    await getApolloDeps().captureLog(APOLLO_LOG_CAPTURE_CHANNEL, ENTRY);

    expect(capture).toHaveBeenCalledWith(APOLLO_LOG_CAPTURE_CHANNEL, ENTRY);
    expect(warn).not.toHaveBeenCalled();
    expect(getApolloDeps().captureLogDirectory(APOLLO_LOG_CAPTURE_CHANNEL)).toBe(
      "/host-owned/apollo-api",
    );
  });

  it("propagates a genuine host write failure (disk full / permissions) to the caller", async () => {
    const { ctx } = makeCtx({
      warn: vi.fn(),
      capture: vi.fn(async () => {
        throw new Error("ENOSPC");
      }),
    });
    register(ctx);
    await expect(getApolloDeps().captureLog(APOLLO_LOG_CAPTURE_CHANNEL, ENTRY)).rejects.toThrow(
      "ENOSPC",
    );
  });
});
