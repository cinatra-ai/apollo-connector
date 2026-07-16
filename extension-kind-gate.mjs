#!/usr/bin/env node
// ---------------------------------------------------------------------------
// extension-kind-gate — self-contained, zero-dependency extension validator for
// a Cinatra extension repo. ONE local command an external author runs to catch
// what the install pipeline would reject, BEFORE publishing:
//
//     node extension-kind-gate.mjs --package-root .
//
// This file is shipped INTO each scaffolded Cinatra extension repo by
// `cinatra create-extension <kind>` (the cinatra-cli authoring surface) and run
// by the repo's standalone CI. It covers the four extension kinds (agent,
// connector, artifact, skill).
//
// CANONICAL OWNER: this gate is the canonical author-facing pre-publish gate
// (cinatra-cli#72). Its rules mirror the AUTHORITATIVE host enforcers
// in the cinatra monorepo (the install pipeline). The release tooling
// mirrors/tracks it; the cinatra-cli copy is the source of truth for authors.
//
// IT MUST STAY SELF-CONTAINED — only Node builtins, no `@cinatra-ai/*`
// dependency, no `npx`/`pnpm dlx` of a published tool. A public extension repo's
// CI runs unauthenticated and BEFORE the @cinatra-ai registry is reachable, so a
// gate that resolved a published tool would fail closed on a registry 404 for
// every extension repo. This gate has no such dependency.
//
// WHAT IT ENFORCES (the extension→host rules that DEFINE a valid extension —
// each mirrors the authoritative host enforcer in the cinatra monorepo so the
// local gate and the install pipeline cannot disagree):
//
//   COMMON (every kind):
//     - manifest shape: cinatra.kind ∈ the four kinds; cinatra.apiVersion ===
//       "cinatra.ai/v1"; cinatra.dependencies is an array of well-formed
//       ExtensionDependency entries (mirrors extension-deps-gate.mjs +
//       inventory.isValidExtensionDependency).
//     - port names: every cinatra.requestedHostPorts entry is a real
//       HOST_PORT_NAME (mirrors sdk-extensions host-context.HOST_PORT_NAMES).
//     - sdkAbiRange grammar: a declared range parses to supported bounds
//       (mirrors sdk-extensions register.rangeBounds — major ≥ 1, only ^ ~ >= =
//       / bare / x-range). "" and "*" are unpinned/OK.
//     - the `@/` import ban: no source imports a host-internal `@/…` module
//       (mirrors extension-import-ban hostInternal, pinned empty).
//     - SDK-only first-party deps: the only @cinatra-ai/* CODE deps permitted
//       (source imports OR package.json deps/peer/optional) are
//       @cinatra-ai/sdk-extensions + @cinatra-ai/sdk-ui (mirrors
//       extension-import-ban sdkOnly, pinned empty). This subsumes the
//       cross-extension ban for the @cinatra-ai scope. (Standalone scope note
//       below.)
//     - host-peer value-import ban over the serverEntry graph: no VALUE import
//       of @cinatra-ai/{sdk-extensions,sdk-ui,mcp-client} is reachable from
//       cinatra.serverEntry; route values through ctx, keep peers type-only
//       (mirrors host-peer-value-import-ban.mjs HOST_PEERS).
//     - README/license: a root README.md that satisfies the README contract
//       (mirrors extension-readme-gate.validateReadmeContent); package.json
//       `license` matches policy (mirrors extension-license-gate).
//     - serverEntry preflight: a declared serverEntry resolves (direct path or
//       exports-map key, no abs/`..`) to an existing file (mirrors runtime-loader
//       resolveDeclaredServerEntry + classifyServerEntryArtifact). A SOURCE entry
//       (.ts/.tsx/.mts/.cts) is accepted with a WARNING — the runtime store
//       requires a BUILT artifact, but the release build (build-server-entry.mjs)
//       produces it; the dev/source repo legitimately ships source.
//     - retired cinatra.migrations JSON-DSL is rejected (mirrors the SDK
//       `migrations?: never` + the install-preflight/boot/hot-activate refusal).
//     - schema-config: a connector declaring uiSurface:"schema-config" must ship
//       a valid cinatra.configSchema (mirrors classifyConnectorUiSurfaceErrors).
//     - roles: when present, cinatra.roles must be a string[] (the agent-bindings
//       generator validates uniqueness host-side; shape is enforceable here).
//
//   PER-KIND (mirrors the kind's host handler / gate):
//     - agent     → cinatra/oas.json (if present) parses + no retired CRM
//                    primitive in LLM-visible prompt strings (mirrors
//                    scripts/audit/oas-banned-primitives-gate.mjs).
//     - connector → name @<vendor>/<slug>-connector; kind:"connector";
//                    cinatra.visibility (when set) ∈ {admin,workspace}
//                    (mirrors connector-handler.validate).
//     - artifact  → name @cinatra-ai/<slug>-artifact; kind:"artifact"; NO
//                    cinatra.oas; mandatory valid cinatra.artifact descriptor;
//                    cinatra block carries only {kind,apiVersion,artifact,
//                    dependencies,roles,displayName,vendor} (mirrors
//                    artifact-handler.validate + the shared
//                    ARTIFACT_ALLOWED_CINATRA_KEYS; displayName + vendor are
//                    cross-kind presentation/byline metadata).
//     - skill     → name ends `-skills`; kind:"skill" (mirrors the kind-at-end
//                    naming-conformance rule for skills).
//   (The `workflow` kind is RETIRED: a package declaring cinatra.kind:"workflow"
//    is rejected as an unknown kind — there is no workflow per-kind gate.)
//
// WARNINGS (printed, never fail): the gate prints advisory notes for things it
// cannot certify standalone or that are release/runtime-time (source serverEntry
// not yet built; an sdkAbiRange the CURRENT host ABI 2.2.0 would not satisfy).
//
// SCOPE (intentionally a PRE-PUBLISH local gate; the authoritative full OAS
// runtime-invariant validation + the trust/signature check re-run
// marketplace-side at publish/install). STANDALONE SCOPE NOTE: the
// monorepo derives the first-party scope set from the on-disk extensions/<scope>/
// dirs; a single repo cannot see sibling extension scopes, so this gate treats
// ONLY @cinatra-ai as the first-party scope. A cross-extension coupling on a
// non-@cinatra-ai sibling scope is NOT detected here (the monorepo gate would
// fail it). Materially low for normal external authors, whose only first-party
// peers are @cinatra-ai/*.
//
// Usage:
//   node extension-kind-gate.mjs                  # gate cwd
//   node extension-kind-gate.mjs --package-root . # gate an explicit dir
//
// Exit codes: 0 clean / pass · 1 one or more violations.
// ---------------------------------------------------------------------------
// >>> ERT-MIRROR-ONLY-BEGIN: vendoring note (stripped by the canonical projection) >>>
// The release tooling VENDORS the cinatra-cli canonical gate above and ships it
// into monorepo-EXTRACTED repos. The ONLY local edits are the fenced
// `ERT-MIRROR-ONLY` blocks below (the hot-installability UI-surface classifier +
// its connector advisory). Everything OUTSIDE these fences MUST stay
// byte-identical to the cinatra-cli canonical — a scheduled drift audit strips
// these fences and diffs the result against the live canonical. Change the
// canonical upstream (cinatra-cli), then re-sync here; do not diverge locally.
// <<< ERT-MIRROR-ONLY-END: vendoring note <<<

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename, dirname, relative, normalize, isAbsolute, sep } from "node:path";

// ===========================================================================
// arg parsing
// ===========================================================================
export function parseArgs(argv) {
  let packageRoot = ".";
  // Artifact-parity enforcement (the WARN→BLOCK ratchet): default is WARN
  // (advisory); the release/republish path opts into BLOCK via the flag or env.
  let enforceArtifactParity = process.env.CINATRA_ARTIFACT_PARITY === "block";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package-root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--package-root requires a value");
      packageRoot = value;
      i++;
    } else if (arg.startsWith("--package-root=")) {
      packageRoot = arg.slice("--package-root=".length);
    } else if (arg === "--enforce-artifact-parity") {
      enforceArtifactParity = true;
    }
  }
  return { packageRoot: resolve(packageRoot), enforceArtifactParity };
}

// ===========================================================================
// Canonical constants — kept in lock-step with the cinatra monorepo. The
// monorepo parity test (extension-release-tooling tests + the cinatra-side
// gates) is the drift guard; these lists must match exactly.
// ===========================================================================
export const VALID_KINDS = ["agent", "connector", "artifact", "skill"];
export const API_VERSION = "cinatra.ai/v1";

// sdk-extensions host-context.HOST_PORT_NAMES (ABI FROZEN).
export const HOST_PORT_NAMES = new Set([
  "db", "settings", "secrets", "nango", "authSession", "mcp", "objects",
  "jobs", "notifications", "ui", "logger", "runtime", "capabilities", "telemetry",
]);

// inventory.SDK_PACKAGES — the only permitted first-party @cinatra-ai CODE deps.
export const SDK_PACKAGES = new Set(["@cinatra-ai/sdk-extensions", "@cinatra-ai/sdk-ui"]);

// host-peer-value-import-ban.HOST_PEERS — value imports of these over the
// serverEntry graph are forbidden (the prod file:// loader cannot resolve them).
export const HOST_PEERS = new Set([
  "@cinatra-ai/sdk-extensions", "@cinatra-ai/sdk-ui", "@cinatra-ai/mcp-client",
]);

// The host scope is the only scope a standalone repo can authoritatively treat
// as first-party (sibling extension scopes live in the monorepo's extensions/).
export const FIRST_PARTY_SCOPE = "@cinatra-ai";

// inventory dependency enums.
const VALID_DEPENDENCY_EDGE_TYPES = new Set(["runtime", "install-time", "peer"]);
const VALID_DEPENDENCY_REQUIREMENTS = new Set(["required", "optional"]);

// sdk-extensions register.SDK_EXTENSIONS_ABI_VERSION — used only for the
// advisory ABI-compat WARNING (host-side runtime verdict, not author-time validity).
export const SDK_EXTENSIONS_ABI_VERSION = "2.2.0";

const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

// ===========================================================================
// shared text helpers
// ===========================================================================
/** Strip // line and block comments. The `[^:]` guard preserves `https://`
 * inside string literals. Mirrors inventory.stripComments. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Collapse a specifier to its base package: `@scope/name/sub` → `@scope/name`,
 * `pkg/sub` → `pkg`. null for a relative/bare-module specifier. Mirrors
 * inventory.basePackageOf. */
export function basePackageOf(spec) {
  if (typeof spec !== "string" || spec.length === 0) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return null;
    return parts[0] + "/" + parts[1];
  }
  return spec.split("/")[0];
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function nonEmptyStr(v) {
  return typeof v === "string" && v.length > 0;
}

function walkSourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (["dist", "build", ".next", "coverage"].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkSourceFiles(full, acc);
    else if (SOURCE_EXT_RE.test(e.name)) acc.push(full);
  }
  return acc;
}

// ===========================================================================
// Builtins-only import classifier.
//
// The host's host-peer-value-import-ban uses the TypeScript parser to classify
// type-only vs value imports. This gate is plain `.mjs` running BEFORE any npm
// install, so it cannot import `typescript`. This classifier matches the form
// coverage of the monorepo's regex scanners (inventory.mjs) plus the
// type-only/value distinction the host-peer gate needs.
//
// FAIL-CLOSED on ambiguity: only a DECLARATION-LEVEL `import type` /
// `export type` is treated as erased (no runtime edge). Every other import —
// including `import { type X } from "…"` (inline type specifiers) and bare
// side-effect `import "…"` — is treated as a VALUE edge, exactly as the host's
// classifier does under verbatimModuleSyntax / Node type-stripping (only the
// whole-declaration `import type` is erased; an inline `type` brace still emits
// `import {} from "x"`, a runtime edge). This is the safe direction: an
// ambiguous import is conservatively a value edge.
// ===========================================================================

/** Parse `text` into import records: { specifier, isValueEdge, kind }.
 * Covers static `import`/`export … from`, `import type`/`export type`,
 * `import x = require(...)`, bare side-effect `import "x"`, dynamic `import(...)`,
 * and `require(...)`.
 *
 * The static-import clause is matched STATEMENT-LOCAL: between the
 * `import`/`export` keyword and its `from` there may be NO statement boundary —
 * no `;`, no quote (a bare side-effect import's specifier), and no nested
 * `import`/`export`/`from`/`require` keyword. This is the decisive fix for a
 * bare `import "server-only";` on the line ABOVE a real `import type { X } from
 * "@peer"` — a spanning matcher would attribute the type-only import's specifier
 * to the line-above value import and mis-flag it as a host-peer value edge. */
