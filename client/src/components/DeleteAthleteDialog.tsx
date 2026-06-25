import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
import { Button } from './ui/button'
import { useToast } from './ui/toast'

interface Props {
  // The athlete to delete; null keeps the dialog closed.
  athlete: { id: string; name: string } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  // Called after a successful delete so the caller can refresh / navigate away.
  onDeleted: () => void
}

type Mode = 'keep' | 'all'

export default function DeleteAthleteDialog({ athlete, open, onOpenChange, onDeleted }: Props) {
  const toast = useToast()
  // Default to the non-destructive choice: keep the programs.
  const [mode, setMode] = useState<Mode>('keep')
  const [deleting, setDeleting] = useState(false)

  // Reset the choice each time the dialog is opened for a (possibly new) athlete.
  useEffect(() => { if (open) setMode('keep') }, [open, athlete?.id])

  const handleDelete = async () => {
    if (!athlete) return
    setDeleting(true)
    try {
      const query = mode === 'keep' ? '?keep_programs=1' : ''
      const res = await fetch(`/api/athletes/${athlete.id}${query}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        toast.error(`Failed to delete athlete: ${err.error ?? JSON.stringify(err)}`)
        return
      }
      onOpenChange(false)
      onDeleted()
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!deleting) onOpenChange(v) }}>
      {athlete && (
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {athlete.name}?</DialogTitle>
            <DialogDescription>Choose what happens to this athlete's programs.</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <ModeOption
              selected={mode === 'keep'}
              onSelect={() => setMode('keep')}
              title="Keep their programs"
              description="The athlete is removed, but their programs are archived and detached so you can reuse them with another athlete later."
            />
            <ModeOption
              selected={mode === 'all'}
              onSelect={() => setMode('all')}
              title="Delete everything"
              description="The athlete and all of their programs, maxes and payments are permanently deleted."
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : mode === 'keep' ? 'Delete, keep programs' : 'Delete everything'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

function ModeOption({
  selected,
  onSelect,
  title,
  description,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-3 transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'hover:bg-accent'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
            selected ? 'border-primary' : 'border-muted-foreground/40'
          }`}
        >
          {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground mt-0.5">{description}</span>
        </span>
      </div>
    </button>
  )
}
