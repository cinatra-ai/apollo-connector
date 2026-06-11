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
 *
 *   Block B (`no-restricted-syntax`, severity = `strictness`, default `warn`)
 *     Flags raw `<button>`, `<input>`, `<select>`, `<textarea>` and `<a>`
 *     JSX in favor of the shadcn wrappers. The import ban is higher-signal;
 *     the raw-JSX ban is noisier, so it starts at `warn` and is ramped to
 *     `error` per repo once clean.
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
    // Block B — raw control JSX outside the shadcn primitives. The
    // primitives themselves render the raw elements, so uiGlobs are exempt.
    {
      name: "ui-design-system/raw-jsx",
      files: JSX_FILES,
      ignores: [...uiGlobs, ...FIXTURE_IGNORES],
      rules: {
        "no-restricted-syntax": [strictness, ...RAW_JSX_RESTRICTIONS],
      },
    },
  ];
}

export default uiDesignSystem;
