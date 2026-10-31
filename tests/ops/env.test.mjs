// CHV-S03-002: the configuration check refuses a missing required server secret for the targeted
// environment, and keeps test and live credentials apart. All values are fake.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { checkEnv, isSecretName, resolveEnvironment } from "../../packages/shared/src/config/env.ts"

const names = report => report.errors.map(e => e.name)
const APPROVED_GATE = { merchantKyc: true, banking: true, tax: true, approvedBy: "Owner (test fixture)", approvedOn: "2026-10-31" }

const minimalProduction = {
  DATABASE_URL: "postgresql://app:fake-password@primary.db.example.net:5432/chaanavya",
  BETTER_AUTH_SECRET: "fake-auth-secret-0000000000000000000002",
  BETTER_AUTH_URL: "https://shop.example.net",
  ADMIN_URL: "https://admin.shop.example.net",
  API_URL: "https://api.shop.example.net",
  API_INTERNAL_KEY: "fake-internal-key-000000000000000000000001",
  MEDIA_S3_BUCKET: "chaanavya-media",
  MEDIA_S3_ACCESS_KEY_ID: "fake-media-key-id",
  MEDIA_S3_SECRET_ACCESS_KEY: "fake-media-secret-0001",
  MEDIA_PUBLIC_BASE_URL: "https://media.shop.example.net/",
  MEDIA_UPLOAD_ORIGIN: "https://chaanavya-media.s3.ap-south-1.amazonaws.com",
}

const commerceStaging = {
  DATABASE_URL: "postgresql://app:fake-password@staging-db.example.net:5432/chaanavya_staging",
  PAYMENT_MODE: "test",
  RAZORPAY_KEY_ID: "rzp_test_FAKE0000000001",
  RAZORPAY_KEY_SECRET: "fake-key-secret-0001",
  RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-0001",
  BETTER_AUTH_SECRET: "fake-auth-secret-0000000000000000000001",
  BETTER_AUTH_URL: "https://staging.example.net",
  API_URL: "https://api.staging.example.net",
  API_INTERNAL_KEY: "fake-internal-key-000000000000000000000002",
  MEDIA_S3_BUCKET: "chaanavya-media-staging",
  MEDIA_S3_ACCESS_KEY_ID: "fake-media-key-id-staging",
  MEDIA_S3_SECRET_ACCESS_KEY: "fake-media-secret-0002",
  MEDIA_PUBLIC_BASE_URL: "https://media.staging.example.net/",
  MEDIA_UPLOAD_ORIGIN: "https://chaanavya-media-staging.s3.ap-south-1.amazonaws.com",
}

const commerceProduction = {
  ...commerceStaging,
  DATABASE_URL: "postgresql://app:fake-password@primary.db.example.net:5432/chaanavya",
  PAYMENT_MODE: "live",
  RAZORPAY_KEY_ID: "rzp_live_FAKE0000000001",
  BETTER_AUTH_URL: "https://shop.example.net",
  ADMIN_URL: "https://admin.shop.example.net",
}

describe("CHV-S03-002 required secrets per target", () => {
  test("development needs nothing: the placeholder catalogue runs with an empty environment", () => {
    assert.equal(checkEnv({}, { target: "development" }).ok, true)
  })

  test("production refuses each missing required setting (database, auth, URLs, API key, photo storage)", () => {
    assert.equal(checkEnv(minimalProduction, { target: "production" }).ok, true)
    for (const name of Object.keys(minimalProduction)) {
      const report = checkEnv({ ...minimalProduction, [name]: "" }, { target: "production" })
      assert.deepEqual(names(report), [name], name)
    }
  })

  test("staging refuses each missing server secret, and payment secrets once a key is set", () => {
    assert.equal(checkEnv(commerceStaging, { target: "staging" }).ok, true)
    for (const secret of ["DATABASE_URL", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "BETTER_AUTH_SECRET"]) {
      const report = checkEnv({ ...commerceStaging, [secret]: "" }, { target: "staging" })
      assert.equal(report.ok, false, secret)
      assert.ok(names(report).includes(secret), secret)
    }
  })

  test("the CLI exits 1 on a missing secret and prints no values", () => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, BETTER_AUTH_URL: "https://shop.example.net", ANTHROPIC_API_KEY: "fake-anthropic-key-should-not-print" }
    const run = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/check-env.mjs", "--target", "production"], { env, encoding: "utf8" })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /ERROR DATABASE_URL: required in production/)
    assert.ok(!`${run.stdout}${run.stderr}`.includes("fake-anthropic-key-should-not-print"))
    assert.ok(!`${run.stdout}${run.stderr}`.includes("shop.example.net"))
  })
})

