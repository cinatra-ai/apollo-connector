#!/usr/bin/env node
// ---------------------------------------------------------------------------
// extension-kind-gate — self-contained, zero-dependency extension validator for
// a Cinatra extension repo. ONE local command an external author runs to catch
// what the install pipeline would reject, BEFORE publishing:
//
//     node extension-kind-gate.mjs --package-root .
//
// This file is shipped INTO each extracted Cinatra extension repo by the
// extraction script (scripts/extensions/extract-extension-repos.mjs) and run by
// the repo's standalone CI. It covers ALL FIVE extension kinds (agent,
// connector, artifact, skill, workflow).
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
//     - manifest shape: cinatra.kind ∈ the 5 kinds; cinatra.apiVersion ===
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
//       The grammar covers the 7 base field kinds (text/secret/nango-connect/
//       repeatable-list/status-probe/copyable-credential/named-action) plus the
//       PR-4 Track-3 additions (select/record-list/advisory/banner). Every kind
//       is pure DATA: no field carries executable code or HTML; action refs are
//       BY ID only (host resolves + authorizes them). An optional root `tabs`
//       array (cinatra#1102 tab/section grouping — design spec: app-connectors
//       §II) groups fields into named tabs {id,label,fields}; field keys stay
//       unique across the base `fields` AND every tab.
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
//                    dependencies,roles} (mirrors artifact-handler.validate).
//     - skill     → name ends `-skills`; kind:"skill" (mirrors the kind-at-end
//                    naming-conformance rule for skills).
//     - workflow  → package shape (mirrors validateWorkflowExtensionPackage,
//                    INCLUDING the `roles` allowed key) + exactly one well-formed
//                    cinatra/workflow.bpmn.
//
// WARNINGS (printed, never fail): the gate prints advisory notes for things it
// cannot certify standalone or that are release/runtime-time (source serverEntry
// not yet built; an sdkAbiRange the CURRENT host ABI 2.2.0 would not satisfy).
//
// SCOPE (intentionally a PRE-PUBLISH local gate; the authoritative Profile-1.0
// BPMN compile + full OAS runtime-invariant validation + the trust/signature
// check re-run marketplace-side at publish/install). STANDALONE SCOPE NOTE: the
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

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename, dirname, relative, normalize, isAbsolute, sep } from "node:path";

// ===========================================================================
// arg parsing
// ===========================================================================
export function parseArgs(argv) {
  let packageRoot = ".";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package-root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--package-root requires a value");
      packageRoot = value;
      i++;
    } else if (arg.startsWith("--package-root=")) {
      packageRoot = arg.slice("--package-root=".length);
    }
  }
  return { packageRoot: resolve(packageRoot) };
}

// ===========================================================================
// Canonical constants — kept in lock-step with the cinatra monorepo. The
// monorepo parity test (extension-release-tooling tests + the cinatra-side
// gates) is the drift guard; these lists must match exactly.
// ===========================================================================
export const VALID_KINDS = ["agent", "connector", "artifact", "skill", "workflow"];
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
// schema-config validator — ported (rules only) from
// scripts/extensions/generate-extension-manifest.mjs validateConfigSchema.
// ===========================================================================
const SCHEMA_CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
// The 7 base kinds plus the four PR-4 Track-3 additions (select, record-list,
// advisory, banner). The host parser (src/lib/extension-schema-config.ts) is
// extended with the SAME grammar in cinatra#658; this gate is the rules-only
// standalone port. Every kind is PURE DATA — no field may carry executable code
// or arbitrary HTML. `adminOnly` (select options) is a host-evaluated VISIBILITY
// hint declared as data; the connector never evaluates it. record-list/named-
// action/advisory reference host-registered named actions BY ID only — the host
// resolves + authorizes them at the `/api/extensions/{installId}/actions/...`
// endpoint (actor evaluated host-side).
const SCHEMA_CONFIG_FIELD_KINDS = new Set([
  "text", "secret", "nango-connect", "repeatable-list", "status-probe",
  "copyable-credential", "named-action",
  "select", "record-list", "advisory", "banner",
]);
const SCHEMA_CONFIG_BADGE_VARIANTS = new Set([
  "outline", "secondary", "destructive", "muted", "success", "warning", "default",
]);
const SCHEMA_CONFIG_TONES = new Set([
  "info", "success", "warning", "destructive",
]);