export function parseModuleImports(text) {
  const code = stripComments(text);
  const out = [];

  // Static `import …`/`export … from "x"` — including declaration-level
  // type-only (`import type …` / `export type …`, capture group 2). The clause
  // body [^;"'`]* forbids a statement boundary, so a match cannot span past the
  // current statement into a following import.
  const declRe =
    /\b(import|export)\b([ \t]+type\b)?[^;"'`]*?\bfrom[ \t]*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = declRe.exec(code)) !== null) {
    const isTypeOnly = Boolean(m[2]);
    out.push({ specifier: m[3], isValueEdge: !isTypeOnly, kind: m[1] });
  }

  // Bare side-effect import: `import "x";` (no `from`). Value edge. The negative
  // lookahead skips `import type …` / `import x = …` (handled elsewhere) and a
  // dynamic `import(` call.
  const sideEffectRe = /\bimport[ \t]+(?!type\b)["'`]([^"'`]+)["'`]/g;
  while ((m = sideEffectRe.exec(code)) !== null) {
    out.push({ specifier: m[1], isValueEdge: true, kind: "import" });
  }

  // import x = require("y") — value edge unless `import type x = require`.
  const importEqRe =
    /\bimport\b([ \t]+type\b)?[ \t]+[A-Za-z0-9_$]+[ \t]*=[ \t]*require[ \t]*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  while ((m = importEqRe.exec(code)) !== null) {
    out.push({ specifier: m[2], isValueEdge: !m[1], kind: "require" });
  }

  // Dynamic import("x") and require("x")/module.require("x") — value edges.
  const callRe = /(?:\bimport\b|\brequire\b)[ \t]*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  while ((m = callRe.exec(code)) !== null) {
    out.push({ specifier: m[1], isValueEdge: true, kind: "dynamic" });
  }

  return out;
}

/** Distinct `@/…` host-internal specifiers in `text`. */
export function scanHostInternalImports(text) {
  const hits = new Set();
  for (const imp of parseModuleImports(text)) {
    if (imp.specifier.startsWith("@/")) hits.add(imp.specifier);
  }
  return [...hits];
}

/** Is `spec` a NON-SDK first-party (@cinatra-ai) base-package coupling? */
export function isSdkOnlyViolation(spec) {
  const base = basePackageOf(spec);
  if (!base || !base.startsWith("@")) return false;
  const scope = base.split("/")[0];
  if (scope !== FIRST_PARTY_SCOPE) return false;
  return !SDK_PACKAGES.has(base);
}

// ===========================================================================
// COMMON rule engine — runs for EVERY kind. Pure: returns { errors, warnings }.
// ===========================================================================

export function readPackageJson(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

/** Validate ONE cinatra.dependencies entry. Mirrors the install-time
 * `validateExtensionDependencyShape` (packages/extensions/src/manifest-dependencies):
 * right shape + a self-edge is MALFORMED. (The cross-package kind-match + the
 * duplicate-packageName check need the full list — done in validateCommon.) */
export function isValidDependencyEntry(dep, selfName = null) {
  if (!dep || typeof dep !== "object") return false;
  if (typeof dep.packageName !== "string" || dep.packageName.length === 0) return false;
  if (selfName && dep.packageName === selfName) return false; // self-edge — MALFORMED at install
  if (!VALID_DEPENDENCY_EDGE_TYPES.has(dep.edgeType)) return false;
  if (!VALID_DEPENDENCY_REQUIREMENTS.has(dep.requirement)) return false;
  const vc = dep.versionConstraint;
  if (!vc || typeof vc !== "object") return false;
  if (vc.kind === "semver-range") {
    if (!nonEmptyStr(vc.range)) return false;
  } else if (vc.kind === "exact") {
    if (!nonEmptyStr(vc.version)) return false;
  } else if (vc.kind === "git-ref") {
    if (!nonEmptyStr(vc.ref)) return false; // valid SHAPE (the install-plan caveat is a warning)
  } else {
    return false;
  }
  if (dep.kind !== undefined && !VALID_KINDS.includes(dep.kind)) return false;
  return true;
}

/** Mirror of sdk-extensions register.rangeBounds — does the range PARSE to a
 * supported form? (We do NOT need the host-ABI-inside verdict for validity;
 * declaring an unsupported/malformed range is the author-time failure.) Returns
 * true when the range is a supported grammar OR empty/"*". */
export function isSupportedAbiRange(range) {
  const r = (range ?? "").trim();
  if (r === "" || r === "*") return true;
  const m = r.match(/^(\^|~|>=|=)?\s*(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/);
  if (!m) return false;
  const maj = Number(m[2]);
  if (maj < 1) return false; // major-0 ABI semantics differ — fail closed
  return true;
}

/** Advisory: would the CURRENT host ABI satisfy this range? (host-side runtime
 * verdict — a WARNING here, not an author-time validity failure.) Mirrors
 * register.isSdkAbiRangeSatisfied for the supported forms. */
export function abiRangeSatisfiedByHost(range, hostAbi = SDK_EXTENSIONS_ABI_VERSION) {
  const r = (range ?? "").trim();
  if (r === "" || r === "*") return true;
  const m = r.match(/^(\^|~|>=|=)?\s*(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/);
  if (!m) return false;
  const op = m[1] ?? "=";
  const maj = Number(m[2]);
  if (maj < 1) return false;
  const isWild = (t) => t === undefined || /^[xX*]$/.test(t);
  const min = isWild(m[3]) ? null : Number(m[3]);
  const pat = isWild(m[4]) ? null : Number(m[4]);
  const lower = [maj, min ?? 0, pat ?? 0];
  let upper = null;
  if (op === ">=") upper = null;
  else if (op === "^") upper = [maj + 1, 0, 0];
  else if (op === "~") upper = min === null ? [maj + 1, 0, 0] : [maj, min + 1, 0];
  else if (min === null) upper = [maj + 1, 0, 0];
  else if (pat === null) upper = [maj, min + 1, 0];
  else upper = [maj, min, pat + 1];
  const hm = hostAbi.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!hm) return false;
  const host = [Number(hm[1]), Number(hm[2]), Number(hm[3])];
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  if (cmp(host, lower) < 0) return false;
  if (upper && cmp(host, upper) >= 0) return false;
  return true;
}

// ---- license policy (mirror of apply-license-cleanup.targetLicenseFor) ----
/** The policy license a manifest's `license` field must carry, or null if no
 * fixed policy applies (a non-@cinatra-ai or vendored package — the standalone
 * repo then only requires a non-empty value + warns). @cinatra-ai scope ⇒
 * Apache-2.0, UNLESS the package is vendored (cinatra.vendoredFrom present): a
 * vendored package keeps its upstream license. */
export function policyLicenseFor(pkg) {
  const name = typeof pkg?.name === "string" ? pkg.name : "";
  const vendored = pkg?.cinatra?.vendoredFrom != null;
  if (name.startsWith(`${FIRST_PARTY_SCOPE}/`) && !vendored) return "Apache-2.0";
  return null;
}

// ---- serverEntry resolution (mirror of runtime-loader resolveExportsSubpath /
// resolveDeclaredServerEntry + host-peer-value-import-ban safeJoinInside) ----
function resolveExportsSubpath(exportsMap, key) {
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return null;
  // Pinned Cinatra semantics (mirror build-server-entry / runtime-loader): exact
  // key lookup; a conditional entry is ONE level deep; the target MUST be a
  // `./`-relative string — anything else (an absolute/bare/non-`./` string, an
  // array, a wildcard, a nested condition object, a null target) resolves to null.
  const asContractTarget = (t) => (typeof t === "string" && t.startsWith("./") ? t : null);
  const target = exportsMap[key];
  if (typeof target === "string") return asContractTarget(target);
  if (target && typeof target === "object") {
    return asContractTarget(target.import ?? target.default ?? target.require);
  }
  return null;
}

/** Join `rel` inside `rootDir`, refusing absolute paths AND any `..` segment.
 * Segment-level (not normalize-based): a `./dist/../register.mjs` that would
 * normalize back inside the package is STILL refused — the host materializer +
 * loader apply the same segment-level rule so install-time and activation-time
 * agree (mirror extension-package-store + resolveServerEntryPath). */
function safeJoinInside(rootDir, rel) {
  const cleaned = rel.replace(/^\.\//, "");
  if (cleaned.startsWith("/") || isAbsolute(cleaned)) return null;
  if (cleaned.split(/[\\/]/).some((seg) => seg === "..")) return null;
  const abs = normalize(join(rootDir, cleaned));
  const root = normalize(rootDir);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

function fileIsRegular(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function classifyServerEntryArtifact(rel) {
  if (/\.(mjs|cjs|js)$/.test(rel)) return "importable";
  if (/\.(ts|tsx|mts|cts)$/.test(rel)) return "source";
  return "unresolved";
}

/** Resolve cinatra.serverEntry to a verdict. kind ∈ absent | resolved |
 * invalid-exports-target | missing-file | unsafe. Mirrors the host runtime store
 * (extension-package-store): an exports KEY whose target is outside the pinned
 * resolver language is refused (never falls back to the literal path); the
 * resolved `rel` must name the file EXACTLY (no extension probing — the host
 * classifies the literal `rel`, so an extensionless `./register` literal is
 * `unresolved` and refused) and must exist on disk. */
export function resolveServerEntry(packageRoot, pkg) {
  const cinatra = isObj(pkg?.cinatra) ? pkg.cinatra : {};
  const serverEntry = typeof cinatra.serverEntry === "string" ? cinatra.serverEntry : null;
  if (!serverEntry) return { kind: "absent" };
  const exportsMap = pkg.exports;
  const isMap = isObj(exportsMap);
  let rel;
  if (isMap && serverEntry in exportsMap) {
    const resolved = resolveExportsSubpath(exportsMap, serverEntry);
    if (resolved === null) return { kind: "invalid-exports-target", serverEntry };
    rel = resolved;
  } else {
    // A direct (non-exports-key) serverEntry that is NOT a `./`-relative string
    // is outside the resolver language too — refuse it like an invalid target.
    if (!serverEntry.startsWith("./")) return { kind: "invalid-exports-target", serverEntry };
    rel = serverEntry;
  }
  const abs = safeJoinInside(packageRoot, rel);
  if (!abs) return { kind: "unsafe", serverEntry, rel };
  // EXACT file (no probing) — the host classifies + materializes the literal rel.
  if (fileIsRegular(abs)) return { kind: "resolved", rel, abs };
  return { kind: "missing-file", serverEntry, rel };
}

function resolveRelativeImport(packageRoot, fromAbs, rel) {
  const baseRel = relative(packageRoot, dirname(fromAbs));
  const joined = safeJoinInside(packageRoot, join(baseRel || ".", rel));
  if (!joined) return null;
  const candidates = [joined];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(joined + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(join(joined, `index${ext}`));
  for (const c of candidates) if (fileIsRegular(c)) return c;
  return null;
}

function resolveSelfPackageImport(packageRoot, exportsMap, selfName, spec) {
  const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (base !== selfName) return null;
  const subpath = spec === selfName ? "." : "." + spec.slice(selfName.length);
  const rel = resolveExportsSubpath(exportsMap, subpath);
  if (!rel) return null;
  const abs = safeJoinInside(packageRoot, rel);
  if (!abs) return null;
  if (fileIsRegular(abs)) return abs;
  for (const ext of SOURCE_EXTENSIONS) if (fileIsRegular(abs + ext)) return abs + ext;
  return null;
}

/** Trace the serverEntry VALUE-edge graph over the extension's OWN files and
 * return host-peer value-import hit descriptors. Mirrors
 * host-peer-value-import-ban.scanExtensionGraph. */
export function scanHostPeerValueImports(packageRoot, pkg, entryAbs) {
  if (!entryAbs) return [];
  const selfName = typeof pkg?.name === "string" ? pkg.name : null;
  const exportsMap = pkg?.exports;
  const visited = new Set();
  const queue = [entryAbs];
  const hits = new Set();
  while (queue.length) {
    const fileAbs = queue.shift();
    if (visited.has(fileAbs)) continue;
    visited.add(fileAbs);
    let source;
    try {
      source = readFileSync(fileAbs, "utf8");
    } catch (err) {
      // Fail-loud: a file that resolved INTO the graph but can't be read cannot
      // be certified (mirrors the host gate's fail-closed contract).
      throw new Error(
        `serverEntry graph file ${relative(packageRoot, fileAbs)} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const imp of parseModuleImports(source)) {
      if (!imp.isValueEdge) continue;
      const base = basePackageOf(imp.specifier);
      if (base && HOST_PEERS.has(base)) {
        hits.add(`${relative(packageRoot, fileAbs)} :: ${base}`);
      }
      // Follow only relative + self-package value edges (never node_modules /
      // third-party bare specifiers).
      const spec = imp.specifier;
      let next = null;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        next = resolveRelativeImport(packageRoot, fileAbs, spec);
      } else if (selfName) {
        next = resolveSelfPackageImport(packageRoot, exportsMap, selfName, spec);
      }
      if (next && !visited.has(next)) queue.push(next);
    }
  }
  return [...hits].sort();
}

// >>> ERT-MIRROR-ONLY-BEGIN: hot-installability UI-surface classifier (absent from the cinatra-cli canonical) >>>
// ===========================================================================
// Hot-installability UI-surface classifier — mirror of the host
// `classifyUiSurface` (cinatra scripts/extensions/generate-extension-manifest.mjs).
//
// A connector is HOT-installable (no app rebuild) only when its setup surface is
// declarative: `cinatra.uiSurface:"schema-config"` (+ a `cinatra.configSchema`)
// or a facade/no-UI connector. A connector whose setup page is a BUNDLED REACT
// component (`cinatra.uiSurface:"bundled-react"`, or the legacy heuristic of a
// bespoke `src/setup-page.tsx` / `src/settings-page.tsx`) is base-image-only —
// the host raises ConnectorRequiresRebuildError and it is NOT hot-installable.
//
// This classifier is PURE over the manifest's cinatra block + presence flags so
// it can be reused by the report + the validator WITHOUT re-running the gate
// (no recursion into runGate). Only `connector` has a UI surface — every other
// kind is declarative ⇒ classified `null` (hot).
// ===========================================================================

/** Filesystem presence flags the host derives in `entryFlags` (the bundled-react
 * heuristic when no `cinatra.uiSurface` is declared). */
export function readConnectorUiFlags(packageRoot) {
  return {
    hasSetupPage: existsSync(join(packageRoot, "src", "setup-page.tsx")),
    hasSettingsPage: existsSync(join(packageRoot, "src", "settings-page.tsx")),
  };
}

/**
 * Classify a connector's UI surface. Mirrors host `classifyUiSurface` EXACTLY:
 *   uiSurface:"schema-config" → "schema-config" (hot)
 *   uiSurface:"bundled-react" → "bundled-react" (NOT hot — base-image-only)
 *   else hasSetupPage || hasSettingsPage → "bundled-react" (legacy heuristic)
 *   else → null (facade/runtime connector — hot)
 * A non-connector kind is always `null` (declarative kinds are always hot).
 *
 * @param {string} kind the manifest `cinatra.kind`
 * @param {object} cinatra the manifest `cinatra` block
 * @param {{hasSetupPage:boolean, hasSettingsPage:boolean}} flags
 * @returns {"schema-config"|"bundled-react"|null}
 */
export function classifyConnectorUiSurface(kind, cinatra, flags) {
  if (kind !== "connector") return null;
  const cin = isObj(cinatra) ? cinatra : {};
  if (cin.uiSurface === "schema-config") return "schema-config";
  if (cin.uiSurface === "bundled-react") return "bundled-react";
  if (flags?.hasSetupPage || flags?.hasSettingsPage) return "bundled-react";
  return null;
}

// <<< ERT-MIRROR-ONLY-END: hot-installability UI-surface classifier <<<
// ===========================================================================
// Dead app-route guard.
//
// Skill/README/authoring content frequently links the user to a Cinatra app
// route (e.g. "[Open settings](/settings)"). When the app renames or removes a
// route, those links rot silently — the assistant then sends users to a 404.
// This guard fails the gate on any reference to a KNOWN-DEAD top-level app
// route in a markdown file, with the live replacement, so a new (or stale)
// skill that names a dead route cannot pass CI.
//
// Grounded against the cinatra app router (src/app/*) — only routes verified
// REMOVED are listed; live routes (e.g. /workflows, which still exists) are
// deliberately NOT listed to avoid false failures. Each entry matches a
// route-shaped reference (start-of-line or a markdown/string/bracket delimiter
// before it; a non-path terminator after it) so it does not fire on a legit
// nested route such as /teams/{teamId}/settings or on /settings/connections,
// which has its own (more specific) rule. Matches inside fenced code blocks are
// skipped (illustrative, not live links); backticked inline references DO fire.
//
// The prefix also catches an ABSOLUTE cinatra app URL (e.g.
// https://app.cinatra.ai/settings) — a delimiter alone would miss it because a
// hostname char sits right before the path. To avoid flagging unrelated
// third-party URLs that merely share a path, the host form is scoped to a
// cinatra app host (…cinatra.ai or …cinatra.app, optionally with a subdomain).
// The host is LEFT-BOUNDED (`//`, `@`, or a label-dot before the cinatra label)
// so a look-alike like `evilcinatra.ai` does NOT match, and an optional `:port`
// is tolerated (e.g. https://cinatra.ai:443/settings). Out of scope (rare in
// skill prose, and adding them risks false-positives): routes that live in a
// URL query (`?next=/settings`) or fragment (`#/settings`) — the assistant
// surfaces a bare path or an absolute app URL, not a re-encoded one.
// ===========================================================================
const CINATRA_HOST = String.raw`(?:/{2}|@|[A-Za-z0-9-]+\.)(?:[A-Za-z0-9-]+\.)*cinatra\.(?:ai|app)(?::\d+)?`;
const ROUTE_PREFIX = String.raw`(?:^|[\s([{"'\`<]|${CINATRA_HOST})`;
// Terminator AFTER the route: end, whitespace, or a delimiter — but for the
// bare /settings rule, a following "/" is NOT allowed (so /settings/connections
// is only reported by its own, more specific rule, never duplicated here).
const ROUTE_END_NO_SLASH = String.raw`(?=$|[\s)\]}'"\`>,.;:!?#])`;
const ROUTE_END_WITH_SLASH = String.raw`(?=$|[/?#\s)\]}'"\`>,.;:!?])`;

