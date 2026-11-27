import { useState } from 'react'
import { LifeBuoy } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import ReportProblemDialog from './ReportProblemDialog'

/** Settings → Help: the way to tell support something is wrong (S4, D83). */
export default function ReportProblemCard() {
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Something not working?</CardTitle>
        <CardDescription>
          Send a problem report: what you write, the app version and the end of the app’s log. You see what
          goes in before it is sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => setOpen(true)}><LifeBuoy className="h-4 w-4" /> Report a problem</Button>
        <ReportProblemDialog open={open} onOpenChange={setOpen} />
      </CardContent>
    </Card>
  )
}
