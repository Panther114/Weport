/** Error messages are inspected and discarded by the main-process allowlist. */
export function installRemoteErrorWiring(): void {
  const report = (value: unknown) => {
    const error = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack }
      : { message: typeof value === 'string' ? value : '' }
    window.electronAPI?.telemetry?.reportError(error)
  }
  window.addEventListener('error', event => report(event.error ?? event.message))
  window.addEventListener('unhandledrejection', event => report(event.reason))
}
