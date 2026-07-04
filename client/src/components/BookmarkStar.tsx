import { Star } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * Clickable yellow star for bookmarking a program (reuse later). Presentational:
 * the parent owns the toggle + persistence. Stops propagation so clicking it
 * inside a card link doesn't navigate.
 */
export default function BookmarkStar({
  bookmarked,
  onToggle,
  className,
}: {
  bookmarked: boolean
  onToggle: (next: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      title={bookmarked ? 'Bookmarked — click to remove' : 'Bookmark this program for reuse'}
      aria-pressed={bookmarked}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle(!bookmarked)
      }}
      className={cn('rounded p-1 transition-colors hover:bg-accent', className)}
    >
      <Star
        className={cn(
          'h-4 w-4',
          bookmarked ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground/60',
        )}
      />
    </button>
  )
}
