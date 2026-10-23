"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { fieldClass } from "@/components/admin/blocks"

export type TeamMember = { id: string; email: string; roles: string[]; twoFactorEnabled: boolean; disabledAt: string | null; etag: string }

const ROLES = ["OWNER", "ADMIN", "STAFF"] as const
const LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", STAFF: "Staff" }

type Action = { key: string; label: string; method: "POST" | "DELETE"; path: (id: string) => string; body?: object; etag: boolean; danger?: boolean }

function actionsFor(member: TeamMember): Action[] {
  if (member.disabledAt) return []
  return [
    ...ROLES.filter(r => !member.roles.includes(r)).map(r => ({ key: `grant:${r}`, label: `Give the ${LABEL[r]} role`, method: "POST" as const, path: (id: string) => `/api/admin/staff/${id}/roles`, body: { role: r }, etag: true })),
    ...member.roles.map(r => ({ key: `revoke:${r}`, label: `Remove the ${LABEL[r] ?? r} role (signs them out)`, method: "DELETE" as const, path: (id: string) => `/api/admin/staff/${id}/roles/${r}`, etag: true, danger: true })),
    { key: "sessions", label: "Sign out on every device", method: "DELETE", path: id => `/api/admin/staff/${id}/sessions`, etag: false },
    { key: "deactivate", label: "Deactivate (cannot sign in again)", method: "POST", path: id => `/api/admin/staff/${id}/deactivate`, etag: true, danger: true },
  ]
}

// Owners manage staff here. The server checks the owner's permission, two-factor session and the
// record's ETag on every change, and writes an audit entry with the reason given below.
export function TeamManager({ members, currentUserId }: { members: TeamMember[]; currentUserId: string }) {
  const router = useRouter()
  const [editing, setEditing] = useState<TeamMember | null>(null)
  const [actionKey, setActionKey] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actions = useMemo(() => (editing ? actionsFor(editing) : []), [editing])
  const action = actions.find(a => a.key === actionKey)

  function open(member: TeamMember) {
    setEditing(member)
    setActionKey("")
    setReason("")
    setError(null)
  }

  async function apply() {
    if (!editing || !action) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(action.path(editing.id), {
        method: action.method,
        headers: { "content-type": "application/json", ...(action.etag && { "if-match": editing.etag }) },
        body: JSON.stringify({ ...action.body, reason }),
      })
      if (res.ok) {
        setEditing(null)
        router.refresh()
        return
      }
      const body = await res.json().catch(() => null)
      if (res.status === 412) {
        setError("Someone else changed this person a moment ago. The list has been reloaded; check it and try again.")
        router.refresh()
        return
      }
      setError(body?.error?.message ?? (res.status === 403 ? "Your role cannot make this change." : "The change could not be saved."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="overflow-x-auto border border-line bg-card">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
              <th scope="col" className="px-4 py-3 font-semibold">Person</th>
              <th scope="col" className="px-4 py-3 font-semibold">Roles</th>
              <th scope="col" className="px-4 py-3 font-semibold">Two-factor</th>
              <th scope="col" className="px-4 py-3 font-semibold">Status</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-3 break-all text-ink">{m.email}</td>
                <td className="px-4 py-3 text-ink">{m.roles.length ? m.roles.map(r => LABEL[r] ?? r).join(", ") : "None"}</td>
                <td className="px-4 py-3 text-ink">{m.twoFactorEnabled ? "Set up" : "Not set up"}</td>
                <td className="px-4 py-3 text-ink">{m.disabledAt ? "Deactivated" : "Active"}</td>
                <td className="px-4 py-3 text-right">
                  {m.id === currentUserId ? (
                    <span className="text-xs text-muted-foreground">You</span>
                  ) : m.disabledAt ? null : (
                    <Button variant="quiet" size="sm" onClick={() => open(m)} aria-label={`Manage ${m.email}`}>
                      Manage
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={editing !== null} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="rounded-none border-line bg-paper sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl font-medium text-ink">Manage access</DialogTitle>
            <DialogDescription className="break-all">{editing?.email}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="team-action">Change</Label>
              <select id="team-action" value={actionKey} onChange={e => setActionKey(e.target.value)} className={fieldClass}>
                <option value="">Choose a change</option>
                {actions.map(a => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="team-reason">Reason (kept in the audit trail)</Label>
              <Textarea id="team-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} className="min-h-24 rounded-none border-line-strong bg-paper" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="quiet" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={busy || !action || reason.trim().length < 3}>
              {busy ? "Saving" : "Apply change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