describe("Stage 07 service scopes", () => {
  test("each service is checked only for its own settings", () => {
    const api = checkEnv(minimalProduction, { target: "production", service: "api" }).settings.map(s => s.name)
    const web = checkEnv({ ...minimalProduction, DATABASE_URL: "", BETTER_AUTH_SECRET: "", MEDIA_S3_ACCESS_KEY_ID: "", MEDIA_S3_SECRET_ACCESS_KEY: "" }, { target: "production", service: "web" })
    assert.ok(api.includes("DATABASE_URL") && !api.includes("API_URL"))
    assert.ok(web.settings.some(s => s.name === "API_URL") && !web.settings.some(s => s.name === "DATABASE_URL"))
    assert.deepEqual(web.errors, [])
  })

  test("the web host refuses database and sign-in secrets outside development", () => {
    const web = checkEnv(minimalProduction, { target: "production", service: "web" })
    for (const name of ["DATABASE_URL", "BETTER_AUTH_SECRET", "MEDIA_S3_SECRET_ACCESS_KEY"]) assert.ok(names(web).includes(name), name)
    assert.equal(checkEnv(minimalProduction, { target: "development", service: "web" }).errors.some(e => e.name === "DATABASE_URL"), false)
  })

  test("photo storage addresses: https in production, the public base ends in /, the upload origin is an origin only", () => {
    assert.ok(names(checkEnv({ ...minimalProduction, MEDIA_PUBLIC_BASE_URL: "http://media.shop.example.net/" }, { target: "production" })).includes("MEDIA_PUBLIC_BASE_URL"))
    assert.ok(names(checkEnv({ ...minimalProduction, MEDIA_PUBLIC_BASE_URL: "https://media.shop.example.net" }, { target: "production" })).includes("MEDIA_PUBLIC_BASE_URL"))
    assert.ok(names(checkEnv({ ...minimalProduction, MEDIA_UPLOAD_ORIGIN: "https://bucket.example.net/path" }, { target: "production" })).includes("MEDIA_UPLOAD_ORIGIN"))
    assert.ok(!checkEnv(minimalProduction, { target: "production", service: "web" }).settings.some(s => s.name === "MEDIA_S3_SECRET_ACCESS_KEY"), "the web host never needs storage credentials")
  })

  test("the API address must be https in production and the internal key long and random", () => {
    assert.ok(names(checkEnv({ ...minimalProduction, API_URL: "http://api.shop.example.net" }, { target: "production" })).includes("API_URL"))
    assert.ok(names(checkEnv({ ...minimalProduction, API_INTERNAL_KEY: "short" }, { target: "production" })).includes("API_INTERNAL_KEY"))
  })
})

describe("test and live separation", () => {
  test("live payment keys are refused outside production", () => {
    const report = checkEnv({ ...commerceStaging, RAZORPAY_KEY_ID: "rzp_live_FAKE0000000001" }, { target: "staging" })
    assert.ok(names(report).includes("RAZORPAY_KEY_ID"))
    assert.equal(checkEnv({ ...commerceStaging, PAYMENT_MODE: "live" }, { target: "staging" }).ok, false)
  })

  test("test payment keys are refused in production", () => {
    // Live keys pass only once the legal gate is approved (Stage 14.02); here, a recorded approval for the fixture.
    assert.equal(checkEnv(commerceProduction, { target: "production", liveGate: APPROVED_GATE }).ok, true)
    assert.deepEqual(names(checkEnv(commerceProduction, { target: "production" })).sort(), ["PAYMENT_MODE", "RAZORPAY_KEY_ID"], "refused while the gate is closed")
    const report = checkEnv({ ...commerceProduction, RAZORPAY_KEY_ID: "rzp_test_FAKE0000000001" }, { target: "production" })
    assert.ok(names(report).includes("RAZORPAY_KEY_ID"))
    assert.equal(checkEnv({ ...commerceProduction, PAYMENT_MODE: "test" }, { target: "production" }).ok, false)
  })

  test("a test credential hidden in any other setting is still refused in production", () => {
    const report = checkEnv({ ...minimalProduction, SOME_OTHER_SETTING: "prefix-rzp_test_FAKE00000001" }, { target: "production" })
    assert.ok(names(report).includes("SOME_OTHER_SETTING"))
  })

  test("development and staging cannot point at a production-looking database; production cannot use a local one", () => {
    assert.equal(checkEnv({ ...commerceStaging, DATABASE_URL: "postgresql://app:x@prod-db.example.net/chaanavya" }, { target: "staging" }).ok, false)
    assert.equal(checkEnv({ ...commerceProduction, DATABASE_URL: "postgresql://chaanavya:x@127.0.0.1:15432/chaanavya_dev" }, { target: "production" }).ok, false)
  })

  test("APP_ENV=production is refused on a Vercel preview deployment", () => {
    assert.equal(checkEnv({ ...minimalProduction, APP_ENV: "production", VERCEL_ENV: "preview" }).ok, false)
  })
})

