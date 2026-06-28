/**
 * ui-design-system — shareable ESLint flat-config preset.
 *
 * Enforces "UI work uses shadcn" mechanically:
 *
 *   Block A (`no-restricted-imports`, always `error`)
 *     Bans Radix (`@radix-ui/*`, `radix-ui`) and non-shadcn UI libraries
 *     (MUI, Chakra, antd, Mantine, Emotion, styled-components, HeadlessUI),
 *     plus the Drizzle Cube client surface (`drizzle-cube/client*`,
 *     `react-grid-layout`) outside its dashboard-components directory.
 *     `no-restricted-imports` only sees STATIC ESM imports, so the same
 *     bans are mirrored onto dynamic forms by Block C.
 *
 *   Block C (`no-restricted-syntax`)
 *     Closes the dynamic-loader gap: a `require("@mui/material")` or an
 *     `await import("@mui/material")` is invisible to `no-restricted-imports`
 *     (which only sees static ESM `import`). Block C re-bans the exact same
 *     module groups as Block A on dynamic `import()` (`ImportExpression`) and
 *     CommonJS `require(...)` call expressions, with the identical path
 *     carve-out semantics (the dashboard carve-out re-allows the Drizzle Cube
 *     surface; the shadcn primitives re-allow Radix). The selectors are
 *     derived from the SAME ban groups Block A uses, so the two cannot drift.
 *     Severity: `error` on non-JSX sources. On JSX sources Block C shares the
 *     single `no-restricted-syntax` rule with Block B (ESLint applies one
 *     severity per rule and never merges options across configs), so there it
 *     runs at the Block-B `strictness` — a dynamic ban in a .tsx warns while
 *     the repo is at `warn` and becomes an error when the repo ramps to
 *     `error`. Static imports (Block A) stay `error` everywhere regardless.
 *
 *   Block B (`no-restricted-syntax`, severity = `strictness`, default `warn`)
 *     Flags raw `<button>`, `<input>`, `<select>`, `<textarea>` and `<a>`
 *     JSX in favor of the shadcn wrappers. The import ban is higher-signal;
 *     the raw-JSX ban is noisier, so it starts at `warn` and is ramped to
 *     `error` per repo once clean. On JSX files it carries the Block-C
 *     dynamic-loader selectors too (see Block C).
 *
 *   Exemptions are expressed ONLY as flat-config `files` carve-outs (never
 *   inline `eslint-disable`):
 *     - `uiGlobs` (default: `components/ui` and `src/ui` directories at any
 *       depth): the vendored shadcn primitives. Radix is re-allowed (shadcn
 *       primitives are built on Radix) and Block B does not apply (the
 *       wrappers themselves render the raw elements).
 *     - `drizzleCubeGlobs` (default: `packages/dashboards/src/components`
 *       directories at any depth): re-allows `drizzle-cube/client*` and
 *       `react-grid-layout` ONLY. Everything else (Radix included) stays
 *       banned, so the rest of a dashboards package keeps full enforcement.
 *     - `__tests__/fixtures` directories are excluded from every block so
 *       repos can keep deliberately-violating lint fixtures.
 *
 *   `recharts` is the allowed shadcn chart primitive and is used well beyond
 *   the dashboards code — it is deliberately NOT banned and NOT scoped to
 *   the Drizzle Cube carve-out.
 *
 * Note: lint can prohibit non-shadcn UI; it cannot prove a rendered
 * component is shadcn. This preset enforces the prohibitions.
 *
 * Usage — spread into the consuming repo's own `eslint.config.mjs` (local
 * dev and CI then agree; the reusable workflow runs plain ESLint against
 * the repo's config, never a generated one):
 *
 *   import { uiDesignSystem } from "./tools/ui-design-system.flat.mjs";
 *   export default [
 *     // ...repo config...
 *     ...uiDesignSystem(),
 *   ];
 *
 * Options resolve as: explicit option > environment variable > default.
 * The reusable workflow (`.github/workflows/ui-design-system-gate.yml`)
 * forwards its typed inputs through the environment variables, so a caller
 * that sticks to `uiDesignSystem()` is configured from the workflow alone:
 *
 *   uiGlobs          UI_DESIGN_SYSTEM_UI_GLOBS            (comma-separated)
 *   drizzleCubeGlobs UI_DESIGN_SYSTEM_DRIZZLE_CUBE_GLOBS  (comma-separated)
 *   strictness       UI_DESIGN_SYSTEM_STRICTNESS          (warn | error)
 *
 * Flat-config semantics this preset relies on: ESLint does NOT merge rule
 * options across matching config objects — the LAST matching object wins
 * for a given file. Carve-outs therefore re-state the full pattern set
 * minus what they re-allow. A file matching both carve-outs (e.g. a
 * `components/ui/` dir nested inside the Drizzle Cube directory) gets the
 * ui carve-out (declared last): Radix allowed, Drizzle Cube client banned.
 */

