import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } }
  },
  globalIgnores([".local/**", ".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts"])
]);
