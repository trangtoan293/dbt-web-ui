import React from "react"
import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

const STATUS_STYLES: Record<string, string> = {
  running: "border-blue-200 bg-blue-50 text-blue-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  pass: "border-emerald-200 bg-emerald-50 text-emerald-700",
  error: "border-red-200 bg-red-50 text-red-700",
  fail: "border-red-200 bg-red-50 text-red-700",
  cancelled: "border-amber-200 bg-amber-50 text-amber-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  skipped: "border-slate-200 bg-slate-50 text-slate-600",
  pending: "border-slate-200 bg-slate-50 text-slate-600",
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="animate-spin" />
  if (status === "success" || status === "pass") return <CheckCircle2 />
  if (status === "error" || status === "fail") return <XCircle />
  if (status === "cancelled" || status === "warn") return <AlertCircle />
  return <Clock />
}

export default function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  const normalized = status.toLowerCase()
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold capitalize [&_svg]:h-3.5 [&_svg]:w-3.5",
      STATUS_STYLES[normalized] || STATUS_STYLES.pending,
      className,
    )}>
      <StatusIcon status={normalized} />
      {status}
    </span>
  )
}
