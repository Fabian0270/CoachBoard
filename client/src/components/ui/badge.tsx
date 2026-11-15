import * as React from 'react'
import { cn } from '../../lib/utils'

const Badge = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'secondary' | 'destructive' | 'outline' }
>(({ className, variant = 'default', ...props }, ref) => {
  const variantClasses = {
    default: 'border-primary/35 bg-primary/10 text-primary',
    secondary: 'border-border bg-secondary text-secondary-foreground',
    destructive: 'border-destructive/35 bg-destructive/10 text-destructive',
    outline: 'text-muted-foreground',
  }
  return (
    <div
      ref={ref}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors focus:outline-none focus:ring-2 focus:ring-ring/60', variantClasses[variant], className)}
      {...props}
    />
  )
})
Badge.displayName = 'Badge'

export { Badge }