// FAIL-CLOSED key allowlist per field kind. Every field is PURE DATA: an
// UNKNOWN key (e.g. "html", "onClick", "render", "component", "script") is
// REJECTED, so an author cannot smuggle an executable/HTML carrier past the
// grammar even on an otherwise-valid field. Nested objects (select options,
// record-list badges, banner variants) have their own allowlists below.
const SCHEMA_CONFIG_ALLOWED_KEYS = {
  text: new Set(["kind", "key", "label", "placeholder", "required", "description"]),
  secret: new Set(["kind", "key", "label", "required", "description"]),
  "nango-connect": new Set(["kind", "label", "providerConfigKey", "description"]),
  "repeatable-list": new Set(["kind", "key", "label", "itemLabel", "itemFields", "description"]),
  "status-probe": new Set(["kind", "label", "actionId", "description"]),
  "copyable-credential": new Set(["kind", "key", "label", "description"]),
  "named-action": new Set(["kind", "label", "actionId", "confirm", "description"]),
  select: new Set(["kind", "key", "label", "options", "defaultValue", "description"]),
  "record-list": new Set([
    "kind", "label", "listActionId", "deleteActionId", "emptyState",
    "itemTitleKey", "itemSubtitleKey", "itemBadges", "description",
  ]),
  advisory: new Set(["kind", "label", "tone", "probeActionId", "whenReady", "whenNotReady", "description"]),
  banner: new Set(["kind", "label", "variants"]),
};
const SCHEMA_CONFIG_OPTION_KEYS = new Set(["value", "label", "adminOnly"]);
const SCHEMA_CONFIG_BADGE_KEYS = new Set(["key", "label", "variant"]);
const SCHEMA_CONFIG_BANNER_VARIANT_KEYS = new Set(["name", "tone", "message"]);

/** Push an error for any key on `raw` not in `allowed` (fail-closed: no
 *  unexpected/executable carrier keys). */
function rejectUnknownKeys(raw, allowed, at, errors) {
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      errors.push(`${at}: unknown key ${JSON.stringify(k)} — schema-config fields are pure data (no executable/HTML keys)`);
    }
  }
}