export const DEAD_APP_ROUTES = [
  { route: "/settings/connections", replacement: "/connectors", pattern: new RegExp(`${ROUTE_PREFIX}(/settings/connections)${ROUTE_END_WITH_SLASH}`, "g") },
  { route: "/settings", replacement: "/account", pattern: new RegExp(`${ROUTE_PREFIX}(/settings)${ROUTE_END_NO_SLASH}`, "g") },
  { route: "/agents/registry", replacement: "/configuration/marketplace", pattern: new RegExp(`${ROUTE_PREFIX}(/agents/registry)${ROUTE_END_WITH_SLASH}`, "g") },
  // The standalone run-agent picker page was removed (not redirected, by
  // design — cinatra-ai/cinatra#1007): the picker now lives on the /agents
  // "All Agents" tab. WITH_SLASH deliberately covers the removed page's whole
  // subtree. The dynamic /agents/<vendor>/<slug>/<instanceId> routes stay
  // live and would collide only if a vendor were literally named "run" —
  // no cinatra vendor is (vendors are npm-scope-shaped names such as
  // cinatra-ai); narrow this rule to NO_SLASH if one ever appears.
  { route: "/agents/run", replacement: "/agents", pattern: new RegExp(`${ROUTE_PREFIX}(/agents/run)${ROUTE_END_WITH_SLASH}`, "g") },
];

/** Yield checkable markdown lines (outside fenced code blocks) as
 * { lineno, text } from `rawText`. Inline `code spans` are kept — a backticked
 * dead route is still a dead route the assistant will surface. */
export function* iterMarkdownLines(rawText) {
  let inFence = false;
  let lineno = 0;
  for (const raw of rawText.split(/\r?\n/)) {
    lineno += 1;
    const t = raw.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    yield { lineno, text: raw };
  }
}

/** Walk `.md` files under `dir`, skipping vendor/build dirs. */
function walkMarkdownFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (["dist", "build", ".next", "coverage"].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMarkdownFiles(full, acc);
    else if (/\.md$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

/** Scan every markdown file under `packageRoot` for references to a known-dead
 * app route. Returns an array of human-readable error strings (file:line + the
 * live replacement). Self-contained; no host dependency. */
export function validateNoDeadAppRoutes(packageRoot) {
  const errors = [];
  for (const file of walkMarkdownFiles(packageRoot)) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(packageRoot, file) || basename(file);
    for (const { lineno, text } of iterMarkdownLines(raw)) {
      for (const { route, replacement, pattern } of DEAD_APP_ROUTES) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          errors.push(`${rel}:${lineno} references dead app route ${route} — use ${replacement} (the route was renamed/removed in the cinatra app)`);
        }
      }
    }
  }
  return errors;
}

/** The common (all-kinds) validation. Returns { errors:[], warnings:[] }. */
export function validateCommon(packageRoot) {
  const errors = [];
  const warnings = [];
  let pkg;
  try {
    pkg = readPackageJson(packageRoot);
  } catch (err) {
    return { errors: [`could not read package.json: ${err instanceof Error ? err.message : String(err)}`], warnings };
  }
  const cinatra = isObj(pkg.cinatra) ? pkg.cinatra : null;

  // ---- 1. manifest shape ----
  if (!cinatra) {
    errors.push("package.json must declare a `cinatra` manifest block (object)");
    return { errors, warnings }; // nothing else checkable without it
  }
  if (!VALID_KINDS.includes(cinatra.kind)) {
    errors.push(`cinatra.kind must be one of ${VALID_KINDS.join(", ")} (got ${JSON.stringify(cinatra.kind)})`);
  }
  if (cinatra.apiVersion !== API_VERSION) {
    errors.push(`cinatra.apiVersion must be ${JSON.stringify(API_VERSION)} (got ${JSON.stringify(cinatra.apiVersion ?? null)})`);
  }
  const selfPkgName = typeof pkg.name === "string" ? pkg.name : null;
  if (cinatra.dependencies === null) {
    // explicit null is MALFORMED at install — "no dependencies" is spelled [].
    errors.push('cinatra.dependencies must be an array (declare "no dependencies" as []), not null');
  } else if (!Array.isArray(cinatra.dependencies)) {
    errors.push("cinatra.dependencies must be an array (use [] when none)");
  } else {
    const seenDeps = new Set();
    cinatra.dependencies.forEach((dep, i) => {
      if (!isValidDependencyEntry(dep, selfPkgName)) {
        errors.push(`cinatra.dependencies[${i}] is malformed: need {packageName (not self), edgeType∈{runtime,install-time,peer}, versionConstraint:{kind∈{semver-range,exact,git-ref},…}, requirement∈{required,optional}[, kind]} (got ${JSON.stringify(dep)})`);
        return;
      }
      if (seenDeps.has(dep.packageName)) {
        errors.push(`cinatra.dependencies has a duplicate entry for ${dep.packageName} (install rejects duplicate edges)`);
      }
      seenDeps.add(dep.packageName);
      if (dep.versionConstraint?.kind === "git-ref") {
        warnings.push(`cinatra.dependencies[${i}] on ${dep.packageName} uses a git-ref constraint — valid manifest shape, but a git-ref target is NOT installable from the v1 registry (the install planner refuses it); pin a published semver-range/exact version for a registry-installable package`);
      }
    });
  }

  // ---- retired migrations field ----
  if (cinatra.migrations !== undefined) {
    errors.push("cinatra.migrations (the retired JSON-DSL migration field) is rejected everywhere — use cinatra.migrationsDir with node-pg-migrate modules");
  }

  // ---- roles shape ----
  if (cinatra.roles !== undefined) {
    if (!Array.isArray(cinatra.roles) || !cinatra.roles.every((r) => nonEmptyStr(r))) {
      errors.push("cinatra.roles must be an array of non-empty strings when present");
    }
  }

  // ---- 2. port names ----
  if (cinatra.requestedHostPorts !== undefined) {
    if (!Array.isArray(cinatra.requestedHostPorts)) {
      errors.push("cinatra.requestedHostPorts must be an array when present");
    } else {
      for (const p of cinatra.requestedHostPorts) {
        if (!HOST_PORT_NAMES.has(p)) {
          errors.push(`cinatra.requestedHostPorts contains an unknown port ${JSON.stringify(p)} — valid ports: ${[...HOST_PORT_NAMES].join(", ")}`);
        }
      }
    }
  }

  // ---- 3. sdkAbiRange grammar ----
  if (cinatra.sdkAbiRange !== undefined) {
    if (typeof cinatra.sdkAbiRange !== "string") {
      errors.push("cinatra.sdkAbiRange must be a string when present");
    } else if (!isSupportedAbiRange(cinatra.sdkAbiRange)) {
      errors.push(`cinatra.sdkAbiRange ${JSON.stringify(cinatra.sdkAbiRange)} is not a supported range (use exact X.Y.Z, X / X.Y / X.x, ^X[.Y[.Z]], ~X[.Y[.Z]], or >=X[.Y[.Z]]; major must be ≥ 1; the host fails closed on anything else)`);
    } else if (!abiRangeSatisfiedByHost(cinatra.sdkAbiRange)) {
      warnings.push(`cinatra.sdkAbiRange ${JSON.stringify(cinatra.sdkAbiRange)} is not satisfied by the current host SDK ABI ${SDK_EXTENSIONS_ABI_VERSION} — the host would refuse to activate this build (verify against the host you target)`);
    }
  }

  // ---- schema-config (connector) ----
  if (cinatra.kind === "connector" && cinatra.uiSurface === "schema-config") {
    if (!isObj(cinatra.configSchema)) {
      errors.push('uiSurface:"schema-config" requires an object cinatra.configSchema');
    } else {
      for (const e of validateConfigSchema(cinatra.configSchema)) {
        errors.push(`cinatra.configSchema ${e}`);
      }
    }
  }

  // >>> ERT-MIRROR-ONLY-BEGIN: bundled-react hot-installability advisory (absent from the cinatra-cli canonical) >>>
  // ---- hot-installability advisory (connector): a bundled-react setup surface
  // is base-image-only, so the connector is NOT hot-installable (the host raises
  // ConnectorRequiresRebuildError). This is a WARNING, never an error — a
  // bundled-react connector stays a VALID extension during the cold→hot
  // transition; the warning surfaces the follow-up (convert to schema-config).
  if (cinatra.kind === "connector") {
    const uiSurface = classifyConnectorUiSurface(cinatra.kind, cinatra, readConnectorUiFlags(packageRoot));
    if (uiSurface === "bundled-react") {
      warnings.push(
        'bundled-legacy: not hot-installable — this connector ships a bundled-react setup ' +
          'surface (cinatra.uiSurface:"bundled-react" or a src/setup-page.tsx / src/settings-page.tsx ' +
          'page), which is base-image-only. Convert to cinatra.uiSurface:"schema-config" + a ' +
          'declarative cinatra.configSchema to make it hot-installable (see mcp-server-connector#4 ' +
          "exemplar). Bundled-react stays valid during the transition.",
      );
    }
  }

  // <<< ERT-MIRROR-ONLY-END: bundled-react hot-installability advisory <<<
  // ---- 4 + 5 + 6. @/ ban, SDK-only deps (source + manifest) ----
  const sourceFiles = walkSourceFiles(packageRoot);
  const selfName = typeof pkg.name === "string" ? pkg.name : null;
  const hostInternal = new Set();
  const sdkOnly = new Set();
  for (const f of sourceFiles) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const h of scanHostInternalImports(text)) hostInternal.add(h);
    for (const imp of parseModuleImports(text)) {
      const base = basePackageOf(imp.specifier);
      if (base && base !== selfName && isSdkOnlyViolation(base)) sdkOnly.add(base);
    }
  }
  const declaredDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  for (const key of Object.keys(declaredDeps)) {
    if (key === selfName) continue;
    if (isSdkOnlyViolation(key)) sdkOnly.add(key);
  }
  for (const h of [...hostInternal].sort()) {
    errors.push(`@/ host-internal import "${h}" — an extension reaches host capability ONLY through register(ctx) ports; remove the @/ import`);
  }
  for (const s of [...sdkOnly].sort()) {
    errors.push(`non-SDK first-party dependency "${s}" — the only permitted @cinatra-ai code deps are @cinatra-ai/sdk-extensions and @cinatra-ai/sdk-ui; route everything else through register(ctx) host ports`);
  }

  // ---- 7. host-peer value-import ban over the serverEntry graph ----
  const entry = resolveServerEntry(packageRoot, pkg);
  if (entry.kind === "resolved") {
    let peerHits;
    try {
      peerHits = scanHostPeerValueImports(packageRoot, pkg, entry.abs);
    } catch (err) {
      errors.push(`host-peer value-import scan failed: ${err instanceof Error ? err.message : String(err)}`);
      peerHits = [];
    }
    for (const hit of peerHits) {
      errors.push(`host-peer VALUE import reachable from serverEntry: ${hit} — keep host peers (@cinatra-ai/sdk-extensions, sdk-ui, mcp-client) type-only or take values via ctx (the prod file:// loader cannot resolve a bare host-peer specifier)`);
    }
  }

  // ---- 9. serverEntry preflight ----
  if (entry.kind === "invalid-exports-target") {
    errors.push(`cinatra.serverEntry "${entry.serverEntry}" is outside the supported resolver language — it must be a "./"-relative path, OR an exports-map key whose target is a "./"-relative string (one-level {import|default|require} conditionals allowed)`);
  } else if (entry.kind === "unsafe") {
    errors.push(`cinatra.serverEntry resolves to an unsafe path "${entry.rel}" (absolute or escapes the package with ..)`);
  } else if (entry.kind === "missing-file") {
    errors.push(`cinatra.serverEntry "${entry.serverEntry}" resolves to "${entry.rel}" but no such file exists in the package`);
  } else if (entry.kind === "resolved") {
    const cls = classifyServerEntryArtifact(entry.rel);
    if (cls === "unresolved") {
      errors.push(`cinatra.serverEntry resolves to "${entry.rel}" which is neither an importable artifact (.mjs/.cjs/.js) nor source (.ts/.tsx/.mts/.cts)`);
    } else if (cls === "source") {
      warnings.push(`cinatra.serverEntry resolves to SOURCE "${entry.rel}" — the runtime store accepts only BUILT artifacts (.mjs/.cjs/.js). The release build (build-server-entry) produces the built entry at pack time; this is expected in a source/dev repo.`);
    }
  }

  // ---- 8. README + license ----
  errors.push(...validateReadmePresence(packageRoot, cinatra.kind));
  errors.push(...validateLicensePresence(pkg, warnings));

  // ---- dead app-route guard (all kinds) ----
  errors.push(...validateNoDeadAppRoutes(packageRoot));

  return { errors, warnings };
}

// ===========================================================================
// README contract — ported VERBATIM (rules only) from
// scripts/audit/extension-readme-gate.mjs validateReadmeContent.
// ===========================================================================
export const ALLOWED_H2 = ["Works with", "Capabilities"];
export const REQUIRED_H2 = ["Capabilities"];
export const README_MIN_BYTES = 250;
export const README_MAX_BYTES = 2500;
export const WORKS_WITH_MIN_BULLETS = 1;
export const CAPABILITIES_MIN_BULLETS = 2;

