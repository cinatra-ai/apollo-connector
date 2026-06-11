// ESLint config for this extracted-extension source mirror. Its only lint
// surface is the org ui-design-system gate ("UI work uses shadcn" —
// cinatra-ai/cinatra-engineering#62): tools/ui-design-system.flat.mjs is a
// byte-identical vendored copy of
// cinatra-ai/ci/config/ui-design-system.flat.mjs
// @ ee01071f703412c4aa6e6b2fb16b089cb8bbeac0 (the same ci commit the thin
// caller workflow pins), spread here exactly per its caller contract
// (TS/JSX-capable parser + spread the preset).
//
// Exemptions are flat-config files-glob carve-outs inside the preset
// (components/ui — the vendored shadcn primitives). Never use inline
// eslint-disable for these rules: CI runs with --no-inline-config.
import tsParser from "@typescript-eslint/parser";

import { uiDesignSystem } from "./tools/ui-design-system.flat.mjs";

export default [
  // Parser coverage matches the preset's lint surface
  // (js,jsx,cjs,mjs,ts,tsx,cts,mts): the TS parser for TypeScript files,
  // JSX enabled only where JSX is legal (espree handles plain JS/ESM).
  {
    files: ["**/*.{ts,mts,cts}"],
    languageOptions: { parser: tsParser },
  },
  {
    files: ["**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  ...uiDesignSystem(),
];
