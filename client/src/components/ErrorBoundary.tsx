import { Component, ReactNode } from 'react'
import { Button } from './ui/button'

interface Props { children: ReactNode }
interface State {
  error: Error | null
  logPath: string | null
  canReveal: boolean
  copied: boolean
}

/**
 * Last line of defence for the whole app. Catches render errors and, unusually,
 * unhandled promise rejections too — a lot of this app's work happens in async
 * handlers that React's boundary would otherwise never see.
 *
 * The screen is deliberately written for a coach, not a developer: what happened,
 * that their data is safe, and two ways to get the detail to someone who can act
 * on it. The stack lives behind a disclosure rather than being the page.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, logPath: null, canReveal: false, copied: false }

  private unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
    const error = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason ?? 'Unhandled promise rejection'))
    this.setState({ error })
    void this.loadPaths()
  }

  componentDidMount() {
    window.addEventListener('unhandledrejection', this.unhandledRejectionHandler)
  }

  componentWillUnmount() {
    window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler)
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch() {
    void this.loadPaths()
  }

  /** Where the log lives, so the screen can offer to open it. Best-effort only. */
  private loadPaths = async () => {
    try {
      const res = await fetch('/api/system/paths')
      if (!res.ok) return
      const paths = await res.json()
      this.setState({ logPath: paths.logPath ?? null, canReveal: !!paths.canReveal })
    } catch {
      /* the server may be the thing that broke — degrade to the stack below */
    }
  }

  private diagnostics(): string {
    const { error } = this.state
    return [
      'CoachBoard error report',
      `When:    ${new Date().toISOString()}`,
      `Screen:  ${window.location.hash || '#/'}`,
      `Message: ${error?.message ?? 'unknown'}`,
      '',
      error?.stack ?? '(no stack available)',
    ].join('\n')
  }

  private copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(this.diagnostics())
      this.setState({ copied: true })
    } catch {
      /* clipboard blocked — the same text is visible under Technical details */
    }
  }

  private openLogFolder = async () => {
    try {
      await fetch('/api/system/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'logs' }),
      })
    } catch {
      /* nothing further we can offer from a broken screen */
    }
  }

  render() {
    const { error, logPath, canReveal, copied } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-xl rounded-lg border border-border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">Something went wrong</h1>

          <p className="mt-2 text-sm text-muted-foreground">
            CoachBoard hit an error it could not recover from on this screen. Your athletes,
            programs and settings are stored on this computer and have not been affected.
          </p>

          <p className="mt-4 break-words rounded-md bg-muted px-3 py-2 text-sm font-medium">
            {error.message}
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => this.setState({ error: null, copied: false })}>
              Try again
            </Button>
            <Button variant="outline" onClick={this.copyDetails}>
              {copied ? 'Copied' : 'Copy details'}
            </Button>
            {canReveal && (
              <Button variant="outline" onClick={this.openLogFolder}>
                Open log folder
              </Button>
            )}
          </div>

          <details className="mt-5">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
              Technical details
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
              {error.stack ?? '(no stack available)'}
            </pre>
            {logPath && (
              <p className="mt-2 break-all text-xs text-muted-foreground">Log file: {logPath}</p>
            )}
          </details>
        </div>
      </div>
    )
  }
}
