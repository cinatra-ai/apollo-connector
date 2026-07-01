// Contract fixtures for the declarative setup DSL (cinatra.configSchema).
//
// The Apollo connector ships a `uiSurface:"schema-config"` declaration
// (cinatra#782) so the host renders its setup page from DATA with NO rebuild —
// retiring the bundled-react settings/setup pages. These tests prove the
// declared `cinatra.configSchema` passes the PUBLIC validation path: the SAME
// fail-closed `validateConfigSchema` the repo's `extension-kind-gate.mjs` runs
// in CI (the rules-only port of the host's `parseSchemaConfig`).

import { describe, expect, it } from "vitest";
// The package.json is the manifest the host materializes; the configSchema under
// `cinatra` is the exact data the renderer parses.
import pkg from "../../package.json" with { type: "json" };
// The repo's standalone, zero-dependency validator (the kind-gate's public path).
import { validateConfigSchema } from "../../extension-kind-gate.mjs";

const configSchema = (pkg as { cinatra?: { configSchema?: unknown } }).cinatra
  ?.configSchema;

describe("apollo-connector cinatra.configSchema", () => {
  it('declares uiSurface:"schema-config" and requests the "ui" + "capabilities" host ports', () => {
    const cinatra = (pkg as { cinatra: Record<string, unknown> }).cinatra;
    expect(cinatra.uiSurface).toBe("schema-config");
    expect(cinatra.requestedHostPorts).toContain("ui");
    expect(cinatra.requestedHostPorts).toContain("capabilities");
    // Apollo emits usage metrics via the telemetry port — preserved.
    expect(cinatra.requestedHostPorts).toContain("telemetry");
  });

  it("the declared configSchema parses with ZERO validation errors", () => {
    expect(validateConfigSchema(configSchema)).toEqual([]);
  });

  it("covers every setup element the API-key connection needs", () => {
    const fields = (configSchema as { fields: Array<Record<string, unknown>> })
      .fields;
    const byKind = (k: string) => fields.filter((f) => f.kind === k);

    // secret api key (Apollo has no model picker — a single credential).
    expect(byKind("secret").map((f) => f.key)).toContain("apiKey");
    // no select field — Apollo does not pick a model.
    expect(byKind("select")).toHaveLength(0);

    // status-probe + a readiness advisory referencing a registered probe. (Every
    // advisory MUST carry a probeActionId — the host validator requires it — so
    // the Apollo plan-requirement note lives in the secret field's description.)
    expect(byKind("status-probe")[0]?.actionId).toBe("connectionStatus");
    const advisories = byKind("advisory");
    expect(advisories.length).toBeGreaterThan(0);
    expect(advisories.every((a) => typeof a.probeActionId === "string")).toBe(true);
    expect(advisories.some((a) => a.probeActionId === "connectionServiceReady")).toBe(true);
    // the People API Search plan requirement is surfaced on the secret field.
    const secret = byKind("secret").find((f) => f.key === "apiKey");
    expect(String(secret?.description)).toMatch(/People API Search/);

    // save + clear named actions (clear is confirm-gated).
    const namedActions = byKind("named-action");
    const actionIds = namedActions.map((f) => f.actionId);
    expect(actionIds).toEqual(
      expect.arrayContaining(["saveConnection", "clearConnection"]),
    );
    const clear = namedActions.find((f) => f.actionId === "clearConnection");
    expect(clear?.confirm).toBeTruthy();

    // saved / cleared / error banner variants.
    const banner = byKind("banner")[0];
    expect(banner).toBeDefined();
    const variantNames = (banner.variants as Array<{ name: string }>).map(
      (v) => v.name,
    );
    expect(variantNames).toEqual(
      expect.arrayContaining(["saved", "cleared", "error"]),
    );
  });

  describe("validateConfigSchema stays fail-closed", () => {
    const wrap = (field: Record<string, unknown>) => ({ fields: [field] });

    it("rejects an advisory with an invalid tone", () => {
      expect(
        validateConfigSchema(
          wrap({ kind: "advisory", label: "Note", tone: "fuchsia" }),
        ).length,
      ).toBeGreaterThan(0);
    });

    it("rejects a named-action with an invalid actionId", () => {
      expect(
        validateConfigSchema(
          wrap({ kind: "named-action", label: "Go", actionId: "" }),
        ).length,
      ).toBeGreaterThan(0);
    });

    it("rejects an UNKNOWN key on a field (no executable/HTML carrier smuggled in)", () => {
      for (const evil of ["html", "onClick", "render", "component", "script"]) {
        const errs = validateConfigSchema(
          wrap({ kind: "secret", key: "apiKey", label: "Key", [evil]: "<script>x</script>" }),
        );
        expect(errs.length, `expected ${evil} to be rejected`).toBeGreaterThan(0);
      }
    });
  });
});
