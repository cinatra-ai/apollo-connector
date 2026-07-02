// Best-effort log rotation/retention for the connector's on-disk API logs.
//
// Dependency-free leaf module (same rationale as ./log-directory.ts — kept out
// of the heavy index barrel so it carries no init-order coupling). Keeps only
// the newest `maxFiles` connector log files in `directory`, deleting the older
// ones so the request/response captures can never grow unbounded.
//
// Filenames written by write*LogFile have the shape
// `${ISO-timestamp}__${label}__${kind}.json`, where the timestamp is
// `new Date().toISOString()` with `:`/`.` rewritten to `-` — a FIXED-WIDTH,
// lexicographically-sortable UTC prefix. So a plain string sort of the matching
// filenames is chronological (oldest first). We match ONLY that shape so an
// unrelated `.json` dropped in the directory is never pruned.
//
// NEVER throws: retention piggybacks on the write path, and a housekeeping
// failure must not break the API call that produced the log.

import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

/** Default cap on retained log files per directory. */
export const DEFAULT_MAX_LOG_FILES = 200;

/** Matches a `${ISO-timestamp}__${label}__${request|response}.json` log file. */
const LOG_FILENAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z__.+__(?:request|response)\.json$/;

export async function enforceLogRetention(
  directory: string,
  maxFiles: number = DEFAULT_MAX_LOG_FILES,
): Promise<void> {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    return;
  }
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // Directory absent/unreadable — nothing to prune.
    return;
  }
  const logFiles = entries.filter((name) => LOG_FILENAME.test(name)).sort();
  if (logFiles.length <= maxFiles) {
    return;
  }
  const stale = logFiles.slice(0, logFiles.length - maxFiles);
  await Promise.all(
    stale.map((name) => unlink(path.join(directory, name)).catch(() => {})),
  );
}
