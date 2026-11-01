import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "test-results",
      ".yolo-sweep",
      "playwright-report",
      "test/fixtures/vendor",
      "public/latex/swiftlatexpdftex.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: "readonly" } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Playwright fixtures must destructure their dependencies, even when there are none.
    files: ["test/e2e/**/*.ts"],
    rules: { "no-empty-pattern": "off" },
  },
  {
    files: ["test/fixtures/**/*.js"],
    languageOptions: { globals: { React: "readonly", ReactDOM: "readonly" } },
  },
);
