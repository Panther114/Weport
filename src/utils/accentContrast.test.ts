import { describe, expect, it } from 'vitest'
import { accessibleAccent, contrastRatio } from './accentContrast'
describe('custom palette contrast', () => {
  it('keeps readable colors unchanged', () => {
    expect(accessibleAccent('#5b8eff', '#111116')).toBe('#5b8eff')
  })
  it('handles white, black and vibrant custom choices on both themes', () => {
    for (const hex of ['#ffffff', '#000000', '#00ffff', '#ffff00', '#ff00ff', '#00ff00']) {
      for (const background of ['#111116', '#1e1e26', '#ffffff', '#eef0f6']) {
        expect(contrastRatio(accessibleAccent(hex, background), background)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('rejects malformed colors', () => {
    expect(() => accessibleAccent('blue', '#ffffff')).toThrow()
  })
})
