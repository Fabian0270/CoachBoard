import * as React from 'react'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { cn } from '../../lib/utils'

type ToastVariant = 'error' | 'success' | 'info'

/** A button inside the toast — "Undo" after something was removed. */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  action?: ToastAction
  /** How long it stays, in ms. Defaults by variant; longer when there is an action to reach. */
  duration?: number
}

interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
  action?: ToastAction
}

/** Takes the toast down early — e.g. once its Undo has been used some other way. */
export type DismissToast = () => void

interface ToastApi {
  error: (message: string, options?: ToastOptions) => DismissToast
  success: (message: string, options?: ToastOptions) => DismissToast
  info: (message: string, options?: ToastOptions) => DismissToast
}

const ToastContext = React.createContext<ToastApi | null>(null)

// Errors linger longer than confirmations so the coach can read what went wrong.
const DURATION: Record<ToastVariant, number> = { error: 8000, success: 4000, info: 5000 }
/** A toast with a button stays long enough to be read and reached. */
export const ACTION_DURATION = 8000

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])
  const idRef = React.useRef(0)

  const remove = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const api = React.useMemo<ToastApi>(() => {
    const push = (message: string, variant: ToastVariant, options?: ToastOptions): DismissToast => {
      const id = ++idRef.current
      setToasts((prev) => [...prev, { id, message, variant, action: options?.action }])
      window.setTimeout(() => remove(id), options?.duration ?? (options?.action ? ACTION_DURATION : DURATION[variant]))
      return () => remove(id)
    }
    return {
      error: (m, o) => push(m, 'error', o),
      success: (m, o) => push(m, 'success', o),
      info: (m, o) => push(m, 'info', o),
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
  success: 'text-success',
  info: 'text-primary',
}

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    // data-toast-viewport: an open dialog treats a click here as inside itself,
    // so pressing Undo (or dismissing a toast) does not close the dialog.
    <div data-toast-viewport className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant]
        return (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-4 shadow-xl shadow-black/20data-[state=open]:animate-in slide-in-from-right-2 fade-in-0"
            data-state="open"
          >
            <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', ACCENTS[t.variant])} />
            <p className="flex-1 text-sm text-foreground break-words">{t.message}</p>
            {t.action && (
              <button
                type="button"
                onClick={() => { t.action!.onClick(); onDismiss(t.id) }}
                className="shrink-0 rounded-md border px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {t.action.label}
              </button>
            )}
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
