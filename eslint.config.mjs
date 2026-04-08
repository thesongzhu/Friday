import securityPlugin from "eslint-plugin-security";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security: securityPlugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // Sort imports: type imports after value imports
      "sort-imports": [
        "error",
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
          allowSeparatedGroups: true,
        },
      ],
      // Ban console.log in src/ (warn/error allowed). Warn-only to avoid blocking existing code.
      "no-console": ["warn", { "allow": ["warn", "error"] }],
      // Flag overly complex functions
      "complexity": ["warn", 25],
      // Keep functions reasonably sized
      "max-lines-per-function": ["warn", { "max": 200, "skipBlankLines": true, "skipComments": true }],
      // Discourage explicit any — warn first, escalate to error later.
      "@typescript-eslint/no-explicit-any": "warn",
      // Baseline security linting with low churn.
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "error",
      "security/detect-object-injection": "warn",
      "security/detect-non-literal-fs-filename": "warn",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "test/**"],
  },
];
