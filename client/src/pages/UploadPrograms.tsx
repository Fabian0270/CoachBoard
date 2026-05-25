import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Upload, Trash2, FileText } from 'lucide-react'

interface Athlete { id: string; name: string }
interface UploadedProgram { id: string; original_name: string; athlete_id: string | null; uploaded_at: string; content: string | null }

export default function UploadPrograms() {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [uploads, setUploads] = useState<UploadedProgram[]>([])
  const [selectedAthlete, setSelectedAthlete] = useState<string>('none')
  const [uploading, setUploading] = useState(false)
  const [selected, setSelected] = useState<UploadedProgram | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/athletes').then((r) => r.json()),
      fetch('/api/uploaded-programs').then((r) => r.json()),
    ]).then(([a, u]) => { setAthletes(a); setUploads(u) })
  }, [])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    if (selectedAthlete !== 'none') fd.append('athlete_id', selectedAthlete)
    const res = await fetch('/api/uploaded-programs', { method: 'POST', body: fd })
    const record = await res.json()
    setUploads([record, ...uploads])
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/uploaded-programs/${id}`, { method: 'DELETE' })
    setUploads(uploads.filter((u) => u.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  const athleteMap = Object.fromEntries(athletes.map((a) => [a.id, a.name]))

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Upload Programs</h1>
      <Card>
        <CardHeader><CardTitle>Upload a Program File</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-3 items-end">
          <Select value={selectedAthlete} onValueChange={setSelectedAthlete}>
            <SelectTrigger className="w-48"><SelectValue placeholder="No athlete" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No athlete</SelectItem>
              {athletes.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <label className="cursor-pointer">
            <input ref={fileRef} type="file" accept=".txt,.csv,.json,.pdf" className="sr-only" onChange={handleUpload} disabled={uploading} />
            <Button asChild disabled={uploading}>
              <span><Upload className="h-4 w-4 mr-2" />{uploading ? 'Uploading...' : 'Choose File'}</span>
            </Button>
          </label>
        </CardContent>
      </Card>
      {uploads.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <FileText className="h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold mb-2">No uploaded programs</h2>
            <p className="text-muted-foreground">Upload a training program file to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            {uploads.map((u) => (
              <Card key={u.id} className={`cursor-pointer transition-shadow hover:shadow-md ${selected?.id === u.id ? 'ring-2 ring-primary' : ''}`} onClick={() => setSelected(u)}>
                <CardContent className="flex items-center justify-between py-3">
                  <div>
                    <div className="font-medium text-sm">{u.original_name}</div>
                    <div className="text-xs text-muted-foreground">{u.athlete_id ? athleteMap[u.athlete_id] : 'No athlete'} · {u.uploaded_at.split('T')[0]}</div>
                  </div>
                  <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleDelete(u.id) }}><Trash2 className="h-4 w-4" /></Button>
                </CardContent>
              </Card>
            ))}
          </div>
          {selected && (
            <Card>
              <CardHeader><CardTitle className="text-sm">{selected.original_name}</CardTitle></CardHeader>
              <CardContent>
                <pre className="text-xs whitespace-pre-wrap max-h-72 overflow-auto bg-muted p-3 rounded">{selected.content ?? '(binary file)'}</pre>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