export const DEFAULT_UI_GLOBS = ["**/components/ui/**", "**/src/ui/**"];

export const DEFAULT_DRIZZLE_CUBE_GLOBS = [
  "**/packages/dashboards/src/components/**",
];

export const DEFAULT_STRICTNESS = "warn";

const FIXTURE_IGNORES = ["**/__tests__/fixtures/**"];

const SOURCE_FILES = ["**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}"];

const JSX_FILES = ["**/*.{jsx,tsx}"];

// Non-JSX source files. ESLint flat config does NOT merge a rule's options
// across matching configs (last match wins), and `no-restricted-syntax`
// carries a single severity for all its selectors. The raw-JSX block (Block B,
// severity = `strictness`, default `warn`) and the dynamic-loader block
// (Block C, always `error`) both use `no-restricted-syntax`, so they cannot
// co-exist on the same file at different severities. They are therefore kept
// on DISJOINT file sets: Block C owns `no-restricted-syntax` on non-JSX
// sources (always `error`); on JSX sources the raw-JSX block carries BOTH the
// raw-JSX selectors and the dynamic-loader selectors at the configured
// `strictness` (so a dynamic import of a banned lib in a .tsx warns alongside
// raw-JSX until the repo ramps to `error`, then both become errors together).
const NON_JSX_SOURCE_FILES = ["**/*.{js,cjs,mjs,ts,cts,mts}"];

const NON_JSX_EXT = "**/*.{js,cjs,mjs,ts,cts,mts}";
const JSX_EXT = "**/*.{jsx,tsx}";

// AND a path-zone glob with an extension glob. ESLint flat config treats a
// nested array inside `files` as a logical AND (every pattern must match), so
// `[[zoneGlob, extGlob]]` matches files in the zone with that extension only —
// keeping the non-JSX (Block C, always `error`) and JSX (combined Block B+C,
// `strictness`) `no-restricted-syntax` layers on disjoint file sets.
const andNonJsx = (globs) => globs.map((glob) => [glob, NON_JSX_EXT]);
const andJsx = (globs) => globs.map((glob) => [glob, JSX_EXT]);

// ───── Block A pattern groups ─────

export const RADIX_BAN = [
  {
    group: ["@radix-ui/*", "radix-ui", "radix-ui/*"],
    message:
      "Radix belongs inside the vendored shadcn primitives (components/ui or src/ui) — import the shadcn wrapper instead.",
  },
];

export const UI_LIB_BAN = [
  {
    group: [
      "@mui/*",
      "@material-ui/*",
      "@chakra-ui/*",
      "antd",
      "antd/*",
      "@ant-design/*",
      "@mantine/*",
      "@emotion/*",
      "styled-components",
      "styled-components/*",
      "@headlessui/*",
    ],
    message:
      "shadcn/ui is the design system — non-shadcn UI libraries are banned everywhere.",
  },
];

export const DRIZZLE_CLIENT_BAN = [
  {
    regex: "^drizzle-cube/client(/|$)",
    message:
      "drizzle-cube/client is allowed ONLY inside the Drizzle Cube dashboard-components directory.",
  },
];