export function stripCodeFences(text) {
  const lines = text.split("\n");
  const out = [];
  let fence = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence === null) {
      const mm = trimmed.match(/^(```+|~~~+)/);
      if (mm) {
        fence = mm[1][0].repeat(mm[1].length);
        continue;
      }
      out.push(line.replace(/`[^`\n]*`/g, ""));
    } else {
      const mm = trimmed.match(/^(```+|~~~+)\s*$/);
      if (mm && mm[1][0] === fence[0] && mm[1].length >= fence.length) fence = null;
    }
  }
  return out.join("\n");
}

export function hasFrontmatter(rawText) {
  return /^---\s*\r?\n/.test(rawText) || /^\+\+\+\s*\r?\n/.test(rawText);
}

export function findRawHtml(strippedText) {
  const re = /<[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>/g;
  const matches = [];
  let m;
  while ((m = re.exec(strippedText)) !== null) matches.push(m[0]);
  return matches;
}

export function parseBlocks(strippedText) {
  const lines = strippedText.split("\n");
  const blocks = [];
  let para = null;
  const flushPara = () => {
    if (para) {
      blocks.push({ type: "para", text: para.text.trim(), lineIndex: para.start });
      para = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      flushPara();
      blocks.push({ type: "blank", lineIndex: i });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushPara();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim(), lineIndex: i });
      continue;
    }
    const bullet = line.match(/^([-*+])\s+(.+)$/);
    if (bullet) {
      flushPara();
      blocks.push({ type: "bullet", text: bullet[2].trim(), lineIndex: i });
      continue;
    }
    if (para) para.text += " " + line;
    else para = { text: line, start: i };
  }
  flushPara();
  return blocks;
}

export function isEmphasisOnlyParagraph(text) {
  const t = text.trim();
  if (!t) return false;
  return /^\*[^*]+\*$/.test(t) || /^_[^_]+_$/.test(t);
}

export function validateReadmeContent({ kind, text, sizeBytes }) {
  const errors = [];
  if (!VALID_KINDS.includes(kind)) {
    errors.push(`unknown kind "${kind}" — expected one of ${VALID_KINDS.join(", ")}`);
    return errors;
  }
  if (sizeBytes < README_MIN_BYTES) errors.push(`README size ${sizeBytes}B is under minimum ${README_MIN_BYTES}B`);
  if (sizeBytes > README_MAX_BYTES) errors.push(`README size ${sizeBytes}B is over maximum ${README_MAX_BYTES}B`);
  if (hasFrontmatter(text)) errors.push("README must not have YAML/TOML frontmatter");

  const stripped = stripCodeFences(text);
  const html = findRawHtml(stripped);
  if (html.length) errors.push(`README has raw HTML outside code fences: ${html.slice(0, 3).join(", ")}`);

  const blocks = parseBlocks(stripped);
  const headings = blocks.filter((b) => b.type === "heading");
  const h1s = headings.filter((h) => h.level === 1);
  const h2s = headings.filter((h) => h.level === 2);
  const deepHeadings = headings.filter((h) => h.level >= 3);

  if (h1s.length !== 1) errors.push(`README H1 count is ${h1s.length} (expected exactly 1)`);
  if (deepHeadings.length) errors.push(`README H3+ headings are not allowed (e.g. "${deepHeadings[0].text}")`);

  const allowedH2Lower = new Set(ALLOWED_H2.map((h) => h.toLowerCase()));
  for (const h of h2s) {
    if (!allowedH2Lower.has(h.text.trim().toLowerCase())) {
      errors.push(`disallowed README H2 "## ${h.text}" — only ${ALLOWED_H2.map((x) => `"## ${x}"`).join(" and ")} are permitted`);
    }
  }
  const h2Lower = new Set(h2s.map((h) => h.text.trim().toLowerCase()));
  for (const req of REQUIRED_H2) {
    if (!h2Lower.has(req.toLowerCase())) errors.push(`README missing required section: "## ${req}"`);
  }
  const worksIdx = h2s.findIndex((h) => h.text.trim().toLowerCase() === "works with");
  const capsIdx = h2s.findIndex((h) => h.text.trim().toLowerCase() === "capabilities");
  if (worksIdx >= 0 && capsIdx >= 0 && worksIdx > capsIdx) errors.push('README "## Works with" must come BEFORE "## Capabilities"');

  if (h1s.length === 1) {
    const h1Block = h1s[0];
    const firstH2Block = h2s[0];
    const bodyStartIdx = blocks.indexOf(h1Block) + 1;
    const bodyEndIdx = firstH2Block ? blocks.indexOf(firstH2Block) : blocks.length;
    const between = blocks.slice(bodyStartIdx, bodyEndIdx);
    const paragraphs = between.filter((b) => b.type === "para");
    const bullets = between.filter((b) => b.type === "bullet");
    if (paragraphs.length === 0) errors.push("README missing description paragraph between H1 and first H2");
    if (bullets.length > 0) errors.push("README description area between H1 and first H2 must not contain bullets");
    if (paragraphs.length > 0 && isEmphasisOnlyParagraph(paragraphs[0].text)) {
      errors.push("README italic-only tagline under H1 is not allowed — the description paragraph IS the lede");
    }
  }
  for (let i = 0; i < h2s.length; i++) {
    const start = blocks.indexOf(h2s[i]);
    const end = i + 1 < h2s.length ? blocks.indexOf(h2s[i + 1]) : blocks.length;
    const section = blocks.slice(start + 1, end);
    const paragraphs = section.filter((b) => b.type === "para");
    const bullets = section.filter((b) => b.type === "bullet");
    if (paragraphs.length > 0) errors.push(`README section "## ${h2s[i].text}" must contain bullets only — found ${paragraphs.length} paragraph(s)`);
    const sectionName = h2s[i].text.trim().toLowerCase();
    if (sectionName === "capabilities" && bullets.length < CAPABILITIES_MIN_BULLETS) {
      errors.push(`README "## Capabilities" must have at least ${CAPABILITIES_MIN_BULLETS} bullets (found ${bullets.length})`);
    }
    if (sectionName === "works with" && bullets.length < WORKS_WITH_MIN_BULLETS) {
      errors.push(`README "## Works with" must have at least ${WORKS_WITH_MIN_BULLETS} bullet (found ${bullets.length})`);
    }
  }
  return errors;
}

function validateReadmePresence(packageRoot, kind) {
  const readmePath = join(packageRoot, "README.md");
  if (!existsSync(readmePath)) return ["missing required root README.md (marketplace-ready; see the README contract)"];
  let text;
  try {
    text = readFileSync(readmePath, "utf8");
  } catch (err) {
    return [`could not read README.md: ${err instanceof Error ? err.message : String(err)}`];
  }
  return validateReadmeContent({ kind, text, sizeBytes: Buffer.byteLength(text, "utf8") });
}

function validateLicensePresence(pkg, warnings) {
  const errors = [];
  const want = policyLicenseFor(pkg);
  const have = pkg?.license;
  if (want !== null) {
    if (have !== want) errors.push(`package.json license=${JSON.stringify(have ?? null)}, want "${want}" (@cinatra-ai extensions are Apache-2.0)`);
  } else if (!nonEmptyStr(have)) {
    errors.push("package.json must declare a non-empty `license` (SPDX identifier)");
  } else {
    warnings.push(`license "${have}" — the host applies its own license-field policy at publish; verify it matches the target host policy for your scope`);
  }
  return errors;
}

// ===========================================================================
// schema-config validator — kept in LOCK-STEP with the AUTHORITATIVE host gate
// scripts/extensions/generate-extension-manifest.mjs validateConfigSchema in the
// cinatra monorepo (the source-of-truth the install pipeline runs at publish).
//
// CANONICAL-OWNER NOTE: this validator's field-kind set + per-kind key
// allowlists mirror the LIVE host as of cinatra#658 (PR-4) — which ADDED the
// {select, record-list, banner, advisory} field kinds and the exact per-kind
// key allowlists on top of the original {text, secret, nango-connect,
// repeatable-list, status-probe, copyable-credential, named-action}. An older
// gate (e.g. the extension-release-tooling copy at the time of this sync) that
// knows only the original seven would WRONGLY REJECT a connector authored with
// the new DSL. The cinatra-cli copy is the CANONICAL author-facing gate; the
// `schema-config-parity` self-test (tests/) is the drift guard that fails if
// this set/key-rules diverge from the host fixtures.
//
// PURE-DATA INVARIANT: every kind has an EXACT key allowlist; an unknown key on
// a field is REJECTED here so a smuggled executable/HTML carrier key can never
// reach the manifest (mirrors the host fail-closed allowlist).
// ===========================================================================
const SCHEMA_CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SCHEMA_CONFIG_FIELD_KINDS = new Set([
  "text", "secret", "nango-connect", "repeatable-list", "status-probe",
  "copyable-credential", "named-action",
  // cinatra#658 (PR-4) extended vocabulary.
  "select", "record-list", "banner", "advisory",
  // cinatra#782 field-kind expansion: action-sourced select options, boolean
  // toggle, numeric input, free-form string list.
  "dynamic-select-options", "boolean", "number", "free-list",
]);
// Exact per-kind key allowlists — mirror src/lib/extension-schema-config.ts /
// generate-extension-manifest.mjs so a smuggled key is REJECTED at the gate too.
const SCHEMA_CONFIG_FIELD_KEYS = {
  text: new Set(["kind", "key", "label", "placeholder", "required", "description"]),
  secret: new Set(["kind", "key", "label", "required", "description"]),
  "nango-connect": new Set(["kind", "label", "providerConfigKey", "description"]),
  "repeatable-list": new Set(["kind", "key", "label", "itemLabel", "itemFields", "description"]),
  "status-probe": new Set(["kind", "label", "actionId", "description"]),
  "copyable-credential": new Set(["kind", "key", "label", "description"]),
  "named-action": new Set(["kind", "label", "actionId", "confirm", "role", "description"]),
  select: new Set(["kind", "key", "label", "options", "defaultValue", "description"]),
  "record-list": new Set([
    "kind", "label", "listActionId", "deleteActionId", "emptyState",
    "itemTitleKey", "itemSubtitleKey", "itemBadges", "description",
  ]),
  banner: new Set(["kind", "label", "variants"]),
  advisory: new Set(["kind", "label", "tone", "probeActionId", "whenReady", "whenNotReady", "description"]),
  // cinatra#782 field-kind expansion (action-sourced select / boolean / number / free-list).
  "dynamic-select-options": new Set([
    "kind", "key", "label", "optionsAction", "defaultValue", "placeholder", "description",
  ]),
  boolean: new Set(["kind", "key", "label", "defaultValue", "description"]),
  number: new Set([
    "kind", "key", "label", "min", "max", "step", "defaultValue", "placeholder", "required", "description",
  ]),
  "free-list": new Set(["kind", "key", "label", "itemLabel", "placeholder", "description"]),
};
const SCHEMA_CONFIG_ROOT_KEYS = new Set(["title", "description", "fields", "tabs", "hydrateAction"]);
const SCHEMA_CONFIG_BADGE_VARIANTS = new Set([
  "outline", "secondary", "destructive", "success", "warning", "info", "ghost", "muted",
]);
const SCHEMA_CONFIG_BANNER_TONES = new Set([
  "default", "destructive", "warning", "success", "info",
]);
// cinatra#1102 tab/section grouping: a tab carries ONLY {id,label,fields}.
const SCHEMA_CONFIG_TAB_KEYS = new Set(["id", "label", "fields"]);
/** A finite number (rejects NaN/±Infinity/non-number) — fail-closed, mirrors
 *  the host parser's finiteNum. */
function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function rejectUnknownConfigKeys(raw, allowed, at, errors) {
  let ok = true;
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      errors.push(`${at}: unexpected key ${JSON.stringify(k)}`);
      ok = false;
    }
  }
  return ok;
}

function validateConfigSchemaField(kind, raw, at, errors, seenKeys) {
  const allowed = SCHEMA_CONFIG_FIELD_KEYS[kind];
  if (allowed && !rejectUnknownConfigKeys(raw, allowed, at, errors)) {
    return;
  }
  if (!nonEmptyStr(raw.label)) {
    errors.push(`${at}: missing "label"`);
    return;
  }
  const needsKey =
    kind === "text" || kind === "secret" || kind === "copyable-credential" ||
    kind === "repeatable-list" || kind === "select" ||
    kind === "dynamic-select-options" || kind === "boolean" ||
    kind === "number" || kind === "free-list";
  if (needsKey) {
    if (!nonEmptyStr(raw.key) || !SCHEMA_CONFIG_KEY_RE.test(raw.key)) {
      errors.push(`${at}: invalid or missing "key"`);
      return;
    }
    if (seenKeys.has(raw.key)) {
      errors.push(`${at}: duplicate key "${raw.key}"`);
      return;
    }
    seenKeys.add(raw.key);
  }
  if (kind === "nango-connect" && !nonEmptyStr(raw.providerConfigKey)) {
    errors.push(`${at}: nango-connect requires "providerConfigKey"`);
  }
  if ((kind === "status-probe" || kind === "named-action") && (!nonEmptyStr(raw.actionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.actionId))) {
    errors.push(`${at}: ${kind} requires a valid "actionId"`);
  }
  // Optional canonical connection-action role — a CLOSED allowlist (mirrors the
  // host parser: role ∈ {connect, disconnect}). Absent → a plain named action.
  if (kind === "named-action" && raw.role !== undefined && raw.role !== "connect" && raw.role !== "disconnect") {
    errors.push(`${at}: named-action "role" must be "connect" or "disconnect" when present`);
  }
  if (kind === "repeatable-list") {
    const items = raw.itemFields;
    if (!Array.isArray(items) || items.length === 0) {
      errors.push(`${at}: repeatable-list requires a non-empty "itemFields"`);
      return;
    }
    const itemSeen = new Set();
    items.forEach((item, j) => {
      const itemAt = `${at}.itemFields[${j}]`;
      if (!isObj(item) || (item.kind !== "text" && item.kind !== "secret")) {
        errors.push(`${itemAt}: must be a flat text or secret field`);
        return;
      }
      validateConfigSchemaField(item.kind, item, itemAt, errors, itemSeen);
    });
  }
  if (kind === "select") {
    const options = raw.options;
    if (!Array.isArray(options) || options.length === 0) {
      errors.push(`${at}: select requires a non-empty "options"`);
      return;
    }
    const seenValues = new Set();
    options.forEach((opt, j) => {
      const optAt = `${at}.options[${j}]`;
      if (!isObj(opt) || !rejectUnknownConfigKeys(opt, new Set(["value", "label", "adminOnly"]), optAt, errors)) {
        if (isObj(opt)) return;
        errors.push(`${optAt}: must be an object`);
        return;
      }
      if (!nonEmptyStr(opt.value) || !nonEmptyStr(opt.label)) {
        errors.push(`${optAt}: requires string "value" and "label"`);
        return;
      }
      // Mirror the host RENDERER (parseSchemaConfig) which rejects a duplicate
      // option value — the install-generator gate alone does not, so without
      // this a connector would pass the gate but render `invalid-schema-config`.
      if (seenValues.has(opt.value)) {
        errors.push(`${optAt}: duplicate value ${JSON.stringify(opt.value)}`);
        return;
      }
      seenValues.add(opt.value);
    });
    if (nonEmptyStr(raw.defaultValue) && !seenValues.has(raw.defaultValue)) {
      errors.push(`${at}: defaultValue is not one of "options"`);
    }
  }
  if (kind === "record-list") {
    if (!nonEmptyStr(raw.listActionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.listActionId)) {
      errors.push(`${at}: record-list requires a valid "listActionId"`);
    }
    if (raw.deleteActionId !== undefined && (!nonEmptyStr(raw.deleteActionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.deleteActionId))) {
      errors.push(`${at}: record-list "deleteActionId" must be a valid action id`);
    }
    if (!nonEmptyStr(raw.emptyState)) errors.push(`${at}: record-list requires "emptyState"`);
    if (!nonEmptyStr(raw.itemTitleKey)) errors.push(`${at}: record-list requires "itemTitleKey"`);
    const badges = raw.itemBadges;
    if (!Array.isArray(badges)) {
      errors.push(`${at}: record-list requires an "itemBadges" array`);
    } else {
      badges.forEach((b, j) => {
        const bAt = `${at}.itemBadges[${j}]`;
        if (!isObj(b) || !rejectUnknownConfigKeys(b, new Set(["key", "label", "variant"]), bAt, errors)) {
          if (isObj(b)) return;
          errors.push(`${bAt}: must be an object`);
          return;
        }
        if (!nonEmptyStr(b.key) || !nonEmptyStr(b.label)) errors.push(`${bAt}: requires "key" and "label"`);
        if (!nonEmptyStr(b.variant) || !SCHEMA_CONFIG_BADGE_VARIANTS.has(b.variant)) {
          errors.push(`${bAt}: invalid badge variant ${JSON.stringify(b.variant)}`);
        }
      });
    }
  }
  if (kind === "banner") {
    const variants = raw.variants;
    if (!Array.isArray(variants) || variants.length === 0) {
      errors.push(`${at}: banner requires a non-empty "variants"`);
    } else {
      const seenNames = new Set();
      variants.forEach((v, j) => {
        const vAt = `${at}.variants[${j}]`;
        if (!isObj(v) || !rejectUnknownConfigKeys(v, new Set(["name", "tone", "message"]), vAt, errors)) {
          if (isObj(v)) return;
          errors.push(`${vAt}: must be an object`);
          return;
        }
        if (!nonEmptyStr(v.name) || !SCHEMA_CONFIG_KEY_RE.test(v.name)) {
          errors.push(`${vAt}: requires a valid "name"`);
        } else if (seenNames.has(v.name)) {
          // Mirror the host RENDERER (parseSchemaConfig) which rejects a
          // duplicate variant name — the install-generator gate alone does not.
          errors.push(`${vAt}: duplicate variant name ${JSON.stringify(v.name)}`);
        } else {
          seenNames.add(v.name);
        }
        if (!nonEmptyStr(v.tone) || !SCHEMA_CONFIG_BANNER_TONES.has(v.tone)) errors.push(`${vAt}: invalid tone`);
        if (!nonEmptyStr(v.message)) errors.push(`${vAt}: requires a "message"`);
      });
    }
  }
  if (kind === "advisory") {
    if (!nonEmptyStr(raw.probeActionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.probeActionId)) {
      errors.push(`${at}: advisory requires a valid "probeActionId"`);
    }
    if (!nonEmptyStr(raw.tone) || !SCHEMA_CONFIG_BANNER_TONES.has(raw.tone)) errors.push(`${at}: advisory requires a valid "tone"`);
    if (!nonEmptyStr(raw.whenReady) || !nonEmptyStr(raw.whenNotReady)) errors.push(`${at}: advisory requires "whenReady" and "whenNotReady"`);
  }
  // ---- dynamic-select-options: a select whose OPTIONS are action-sourced
  //      (cinatra#782) — the renderer fetches `optionsAction` at mount. Only
  //      the action id is declared here; membership of `defaultValue` in the
  //      fetched options can't be checked at this static-validation stage.
  if (kind === "dynamic-select-options") {
    if (!nonEmptyStr(raw.optionsAction) || !SCHEMA_CONFIG_KEY_RE.test(raw.optionsAction)) {
      errors.push(`${at}: dynamic-select-options requires a valid "optionsAction"`);
    }
    if (raw.defaultValue !== undefined && !nonEmptyStr(raw.defaultValue)) {
      errors.push(`${at}: dynamic-select-options "defaultValue" must be a non-empty string when present`);
    }
  }
  // ---- boolean: a Switch toggle (cinatra#782). `defaultValue` is a real
  //      boolean primitive, never a truthy stand-in.
  if (kind === "boolean" && raw.defaultValue !== undefined && typeof raw.defaultValue !== "boolean") {
    errors.push(`${at}: boolean "defaultValue" must be a boolean when present`);
  }
  // ---- number: a numeric input with optional min/max/step (cinatra#782).
  //      Every bound must be a finite number; step must be positive; min<=max;
  //      defaultValue (when present) must fall within [min, max].
  if (kind === "number") {
    for (const prop of ["min", "max", "step", "defaultValue"]) {
      if (raw[prop] !== undefined && !isFiniteNum(raw[prop])) {
        errors.push(`${at}: number "${prop}" must be a finite number when present`);
      }
    }
    const min = isFiniteNum(raw.min) ? raw.min : undefined;
    const max = isFiniteNum(raw.max) ? raw.max : undefined;
    const step = isFiniteNum(raw.step) ? raw.step : undefined;
    const defaultValue = isFiniteNum(raw.defaultValue) ? raw.defaultValue : undefined;
    if (step !== undefined && step <= 0) {
      errors.push(`${at}: number "step" must be greater than 0`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      errors.push(`${at}: number "min" must be <= "max"`);
    }
    if (
      defaultValue !== undefined &&
      ((min !== undefined && defaultValue < min) || (max !== undefined && defaultValue > max))
    ) {
      errors.push(`${at}: number "defaultValue" is outside [min, max]`);
    }
  }
  // ---- free-list: an add/remove editor for a free-form string[] (cinatra#782).
  //      No further shape beyond the allowlisted keys above.
}

/**
 * Validate the optional root `tabs` key (cinatra#1102 — the tab/section
 * grouping over the setup surface). Mirrors the host parser's `parseTabs`:
 * fail-closed on an unknown per-tab key, a missing/invalid/duplicate id, a
 * missing label, or an empty `fields`; field keys share the SAME `seenKeys`
 * set as the base fields (one flat submit namespace). Shape only — the host
 * render-time Help-tab-last reordering is not a validity rule.
 */
function validateConfigSchemaTabs(raw, errors, seenKeys) {
  if (!Array.isArray(raw)) {
    errors.push("configSchema.tabs must be an array");
    return;
  }
  const seenTabIds = new Set();
  raw.forEach((tab, i) => {
    const at = `tabs[${i}]`;
    if (!isObj(tab)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    rejectUnknownConfigKeys(tab, SCHEMA_CONFIG_TAB_KEYS, at, errors);
    if (!nonEmptyStr(tab.id) || !SCHEMA_CONFIG_KEY_RE.test(tab.id)) {
      errors.push(`${at}: invalid or missing "id"`);
      return;
    }
    if (seenTabIds.has(tab.id)) {
      errors.push(`${at}: duplicate tab id ${JSON.stringify(tab.id)}`);
      return;
    }
    seenTabIds.add(tab.id);
    if (!nonEmptyStr(tab.label)) {
      errors.push(`${at}: missing "label"`);
      return;
    }
    if (!Array.isArray(tab.fields) || tab.fields.length === 0) {
      errors.push(`${at}: tab requires a non-empty "fields" array`);
      return;
    }
    tab.fields.forEach((field, j) => {
      const fieldAt = `${at}.fields[${j}]`;
      if (!isObj(field)) {
        errors.push(`${fieldAt}: must be an object`);
        return;
      }
      if (typeof field.kind !== "string" || !SCHEMA_CONFIG_FIELD_KINDS.has(field.kind)) {
        errors.push(`${fieldAt}: unknown field kind ${JSON.stringify(field.kind)}`);
        return;
      }
      validateConfigSchemaField(field.kind, field, fieldAt, errors, seenKeys);
    });
  });
}

export function validateConfigSchema(raw) {
  if (!isObj(raw)) return ["must be an object"];
  const errors = [];
  rejectUnknownConfigKeys(raw, SCHEMA_CONFIG_ROOT_KEYS, "configSchema", errors);
  // Fail-closed like the host parser: a present-but-malformed hydrateAction is a
  // validation error (same actionId grammar, identical error string).
  if (
    raw.hydrateAction !== undefined &&
    (!nonEmptyStr(raw.hydrateAction) || !SCHEMA_CONFIG_KEY_RE.test(raw.hydrateAction))
  ) {
    errors.push(`configSchema: "hydrateAction" must be a valid actionId string`);
  }
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    errors.push("fields must be a non-empty array");
    return errors;
  }
  const seenKeys = new Set();
  raw.fields.forEach((field, i) => {
    const at = `fields[${i}]`;
    if (!isObj(field)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (typeof field.kind !== "string" || !SCHEMA_CONFIG_FIELD_KINDS.has(field.kind)) {
      errors.push(`${at}: unknown field kind ${JSON.stringify(field.kind)}`);
      return;
    }
    validateConfigSchemaField(field.kind, field, at, errors, seenKeys);
  });
  // Optional tab groups (cinatra#1102). Parsed with the SAME seenKeys set so a
  // field key is unique across the base fields AND every tab.
  if (raw.tabs !== undefined) {
    validateConfigSchemaTabs(raw.tabs, errors, seenKeys);
  }
  return errors;
}

// ===========================================================================
// agent gate — retired-CRM-primitive scan over LLM-visible OAS prompt strings.
// Ported verbatim (rules only) from scripts/audit/oas-banned-primitives-gate.mjs.
// ===========================================================================
const LLM_VISIBLE_FIELDS = new Set(["system", "user", "description"]);

const BANNED_PRIMITIVES = [
  "lists_list", "lists_get", "lists_create", "lists_update", "lists_delete",
  "lists_members_add", "lists_members_remove", "lists_members_count",
  "accounts_list", "accounts_get", "accounts_create", "accounts_update", "accounts_delete",
  "contacts_list", "contacts_get", "contacts_create", "contacts_update", "contacts_delete",
  "contacts_sources_list",
];

const BANNED_TYPEHINTS = [
  "@cinatra-ai/entity-accounts:account",
  "@cinatra-ai/entity-contacts:contact",
];

function wordBoundary(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
}

const PRIMITIVE_PATTERNS = BANNED_PRIMITIVES.map((token) => ({
  token,
  re: wordBoundary(token),
  reason: `${token} is retired — route through the crm_* facade`,
}));

const OBJECTS_LIST_CRM_RE =
  /objects_list[\s\S]{0,120}@cinatra-ai\/entity-(accounts:account|contacts:contact)/;

function walkLlmStrings(node, onString) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkLlmStrings(item, onString);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && LLM_VISIBLE_FIELDS.has(key)) onString(key, value);
    else if (value && typeof value === "object") walkLlmStrings(value, onString);
  }
}

function scanOasString(field, text, findings) {
  for (const { token, re, reason } of PRIMITIVE_PATTERNS) {
    if (re.test(text)) findings.push({ field, token, reason });
  }
  for (const hint of BANNED_TYPEHINTS) {
    if (text.includes(hint)) {
      findings.push({ field, token: hint, reason: `legacy entity typeHint ${hint} — CRM entities live in Twenty; use the crm_* facade` });
    }
  }
  if (OBJECTS_LIST_CRM_RE.test(text)) {
    findings.push({
      field,
      token: "objects_list(<crm-entity-type>)",
      reason: "objects_list over a CRM entity type is the retired heavy-field read path — use crm_account_search / crm_contact_search",
    });
  }
}

// ===========================================================================
// Layer-1 artifact-parity — the earliest, zero-dep static screen for the
// declarative artifact-materialization contract (a companion to the host-side
// compile/publish-time parity gates). An agent that DECLARES `cinatra.produces`
// must ship a runnable materialization for it: either a declarative EndNode
// output binding (`outputs[].cinatra.artifact`) or a deterministic
// `artifact_materialize` passthrough node. This mirrors a STATIC SUBSET of the
// host binding grammar (the host module is the authoritative validator and
// re-checks at compile/run time); it is dependency-free so it runs in every
// extension repo's standalone CI before the registry is reachable.
//
// ROLLOUT (ratchet): every finding here is ADVISORY (a warning) by default, so
// the un-migrated fleet never reddens. The release/republish path opts into
// enforcement — `--enforce-artifact-parity` or env CINATRA_ARTIFACT_PARITY=block
// — which promotes the SAME findings to hard errors. runGate does the routing.
// ===========================================================================

/** Text-authorable MIME universe for declarative bindings (v1). Byte-mirror of
 * the host ARTIFACT_BINDING_AUTHORABLE_MIMES; binary artifacts stay on the
 * upload/template paths. */
export const ARTIFACT_AUTHORABLE_MIMES = new Set([
  "text/markdown", "text/plain", "text/html", "application/json", "application/xml",
]);
/** The deterministic passthrough tool that materializes an artifact mid-flow. */
export const ARTIFACT_MATERIALIZE_TOOL = "artifact_materialize";
/** URL marker identifying the deterministic passthrough route. */
export const AGENTS_PASSTHROUGH_URL_MARKER = "/api/agents/passthrough";
/** Passthrough tools that WRITE (persist) — a node invoking one must NOT be
 * stamped riskClass:"read_only". Keyed on the invoked tool, never the node name
 * (a node literally named "write" that only calls the LLM bridge is read_only). */
export const ARTIFACT_WRITE_SEAM_TOOLS = new Set([
  "artifact_materialize", "artifact_authoring_emit", "objects_save",
]);
const ARTIFACT_BINDING_KEYS = new Set(["extension", "contentFrom", "titleFrom", "declaredMime", "mimeFrom"]);

function isPlainObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyStr(v) {
  return typeof v === "string" && v.length > 0;
}
/** A `{{ ... }}` placeholder makes a value runtime-templated — not a literal. */
function isTemplated(v) {
  return typeof v === "string" && v.includes("{{");
}

/** Normalize package.json `cinatra.produces` to a Set of extension names, or
 * `null` when the field is ABSENT (nothing declared ⇒ no parity obligation).
 * Accepts the on-disk `[{extension}]` object form and, defensively, bare
 * strings. A present-but-malformed value normalizes to an EMPTY set (fail-closed
 * membership: any binding then disagrees with declared production). */
export function normalizeProduces(cinatra) {
  const raw = cinatra?.produces;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set();
  for (const entry of raw) {
    if (typeof entry === "string") out.add(entry);
    else if (isPlainObj(entry) && typeof entry.extension === "string") out.add(entry.extension);
  }
  return out;
}

/** Validate the SHAPE of one `cinatra.artifact` binding — static mirror of the
 * host `artifactOutputBindingSchema` (strict keys; declaredMime XOR mimeFrom;
 * authorable MIME). Returns human-readable issue phrases (empty ⇒ valid shape). */
export function validateArtifactBindingShape(obj) {
  const issues = [];
  if (!isPlainObj(obj)) return ["binding must be an object"];
  for (const k of Object.keys(obj)) {
    if (!ARTIFACT_BINDING_KEYS.has(k)) issues.push(`unknown field "${k}" (strict — a typo never silently no-ops)`);
  }
  if (!isNonEmptyStr(obj.extension)) issues.push("extension must be a non-empty string");
  if (!isNonEmptyStr(obj.contentFrom)) issues.push("contentFrom must be a non-empty string");
  if (!isNonEmptyStr(obj.titleFrom)) issues.push("titleFrom must be a non-empty string");
  const hasDeclared = obj.declaredMime !== undefined;
  const hasFrom = obj.mimeFrom !== undefined;
  if (hasDeclared === hasFrom) issues.push("exactly one of declaredMime / mimeFrom is required");
  if (hasDeclared) {
    if (!isNonEmptyStr(obj.declaredMime)) issues.push("declaredMime must be a non-empty string");
    else if (!ARTIFACT_AUTHORABLE_MIMES.has(obj.declaredMime)) {
      issues.push(`declaredMime "${obj.declaredMime}" is not text-authorable (allowed: ${[...ARTIFACT_AUTHORABLE_MIMES].join(", ")})`);
    }
  }
  if (hasFrom && !isNonEmptyStr(obj.mimeFrom)) issues.push("mimeFrom must be a non-empty string");
  return issues;
}

/** Collect + validate `outputs[].cinatra.artifact` bindings on the TOP-LEVEL
 * EndNode components (subflow EndNodes do not surface run-completion outputs, so
 * they cannot bind — matches the host scope). Returns `{ attempted, errors }`;
 * `attempted` counts EVERY annotation (valid or not) so the presence check can
 * distinguish "tried but broke" from "absent". `producesSet`: Set of declared
 * extensions, or null to SKIP the membership check. */
export function collectArtifactBindings(oasDoc, producesSet) {
  const errors = [];
  let attempted = 0;
  const refs = isPlainObj(oasDoc?.$referenced_components) ? oasDoc.$referenced_components : {};
  for (const [nodeId, comp] of Object.entries(refs)) {
    if (!isPlainObj(comp) || comp.component_type !== "EndNode") continue;
    const outputs = Array.isArray(comp.outputs) ? comp.outputs : [];
    const outputTitles = new Set(
      outputs.filter(isPlainObj).map((o) => o.title).filter((t) => typeof t === "string"),
    );
    for (const out of outputs) {
      if (!isPlainObj(out)) continue;
      const ann = isPlainObj(out.cinatra) ? out.cinatra : null;
      const artifact = ann?.artifact;
      if (artifact === undefined || artifact === null) continue;
      attempted++;
      const title = typeof out.title === "string" ? out.title : "<untitled>";
      const where = `cinatra/oas.json EndNode "${nodeId}" output "${title}" cinatra.artifact`;
      const shape = validateArtifactBindingShape(artifact);
      if (shape.length) {
        for (const s of shape) errors.push(`${where}: ${s}`);
        continue;
      }
      let refBad = false;
      const refFields = ["contentFrom", "titleFrom"];
      if (artifact.mimeFrom !== undefined) refFields.push("mimeFrom");
      for (const field of refFields) {
        if (!outputTitles.has(artifact[field])) {
          errors.push(`${where}.${field}: "${artifact[field]}" does not name an output of EndNode "${nodeId}" (outputs: [${[...outputTitles].join(", ")}])`);
          refBad = true;
        }
      }
      if (refBad) continue;
      if (producesSet && !producesSet.has(artifact.extension)) {
        errors.push(`${where}.extension: "${artifact.extension}" is not declared in package.json cinatra.produces — declared production and bindings must agree`);
      }
    }
  }
  return { attempted, errors };
}

/** Walk every passthrough-route ApiNode (`url` carries the passthrough marker),
 * top-level AND inside nested Flows / FlowNode subflows (the tool fires
 * mid-flow, so unlike EndNode bindings there is no top-level-only scoping). */
function walkPassthroughApiNodes(oasDoc, visit) {
  function go(value, refKey) {
    if (!isPlainObj(value)) return;
    if (
      value.component_type === "ApiNode" &&
      typeof value.url === "string" &&
      value.url.includes(AGENTS_PASSTHROUGH_URL_MARKER)
    ) {
      visit(value, refKey);
    }
    const refs = value.$referenced_components;
    if (isPlainObj(refs)) for (const [k, v] of Object.entries(refs)) go(v, k);
    if (isPlainObj(value.subflow)) go(value.subflow, refKey);
  }
  go(oasDoc, "$");
}

/** Read a passthrough ApiNode's `data` block, accepting the object form or a
 * JSON string that parses to an object (the fleet authors object-shaped blocks). */
function readPassthroughData(node) {
  let data = node.data;
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (isPlainObj(parsed)) data = parsed;
    } catch {
      /* leave as string — not an object-shaped block */
    }
  }
  return isPlainObj(data) ? data : null;
}

/** Collect + validate `artifact_materialize` passthrough nodes — static mirror
 * of the host `collectArtifactMaterializeNodesFromOasDocument` subset: literal
 * extension (∈ produces), literal authorable declaredMime, literal node_id equal
 * to the ApiNode's id, present content + title. Returns `{ attempted, errors }`. */
export function collectArtifactMaterializeNodes(oasDoc, producesSet) {
  const errors = [];
  let attempted = 0;
  walkPassthroughApiNodes(oasDoc, (node, refKey) => {
    const data = readPassthroughData(node);
    if (!data || data.tool !== ARTIFACT_MATERIALIZE_TOOL) return;
    attempted++;
    const nodeId = isNonEmptyStr(node.id) ? node.id : refKey;
    const where = `cinatra/oas.json ApiNode "${nodeId}" artifact_materialize`;
    const input = data.input;
    if (!isPlainObj(input)) {
      errors.push(`${where}.input: required object {extension, content, title, declaredMime, node_id}`);
      return;
    }
    if (!isNonEmptyStr(input.extension) || isTemplated(input.extension)) {
      errors.push(`${where}.input.extension: must be a literal artifact-extension package name (got ${JSON.stringify(input.extension)})`);
    } else if (producesSet && !producesSet.has(input.extension)) {
      errors.push(`${where}.input.extension: "${input.extension}" is not declared in package.json cinatra.produces — declared production and materialization must agree`);
    }
    if (!isNonEmptyStr(input.declaredMime) || isTemplated(input.declaredMime)) {
      errors.push(`${where}.input.declaredMime: must be a literal MIME type (got ${JSON.stringify(input.declaredMime)})`);
    } else if (!ARTIFACT_AUTHORABLE_MIMES.has(input.declaredMime)) {
      errors.push(`${where}.input.declaredMime: "${input.declaredMime}" is not text-authorable (allowed: ${[...ARTIFACT_AUTHORABLE_MIMES].join(", ")})`);
    }
    if (!isNonEmptyStr(input.node_id) || isTemplated(input.node_id)) {
      errors.push(`${where}.input.node_id: must be a literal equal to this ApiNode's id`);
    } else if (input.node_id !== nodeId) {
      errors.push(`${where}.input.node_id: "${input.node_id}" must equal this ApiNode's id ("${nodeId}") — it is the idempotency-ledger identity`);
    }
    if (!isNonEmptyStr(input.content)) errors.push(`${where}.input.content: required non-empty string`);
    if (!isNonEmptyStr(input.title)) errors.push(`${where}.input.title: required non-empty string`);
  });
  return { attempted, errors };
}