function validateConfigSchemaField(kind, raw, at, errors, seenKeys) {
  const allowedKeys = SCHEMA_CONFIG_ALLOWED_KEYS[kind];
  if (allowedKeys) rejectUnknownKeys(raw, allowedKeys, at, errors);
  if (!nonEmptyStr(raw.label)) {
    errors.push(`${at}: missing "label"`);
    return;
  }
  const needsKey = kind === "text" || kind === "secret" || kind === "copyable-credential" || kind === "repeatable-list" || kind === "select";
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
  // ---- select: a dropdown of value/label options. Per-option `adminOnly` is a
  //      host-evaluated visibility hint (data only); the connector never gates.
  if (kind === "select") {
    const options = raw.options;
    if (!Array.isArray(options) || options.length === 0) {
      errors.push(`${at}: select requires a non-empty "options"`);
      return;
    }
    const seenValues = new Set();
    options.forEach((opt, j) => {
      const optAt = `${at}.options[${j}]`;
      if (!isObj(opt) || !nonEmptyStr(opt.value) || !nonEmptyStr(opt.label)) {
        errors.push(`${optAt}: select option must have a non-empty string "value" and "label"`);
        return;
      }
      rejectUnknownKeys(opt, SCHEMA_CONFIG_OPTION_KEYS, optAt, errors);
      if (seenValues.has(opt.value)) {
        errors.push(`${optAt}: duplicate option value "${opt.value}"`);
        return;
      }
      seenValues.add(opt.value);
      if (opt.adminOnly !== undefined && typeof opt.adminOnly !== "boolean") {
        errors.push(`${optAt}: "adminOnly" must be a boolean when present`);
      }
    });
    if (raw.defaultValue !== undefined && (!nonEmptyStr(raw.defaultValue) || !seenValues.has(raw.defaultValue))) {
      errors.push(`${at}: "defaultValue" must be one of the declared option values`);
    }
  }
  // ---- record-list: a LIVE list of existing rows sourced from a host list
  //      action, with per-row badges declared as data + an optional per-row
  //      delete action. Distinct from create-time repeatable-list. Both actions
  //      are referenced BY ID only — the host resolves + authorizes them.
  if (kind === "record-list") {
    if (!nonEmptyStr(raw.listActionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.listActionId)) {
      errors.push(`${at}: record-list requires a valid "listActionId"`);
    }
    if (raw.deleteActionId !== undefined && (!nonEmptyStr(raw.deleteActionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.deleteActionId))) {
      errors.push(`${at}: record-list "deleteActionId" must be a valid action id when present`);
    }
    if (raw.itemBadges !== undefined) {
      if (!Array.isArray(raw.itemBadges)) {
        errors.push(`${at}: record-list "itemBadges" must be an array when present`);
      } else {
        raw.itemBadges.forEach((badge, j) => {
          const badgeAt = `${at}.itemBadges[${j}]`;
          if (!isObj(badge) || !nonEmptyStr(badge.key) || !nonEmptyStr(badge.label)) {
            errors.push(`${badgeAt}: record-list badge must have a non-empty string "key" and "label"`);
            return;
          }
          rejectUnknownKeys(badge, SCHEMA_CONFIG_BADGE_KEYS, badgeAt, errors);
          if (badge.variant !== undefined && !SCHEMA_CONFIG_BADGE_VARIANTS.has(badge.variant)) {
            errors.push(`${badgeAt}: unknown badge variant ${JSON.stringify(badge.variant)}`);
          }
        });
      }
    }
    for (const k of ["itemTitleKey", "itemSubtitleKey"]) {
      if (raw[k] !== undefined && !nonEmptyStr(raw[k])) {
        errors.push(`${at}: record-list "${k}" must be a non-empty string when present`);
      }
    }
    if (raw.emptyState !== undefined && !nonEmptyStr(raw.emptyState)) {
      errors.push(`${at}: record-list "emptyState" must be a non-empty string when present`);
    }
  }
  // ---- advisory: a readiness/warning note. Optional host probe action drives
  //      the ready/not-ready copy. Pure copy — never executable.
  if (kind === "advisory") {
    if (raw.probeActionId !== undefined && (!nonEmptyStr(raw.probeActionId) || !SCHEMA_CONFIG_KEY_RE.test(raw.probeActionId))) {
      errors.push(`${at}: advisory "probeActionId" must be a valid action id when present`);
    }
    if (raw.tone !== undefined && !SCHEMA_CONFIG_TONES.has(raw.tone)) {
      errors.push(`${at}: advisory "tone" must be one of ${[...SCHEMA_CONFIG_TONES].join(", ")}`);
    }
    for (const k of ["whenReady", "whenNotReady"]) {
      if (raw[k] !== undefined && !nonEmptyStr(raw[k])) {
        errors.push(`${at}: advisory "${k}" must be a non-empty string when present`);
      }
    }
  }
  // ---- banner: result-feedback driven by action RESULTS (not search params).
  //      Declared variants are pure data {name, tone, message}.
  if (kind === "banner") {
    const variants = raw.variants;
    if (!Array.isArray(variants) || variants.length === 0) {
      errors.push(`${at}: banner requires a non-empty "variants"`);
      return;
    }
    const seenNames = new Set();
    variants.forEach((variant, j) => {
      const variantAt = `${at}.variants[${j}]`;
      if (!isObj(variant) || !nonEmptyStr(variant.name) || !nonEmptyStr(variant.message)) {
        errors.push(`${variantAt}: banner variant must have a non-empty string "name" and "message"`);
        return;
      }
      rejectUnknownKeys(variant, SCHEMA_CONFIG_BANNER_VARIANT_KEYS, variantAt, errors);
      if (seenNames.has(variant.name)) {
        errors.push(`${variantAt}: duplicate banner variant name "${variant.name}"`);
        return;
      }
      seenNames.add(variant.name);
      if (!SCHEMA_CONFIG_TONES.has(variant.tone)) {
        errors.push(`${variantAt}: banner variant "tone" must be one of ${[...SCHEMA_CONFIG_TONES].join(", ")}`);
      }
    });
  }
}

// cinatra#1102 tab/section grouping primitive (design spec: app-connectors §II
// — a tabbed setup page, reserved Help tab always last). Mirrors the SAME
// vocabulary the host parser added to src/lib/extension-schema-config.ts: a
// root `tabs` key, each entry carrying ONLY {id,label,fields} (fail-closed, no
// executable/HTML carrier), field keys unique across the base `fields` AND
// every tab (one flat submit namespace). The reserved id below matches the
// host's HELP_TAB_ID; this standalone gate validates SHAPE only (like the host
// parser it mirrors, it does not require Help to be declared last — the host
// normalizes the render order silently either way).
const SCHEMA_CONFIG_TAB_KEYS = new Set(["id", "label", "fields"]);
export const SCHEMA_CONFIG_HELP_TAB_ID = "help";

