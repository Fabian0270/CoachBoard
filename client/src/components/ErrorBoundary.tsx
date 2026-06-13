import { Component, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  private unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
    const error = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason ?? 'Unhandled promise rejection'))
    this.setState({ error })
  }

  componentDidMount() {
    window.addEventListener('unhandledrejection', this.unhandledRejectionHandler)
  }

  componentWillUnmount() {
    window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler)
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <h2 style={{ color: 'red' }}>Something went wrong</h2>
          <p><strong>{this.state.error.message}</strong></p>
          <p style={{ fontSize: 12, color: '#666' }}>{this.state.error.stack}</p>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
