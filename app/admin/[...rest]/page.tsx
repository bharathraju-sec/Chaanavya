import { notFound } from "next/navigation"

// Any admin address without a page gets the plain admin 404 (also on the admin host).
export default function UnknownAdminPage() {
  notFound()
}
