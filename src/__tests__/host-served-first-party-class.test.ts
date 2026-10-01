import { describe, expect, it } from "vitest";
import { isSdkOnlyViolation, scanHostInternalImports } from "../../extension-kind-gate.mjs";

const SHARED_MODULE = "@cinatra-ai/design-primitives";

describe("host-served primitive imports", () => {
  it("accepts the shared module without allowing unrelated first-party packages", () => {
    expect(isSdkOnlyViolation(SHARED_MODULE)).toBe(false);
    expect(isSdkOnlyViolation("@cinatra-ai/objects")).toBe(true);
    expect(isSdkOnlyViolation("@cinatra-ai/mcp-server/credentials")).toBe(true);
    expect(isSdkOnlyViolation("@cinatra-ai/design-primitives-private")).toBe(true);
  });

  it("keeps the host-internal import ban", () => {
    const source = ["import", '"@/components/ui/button"'].join(" ");
    expect(scanHostInternalImports(source)).toEqual(["@/components/ui/button"]);
  });
});
