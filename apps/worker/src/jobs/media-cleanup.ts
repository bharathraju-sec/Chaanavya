// Photo storage clean-up (Stage 08 deletion policy):
//   - upload intents that expired without being completed: their staging objects are deleted
//     (the browser may have uploaded a file and never asked for it to be checked);
//   - photos removed from a product more than 7 days ago: their public and staging files are deleted
//     and the row is marked as cleaned (storage keys cleared). The row stays for the audit trail.
// Deleting an object that does not exist is not an error, so a crash mid-run is simply repeated.
import type { Tx } from "@chaanavya/api/db/client"
import type { MediaStorage } from "@chaanavya/api/media/storage"
import type { Job } from "../runner.ts"

export const REMOVED_MEDIA_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const BATCH = 100

export function mediaCleanupJob(storage: () => MediaStorage): Job {
  return {
    name: "media-cleanup",
    lockKey: 7_003,
    everyMs: 60 * 60 * 1000,
    async run(tx: Tx) {
      const now = Date.now()
      const abandoned = await tx.mediaUpload.findMany({ where: { completedAt: null, expiresAt: { lt: new Date(now) } }, take: BATCH, select: { id: true, stagingKey: true } })
      for (const intent of abandoned) {
        await storage().remove(intent.stagingKey)
        await tx.mediaUpload.update({ where: { id: intent.id }, data: { completedAt: new Date() } })
      }
      const removed = await tx.productMedia.findMany({
        where: { removedAt: { lt: new Date(now - REMOVED_MEDIA_GRACE_MS) }, OR: [{ storageKey: { not: null } }, { stagingKey: { not: null } }] },
        take: BATCH,
        select: { id: true, storageKey: true, stagingKey: true },
      })
      for (const media of removed) {
        for (const key of [media.storageKey, media.stagingKey]) if (key) await storage().remove(key)
        await tx.productMedia.update({ where: { id: media.id }, data: { storageKey: null, stagingKey: null } })
      }
      return { abandonedUploads: abandoned.length, removedPhotos: removed.length }
    },
  }
}
