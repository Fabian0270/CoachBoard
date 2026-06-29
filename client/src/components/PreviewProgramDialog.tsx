import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
import { Button } from './ui/button'
import { Download } from 'lucide-react'
import ExcelPreview from './ExcelPreview'

interface Props {
  programId: string
  programName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Triggers the same "Download as Excel" flow as the Export menu. */
  onDownload: () => void
}

export default function PreviewProgramDialog({ programId, programName, open, onOpenChange, onDownload }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Excel preview — {programName}</DialogTitle>
          <DialogDescription>
            This is exactly how the sheet looks when downloaded or emailed to the athlete.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-auto">
          {open && <ExcelPreview programId={programId} />}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={() => { onDownload(); onOpenChange(false) }}>
            <Download className="h-4 w-4" />
            Download as Excel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
