import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none', className)}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onInteractOutside, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
  // Where the cursor was when the dialog opened, to put it back on close.
  // Radix only returns focus to a DialogTrigger, and the app opens its dialogs
  // from plain buttons, menus and shortcuts — so closing one (Esc, ×, Cancel)
  // dropped the cursor on the page itself and Tab started again from the top.
  // Read as the dialog opens, every time: Radix calls onOpenAutoFocus just
  // before it moves focus in. (A mount-time read was not enough — most dialogs
  // stay mounted with open={false} and would remember the page's first focus.)
  const returnTo = React.useRef<HTMLElement | null>(null)
  return (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      onOpenAutoFocus={(event) => {
        const active = document.activeElement
        // An `autoFocus` field inside the dialog has already taken focus by
        // now, so what was focused before is lost. Don't use autoFocus inside a
        // DialogContent: Radix puts the cursor in the first field anyway.
        const inside = active instanceof Node && (event.currentTarget as Node | null)?.contains(active)
        returnTo.current = active instanceof HTMLElement && active !== document.body && !inside ? active : null
        onOpenAutoFocus?.(event)
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event)
        if (event.defaultPrevented) return
        const el = returnTo.current
        // A menu item that opened the dialog is gone by now; then the page's
        // own handling (or nothing) is the honest answer.
        if (el && el.isConnected) {
          event.preventDefault()
          el.focus()
        }
      }}
      // A toast sits outside the dialog in the DOM, so pressing its Undo or its
      // × counted as a click outside and closed the dialog under it.
      onInteractOutside={(event) => {
        if ((event.target as Element | null)?.closest?.('[data-toast-viewport]')) event.preventDefault()
        onInteractOutside?.(event)
      }}
      // Centred with the `translate` property, not a transform: the open and
      // close animation scales the dialog, and a scaled transform-translate
      // drifted it about 10 px off-centre while it ran.
      className={cn('fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg [translate:-50%_-50%] gap-4 border bg-popover p-6 shadow-2xl shadow-black/30 data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none sm:rounded-xl', className)}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export { Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }
