import { useEffect, useState } from 'react'
import { cn } from '../lib/utils'

/**
 * Fades + slides its children in on mount. Used to animate tab-panel switches
 * (Radix remounts the active panel, so wrapping each panel gives the slide).
 * Pure CSS transition, matching the app's only animation idiom (ThemeToggle);
 * respects reduced-motion.
 */
export default function SlideIn({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div
      className={cn(
        'transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none',
        shown ? 'translate-x-0 opacity-100' : 'translate-x-3 opacity-0',
        className,
      )}
    >
      {children}
    </div>
  )
}