function validateConfigSchemaTabs(rawTabs, errors, seenKeys) {
  if (!Array.isArray(rawTabs)) {
    errors.push(`configSchema.tabs must be an array`);
    return;
  }
  const seenTabIds = new Set();
  rawTabs.forEach((tab, i) => {
    const at = `tabs[${i}]`;
    if (!isObj(tab)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    rejectUnknownKeys(tab, SCHEMA_CONFIG_TAB_KEYS, at, errors);
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
    // Threaded through the SAME seenKeys set as the base fields — a keyed field
    // (text/secret/.../free-list) must be unique across the whole surface, not
    // just within its own tab (mirrors the host parser's shared namespace).
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

const SCHEMA_CONFIG_ROOT_KEYS = new Set(["title", "description", "fields", "tabs"]);

export function validateConfigSchema(raw) {
  if (!isObj(raw)) return ["must be an object"];
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) return ["fields must be a non-empty array"];
  const errors = [];
  // FAIL-CLOSED at the root too: reject any unknown top-level key (e.g. "html",
  // "script") so the whole grammar — not just fields — is pure data.
  rejectUnknownKeys(raw, SCHEMA_CONFIG_ROOT_KEYS, "configSchema", errors);
  if (raw.title !== undefined && !nonEmptyStr(raw.title)) {
    errors.push(`configSchema: "title" must be a non-empty string when present`);
  }
  if (raw.description !== undefined && !nonEmptyStr(raw.description)) {
    errors.push(`configSchema: "description" must be a non-empty string when present`);
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

/** Validate an agent extension at packageRoot. Pure: returns string[] errors. */
export function validateAgent(packageRoot) {
  const errors = [];
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
export const ARTIFACT_ALLOWED_CINATRA_KEYS = new Set(["kind", "apiVersion", "artifact", "dependencies", "roles"]);

const SKILL_REF_IS_INVALID = (s) => /\.md$/i.test(s) || /^\.{0,2}\//.test(s) || s.startsWith("/");
const ARTIFACT_FORMS = new Set(["file", "connectorRef", "dashboard"]);

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
  for (const k of Object.keys(a)) {
    if (!["accepts", "satisfies", "templates", "skills", "agentDependencies", "matcherConfidenceThreshold"].includes(k)) {
      errors.push(`unexpected key "${k}"`);
    }
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
  }
  for (const k of Object.keys(cinatra)) {
    if (!ARTIFACT_ALLOWED_CINATRA_KEYS.has(k)) {
      errors.push(`artifact extensions may only declare cinatra.{kind,apiVersion,artifact,dependencies,roles}; unexpected key "${k}"`);
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
// workflow gate — package shape (mirror validateWorkflowExtensionPackage,
// INCLUDING the `roles` allowed key — cinatra#151 Stage 5) + a single
// well-formed cinatra/workflow.bpmn.
// ===========================================================================
const WORKFLOW_PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-workflow$/;

export function validateWorkflowPackageShape(pkg) {
  const errors = [];
  const cinatra = (pkg && pkg.cinatra) || {};
  if (typeof pkg?.name !== "string" || !WORKFLOW_PACKAGE_NAME_RE.test(pkg.name)) {
    errors.push(`package name must match @<scope>/<slug>-workflow (got ${JSON.stringify(pkg?.name)})`);
  }
  if (cinatra.kind !== "workflow") {
    errors.push(`package.json must declare cinatra.kind: "workflow" (got ${JSON.stringify(cinatra.kind)})`);
  }
  if (cinatra.workflow !== undefined) {
    errors.push("inline cinatra.workflow is forbidden; ship a cinatra/workflow.bpmn sidecar");
  }
  if (typeof cinatra.workflowVersion !== "number" || !Number.isInteger(cinatra.workflowVersion) || cinatra.workflowVersion <= 0) {
    errors.push(`cinatra.workflowVersion must be a positive integer (got ${JSON.stringify(cinatra.workflowVersion)})`);
  }
  // `roles` is cross-kind (cinatra#151 Stage 5) — a workflow package may carry it.
  const allowed = new Set(["kind", "apiVersion", "workflowVersion", "dependencies", "roles"]);
  for (const k of Object.keys(cinatra)) {
    if (!allowed.has(k)) errors.push(`unexpected cinatra key "${k}"`);
  }
  return errors;
}

const BPMN_MODEL_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";

export function validateBpmnSanity(xml) {
  const errors = [];
  if (typeof xml !== "string" || xml.trim() === "") {
    errors.push("cinatra/workflow.bpmn is empty");
    return errors;
  }
  const stripped = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");

  const prefixOf = (qname) => (qname.includes(":") ? qname.split(":")[0] : "");
  const localOf = (qname) => (qname.includes(":") ? qname.split(":")[1] : qname);

  const tagRe = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const stack = [];
  let m;
  let rootName = null;
  let rootAttrs = "";
  const openTags = [];
  while ((m = tagRe.exec(stripped)) !== null) {
    const isClose = m[1] === "/";
    const name = m[2];
    const attrs = m[3] || "";
    const selfClose = m[4] === "/";
    if (!isClose) {
      if (rootName === null) {
        rootName = name;
        rootAttrs = attrs;
      }
      openTags.push({ prefix: prefixOf(name), local: localOf(name) });
    }
    if (selfClose) continue;
    if (isClose) {
      const top = stack.pop();
      if (top !== name) {
        errors.push(`malformed BPMN XML: closing </${name}> does not match <${top ?? "(none)"}>`);
        return errors;
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    errors.push(`malformed BPMN XML: unclosed element <${stack[stack.length - 1]}>`);
    return errors;
  }
  if (rootName === null) {
    errors.push("BPMN has no root element");
    return errors;
  }
  const bpmnPrefixes = new Set();
  const nsRe = /xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let nm;
  while ((nm = nsRe.exec(rootAttrs)) !== null) {
    const prefix = nm[1] ?? "";
    const uri = nm[2] ?? nm[3];
    if (uri === BPMN_MODEL_NS) bpmnPrefixes.add(prefix);
  }
  if (bpmnPrefixes.size === 0) {
    errors.push(`not a BPMN document: root element does not bind the BPMN 2.0 MODEL namespace (${BPMN_MODEL_NS})`);
    return errors;
  }
  if (localOf(rootName) !== "definitions" || !bpmnPrefixes.has(prefixOf(rootName))) {
    errors.push(`BPMN root must be <definitions> in the BPMN MODEL namespace (got <${rootName}>)`);
  }
  const processCount = openTags.filter((t) => t.local === "process" && bpmnPrefixes.has(t.prefix)).length;
  if (processCount < 1) errors.push("BPMN must declare at least one <process> in the BPMN MODEL namespace");
  return errors;
}

export function findWorkflowSidecars(packageRoot) {
  const out = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full);
      } else if (e.name === "workflow.bpmn" && basename(dirname(full)) === "cinatra") {
        out.push(full);
      }
    }
  };
  walk(packageRoot);
  return out;
}

export function validateWorkflow(packageRoot) {
  const errors = [];
  let pkg;
  try {
    pkg = readPackageJson(packageRoot);
  } catch (err) {
    errors.push(`could not read package.json: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
  errors.push(...validateWorkflowPackageShape(pkg));
  const bpmnPath = join(packageRoot, "cinatra", "workflow.bpmn");
  if (!existsSync(bpmnPath)) {
    errors.push("missing required sidecar cinatra/workflow.bpmn");
    return errors;
  }
  const allSidecars = findWorkflowSidecars(packageRoot);
  if (allSidecars.length > 1) {
    errors.push(`expected exactly one cinatra/workflow.bpmn, found ${allSidecars.length}: ${allSidecars.map((p) => relative(packageRoot, p)).join(", ")}`);
    return errors;
  }
  let xml;
  try {
    xml = readFileSync(bpmnPath, "utf8");
  } catch (err) {
    errors.push(`could not read cinatra/workflow.bpmn: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
  errors.push(...validateBpmnSanity(xml));
  return errors;
}

// ===========================================================================
// dispatch
// ===========================================================================
const KIND_GATES = {
  agent: validateAgent,
  connector: validateConnector,
  artifact: validateArtifact,
  skill: validateSkill,
  workflow: validateWorkflow,
};

/** Run the full gate for the package at packageRoot. Returns
 * { kind, errors, warnings }. ALWAYS runs the common rules, THEN the kind gate. */
export function runGate(packageRoot) {
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
  return { kind, errors, warnings };
}

function main() {
  const { packageRoot } = parseArgs(process.argv.slice(2));
  const { kind, errors, warnings } = runGate(packageRoot);
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