/** A node stamped riskClass:"read_only" that invokes a WRITE-seam passthrough
 * tool is mislabelled — the run persists, so it is not read-only. Keyed on the
 * invoked `data.tool`, never the node name. Returns string[] errors. */
export function findReadonlyWriteToolMislabels(oasDoc) {
  const errors = [];
  walkPassthroughApiNodes(oasDoc, (node, refKey) => {
    const data = readPassthroughData(node);
    const tool = data?.tool;
    if (typeof tool !== "string" || !ARTIFACT_WRITE_SEAM_TOOLS.has(tool)) return;
    const riskClass = node?.metadata?.cinatra?.riskClass;
    if (riskClass === "read_only") {
      const nodeId = isNonEmptyStr(node.id) ? node.id : refKey;
      errors.push(`cinatra/oas.json ApiNode "${nodeId}": riskClass "read_only" on a node invoking the write tool "${tool}" — a persisting node must not be labelled read_only`);
    }
  });
  return errors;
}

/** Layer-1 artifact-parity findings (mode-independent string[]). Fires only for
 * AGENTS: an agent that declares `cinatra.produces` must ship a runnable
 * materialization; bindings / materialize nodes must be well-formed and agree
 * with `produces`; a write-seam node must not be labelled read_only. runGate
 * routes these to warnings (default) or errors (enforce). */
