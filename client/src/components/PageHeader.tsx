import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

/**
 * The one title treatment every screen uses: an optional small eyebrow above
 * (context such as the date or the parent section), the title, an optional
 * muted description, and actions aligned right.
 */
export default function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow && (
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</div>
        )}
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
