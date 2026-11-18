// @ts-check
// Type-aware linting (typescript-eslint recommendedTypeChecked): catches floating promises
// and unsafe `any`, which matter in an asynchronous, queue-based app. Type information
// comes from the TypeScript 6 API (see the "//" note in package.json).

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", "coverage/", "eval/data/"] },
  {
    files: ["**/*.{js,ts}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `const { key: _omit, ...rest } = obj` is how we drop a key from an object.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
