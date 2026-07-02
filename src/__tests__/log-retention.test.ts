// Proves best-effort log rotation: only the newest N connector log files are
// kept, unrelated files are never touched, and a missing directory is a no-op
// (retention must never throw on the write path).

import { mkdtemp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enforceLogRetention } from "../log-retention";

let dir: string;

function logName(seq: number, kind: "request" | "response" = "request") {
  // Fixed-width ISO-like timestamp prefix so lexical order == chronological.
  const ts = `2026-07-02T00-00-${String(seq).padStart(2, "0")}-000Z`;
  return `${ts}__apollo-call__${kind}.json`;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "apollo-log-retention-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("enforceLogRetention", () => {
  it("keeps only the newest maxFiles log files, deleting the oldest", async () => {
    for (let i = 1; i <= 10; i += 1) {
      await writeFile(path.join(dir, logName(i)), "{}", "utf8");
    }
    await enforceLogRetention(dir, 3);
    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual([logName(8), logName(9), logName(10)]);
  });

  it("is a no-op when the count is within the cap", async () => {
    await writeFile(path.join(dir, logName(1)), "{}", "utf8");
    await writeFile(path.join(dir, logName(2)), "{}", "utf8");
    await enforceLogRetention(dir, 200);
    expect((await readdir(dir)).length).toBe(2);
  });

  it("never deletes unrelated files that are not connector log captures", async () => {
    await writeFile(path.join(dir, logName(1)), "{}", "utf8");
    await writeFile(path.join(dir, logName(2)), "{}", "utf8");
    await writeFile(path.join(dir, "README.json"), "{}", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "x", "utf8");
    await enforceLogRetention(dir, 1);
    const remaining = (await readdir(dir)).sort();
    // Only the oldest matching log file is pruned; foreign files survive.
    expect(remaining).toEqual(["README.json", logName(2), "notes.txt"].sort());
  });

  it("does not throw when the directory is absent", async () => {
    await rm(dir, { recursive: true, force: true });
    await expect(enforceLogRetention(dir, 3)).resolves.toBeUndefined();
  });

  it("does not prune when maxFiles is non-positive", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, logName(1)), "{}", "utf8");
    await enforceLogRetention(dir, 0);
    expect((await readdir(dir)).length).toBe(1);
  });
});
