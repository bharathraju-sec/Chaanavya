// Product photo storage (Stage 08, decision 034): one S3-compatible bucket (AWS S3, Cloudflare R2 or
// any service speaking the S3 API) with two areas:
//
//   staging/<productId>/<uploadId>   private: uploads waiting for review. Only the API reads them,
//                                    and staff see them through short-lived signed links.
//   public/products/<productId>/...  approved photos, readable by anyone (bucket policy or CDN on
//                                    this prefix only), served from MEDIA_PUBLIC_BASE_URL.
//
// Browsers upload straight to the bucket with a signed PUT that fixes the content type, the exact
// length and the SHA-256 (S3 refuses any other bytes), so files never pass through the web host.
// Locally the compose `media` service (S3Mock) stands in for the bucket.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { readEnv, resolveEnvironment } from "@chaanavya/shared/config/env"
import { DEVELOPMENT_MEDIA } from "@chaanavya/shared/media"

type Env = Readonly<Record<string, string | undefined>>

export type StoredObject = { byteSize: number; contentType: string | null; checksumSha256: string | null }
export type SignedUpload = { url: string; method: "PUT"; headers: Record<string, string> }

export interface MediaStorage {
  /** A PUT URL that accepts exactly this content type, length and SHA-256 until it expires. */
  signUpload(key: string, file: { contentType: string; byteSize: number; checksumSha256: string }, expiresInSeconds: number): Promise<SignedUpload>
  head(key: string): Promise<StoredObject | null>
  /** The whole object, refusing anything larger than maxBytes. */
  read(key: string, maxBytes: number): Promise<Buffer>
  /** Copies a staged object to its public key, cacheable for a year (keys never change content). */
  publish(fromKey: string, toKey: string, contentType: string): Promise<void>
  remove(key: string): Promise<void>
  /** A short-lived GET link for staff to preview a private object. */
  signRead(key: string, expiresInSeconds: number): Promise<string>
  publicUrl(key: string): string
}

export function mediaConfig(env: Env = process.env) {
  const development = resolveEnvironment(env) === "development"
  const fallback = <T extends string>(value: string | undefined, local: T) => value || (development ? local : undefined)
  const bucket = fallback(readEnv(env, "MEDIA_S3_BUCKET"), DEVELOPMENT_MEDIA.bucket)
  const endpoint = readEnv(env, "MEDIA_S3_ENDPOINT") || (development && !readEnv(env, "MEDIA_S3_BUCKET") ? DEVELOPMENT_MEDIA.endpoint : undefined)
  const publicBaseUrl = fallback(readEnv(env, "MEDIA_PUBLIC_BASE_URL"), DEVELOPMENT_MEDIA.publicBaseUrl)
  const accessKeyId = fallback(readEnv(env, "MEDIA_S3_ACCESS_KEY_ID"), "development")
  const secretAccessKey = fallback(readEnv(env, "MEDIA_S3_SECRET_ACCESS_KEY"), "development")
  if (!bucket || !publicBaseUrl || !accessKeyId || !secretAccessKey) throw new Error("MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY and MEDIA_PUBLIC_BASE_URL must be set outside development")
  return { bucket, endpoint, publicBaseUrl, region: readEnv(env, "MEDIA_S3_REGION") || "ap-south-1", accessKeyId, secretAccessKey }
}

export function createS3Storage(env: Env = process.env): MediaStorage {
  const config = mediaConfig(env)
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint && { endpoint: config.endpoint, forcePathStyle: true }),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Checksums are set explicitly where they matter (uploads); no automatic CRC32 headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  const Bucket = config.bucket

  return {
    async signUpload(key, file, expiresIn) {
      const command = new PutObjectCommand({ Bucket, Key: key, ContentType: file.contentType, ContentLength: file.byteSize, ChecksumSHA256: file.checksumSha256 })
      // Content type, length and checksum are signed headers: the browser must send exactly these.
      const url = await getSignedUrl(client, command, {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length", "x-amz-checksum-sha256"]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      })
      return { url, method: "PUT", headers: { "content-type": file.contentType, "x-amz-checksum-sha256": file.checksumSha256 } }
    },
    async head(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket, Key: key, ChecksumMode: "ENABLED" }))
        return { byteSize: head.ContentLength ?? 0, contentType: head.ContentType ?? null, checksumSha256: head.ChecksumSHA256 ?? null }
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
        throw error
      }
    },
    async read(key, maxBytes) {
      const object = await client.send(new GetObjectCommand({ Bucket, Key: key }))
      if ((object.ContentLength ?? 0) > maxBytes) throw new Error("object larger than allowed")
      const bytes = Buffer.from(await object.Body!.transformToByteArray())
      if (bytes.length > maxBytes) throw new Error("object larger than allowed")
      return bytes
    },
    async publish(fromKey, toKey, contentType) {
      await client.send(
        new CopyObjectCommand({ Bucket, Key: toKey, CopySource: `${Bucket}/${fromKey}`, MetadataDirective: "REPLACE", ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }),
      )
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
    },
    signRead(key, expiresIn) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn })
    },
    publicUrl(key) {
      return `${config.publicBaseUrl}${key}`
    },
  }
}

let shared: MediaStorage | undefined
/** One storage client per process, from the environment. */
export const mediaStorage = () => (shared ??= createS3Storage())

export const stagingKey = (productId: string, uploadId: string) => `staging/${productId}/${uploadId}`
export const publicKey = (productId: string, mediaId: string, extension: string) => `public/products/${productId}/${mediaId}.${extension}`
