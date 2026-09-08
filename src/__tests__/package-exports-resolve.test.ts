// Every subpath this package publishes must resolve to a file that exists.
// Retiring a module (cinatra#981 retired the connector-owned filesystem log
// directory leaf) has to retire its exports entry with it: a dangling subpath
// export is a runtime resolution error for anything importing it, and neither
// the package tests nor the extension kind gate would otherwise catch it.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  exports?: Record<string, unknown>;
};

function subpathTargets(exportsField: unknown): string[] {
  const targets: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      if (node.startsWith("./")) targets.push(node);
      return;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    }
  };
  walk(exportsField);
  return targets;
}

describe("package.json exports", () => {
  it("every exported subpath target exists on disk", () => {
    const missing = subpathTargets(pkg.exports).filter(
      (target) => !existsSync(path.join(packageRoot, target)),
    );
    expect(missing).toEqual([]);
  });

  it("exports no retired filesystem log-directory leaf", () => {
    expect(Object.keys(pkg.exports ?? {})).not.toContain("./log-directory");
  });
});