export const GRID_LAYOUT_BAN = [
  {
    group: ["react-grid-layout", "react-grid-layout/*"],
    message:
      "react-grid-layout is allowed ONLY inside the Drizzle Cube dashboard-components directory.",
  },
];

// ───── Block B selectors ─────

export const RAW_JSX_RESTRICTIONS = [
  ["button", "<Button> (components/ui/button)"],
  ["input", "<Input> (components/ui/input)"],
  ["select", "<Select> (components/ui/select)"],
  ["textarea", "<Textarea> (components/ui/textarea)"],
  ["a", "the shadcn link pattern (e.g. <Button asChild><Link/></Button>)"],
].map(([element, replacement]) => ({
  selector: `JSXOpeningElement[name.name='${element}']`,
  message: `Raw <${element}> — use the shadcn wrapper ${replacement} instead.`,
}));

// ───── Block C: dynamic-loader coverage (derived from Block A groups) ─────
//
// `no-restricted-imports` matches only static `import ... from "x"`. It does
// not see `await import("x")` (ImportExpression) or `require("x")`. Block C
// re-bans the SAME module groups on those two dynamic forms using
// `no-restricted-syntax` AST selectors, so a dynamic loader cannot evade the
// design-system ban. Selectors are GENERATED from the Block A pattern groups
// below — there is no second source of truth to drift.

const SELECTOR_SEP = "\\u002F"; // a literal "/" inside an ESLint selector regex

// Escape a literal module name for use inside an ESLint selector regex,
// emitting "/" as the / escape (a bare "/" closes the regex literal in a
// selector). Module specifiers are plain package names, but `@scope`, `.` and
// `-` are still regex metacharacters worth escaping defensively.
function escapeModuleForSelector(name) {
  return name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\//g, SELECTOR_SEP);
}

