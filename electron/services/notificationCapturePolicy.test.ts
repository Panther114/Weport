import { describe, expect, it } from 'vitest'
import { desktopCaptureAllowed } from './notificationCapturePolicy'

describe('notification recording compatibility', () => {
  it('uses capture-free notifications by default, including legacy/malformed config', () => {
    for (const mode of [undefined, null, '', 'compatible', 'unknown', true]) {
      expect(desktopCaptureAllowed(mode, 'win32')).toBe(false)
      expect(desktopCaptureAllowed(mode, 'darwin')).toBe(false)
    }
  })
  it('requires explicit live glass and always avoids Linux desktop capture', () => {
    expect(desktopCaptureAllowed('live-glass', 'win32')).toBe(true)
    expect(desktopCaptureAllowed('live-glass', 'darwin')).toBe(true)
    expect(desktopCaptureAllowed('live-glass', 'linux')).toBe(false)
  })
})