describe("secrets never reach the browser", () => {
  test("secret-looking NEXT_PUBLIC_ settings are refused", () => {
    for (const name of ["NEXT_PUBLIC_RAZORPAY_KEY_SECRET", "NEXT_PUBLIC_ADMIN_TOKEN", "NEXT_PUBLIC_DATABASE_URL", "NEXT_PUBLIC_ANTHROPIC_API_KEY"]) {
      assert.ok(names(checkEnv({ [name]: "anything" }, { target: "development" })).includes(name), name)
    }
    assert.equal(checkEnv({ NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-ABCDE12345" }, { target: "development" }).ok, true)
  })

  test("a public setting may not carry a server secret's value", () => {
    const report = checkEnv({ ...commerceStaging, NEXT_PUBLIC_RAZORPAY_KEY_ID: "fake-key-secret-0001" }, { target: "staging" })
    assert.ok(names(report).includes("NEXT_PUBLIC_RAZORPAY_KEY_ID"))
  })

  test("reports contain names and statuses, never values", () => {
    // Config words such as "live" legitimately appear as mode names; credentials must never appear.
    const broken = { ...commerceProduction, RAZORPAY_KEY_ID: "rzp_test_FAKE0000000009" }
    for (const report of [checkEnv(commerceProduction, { target: "production" }), checkEnv(broken, { target: "production" })]) {
      const serialized = JSON.stringify(report)
      for (const name of ["DATABASE_URL", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "BETTER_AUTH_SECRET"]) {
        assert.ok(!serialized.includes(broken[name]) && !serialized.includes(commerceProduction[name]), `${name} value leaked into report`)
      }
    }
  })
})

describe("environment resolution and secret classification", () => {
  test("VERCEL_ENV maps preview to staging", () => {
    assert.equal(resolveEnvironment({ VERCEL_ENV: "production" }), "production")
    assert.equal(resolveEnvironment({ VERCEL_ENV: "preview" }), "staging")
    assert.equal(resolveEnvironment({}), "development")
    assert.equal(resolveEnvironment({ APP_ENV: "staging", VERCEL_ENV: "production" }), "staging")
  })

  test("secret names", () => {
    for (const name of ["BETTER_AUTH_SECRET", "DATABASE_URL", "RAZORPAY_KEY_SECRET", "VERCEL_OIDC_TOKEN", "SOME_SERVICE_API_KEY"]) assert.equal(isSecretName(name), true, name)
    for (const name of ["BETTER_AUTH_URL", "ADMIN_URL", "RAZORPAY_KEY_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "LOG_LEVEL"]) assert.equal(isSecretName(name), false, name)
  })
})

describe("sign-in settings (Stage 05)", () => {
  test("the auth secret must be long and the production URL must use https", () => {
    assert.ok(names(checkEnv({ ...commerceStaging, BETTER_AUTH_SECRET: "too-short" }, { target: "staging" })).includes("BETTER_AUTH_SECRET"))
    assert.ok(names(checkEnv({ ...commerceProduction, BETTER_AUTH_URL: "http://chaanavya.example" }, { target: "production" })).includes("BETTER_AUTH_URL"))
    assert.ok(names(checkEnv({ ...commerceStaging, BETTER_AUTH_URL: "" }, { target: "staging" })).includes("BETTER_AUTH_URL"))
    assert.equal(checkEnv({ DATABASE_URL: "postgresql://a:b@127.0.0.1:15432/chaanavya_dev", PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000001", RAZORPAY_KEY_SECRET: "fake-key-secret-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-0001", BETTER_AUTH_SECRET: "fake-auth-secret-0000000000000000000001" }, { target: "development" }).ok, true, "the URL may default locally")
  })

  test("the admin URL must be https in production and on its own host", () => {
    assert.ok(names(checkEnv({ ...minimalProduction, ADMIN_URL: "http://admin.shop.example.net" }, { target: "production" })).includes("ADMIN_URL"))
    assert.ok(names(checkEnv({ ...minimalProduction, ADMIN_URL: "https://shop.example.net" }, { target: "production" })).includes("ADMIN_URL"))
    assert.ok(names(checkEnv({ ...minimalProduction, ADMIN_URL: "https://admin.shop.example.net/admin" }, { target: "production" })).includes("ADMIN_URL"))
  })
})
