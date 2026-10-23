// Audit events as a table (Stage 06). Shows IDs, actions, reasons and correlation IDs only; the
// rows never contain personal data (enforced where they are written).

export type AuditRow = {
  id: string
  action: string
  actorKind: string
  actorId: string | null
  entityType: string
  entityId: string
  reason: string
  correlationId: string
  occurredAt: Date | string
}

const time = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })
const short = (id: string | null) => (id ? (id.length > 13 ? `${id.slice(0, 8)}...` : id) : "")

export function AuditTable({ events, compact = false }: { events: AuditRow[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto border border-line bg-card">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            <th scope="col" className="px-4 py-3 font-semibold">When (IST)</th>
            <th scope="col" className="px-4 py-3 font-semibold">Action</th>
            <th scope="col" className="px-4 py-3 font-semibold">By</th>
            <th scope="col" className="px-4 py-3 font-semibold">On</th>
            <th scope="col" className="px-4 py-3 font-semibold">Reason</th>
            {!compact && <th scope="col" className="px-4 py-3 font-semibold">Correlation</th>}
          </tr>
        </thead>
        <tbody>
          {events.map(e => (
            <tr key={e.id} className="border-b border-line last:border-b-0 align-top">
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{time.format(new Date(e.occurredAt))}</td>
              <td className="px-4 py-3 font-medium text-ink">{e.action}</td>
              <td className="px-4 py-3 text-ink">
                {e.actorKind} <span className="font-mono text-xs text-muted-foreground" title={e.actorId ?? undefined}>{short(e.actorId)}</span>
              </td>
              <td className="px-4 py-3 text-ink">
                {e.entityType} <span className="font-mono text-xs text-muted-foreground" title={e.entityId}>{short(e.entityId)}</span>
              </td>
              <td className="max-w-xs px-4 py-3 break-words text-ink">{e.reason}</td>
              {!compact && <td className="px-4 py-3 font-mono text-xs text-muted-foreground" title={e.correlationId}>{short(e.correlationId)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
