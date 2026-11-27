import { useState } from 'react'
import ReportProblemDialog from './ReportProblemDialog'

/**
 * "Report this" under a failed import (S4, D83): opens the problem report with
 * the file that failed attached (the coach can untick it) and what went wrong
 * already written.
 */
export default function ReportThisLink({ file, what }: { file: File | null; what: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => setOpen(true)}>
        Report this
      </button>
      <ReportProblemDialog
        open={open}
        onOpenChange={setOpen}
        file={file}
        initialDescription={`${what}\n\n(What I expected:)`}
      />
    </>
  )
}
