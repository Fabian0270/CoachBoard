import { ChevronLeft } from 'lucide-react'

export default function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mt-1"
    >
      <ChevronLeft className="h-3.5 w-3.5" />
      Back
    </button>
  )
}
