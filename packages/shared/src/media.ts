// Where product photos live, as the web host needs to know it (Stage 08): the origin public photos
// are served from (img-src on every page) and the origin of the bucket's signed upload and preview
// links (connect-src and img-src on admin pages only). Origins only; the web host never holds
// storage credentials.
import { readEnv, resolveEnvironment, type Env } from "./config/env.ts"

/** The local S3Mock from compose.yaml (development only). */
export const DEVELOPMENT_MEDIA = { endpoint: "http://127.0.0.1:9090", bucket: "chaanavya-media", publicBaseUrl: "http://127.0.0.1:9090/chaanavya-media/" } as const

const originOf = (value: string | undefined) => {
  try {
    return value ? new URL(value).origin : null
  } catch {
    return null
  }
}

export function mediaOrigins(env: Env) {
  const development = resolveEnvironment(env) === "development"
  return {
    public: originOf(readEnv(env, "MEDIA_PUBLIC_BASE_URL")) ?? (development ? originOf(DEVELOPMENT_MEDIA.publicBaseUrl) : null),
    upload: originOf(readEnv(env, "MEDIA_UPLOAD_ORIGIN")) ?? (development ? originOf(DEVELOPMENT_MEDIA.endpoint) : null),
  }
}
