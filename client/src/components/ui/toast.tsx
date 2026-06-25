import * as React from 'react'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { cn } from '../../lib/utils'

type ToastVariant = 'error' | 'success' | 'info'

interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
}

interface ToastApi {
  error: (message: string) => void
  success: (message: string) => void
  info: (message: string) => void
}

const ToastContext = React.createContext<ToastApi | null>(null)

// Errors linger longer than confirmations so the coach can read what went wrong.
const DURATION: Record<ToastVariant, number> = { error: 8000, success: 4000, info: 5000 }

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])
  const idRef = React.useRef(0)

  const remove = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const api = React.useMemo<ToastApi>(() => {
    const push = (message: string, variant: ToastVariant) => {
      const id = ++idRef.current
      setToasts((prev) => [...prev, { id, message, variant }])
      window.setTimeout(() => remove(id), DURATION[variant])
    }
    return {
      error: (m) => push(m, 'error'),
      success: (m) => push(m, 'success'),
      info: (m) => push(m, 'info'),
    }
  }, [remove])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={remove} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}

const ICONS: Record<ToastVariant, typeof Info> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
}

const ACCENTS: Record<ToastVariant, string> = {
  error: 'text-destructive',
  success: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-primary',
}

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant]
        return (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-background p-4 shadow-lg data-[state=open]:animate-in slide-in-from-right-2 fade-in-0"
            data-state="open"
          >
            <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', ACCENTS[t.variant])} />
            <p className="flex-1 text-sm text-foreground break-words">{t.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="shrink-0 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
