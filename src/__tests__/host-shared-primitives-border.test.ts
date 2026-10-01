import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { preProcessFile } from "typescript";
import { describe, expect, it } from "vitest";

const SHARED_MODULE = "@cinatra-ai/design-primitives";

const SOURCE_ROOT = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(file);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

describe("design primitive boundary", () => {
  it("keeps no copies under the product primitive directory", () => {
    expect(existsSync(join(SOURCE_ROOT, "components", "ui"))).toBe(false);
  });

  it("uses only the exact host module id, without a registry dependency", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain(SHARED_MODULE);
    }
    const imports = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map(({ fileName }) => fileName),
    );
    expect(imports).toContain(SHARED_MODULE);
    expect(imports.filter((specifier) => specifier.startsWith(`${SHARED_MODULE}/`))).toEqual([]);
  });

  it("imports no product primitive copy or host-internal utility", () => {
    const offenders = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles
        .filter(({ fileName }) =>
          /(^|\/)components\/ui(?:\/|$)/.test(fileName) ||
          /^@\/lib\/utils(?:\/|$)/.test(fileName),
        )
        .map(({ fileName }) => `${relative(SOURCE_ROOT, file)}: ${fileName}`),
    );
    expect(offenders).toEqual([]);
  });
});