// Turn one Block-A glob into a selector-regex alternative with the SAME match
// surface `no-restricted-imports` gives it, so the dynamic ban neither over-
// nor under-matches the static one:
//   - `@mui/*`           → `^@mui/.*$`        (a subpath is REQUIRED;
//                          bare `@mui` is not a static-banned specifier)
//   - `radix-ui`         → `^radix-ui$`            (exactly the bare name)
//   - `react-grid-layout`→ `^react-grid-layout$`   (bare name only)
// A group that lists both the bare name and `name/*` (e.g. `radix-ui` +
// `radix-ui/*`) yields two alternatives that together cover name-or-subpath.
function patternEntryToRegexAlternatives(entry) {
  if (entry.regex) {
    // The one `regex` entry (`^drizzle-cube/client(/|$)`) is authored against
    // import specifiers already; re-emit it with "/" escaped for selectors.
    return [entry.regex.replace(/\//g, SELECTOR_SEP)];
  }
  return entry.group.map((glob) => {
    if (glob.endsWith("/*")) {
      const base = escapeModuleForSelector(glob.slice(0, -2));
      return `^${base}${SELECTOR_SEP}.*$`; // subpath required
    }
    if (glob.endsWith("*")) {
      const base = escapeModuleForSelector(glob.slice(0, -1));
      return `^${base}.*$`; // prefix match (no bare `*` globs ship today)
    }
    return `^${escapeModuleForSelector(glob)}$`; // exact bare name
  });
}

// Build the `no-restricted-syntax` restriction objects (ImportExpression +
// require() CallExpression) for a set of Block-A pattern groups, reusing each
// group's own `message`.
function dynamicBansFor(...patternGroups) {
  const restrictions = [];
  for (const entry of patternGroups.flat()) {
    // De-dupe: a group like `["radix-ui", "radix-ui/*"]` collapses to one
    // subpath-matching alternative, so the generated regex stays minimal.
    const alternatives = [...new Set(patternEntryToRegexAlternatives(entry))];
    const regex = alternatives.join("|");
    restrictions.push(
      {
        selector: `ImportExpression[source.value=/${regex}/]`,
        message: `Dynamic import() of a banned module — ${entry.message}`,
      },
      {
        selector: `CallExpression[callee.name='require'][arguments.0.value=/${regex}/]`,
        message: `require() of a banned module — ${entry.message}`,
      },
    );
  }
  return restrictions;
}

// Everywhere (mirrors Block A's "ui-design-system/imports").
export const DYNAMIC_IMPORT_BANS = dynamicBansFor(
  RADIX_BAN,
  UI_LIB_BAN,
  DRIZZLE_CLIENT_BAN,
  GRID_LAYOUT_BAN,
);

// Drizzle Cube carve-out (mirrors "imports-drizzle-cube-carve-out"):
// re-allow the Drizzle Cube surface, keep Radix + UI-lib bans.
export const DYNAMIC_IMPORT_BANS_DRIZZLE_CUBE = dynamicBansFor(
  RADIX_BAN,
  UI_LIB_BAN,
);

// shadcn-primitives carve-out (mirrors "imports-ui-carve-out"): re-allow
// Radix, keep everything else.
export const DYNAMIC_IMPORT_BANS_UI = dynamicBansFor(
  UI_LIB_BAN,
  DRIZZLE_CLIENT_BAN,
  GRID_LAYOUT_BAN,
);

// ───── Option resolution ─────

function toGlobArray(value, optionName) {
  const globs = (
    Array.isArray(value) ? value : String(value).split(",")
  )
    .map((glob) => String(glob).trim())
    .filter(Boolean);
  if (globs.length === 0) {
    throw new Error(`ui-design-system: ${optionName} must contain at least one glob`);
  }
  return globs;
}

function resolveStrictness(value) {
  if (value !== "warn" && value !== "error") {
    throw new Error(
      `ui-design-system: strictness must be "warn" or "error", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Build the preset's config objects. Spread the result into the consuming
 * repo's flat config (see module docblock for option/env precedence).
 *
 * @param {object} [options]
 * @param {string|string[]} [options.uiGlobs] shadcn primitive dirs.
 * @param {string|string[]} [options.drizzleCubeGlobs] Drizzle Cube dashboard-components dirs.
 * @param {"warn"|"error"} [options.strictness] severity of the raw-JSX block.
 * @returns {import("eslint").Linter.Config[]}
 */
export function uiDesignSystem(options = {}) {
  const uiGlobs = toGlobArray(
    options.uiGlobs ?? process.env.UI_DESIGN_SYSTEM_UI_GLOBS ?? DEFAULT_UI_GLOBS,
    "uiGlobs",
  );
  const drizzleCubeGlobs = toGlobArray(
    options.drizzleCubeGlobs ??
      process.env.UI_DESIGN_SYSTEM_DRIZZLE_CUBE_GLOBS ??
      DEFAULT_DRIZZLE_CUBE_GLOBS,
    "drizzleCubeGlobs",
  );
  const strictness = resolveStrictness(
    options.strictness ??
      process.env.UI_DESIGN_SYSTEM_STRICTNESS ??
      DEFAULT_STRICTNESS,
  );

  return [
    // Block A — everywhere: no Radix, no competing UI libraries, no Drizzle
    // Cube client surface.
    {
      name: "ui-design-system/imports",
      files: SOURCE_FILES,
      ignores: FIXTURE_IGNORES,
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              ...RADIX_BAN,
              ...UI_LIB_BAN,
              ...DRIZZLE_CLIENT_BAN,
              ...GRID_LAYOUT_BAN,
            ],
          },
        ],
      },
    },
    // Drizzle Cube carve-out — re-allow drizzle-cube/client* and
    // react-grid-layout ONLY; Radix and the UI-library bans still apply.
    // (Mirrors the proven boundary: exempt by path, re-allow by import.)
    {
      name: "ui-design-system/imports-drizzle-cube-carve-out",
      files: drizzleCubeGlobs,
      ignores: FIXTURE_IGNORES,
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [...RADIX_BAN, ...UI_LIB_BAN] },
        ],
      },
    },
    // shadcn-primitives carve-out — re-allow Radix ONLY; everything else
    // stays banned. Declared last so a ui/ dir nested inside the Drizzle
    // Cube directory is treated as shadcn primitives.
    {
      name: "ui-design-system/imports-ui-carve-out",
      files: uiGlobs,
      ignores: FIXTURE_IGNORES,
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              ...UI_LIB_BAN,
              ...DRIZZLE_CLIENT_BAN,
              ...GRID_LAYOUT_BAN,
            ],
          },
        ],
      },
    },
    // ─── Block C: dynamic-loader bans on NON-JSX sources (always `error`) ───
    // Mirrors Block A's three import layers (everywhere → Drizzle Cube
    // carve-out → ui carve-out, last match wins) for `import()`/`require()`.
    // Scoped to non-JSX extensions so it never collides with the JSX block
    // below on a single `no-restricted-syntax` severity.
    {
      name: "ui-design-system/dynamic-imports",
      files: NON_JSX_SOURCE_FILES,
      ignores: FIXTURE_IGNORES,
      rules: {
        "no-restricted-syntax": ["error", ...DYNAMIC_IMPORT_BANS],
      },
    },
    {
      name: "ui-design-system/dynamic-imports-drizzle-cube-carve-out",
      files: andNonJsx(drizzleCubeGlobs),
      ignores: FIXTURE_IGNORES,
      rules: {
        "no-restricted-syntax": ["error", ...DYNAMIC_IMPORT_BANS_DRIZZLE_CUBE],
      },
    },
    {
      name: "ui-design-system/dynamic-imports-ui-carve-out",
      files: andNonJsx(uiGlobs),
      ignores: FIXTURE_IGNORES,
      rules: {
        "no-restricted-syntax": ["error", ...DYNAMIC_IMPORT_BANS_UI],
      },
    },
    // Block B + Block C on JSX sources. The raw-JSX block (Block B) and the
    // dynamic-loader block (Block C) share `no-restricted-syntax`, so on JSX
    // files they are combined into one rule at the configured `strictness`.
    // Layered everywhere → Drizzle Cube carve-out → ui carve-out (last match
    // wins). The non-JSX ui carve-out above does NOT cover .tsx, so the ui
    // carve-out for JSX is restated here (Radix dynamic loads re-allowed, the
    // rest still banned). raw-JSX selectors are omitted inside uiGlobs (the
    // shadcn primitives render the raw elements themselves).
    {
      name: "ui-design-system/raw-jsx",
      files: JSX_FILES,
      ignores: [...uiGlobs, ...FIXTURE_IGNORES],
      rules: {
        "no-restricted-syntax": [
          strictness,
          ...RAW_JSX_RESTRICTIONS,
          ...DYNAMIC_IMPORT_BANS,
        ],
      },
    },
    {
      name: "ui-design-system/raw-jsx-drizzle-cube-carve-out",
      files: andJsx(drizzleCubeGlobs),
      ignores: [...uiGlobs, ...FIXTURE_IGNORES],
      rules: {
        "no-restricted-syntax": [
          strictness,
          ...RAW_JSX_RESTRICTIONS,
          ...DYNAMIC_IMPORT_BANS_DRIZZLE_CUBE,
        ],
      },
    },
    // ui carve-out on JSX sources: dynamic-loader bans only (no raw-JSX, since
    // uiGlobs are exempt). Declared last so a ui/ dir wins over the everywhere
    // and Drizzle Cube JSX layers. Severity tracks `strictness` to stay on one
    // value with the other JSX `no-restricted-syntax` rules; Radix is the only
    // dynamic load re-allowed here.
    {
      name: "ui-design-system/dynamic-imports-ui-carve-out-jsx",
      files: andJsx(uiGlobs),
      ignores: FIXTURE_IGNORES,
      rules: {
        "no-restricted-syntax": [strictness, ...DYNAMIC_IMPORT_BANS_UI],
      },
    },
  ];
}

export default uiDesignSystem;
