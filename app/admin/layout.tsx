import type { Metadata } from "next"

// Admin workspace (Stage 06). Served at ADMIN_URL (for example admin.chaanavya.in) or, without it,
// at /admin. Never indexed. Access checks live in each page (lib/auth/permissions.ts).
export const metadata: Metadata = {
  title: { default: "Admin", template: "%s | Chaanavya admin" },
  robots: { index: false, follow: false, nocache: true },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh flex-1 flex-col bg-paper">{children}</div>
}
