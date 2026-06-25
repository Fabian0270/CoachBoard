import { useEffect, useState } from 'react'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { useToast } from '../components/ui/toast'
import { useConfirm } from '../components/ui/confirm-dialog'
import { Palette, Pencil, Trash2, Check, X } from 'lucide-react'

interface ExportStyle {
  id: string
  name: string
  descriptor: { orientation: string }
  created_at: string
}

export default function ExportStyles() {
  const toast = useToast()
  const confirm = useConfirm()
  const [styles, setStyles] = useState<ExportStyle[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const load = () => {
    setLoading(true)
    fetch('/api/export-styles')
      .then((r) => r.json())
      .then((data) => setStyles(Array.isArray(data) ? data : []))
      .catch(() => setStyles([]))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const startEdit = (s: ExportStyle) => { setEditingId(s.id); setDraftName(s.name) }
  const cancelEdit = () => { setEditingId(null); setDraftName('') }

  const saveRename = async (id: string) => {
    const name = draftName.trim()
    if (!name) return
    const res = await fetch(`/api/export-styles/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (res.ok) { cancelEdit(); load() }
    else toast.error('Failed to rename style')
  }

  const remove = async (s: ExportStyle) => {
    if (!(await confirm({
      title: `Delete the style "${s.name}"?`,
      description: "Programs already using it keep their look; it just won't be offered for new programs.",
      confirmLabel: 'Delete',
      destructive: true,
    }))) return
    const res = await fetch(`/api/export-styles/${s.id}`, { method: 'DELETE' })
    if (res.ok) load()
    else toast.error('Failed to delete style')
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Palette className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-3xl font-bold">Excel Styles</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Saved layouts captured from imported programs. Apply one when creating a new program to export it
        in that coach’s style — colours, columns, day labels and any form link are kept.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : styles.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No saved styles yet. When you import a program, tick “Save this program’s style for future
            programs” to add one here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {styles.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex items-center gap-3 py-3">
                {editingId === s.id ? (
                  <>
                    <Input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveRename(s.id); if (e.key === 'Escape') cancelEdit() }}
                      className="flex-1"
                    />
                    <Button size="sm" variant="ghost" onClick={() => saveRename(s.id)} aria-label="Save name">
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEdit} aria-label="Cancel">
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="text-xs text-muted-foreground">{s.descriptor?.orientation ?? 'layout'} style</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => startEdit(s)} aria-label="Rename">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(s)} aria-label="Delete">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
