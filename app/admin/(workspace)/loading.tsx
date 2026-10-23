import { Skeleton } from "@/components/ui/skeleton"

// Shown while an admin page loads: the outline of a heading and a block, never sample content.
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="mb-4 h-3 w-24 rounded-none bg-well" />
      <Skeleton className="mb-10 h-12 w-72 rounded-none bg-well" />
      <Skeleton className="h-40 w-full rounded-none bg-well" />
    </div>
  )
}
