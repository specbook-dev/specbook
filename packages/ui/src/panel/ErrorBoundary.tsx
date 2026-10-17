import { Component, type ComponentChildren } from 'preact'

interface Props {
  children: ComponentChildren
}

/**
 * What is drawn in a panel comes from a run, and a run is whatever the API answered and whatever the project's code did with
 * it. If drawing that fails anyway, the panel says so in words and offers the run again, instead of stopping where it was
 * with nothing to click: a render that throws leaves the part of the page under it dead.
 */
export class ErrorBoundary extends Component<Props, { error?: Error }> {
  state: { error?: Error } = {}

  componentDidCatch(error: unknown) {
    console.error('specbook: a panel could not be drawn', error)
    this.setState({ error: error instanceof Error ? error : new Error(String(error)) })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div class="panel-error" role="alert">
        <p>
          <strong>This could not be shown.</strong> The run finished, but what it returned could not
          be drawn.
        </p>
        <pre>{error.message}</pre>
        <button type="button" class="btn" onClick={() => this.setState({ error: undefined })}>
          Try drawing it again
        </button>
      </div>
    )
  }
}
