import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'

/**
 * Three-way disconnect: keep the synced videos (just forget the token) or
 * purge everything. useConfirm() is binary, hence a custom dialog.
 */
export default function DisconnectDiscordDialog({
  open,
  onOpenChange,
  onDisconnected,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onDisconnected: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const disconnect = async (purge: boolean) => {
    setBusy(true)
    try {
      const res = await fetch('/api/discord/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purge }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to disconnect')
        return
      }
      toast.success(
        purge
          ? `Discord disconnected — synced data deleted (${data.deletedFiles ?? 0} files removed)`
          : 'Discord disconnected — synced videos were kept',
      )
      onOpenChange(false)
      onDisconnected()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect Discord?</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>CoachBoard forgets the bot token and stops syncing. You choose what happens to the
          videos and messages already synced to this computer.</p>
          <p className="text-xs">
            Tip: also delete the bot in the Discord Developer Portal (or at least Reset Token) so
            the old token can’t be used.
          </p>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button className="w-full" variant="outline" disabled={busy} onClick={() => disconnect(false)}>
            Disconnect, keep synced videos
          </Button>
          <Button className="w-full" variant="destructive" disabled={busy} onClick={() => disconnect(true)}>
            Disconnect and delete everything
          </Button>
          <Button className="w-full" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