export function collectArtifactParityFindings(packageRoot, pkg) {
  const cinatra = pkg?.cinatra;
  if (cinatra?.kind !== "agent") return [];
  const producesSet = normalizeProduces(cinatra);
  const declaresProduces = producesSet !== null && producesSet.size > 0;
  const declared = declaresProduces ? [...producesSet].join(", ") : "";

  const oasPath = join(packageRoot, "cinatra", "oas.json");
  if (!existsSync(oasPath)) {
    if (declaresProduces) {
      return [`package.json cinatra.produces declares [${declared}] but the agent ships no cinatra/oas.json — no runnable materialization (a declarative EndNode binding or an artifact_materialize node) exists for the declared production`];
    }
    return [];
  }
  let oasDoc;
  try {
    oasDoc = JSON.parse(readFileSync(oasPath, "utf8"));
  } catch {
    return []; // validateAgent already reports the parse error
  }

  const bindings = collectArtifactBindings(oasDoc, producesSet);
  const nodes = collectArtifactMaterializeNodes(oasDoc, producesSet);
  const findings = [...bindings.errors, ...nodes.errors, ...findReadonlyWriteToolMislabels(oasDoc)];
  if (declaresProduces && bindings.attempted === 0 && nodes.attempted === 0) {
    findings.push(`package.json cinatra.produces declares [${declared}] but cinatra/oas.json has no runnable materialization (no outputs[].cinatra.artifact binding and no artifact_materialize node) for the declared production`);
  }
  return findings;
}

