/** Only an explicit live-glass choice may capture or protect desktop windows. */
export function desktopCaptureAllowed(mode: unknown, platform: string): boolean {
  return mode === 'live-glass' && platform !== 'linux'
}
