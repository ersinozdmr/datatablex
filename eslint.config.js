import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import reactPlugin from "eslint-plugin-react";
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
    plugins: { react: reactPlugin, "react-hooks": reactHooksPlugin },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      "react/jsx-key": "error",
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
