import { cn } from '../lib/utils'

/*
 * The CB mark, traced from the app icon so the sidebar logo and the installer
 * icon are the same shape. Colours follow the theme: the C is the foreground
 * ink (off-white in dark, near-black in light), the B is the Moss accent.
 */
const C_PATH = 'M200 302H578L482 401H236L203 431L150 604L168 622H438L400 720H82L12 645L79 410Z'
const B_PATH =
  'M635 300H950L1012 373L982 465L924 505L962 543L932 645L827 722H432L532 402Z' +
  'M657 402H858L866 414L851 456L832 470H636Z' +
  'M613 552H814L826 566L812 606L792 623H592Z'

export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 290 1024 445" aria-hidden className={cn('shrink-0', className)}>
      <path d={C_PATH} className="fill-foreground" />
      <path d={B_PATH} className="fill-primary" fillRule="evenodd" />
    </svg>
  )
}
