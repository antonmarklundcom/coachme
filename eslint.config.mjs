import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The pre-Vercel Node scripts, kept as reference for the algorithms this
    // app ports (plan.md §5 O1). They are covered by their own tests, not by
    // the app's lint rules.
    "scripts/legacy/**",
  ]),
]);

export default eslintConfig;
