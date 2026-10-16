function rgb(hex: string): number[] { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) }
function luminance(channels: number[]): number {
  return channels.map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 })
    .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
}
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(rgb(foreground)), b = luminance(rgb(background))
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}
/** Preserve hue while adjusting only as much tone as readable UI requires. */
export function accessibleAccent(hex: string, background: string, minimum = 4.5): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex) || !/^#[0-9a-f]{6}$/i.test(background)) throw new Error('Expected six-digit colors')
  const channels = rgb(hex)
  const target = luminance(rgb(background)) > .5 ? 0 : 255
  for (let step = 0; step <= 100; step++) {
    const candidate = '#' + channels.map(value => Math.round(value + (target - value) * step / 100).toString(16).padStart(2, '0')).join('')
    if (contrastRatio(candidate, background) >= minimum) return candidate
  }
  return target ? '#ffffff' : '#000000'
}
