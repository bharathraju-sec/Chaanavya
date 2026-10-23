import { timingSafeEqual } from "node:crypto"
import { revalidateTag } from "next/cache"
import { apiTarget, INTERNAL_KEY_HEADER } from "@/lib/api/forward"
import { CATALOGUE_TAG } from "@/lib/catalogue/client"

// Catalogue cache refresh (Stage 10.10). The worker calls this after a publish, unpublish, catalogue
// edit, photo change or stock change (outbox event `catalogue.updated`). It expires the cached
// catalogue reads, so the next page view reads fresh data from the API instead of waiting out the
// 60 second cache time. Only the worker holds the internal key; browsers get a plain 404. It changes
// no data and returns nothing about the catalogue.
const headers = { "cache-control": "no-store" }

function sameKey(sent: string | null, expected: string) {
  if (!sent) return false
  const a = Buffer.from(sent)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  let key: string
  try {
    key = apiTarget().key
  } catch {
    return new Response(null, { status: 404, headers })
  }
  // Wrong or missing key reads like a route that does not exist.
  if (!sameKey(request.headers.get(INTERNAL_KEY_HEADER), key)) return new Response(null, { status: 404, headers })
  // { expire: 0 }: nothing stale is served after an invalidation; the next request waits for fresh data.
  revalidateTag(CATALOGUE_TAG, { expire: 0 })
  return Response.json({ ok: true }, { headers })
}
