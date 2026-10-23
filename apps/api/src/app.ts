// Builds the API application (Stage 07). Used by main.ts, by the tests (which run it in-process on a
// random port) and by the OpenAPI generator.
//
// Request pipeline, in order:
//   requestContext       correlation ID, forwarded host and client IP, security headers
//   internalCallerOnly   API_INTERNAL_KEY required (except /health and /ready)
//   betterAuthRoutes     /api/auth/* handled by Better Auth
//   readBody             raw body for the API's own routes
//   Nest                 throttle guard, access guard, controller, exception filter
import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import type { NestExpressApplication } from "@nestjs/platform-express"
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger"
import { AppModule } from "./app.module.ts"
import { betterAuthRoutes } from "./auth/handler.ts"
import { readBody } from "./http/body.ts"
import { internalCallerOnly, requestContext } from "./http/internal-caller.ts"

export async function createApiApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: ["error", "warn"], abortOnError: false })
  const http = app.getHttpAdapter().getInstance()
  http.disable("x-powered-by")
  http.disable("etag")
  http.set("trust proxy", false)
  app.use(requestContext)
  app.use(internalCallerOnly)
  app.use(betterAuthRoutes)
  app.use(readBody)
  app.enableShutdownHooks()
  // No CORS headers: browsers never call the API directly (they go through the web host), so every
  // cross-origin browser read is refused by default. The origin allowlist is the shop and admin
  // hosts, enforced per request by the access guard (same-origin check) and by Better Auth.
  return app
}

export function openApiDocument(app: NestExpressApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Chaanavya API")
    .setDescription(
      "Called only by the Chaanavya web host (shop and admin), server to server, with the x-chaanavya-internal-key header. Sign-in endpoints are Better Auth's, under /api/auth, and are not listed here.",
    )
    .setVersion("1")
    .addApiKey({ type: "apiKey", in: "header", name: "x-chaanavya-internal-key" }, "internal-key")
    .addSecurityRequirements("internal-key")
    .build()
  return SwaggerModule.createDocument(app, config)
}
