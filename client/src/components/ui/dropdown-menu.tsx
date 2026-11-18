import * as React from 'react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { rememberMenuTrigger } from '../../lib/menuFocusReturn'

// The app's drop-down menus (P2). Radix gives them what the hand-built ones
// had to be taught one by one: the arrow keys, Home / End, typing a letter to
// jump, Esc and a click outside to close, and focus back on the button.

// Not modal: a modal menu blocks clicks on the rest of the page while it is
// open, and when one of its items opened a dialog the page stayed unclickable
// after that dialog closed (measured in the packaged app: Export → Preview →
// Esc). A menu that never blocks the page has nothing to hand back. A click
// outside still closes it, as the hand-built menus did.
//
// Keep @radix-ui/react-dropdown-menu and react-popover on the same release as
// react-dialog (pinned exactly in package.json): a second copy of Radix's layer
// or focus code makes the copies fight over the page and over focus.
const DropdownMenu = ({ modal = false, ...props }: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Root>) => (
  <MenuPrimitive.Root modal={modal} {...props} />
)
const DropdownMenuTrigger = MenuPrimitive.Trigger
const DropdownMenuGroup = MenuPrimitive.Group

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(({ className, sideOffset = 4, loop = true, ...props }, ref) => (
  // Named after the button that opens it (Radix labels it by that button).
  <MenuPrimitive.Portal>
    <MenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      loop={loop}
      className={cn(
        'z-50 min-w-[10rem] overflow-hidden rounded-lg border bg-popover py-1 text-sm text-popover-foreground shadow-xl shadow-black/20 outline-none data-[state=open]:animate-pop-in motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  </MenuPrimitive.Portal>
))
DropdownMenuContent.displayName = MenuPrimitive.Content.displayName

const itemClass =
  'flex w-full cursor-default select-none items-center gap-2 px-3 py-2 outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, onSelect, ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    className={cn(itemClass, destructive && 'text-destructive data-[highlighted]:bg-destructive/10', className)}
    onSelect={(e) => { rememberMenuTrigger(e.currentTarget as Element); onSelect?.(e) }}
    {...props}
  />
))
DropdownMenuItem.displayName = MenuPrimitive.Item.displayName

/** One choice of several, ticked when it is the current one (a status). */
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup
const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.RadioItem ref={ref} className={cn(itemClass, 'py-1.5', className)} {...props}>
    <span className="flex w-3 justify-center">
      <MenuPrimitive.ItemIndicator><Check className="h-3 w-3" /></MenuPrimitive.ItemIndicator>
    </span>
    {children}
  </MenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = MenuPrimitive.RadioItem.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Label
    ref={ref}
    className={cn('px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground', className)}
    {...props}
  />
))
DropdownMenuLabel.displayName = MenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator ref={ref} className={cn('my-1 h-px bg-border', className)} {...props} />
))
DropdownMenuSeparator.displayName = MenuPrimitive.Separator.displayName

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuLabel, DropdownMenuSeparator,
}
