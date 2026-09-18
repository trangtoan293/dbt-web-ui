"use client"

import { useEffect, useState } from 'react'
import { Button } from '@/components-v2/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components-v2/ui/dialog'

export const boardPath = (name: string) => `charts/${name.trim().replace(/\s+/g, '-')}.yml`

export default function SaveDashboardDialog({ open, onOpenChange, files, suggestion, onSave }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  files: string[]
  suggestion: string
  onSave: (path: string) => void
}) {
  const [name, setName] = useState(suggestion)
  useEffect(() => { if (open) setName(suggestion) }, [open, suggestion])
  const valid = /^[\w -]{1,80}$/.test(name.trim())
  const path = valid ? boardPath(name) : ''
  const overwrite = valid && files.includes(path)

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md">
    <DialogHeader>
      <DialogTitle>Save dashboard</DialogTitle>
      <DialogDescription>The dashboard is written into the project as a file you can commit to Git.</DialogDescription>
    </DialogHeader>
    <label className="block text-xs text-slate-600">Name
      <input aria-label="Dashboard name" autoFocus className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm"
        value={name} maxLength={80} onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && valid) { onSave(path); onOpenChange(false) } }} /></label>
    <p className="text-xs text-slate-500">Saves as <code className="font-mono">{path || 'charts/<name>.yml'}</code></p>
    {!valid && name.length > 0 && <p role="alert" className="text-xs text-red-700">Use 1–80 letters, numbers, spaces, underscores or hyphens.</p>}
    {overwrite && <p role="alert" className="text-xs text-amber-700">{path} already exists and will be replaced.</p>}
    <div className="flex gap-2">
      <Button size="sm" disabled={!valid} onClick={() => { onSave(path); onOpenChange(false) }}>{overwrite ? 'Replace file' : 'Save dashboard'}</Button>
      <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
    </div>
  </DialogContent></Dialog>
}