/** Validate an agent extension at packageRoot. Pure: returns string[] errors. */
export function validateAgent(packageRoot) {
  const errors = [];
  // Typed project-template sidecar (optional; validated hard when present —
  // the install pipeline REFUSES a violating package, so the local gate must
  // catch it pre-publish).
  errors.push(...validateProjectTemplateSidecar(packageRoot));
  const oasPath = join(packageRoot, "cinatra", "oas.json");
  // OAS optional at this gate: an agent without a generated OAS has no
  // LLM-visible prompt strings to scan. Marketplace-side owns "agent MUST ship OAS".
  if (!existsSync(oasPath)) return errors;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(oasPath, "utf8"));
  } catch (err) {
    errors.push(`cinatra/oas.json failed to parse: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
  const findings = [];
  walkLlmStrings(parsed, (field, text) => scanOasString(field, text, findings));
  for (const f of findings) errors.push(`cinatra/oas.json [${f.field}] ${f.token}: ${f.reason}`);
  return errors;
}

// ===========================================================================
// agent gate — typed PROJECT-TEMPLATE sidecar (cinatra/project-template.json).
// Mirror of the AUTHORITATIVE host enforcers in the cinatra monorepo:
// packages/sdk-extensions/src/project-template-contract.ts
// (validateProjectTemplate — collect-ALL structural violations — plus the
// exact-match "one truth source" worker-ref rule
// checkTemplateWorkerRefsAgainstDependencies), wired into the install
// pipeline by packages/agents/src/install-from-package.ts. An agent package
// that ships a template the host would refuse must fail HERE, pre-publish.
// The bracketed [code] tokens mirror the host violation codes one-to-one so
// the parity fixtures can pin both sides.
// ===========================================================================
export const PROJECT_TEMPLATE_FORMAT_VERSION = "cinatra.ai/project-template@1";
const PROJECT_TEMPLATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidTemplateStableId(v) {
  return typeof v === "string" && PROJECT_TEMPLATE_ID_RE.test(v);
}

function isValidTemplateVersionConstraint(v) {
  if (!isObj(v)) return false;
  if (v.kind === "semver-range") return typeof v.range === "string";
  if (v.kind === "exact") return typeof v.version === "string";
  if (v.kind === "git-ref") return typeof v.ref === "string";
  return false;
}

function templateVersionConstraintsEqual(a, b) {
  if (!isObj(a) || !isObj(b) || a.kind !== b.kind) return false;
  if (a.kind === "semver-range") return a.range === b.range;
  if (a.kind === "exact") return a.version === b.version;
  if (a.kind === "git-ref") return a.ref === b.ref;
  return false;
}

/** DFS cycle detection over well-formed dependsOn edges (mirrors the host's
 * findDependencyCycle: only follows edges to known ids, never self). */
function findTemplateDependencyCycle(tasks, knownIds) {
  const edges = new Map();
  for (const t of tasks) {
    if (!isObj(t) || typeof t.id !== "string") continue;
    const deps = Array.isArray(t.dependsOn)
      ? t.dependsOn.filter((d) => typeof d === "string" && knownIds.has(d) && d !== t.id)
      : [];
    edges.set(t.id, deps);
  }
  const color = new Map(); // 0 white, 1 gray, 2 black
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (c === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of edges.keys()) {
    if ((color.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Structural template validation — mirror of the host validateProjectTemplate
 * (collect-ALL, deterministic order). Pure: returns string[] errors. */
export function validateProjectTemplateObject(input) {
  const errors = [];
  const push = (code, path, message) => errors.push(`[${code}] ${path || "(root)"}: ${message}`);
  if (!isObj(input)) {
    push("not_object", "", "template must be an object");
    return errors;
  }
  if (input.formatVersion !== PROJECT_TEMPLATE_FORMAT_VERSION) {
    push("bad_format_version", "formatVersion", `formatVersion must be "${PROJECT_TEMPLATE_FORMAT_VERSION}"`);
  }
  if (!isValidTemplateStableId(input.id)) push("bad_template_id", "id", "id must be a stable token");
  if (typeof input.name !== "string" || input.name.trim() === "") {
    push("bad_template_name", "name", "name must be a non-empty string");
  }
  if (!isObj(input.anchor) || !isValidTemplateStableId(input.anchor.id)) {
    push("bad_anchor", "anchor.id", "anchor.id must be a stable token");
  }
  const tasks = input.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    push("no_tasks", "tasks", "tasks must be a non-empty array");
    return errors;
  }
  const taskIds = new Set();
  const roleToBinding = new Map();
  tasks.forEach((task, i) => {
    if (!isObj(task)) {
      push("bad_task", `tasks[${i}]`, "task must be an object");
      return;
    }
    if (!isValidTemplateStableId(task.id)) {
      push("bad_task_id", `tasks[${i}].id`, "task id must be a stable token (no path separator)");
    } else if (taskIds.has(task.id)) {
      push("duplicate_task_id", `tasks[${i}].id`, `duplicate task id "${task.id}"`);
    } else {
      taskIds.add(task.id);
    }
    if (typeof task.title !== "string" || task.title.trim() === "") {
      push("bad_task_title", `tasks[${i}].title`, "task title must be a non-empty string");
    }
  });
  tasks.forEach((task, i) => {
    if (!isObj(task)) return;
    const at = `tasks[${i}]`;
    if (task.dependsOn !== undefined) {
      if (!Array.isArray(task.dependsOn)) {
        push("bad_depends_on", `${at}.dependsOn`, "dependsOn must be an array of task ids");
      } else {
        const seen = new Set();
        task.dependsOn.forEach((dep, j) => {
          if (typeof dep !== "string" || !taskIds.has(dep)) {
            push("unknown_dependency", `${at}.dependsOn[${j}]`, `dependsOn "${String(dep)}" is not a task id`);
          } else if (dep === task.id) {
            push("self_dependency", `${at}.dependsOn[${j}]`, "a task cannot depend on itself");
          } else if (seen.has(dep)) {
            push("duplicate_dependency", `${at}.dependsOn[${j}]`, `duplicate dependency "${dep}"`);
          } else {
            seen.add(dep);
          }
        });
      }
    }
    if (task.schedule !== undefined && task.schedule !== null) {
      if (!isObj(task.schedule)) {
        push("bad_schedule", `${at}.schedule`, "schedule must be an object");
      } else {
        const s = task.schedule.startOffsetDays;
        const d = task.schedule.dueOffsetDays;
        if (s !== undefined && s !== null && !Number.isInteger(s)) {
          push("bad_offset", `${at}.schedule.startOffsetDays`, "startOffsetDays must be an integer");
        }
        if (d !== undefined && d !== null && !Number.isInteger(d)) {
          push("bad_offset", `${at}.schedule.dueOffsetDays`, "dueOffsetDays must be an integer");
        }
        if (
          typeof s === "number" && Number.isFinite(s) &&
          typeof d === "number" && Number.isFinite(d) &&
          d < s
        ) {
          push("due_before_start", `${at}.schedule.dueOffsetDays`, "dueOffsetDays must be >= startOffsetDays");
        }
      }
    }
    if (task.worker !== undefined && task.worker !== null) {
      const w = task.worker;
      const wAt = `${at}.worker`;
      const roleOk = isObj(w) && isValidTemplateStableId(w.role);
      if (!roleOk) push("bad_worker_role", `${wAt}.role`, "worker.role must be a stable token");
      if (!isObj(w) || typeof w.packageName !== "string" || w.packageName.trim() === "") {
        push("bad_worker_package", `${wAt}.packageName`, "worker.packageName must be a non-empty string");
      }
      if (!isObj(w) || !isValidTemplateVersionConstraint(w.versionConstraint)) {
        push("bad_worker_version", `${wAt}.versionConstraint`, "worker.versionConstraint is malformed");
      }
      if (roleOk && typeof w.packageName === "string" && isValidTemplateVersionConstraint(w.versionConstraint)) {
        const prev = roleToBinding.get(w.role);
        if (!prev) {
          roleToBinding.set(w.role, { packageName: w.packageName, versionConstraint: w.versionConstraint });
        } else if (
          prev.packageName !== w.packageName ||
          !templateVersionConstraintsEqual(prev.versionConstraint, w.versionConstraint)
        ) {
          push("inconsistent_worker_role", `${wAt}.role`, `role "${w.role}" is bound to more than one package/version`);
        }
      }
    }
    if (task.approval !== undefined && task.approval !== null) {
      if (!isObj(task.approval) || !isValidTemplateStableId(task.approval.id)) {
        push("bad_approval", `${at}.approval.id`, "approval.id must be a stable token");
      }
    }
    if (task.acceptance !== undefined) {
      if (!Array.isArray(task.acceptance)) {
        push("bad_acceptance", `${at}.acceptance`, "acceptance must be an array");
      } else {
        const seen = new Set();
        task.acceptance.forEach((c, j) => {
          const cAt = `${at}.acceptance[${j}]`;
          if (!isObj(c) || !isValidTemplateStableId(c.id)) {
            push("bad_acceptance_id", `${cAt}.id`, "acceptance.id must be a stable token");
          } else if (seen.has(c.id)) {
            push("duplicate_acceptance_id", `${cAt}.id`, `duplicate acceptance id "${c.id}"`);
          } else {
            seen.add(c.id);
          }
          if (isObj(c) && (typeof c.description !== "string" || c.description.trim() === "")) {
            push("bad_acceptance_desc", `${cAt}.description`, "acceptance.description must be non-empty");
          }
        });
      }
    }
  });
  const cycle = findTemplateDependencyCycle(tasks, taskIds);
  if (cycle) push("cyclic_dependencies", "tasks", `dependency cycle: ${cycle.join(" -> ")}`);
  return errors;
}

/** The exact-match "one truth source" worker-ref rule — mirror of the host
 * checkTemplateWorkerRefsAgainstDependencies: every template worker ref MUST
 * exact-match a manifest cinatra.dependencies edge by BOTH packageName AND
 * versionConstraint. Pure: returns string[] errors. */
export function checkTemplateWorkerRefsAgainstManifest(template, dependencies) {
  const errors = [];
  const byPackage = new Map();
  for (const dep of Array.isArray(dependencies) ? dependencies : []) {
    if (isObj(dep) && typeof dep.packageName === "string") byPackage.set(dep.packageName, dep);
  }
  const tasks = Array.isArray(template?.tasks) ? template.tasks : [];
  tasks.forEach((task, i) => {
    const w = isObj(task) ? task.worker : null;
    if (!w || !isObj(w)) return;
    const at = `tasks[${i}].worker`;
    const edge = byPackage.get(w.packageName);
    if (!edge) {
      errors.push(`[worker_not_in_dependencies] ${at}.packageName: worker "${w.packageName}" is not declared in cinatra.dependencies`);
      return;
    }
    if (!templateVersionConstraintsEqual(w.versionConstraint, edge.versionConstraint)) {
      errors.push(`[worker_version_mismatch] ${at}.versionConstraint: worker "${w.packageName}" version does not exact-match its cinatra.dependencies edge`);
    }
  });
  return errors;
}

/** Validate the optional cinatra/project-template.json sidecar of an agent
 * package. Absent file → no errors (not a project-template package). Present →
 * structural validation + the exact-match worker-ref rule against the
 * manifest's cinatra.dependencies. Returns string[] errors, each prefixed with
 * the sidecar path. */
export function validateProjectTemplateSidecar(packageRoot) {
  const templatePath = join(packageRoot, "cinatra", "project-template.json");
  if (!existsSync(templatePath)) return [];
  const prefix = "cinatra/project-template.json";
  let raw;
  try {
    raw = readFileSync(templatePath, "utf8");
  } catch (err) {
    return [`${prefix} [template_unreadable]: ${err instanceof Error ? err.message : String(err)}`];
  }
  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    return [`${prefix} [template_unparsable]: not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
  }
  const errors = validateProjectTemplateObject(candidate).map((e) => `${prefix} ${e}`);
  if (errors.length > 0) return errors;
  let pkg;
  try {
    pkg = readPackageJson(packageRoot);
  } catch {
    // The common gate already reports an unreadable package.json; the
    // worker-ref rule simply cannot run without it.
    return errors;
  }
  const deps = Array.isArray(pkg?.cinatra?.dependencies) ? pkg.cinatra.dependencies : [];
  errors.push(...checkTemplateWorkerRefsAgainstManifest(candidate, deps).map((e) => `${prefix} ${e}`));
  return errors;
}

// ===========================================================================
// connector gate — mirror of packages/extensions/src/connector-handler.validate.
// ===========================================================================
export const GENERIC_VENDOR_CONNECTOR_NAME_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-connector$/;

export function validateConnectorPackageShape(pkg) {
  const errors = [];
  const cinatra = (pkg && pkg.cinatra) || {};
  if (typeof pkg?.name !== "string") {
    errors.push("package.json is missing `name`");
  } else if (!GENERIC_VENDOR_CONNECTOR_NAME_RE.test(pkg.name)) {
    errors.push(`package name "${pkg.name}" does not match the kind-at-end convention @<vendor>/<slug>-connector`);
  }
  if (cinatra.kind !== "connector") {
    errors.push(`package.json must declare cinatra.kind: "connector" (got ${JSON.stringify(cinatra.kind)})`);
  }
  const visibility = cinatra.visibility;
  if (visibility !== undefined && visibility !== "admin" && visibility !== "workspace") {
    errors.push(`cinatra.visibility (when set) must be "admin" or "workspace" (got ${JSON.stringify(visibility)})`);
  }
  return errors;
}

export function validateConnector(packageRoot) {
  let pkg;
  try {
    pkg = readPackageJson(packageRoot);
  } catch (err) {
    return [`could not read package.json: ${err instanceof Error ? err.message : String(err)}`];
  }
  return validateConnectorPackageShape(pkg);
}

// ===========================================================================
// artifact gate — mirror of packages/extensions/src/artifact-handler.validate.
// ===========================================================================
export const ARTIFACT_NAME_RE = /^@cinatra-ai\/[a-z0-9][a-z0-9-]*-artifact$/;
export const ARTIFACT_ALLOWED_CINATRA_KEYS = new Set(["kind", "apiVersion", "artifact", "dependencies", "roles", "displayName", "vendor"]);

const SKILL_REF_IS_INVALID = (s) => /\.md$/i.test(s) || /^\.{0,2}\//.test(s) || s.startsWith("/");
const ARTIFACT_FORMS = new Set(["file", "connectorRef", "dashboard"]);

// cinatra#1621/#1622 — the versioned `cinatra.artifact.ui` renderer block. This
// self-contained, zero-dependency kind-gate performs a VALUE-INDEPENDENT
// structural PRE-SCREEN only: the object shape, the per-renderer shape, a
// package-contained `entry` subpath, and the v1 NO-PORTS rule (a renderer
// carries only { entry, propsApiVersion, representations? }). It deliberately
// does NOT re-list the DERIVED values — the closed slot enum (detail/preview),
// the exact `abiVersion`, or the GENERATED `sdkAbiRange` — which live in
// packages/sdk-extensions/src/artifact-contract.ts and are AUTHORITATIVELY
// enforced by the derive-from-live-source conformance gate
// (scripts/extensions/conformance-gate.mjs, run per repo via the reusable
// extension-conformance-gate workflow) and, fail-closed, at marketplace
// publish. Re-listing those derived values in this copy would reintroduce
// exactly the prose-vs-code drift the #979 conformance-gate design exists to
// eliminate. Boot is field-tolerant (a malformed ui degrades-with-diagnostic
// and never drops the extension's type registration or claims), so this
// pre-screen exists to catch gross authoring mistakes early, not to be the
// authoritative ui validator.

/** Mirror of the leaf `isContainedEntryPath` (artifact-contract.ts): a
 * package-relative, path-contained subpath — "./…", no ".."/empty/"." segment,
 * no absolute path, no protocol/URL, no backslash. This is a path SHAPE rule
 * (value-independent), so mirroring it here introduces no derived-value drift. */
function isContainedRendererEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0) return false;
  if (!entry.startsWith("./")) return false;
  if (entry.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(entry)) return false; // protocol / URL
  return !entry.slice(2).split("/").some((s) => s === "" || s === "." || s === "..");
}

const ARTIFACT_UI_ALLOWED_KEYS = ["abiVersion", "sdkAbiRange", "renderers"];
const ARTIFACT_UI_RENDERER_ALLOWED_KEYS = ["entry", "propsApiVersion", "representations"];

/** VALUE-INDEPENDENT shallow structural pre-screen of a `cinatra.artifact.ui`
 * block. Returns string[] errors ([] = shape-conformant). The caller invokes
 * this only when `ui` is present (it is optional — a purely declarative
 * artifact extension ships none). */
export function validateArtifactUiShape(ui) {
  const errors = [];
  if (!isObj(ui)) return ["ui must be an object ({ abiVersion, sdkAbiRange, renderers })"];
  for (const k of Object.keys(ui)) {
    if (!ARTIFACT_UI_ALLOWED_KEYS.includes(k)) errors.push(`ui: unexpected key "${k}"`);
  }
  if (typeof ui.abiVersion !== "number" || !Number.isInteger(ui.abiVersion) || ui.abiVersion < 1) {
    errors.push("ui.abiVersion must be a positive integer");
  }
  if (!nonEmptyStr(ui.sdkAbiRange)) errors.push("ui.sdkAbiRange must be a non-empty string");
  if (!isObj(ui.renderers) || Object.keys(ui.renderers).length === 0) {
    errors.push("ui.renderers must be a non-empty object mapping a v1 slot to a renderer");
    return errors;
  }
  for (const [slot, r] of Object.entries(ui.renderers)) {
    const at = `ui.renderers.${slot}`;
    if (!isObj(r)) {
      errors.push(`${at} must be an object ({ entry, propsApiVersion[, representations] })`);
      continue;
    }
    // v1 NO-PORTS: a renderer requests no host ports — only these three keys.
    for (const k of Object.keys(r)) {
      if (!ARTIFACT_UI_RENDERER_ALLOWED_KEYS.includes(k)) {
        errors.push(`${at}: unexpected key "${k}" — v1 renderers request NO host ports (only { entry, propsApiVersion, representations? })`);
      }
    }
    if (!isContainedRendererEntry(r.entry)) {
      errors.push(`${at}.entry must be a package-relative, path-contained subpath ("./…", no "..", no absolute path or URL)`);
    }
    if (typeof r.propsApiVersion !== "number" || !Number.isInteger(r.propsApiVersion) || r.propsApiVersion < 1) {
      errors.push(`${at}.propsApiVersion must be an integer >= 1`);
    }
    if (
      r.representations !== undefined &&
      (!Array.isArray(r.representations) || r.representations.length === 0 || !r.representations.every(nonEmptyStr))
    ) {
      errors.push(`${at}.representations, when present, must be a non-empty array of MIME pattern strings`);
    }
  }
  return errors;
}

