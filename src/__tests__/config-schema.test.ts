// Contract fixtures for the declarative setup DSL (cinatra.configSchema).
//
// The Apollo connector ships a `uiSurface:"schema-config"` declaration
// (cinatra#782) so the host renders its setup page from DATA with NO rebuild —
// retiring the bundled-react settings/setup pages. These tests prove the
// declared `cinatra.configSchema` passes the PUBLIC validation path: the SAME
// fail-closed `validateConfigSchema` the repo's `extension-kind-gate.mjs` runs
// in CI (the rules-only port of the host's `parseSchemaConfig`). They also pin
// the issue #46 tab-group reorg (design spec: app-connectors §II — the base
// `fields` render as the host's reserved "Setup" tab; a reserved "Help" tab is
// declared LAST, mirroring the openai-connector precedent, cinatra-ai/cinatra
// #1101/#1102 + openai-connector#57).

import { describe, expect, it } from "vitest";
// The package.json is the manifest the host materializes; the configSchema under
// `cinatra` is the exact data the renderer parses.
import pkg from "../../package.json" with { type: "json" };
// The repo's standalone, zero-dependency validator (the kind-gate's public path).
import { validateConfigSchema } from "../../extension-kind-gate.mjs";

const configSchema = (pkg as { cinatra?: { configSchema?: unknown } }).cinatra
  ?.configSchema;

type Field = Record<string, unknown>;
type Tab = { id: string; label: string; fields: Field[] };

const tabs = (configSchema as { tabs?: Tab[] }).tabs ?? [];
const helpTab = tabs.find((t) => t.id === "help");

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

  describe("tab groups (design spec: app-connectors §II — Setup + reserved Help LAST)", () => {
    it("declares exactly one custom tab: the reserved Help tab", () => {
      // Apollo is single-connection with no additional config surface beyond the
      // connection itself (issue #46 acceptance: "correct single-connection vs
      // multi-instance layout for this connector's actual connection model") —
      // so the ONLY custom tab this connector needs is the reserved Help tab,
      // which is what introduces the tablist at all (item 18 of the tablist
      // conformance contract: no tabs + one connection ⇒ no tablist; declaring
      // Help is what turns this into a tabbed page).
      expect(tabs.map((t) => t.id)).toEqual(["help"]);
      expect(helpTab?.label).toBe("Help");
    });

    it('Help tab is READ-ONLY (no form, no Save): exactly one advisory field, no keyed/action-writing field kinds', () => {
      const helpFields = helpTab!.fields;
      expect(helpFields).toHaveLength(1);
      const advisory = helpFields[0] as {
        kind: string;
        tone?: string;
        probeActionId?: string;
        whenReady?: string;
        whenNotReady?: string;
      };
      expect(advisory.kind).toBe("advisory");
      expect(advisory.tone).toBe("info");
      // Reuses the Setup tab's existing connection probe — no new action
      // registered — so `whenReady`/`whenNotReady` track the SAME readiness
      // the status-probe pill on the Setup tab shows.
      expect(advisory.probeActionId).toBe("connectionStatus");
      expect(typeof advisory.whenReady).toBe("string");
      expect(typeof advisory.whenNotReady).toBe("string");
      expect((advisory.whenReady ?? "").length).toBeGreaterThan(0);
      expect((advisory.whenNotReady ?? "").length).toBeGreaterThan(0);
      // The plan-requirement how-to lives on the Help tab too.
      expect(String(advisory.whenNotReady)).toMatch(/People API Search/);

      // No field kind that emits an `<input>`/action button (text, secret,
      // select, boolean, number, free-list, named-action, status-probe,
      // nango-connect, repeatable-list, record-list, dynamic-select-options) —
      // "no form, no Save" per the design spec.
      const writeCapableKinds = new Set([
        "text", "secret", "select", "boolean", "number", "free-list",
        "named-action", "status-probe", "nango-connect", "repeatable-list",
        "record-list", "dynamic-select-options",
      ]);
      for (const f of helpFields) {
        expect(writeCapableKinds.has(f.kind as string), `${JSON.stringify(f.kind)} is not read-only`).toBe(false);
      }
    });

    it("Help tab field key stays unique against the Setup tab (one flat submit namespace — vacuous here since the advisory carries no key, but proves the shared-namespace threading)", () => {
      const setupFields = (configSchema as { fields: Field[] }).fields;
      const setupKeys = new Set(
        setupFields.filter((f) => typeof (f as { key?: unknown }).key === "string").map((f) => (f as { key: string }).key),
      );
      const helpKeys = (helpTab?.fields ?? [])
        .filter((f) => typeof (f as { key?: unknown }).key === "string")
        .map((f) => (f as { key: string }).key);
      for (const k of helpKeys) {
        expect(setupKeys.has(k), `Help tab key "${k}" collides with a Setup tab key`).toBe(false);
      }
    });
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

    it("rejects a non-array tabs value", () => {
      const nonArray = {
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        tabs: {},
      };
      expect(validateConfigSchema(nonArray).length).toBeGreaterThan(0);
    });

    it("rejects a tab with an UNKNOWN key (no executable/HTML carrier smuggled in on a tab)", () => {
      const evil = {
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        tabs: [{ id: "help", label: "Help", fields: [{ kind: "advisory", label: "A" }], onClick: "x" }],
      };
      expect(validateConfigSchema(evil).length).toBeGreaterThan(0);
    });

    it("rejects a tab with an invalid id", () => {
      const invalidId = {
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        tabs: [{ id: "1bad", label: "Help", fields: [{ kind: "advisory", label: "A" }] }],
      };
      expect(validateConfigSchema(invalidId).length).toBeGreaterThan(0);
    });

    it("rejects a tab with a missing label", () => {
      const noLabel = {
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        tabs: [{ id: "help", fields: [{ kind: "advisory", label: "A" }] }],
      };
      expect(validateConfigSchema(noLabel).length).toBeGreaterThan(0);
    });

    it("rejects a tab with a duplicate id", () => {
      const dup = {
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        tabs: [
          { id: "help", label: "Help", fields: [{ kind: "advisory", label: "A", tone: "info" }] },
          { id: "help", label: "Help again", fields: [{ kind: "advisory", label: "B", tone: "info" }] },
        ],
      };
      expect(validateConfigSchema(dup).length).toBeGreaterThan(0);
    });

    it("rejects a tab with an empty fields array", () => {
      const empty = {
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        tabs: [{ id: "help", label: "Help", fields: [] }],
      };
      expect(validateConfigSchema(empty).length).toBeGreaterThan(0);
    });

    it("rejects a keyed field on a tab that collides with a base-fields key", () => {
      const collide = {
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        tabs: [{ id: "help", label: "Help", fields: [{ kind: "text", key: "apiKey", label: "Dup" }] }],
      };
      expect(validateConfigSchema(collide).length).toBeGreaterThan(0);
    });

    it("rejects an UNKNOWN root key (no executable/HTML carrier smuggled in at the top level)", () => {
      const errs = validateConfigSchema({
        fields: [{ kind: "secret", key: "apiKey", label: "Key" }],
        html: "<script>x</script>",
      });
      expect(errs.length).toBeGreaterThan(0);
    });
  });
});
