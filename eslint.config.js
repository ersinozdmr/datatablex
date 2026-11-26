import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintReact from "@eslint-react/eslint-plugin";
import reactHooksPlugin from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.turbo/**", "**/node_modules/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: [
      "packages/react/**/*.{ts,tsx}",
      "packages/antd/**/*.{ts,tsx}",
      "apps/example/src/client/**/*.{ts,tsx}",
    ],
    plugins: { "@eslint-react": eslintReact, "react-hooks": reactHooksPlugin },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      // The two rules of the hooks. The recommended set of eslint-plugin-react-hooks 7 also has the React Compiler
      // rules (refs, set-state-in-effect, ...); the code is not written for the compiler, so they are not enabled.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@eslint-react/no-missing-key": "error",
    },
  },
  {
    // Root maintenance scripts run in Node; the globals are listed here to avoid a `globals` dependency.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly", Buffer: "readonly" },
    },
  },
  eslintConfigPrettier,
);
