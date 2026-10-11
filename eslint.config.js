/**
 * ESLint flat config: TypeScript, React, React hooks and Tailwind CSS v4. Run with `bun run lint`.
 *
 * typescript-eslint needs the TypeScript 6 compiler API (TS 7 ships no API yet and typescript-eslint
 * refuses to load it), so `typescript` in package.json is the official @typescript/typescript6
 * compatibility package, while TypeScript 7 is installed as @typescript/native and still provides
 * the `tsc` that `bun run typecheck` runs.
 */
import path from "node:path";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import betterTailwind from "eslint-plugin-better-tailwindcss";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const TS_FILES = ["src/**/*.{ts,tsx}", "*.ts", "scripts/**/*.ts"];

export default defineConfig([
  globalIgnores(["**/node_modules/", "dist/", ".dev-workspace/", "src/client/generated.css"]),

  {
    name: "mudd/javascript",
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
  },

  {
    name: "mudd/typescript",
    files: TS_FILES,
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      // Type information for the two promise rules below; files resolve to tsconfig.json.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // Includes async handlers passed to JSX attributes (onClick={async () => ...}), whose
      // rejections nothing awaits.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: true } }],
    },
  },

  {
    name: "mudd/react",
    files: ["src/**/*.{ts,tsx}"],
    extends: [react.configs.flat.recommended, react.configs.flat["jsx-runtime"]],
    plugins: { "react-hooks": reactHooks },
    // An explicit version: "detect" crashes eslint-plugin-react 7.37 under ESLint 10 (context.getFilename).
    settings: { react: { version: "18.3" } },
    rules: {
      // Missing keys (also on <>...</> in a list), and a key written twice among the element children
      // of one parent or one array literal. It misses repeats inside <>...</>, siblings behind
      // {cond && ...}, and different expressions with equal values; React warns about those at
      // runtime, and failOnConsoleError() in src/test/dom.ts turns that warning into a test failure.
      "react/jsx-key": ["error", { checkFragmentShorthand: true, warnOnDuplicates: true }],
      // Props are typed with TypeScript.
      "react/prop-types": "off",
      // Only the characters that mean a JSX typo; apostrophes and quotes in copy render fine.
      "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },

  {
    name: "mudd/tailwind",
    files: ["src/client/**/*.tsx"],
    plugins: { "better-tailwindcss": betterTailwind },
    settings: {
      // Also checks strings inside cn(...), which is one of the plugin's default callees.
      "better-tailwindcss": { entryPoint: path.join(import.meta.dirname, "src/client/styles.css") },
    },
    rules: {
      // The app's own classes from `@layer components` in styles.css are not Tailwind utilities.
      "better-tailwindcss/no-unknown-classes": ["error", { ignore: ["^(?:field|label|eyebrow|tag|card|scroll-thin|btn|btn-primary|btn-icon|note|pin)$"] }],
      "better-tailwindcss/no-conflicting-classes": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
      "better-tailwindcss/no-deprecated-classes": "error",
    },
  },
]);