/** Structural mirror of artifactDescriptorSchema (.strict() throughout). */
export function validateArtifactDescriptor(a) {
  const errors = [];
  if (!isObj(a)) return ["must be an object"];
  // accepts (required, ≥1 form)
  if (!isObj(a.accepts)) {
    errors.push("accepts must be an object with ≥1 representation form (file/connectorRef/dashboard)");
  } else {
    const ac = a.accepts;
    for (const k of Object.keys(ac)) {
      if (!["file", "connectorRef", "dashboard"].includes(k)) errors.push(`accepts: unexpected key "${k}"`);
    }
    if (ac.file !== undefined) {
      if (!isObj(ac.file) || !Array.isArray(ac.file.mimeTypes) || ac.file.mimeTypes.length === 0 || !ac.file.mimeTypes.every(nonEmptyStr)) {
        errors.push("accepts.file requires { mimeTypes: non-empty string[] }");
      } else if (Object.keys(ac.file).some((k) => k !== "mimeTypes")) {
        errors.push("accepts.file has unexpected keys");
      }
    }
    if (ac.connectorRef !== undefined) {
      if (!isObj(ac.connectorRef) || !Array.isArray(ac.connectorRef.resolvedMimeTypes) || ac.connectorRef.resolvedMimeTypes.length === 0 || !ac.connectorRef.resolvedMimeTypes.every(nonEmptyStr)) {
        errors.push("accepts.connectorRef requires { resolvedMimeTypes: non-empty string[] }");
      } else if (Object.keys(ac.connectorRef).some((k) => k !== "resolvedMimeTypes")) {
        errors.push("accepts.connectorRef has unexpected keys");
      }
    }
    if (ac.dashboard !== undefined && ac.dashboard !== true) errors.push("accepts.dashboard must be the literal true");
    if (ac.file === undefined && ac.connectorRef === undefined && ac.dashboard === undefined) {
      errors.push("accepts must declare at least one representation form (file/connectorRef/dashboard)");
    }
  }
  if (a.satisfies !== undefined && (!Array.isArray(a.satisfies) || !a.satisfies.every(nonEmptyStr))) {
    errors.push("satisfies must be a string[] when present");
  }
  if (a.templates !== undefined) {
    if (!Array.isArray(a.templates)) errors.push("templates must be an array when present");
    else {
      a.templates.forEach((t, i) => {
        if (!isObj(t)) { errors.push(`templates[${i}] must be an object`); return; }
        if (!nonEmptyStr(t.id)) errors.push(`templates[${i}].id required`);
        if (!ARTIFACT_FORMS.has(t.form)) errors.push(`templates[${i}].form must be file|connectorRef|dashboard`);
        if (!nonEmptyStr(t.mimeType)) errors.push(`templates[${i}].mimeType required`);
        if (!nonEmptyStr(t.path)) errors.push(`templates[${i}].path required`);
        if (t.default !== undefined && typeof t.default !== "boolean") errors.push(`templates[${i}].default must be boolean`);
        for (const k of Object.keys(t)) if (!["id", "form", "mimeType", "path", "default"].includes(k)) errors.push(`templates[${i}] unexpected key "${k}"`);
      });
    }
  }
  if (a.skills !== undefined) {
    if (!isObj(a.skills)) errors.push("skills must be an object when present");
    else {
      for (const facet of Object.keys(a.skills)) {
        if (!["authoring", "matchers", "validators", "enrichers"].includes(facet)) { errors.push(`skills: unexpected facet "${facet}"`); continue; }
        const ids = a.skills[facet];
        if (!Array.isArray(ids) || !ids.every((s) => nonEmptyStr(s) && !SKILL_REF_IS_INVALID(s))) {
          errors.push(`skills.${facet} must be an array of skills-catalog ids (not filesystem paths)`);
        }
      }
    }
  }
  if (a.agentDependencies !== undefined && (!Array.isArray(a.agentDependencies) || !a.agentDependencies.every(nonEmptyStr))) {
    errors.push("agentDependencies must be a string[] when present");
  }
  if (a.matcherConfidenceThreshold !== undefined) {
    const v = a.matcherConfidenceThreshold;
    if (typeof v !== "number" || v < 0 || v > 1) errors.push("matcherConfidenceThreshold must be a number in [0,1]");
  }
  if (a.objectTypes !== undefined) {
    for (const e of validateArtifactObjectTypeClaims(a.objectTypes)) errors.push(e);
  }
  if (a.ui !== undefined) {
    for (const e of validateArtifactUiShape(a.ui)) errors.push(e);
  }
  for (const k of Object.keys(a)) {
    if (!["accepts", "satisfies", "templates", "skills", "agentDependencies", "matcherConfidenceThreshold", "ui", "objectTypes"].includes(k)) {
      errors.push(`unexpected key "${k}"`);
    }
  }
  return errors;
}

// `objectTypes` claims — mirror of the host's manifest claim-entry schema
// (`artifactObjectTypeClaimManifestSchema` + `parseArtifactObjectTypeClaims`
// in the monorepo's @cinatra-ai/objects claims policy leaf) so the local gate
// and the install pipeline cannot disagree. A `kind:"artifact"` extension may
// claim typed object rows: each entry names a namespaced object type id, a
// claim kind ('dedicated' | 'default'), an optional strict dispositions
// payload, and an optional inline JSON Schema for the claimed rows.
export const CLAIMED_OBJECT_TYPE_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;
const CLAIM_KINDS = new Set(["dedicated", "default"]);
const CLAIM_PROJECTIONS = new Set(["raw", "artifact-safe", "none"]);
const CLAIM_SNAPSHOT_POLICIES = new Set(["content", "metadata", "none"]);
const CLAIM_SENSITIVITIES = new Set(["normal", "sensitive"]);

function validateClaimDispositions(d, at) {
  const errors = [];
  if (!isObj(d)) return [`${at}.dispositions must be an object`];
  if (!CLAIM_PROJECTIONS.has(d.projection)) {
    errors.push(`${at}.dispositions.projection must be raw|artifact-safe|none`);
  }
  if (d.pinnable !== undefined && typeof d.pinnable !== "boolean") {
    errors.push(`${at}.dispositions.pinnable must be boolean`);
  }
  // Never-projected rows cannot be pinned into context (mirrors the host's
  // discriminated union: projection "none" forces pinnable false).
  if (d.projection === "none" && d.pinnable === true) {
    errors.push(`${at}.dispositions: projection "none" forbids pinnable true`);
  }
  if (d.snapshotPolicy !== undefined && !CLAIM_SNAPSHOT_POLICIES.has(d.snapshotPolicy)) {
    errors.push(`${at}.dispositions.snapshotPolicy must be content|metadata|none`);
  }
  if (d.redactionPolicyVersion !== undefined && !nonEmptyStr(d.redactionPolicyVersion)) {
    errors.push(`${at}.dispositions.redactionPolicyVersion must be a non-empty string when present`);
  }
  if (d.sensitivity !== undefined && !CLAIM_SENSITIVITIES.has(d.sensitivity)) {
    errors.push(`${at}.dispositions.sensitivity must be normal|sensitive`);
  }
  for (const k of Object.keys(d)) {
    if (!["projection", "pinnable", "snapshotPolicy", "redactionPolicyVersion", "sensitivity"].includes(k)) {
      errors.push(`${at}.dispositions has unexpected key "${k}"`);
    }
  }
  return errors;
}

export function validateArtifactObjectTypeClaims(claims) {
  const errors = [];
  if (!Array.isArray(claims) || claims.length === 0) {
    return ["objectTypes must be a non-empty array of claim entries when present"];
  }
  const seen = new Set();
  claims.forEach((c, i) => {
    const at = `objectTypes[${i}]`;
    if (!isObj(c)) { errors.push(`${at} must be an object`); return; }
    if (!nonEmptyStr(c.type) || !CLAIMED_OBJECT_TYPE_ID_RE.test(c.type)) {
      errors.push(`${at}.type must be a namespaced object type id (@scope/package:local-id)`);
    } else if (seen.has(c.type)) {
      errors.push(`duplicate objectTypes claim for "${c.type}"`);
    } else {
      seen.add(c.type);
    }
    if (!CLAIM_KINDS.has(c.claim)) errors.push(`${at}.claim must be dedicated|default`);
    if (c.dispositions !== undefined) errors.push(...validateClaimDispositions(c.dispositions, at));
    if (c.schema !== undefined && !isObj(c.schema)) errors.push(`${at}.schema must be a JSON Schema object when present`);
    for (const k of Object.keys(c)) {
      if (!["type", "claim", "dispositions", "schema"].includes(k)) errors.push(`${at} has unexpected key "${k}"`);
    }
  });
  return errors;
}

/** The package that REGISTERS a claimed type: the namespace of its id
 * (`@scope/pkg:slug` → `@scope/pkg`). Mirrors the host's
 * `claimedTypeRegisteringPackage`. */
export function claimedTypeRegisteringPackage(objectTypeId) {
  const idx = typeof objectTypeId === "string" ? objectTypeId.indexOf(":") : -1;
  if (idx <= 0) return null;
  const pkg = objectTypeId.slice(0, idx);
  return /^@[\w-]+\/[\w-]+$/.test(pkg) ? pkg : null;
}

/** The third-party schema-source rule (host `validateObjectTypeClaimSchemaSources`,
 * fail-closed): every claimed type must ship an inline JSON Schema, OR be
 * self-namespaced, OR name the registering extension in cinatra.dependencies. */
export function validateObjectTypeClaimSchemaSources(packageName, claims, dependencyPackageNames) {
  const errors = [];
  const deps = new Set(dependencyPackageNames);
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (!isObj(claim) || claim.schema !== undefined) continue;
    const registrant = claimedTypeRegisteringPackage(claim.type);
    if (registrant == null) continue; // shape error already reported above
    if (registrant === packageName) continue; // self-registered type
    if (deps.has(registrant)) continue; // registering extension is a declared dependency
    errors.push(
      `objectTypes claim "${claim.type}" has no schema source: ship a JSON Schema in the claim ` +
        `or declare a cinatra.dependencies entry on the type-registering extension "${registrant}"`,
    );
  }
  return errors;
}

export function validateArtifactPackageShape(pkg) {
  const errors = [];
  const cinatra = (pkg && pkg.cinatra) || {};
  if (typeof pkg?.name !== "string") {
    errors.push("package.json is missing `name`");
  } else if (!ARTIFACT_NAME_RE.test(pkg.name)) {
    errors.push(`package name "${pkg.name}" does not match the kind-at-end convention @cinatra-ai/<slug>-artifact`);
  }
  if (cinatra.kind !== "artifact") {
    errors.push(`package.json must declare cinatra.kind: "artifact" (got ${JSON.stringify(cinatra.kind)})`);
  }
  if ("oas" in cinatra && cinatra.oas != null) {
    errors.push("artifact extensions are metadata-only and must NOT carry a cinatra.oas payload");
  }
  if (cinatra.artifact == null) {
    errors.push("package.json must declare a cinatra.artifact descriptor (accepts[, satisfies][, templates][, skills][, agentDependencies])");
  } else {
    for (const e of validateArtifactDescriptor(cinatra.artifact)) errors.push(`cinatra.artifact descriptor is invalid: ${e}`);
    // Schema-source rule for objectTypes claims (mirrors the host's install
    // pipeline check — cinatra.dependencies entries are { packageName } objects).
    if (isObj(cinatra.artifact) && cinatra.artifact.objectTypes !== undefined) {
      const declaredDeps = Array.isArray(cinatra.dependencies)
        ? cinatra.dependencies
            .map((d) => (isObj(d) && typeof d.packageName === "string" ? d.packageName : null))
            .filter((n) => n != null)
        : [];
      for (const e of validateObjectTypeClaimSchemaSources(pkg.name, cinatra.artifact.objectTypes, declaredDeps)) {
        errors.push(e);
      }
    }
  }
  for (const k of Object.keys(cinatra)) {
    if (!ARTIFACT_ALLOWED_CINATRA_KEYS.has(k)) {
      errors.push(`artifact extensions may only declare cinatra.{kind,apiVersion,artifact,dependencies,roles,displayName,vendor}; unexpected key "${k}"`);
    }
  }
  return errors;
}

export function validateArtifact(packageRoot) {
  let pkg;
  try {
    pkg = readPackageJson(packageRoot);
  } catch (err) {
    return [`could not read package.json: ${err instanceof Error ? err.message : String(err)}`];
  }
  return validateArtifactPackageShape(pkg);
}

// ===========================================================================
// skill gate — mirror of the kind-at-end naming-conformance rule for skills:
// the dir suffix for kind:"skill" is `-skills`, the package follows
// @<scope>/<slug>-skills (first-party-plus-vendored scope policy). A vendored
// skill bundle (e.g. @anthropics/skills) may use a no-suffix VendoredPackageName,
// allowlisted host-side; standalone we accept either the `-skills` suffix OR a
// declared cinatra.vendoredFrom.
// ===========================================================================
export const SKILL_NAME_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-skills$/;

export function validateSkillPackageShape(pkg) {
  const errors = [];
  const cinatra = (pkg && pkg.cinatra) || {};
  if (cinatra.kind !== "skill") {
    errors.push(`package.json must declare cinatra.kind: "skill" (got ${JSON.stringify(cinatra.kind)})`);
  }
  const vendored = cinatra.vendoredFrom != null;
  if (typeof pkg?.name !== "string") {
    errors.push("package.json is missing `name`");
  } else if (!SKILL_NAME_RE.test(pkg.name) && !vendored) {
    errors.push(`package name "${pkg.name}" does not match the kind-at-end convention @<scope>/<slug>-skills (a vendored bundle may use its upstream name with cinatra.vendoredFrom)`);
  }
  return errors;
}

export function validateSkill(packageRoot) {
  let pkg;
  try {
    pkg = readPackageJson(packageRoot);
  } catch (err) {
    return [`could not read package.json: ${err instanceof Error ? err.message : String(err)}`];
  }
  return validateSkillPackageShape(pkg);
}

// ===========================================================================
// dispatch
// ===========================================================================
const KIND_GATES = {
  agent: validateAgent,
  connector: validateConnector,
  artifact: validateArtifact,
  skill: validateSkill,
};

/** Run the full gate for the package at packageRoot. Returns
 * { kind, errors, warnings }. ALWAYS runs the common rules, THEN the kind gate.
 * `opts.enforceArtifactParity` promotes the Layer-1 artifact-parity findings
 * from warnings (the default rollout state) to hard errors (BLOCK on republish);
 * when omitted it falls back to env CINATRA_ARTIFACT_PARITY. The extra arg is
 * optional, so `runGate(packageRoot)` stays source-compatible. */
export function runGate(packageRoot, opts = {}) {
  let pkg;
  try {
    pkg = readPackageJson(packageRoot);
  } catch (err) {
    return { kind: undefined, errors: [`could not read package.json at ${packageRoot}: ${err instanceof Error ? err.message : String(err)}`], warnings: [] };
  }
  const kind = pkg?.cinatra?.kind;
  const common = validateCommon(packageRoot);
  const errors = [...common.errors];
  const warnings = [...common.warnings];
  const kindGate = KIND_GATES[kind];
  if (kindGate) errors.push(...kindGate(packageRoot));
  // Layer-1 artifact parity (ratchet): warnings by default so the un-migrated
  // fleet never reddens; hard errors under enforcement (BLOCK on republish).
  const enforceArtifactParity =
    opts.enforceArtifactParity ?? (process.env.CINATRA_ARTIFACT_PARITY === "block");
  const parity = collectArtifactParityFindings(packageRoot, pkg);
  if (enforceArtifactParity) errors.push(...parity);
  else warnings.push(...parity);
  return { kind, errors, warnings };
}

function main() {
  const { packageRoot, enforceArtifactParity } = parseArgs(process.argv.slice(2));
  const { kind, errors, warnings } = runGate(packageRoot, { enforceArtifactParity });
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  if (errors.length === 0) {
    console.log(
      VALID_KINDS.includes(kind)
        ? `✓ extension-kind-gate: ${kind} extension passed (${warnings.length} warning(s)).`
        : `extension-kind-gate: no validation for kind ${JSON.stringify(kind)}.`,
    );
    process.exit(0);
  }
  console.error(`\n✗ extension-kind-gate: ${errors.length} ${kind ?? "extension"} violation(s):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error("extension-kind-gate: unexpected error", err);
    process.exit(1);
  }
}
