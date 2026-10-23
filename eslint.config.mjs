import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Provider ports and SDKs are server-side, called only by the commerce modules (Stage 02).
const providerImports = [
  { group: ["@/lib/integrations/*", "@/lib/integrations/**"], message: "UI must call commerce modules through server routes, not provider ports." },
  { group: ["razorpay", "razorpay/*", "phonepe*", "@phonepe*/*", "shiprocket*", "@shiprocket*/*"], message: "Provider SDKs are server-only; use lib/integrations through a commerce module." },
];

// Since Stage 07 the database, sessions and business rules live in apps/api; the web host reaches
// them only over HTTP through lib/api (decision 032).
const apiImports = [
  { group: ["@chaanavya/api", "@chaanavya/api/*", "**/apps/api/**", "@prisma/*", "better-auth", "better-auth/*"], message: "The web host calls the API over HTTP (lib/api); it never imports API code, Prisma or Better Auth server code." },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...providerImports,
            ...apiImports,
            { group: ["@/lib/catalogue/*", "@/lib/chat/*", "@/lib/auth/*", "@/lib/api/*"], message: "Server-only module: keep credentials out of client bundles." },
          ],
        },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "proxy.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [...providerImports, ...apiImports] }] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output and generated code.
    "apps/*/dist/**",
    "apps/api/src/db/generated/**",
    "packages/contracts/src/api/schema.ts",
    // Local upgrade workspace, linted from inside its own folder.
    "backup/**",
  ]),
]);

export default eslintConfig;
