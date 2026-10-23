// This judges only the fixed acceptance contract, not general analytical accuracy.
export function passesGroundednessRubric(value, fixture, language, messages) {
  return Boolean(value && value.status === fixture.status && value.verified === false
    && Array.isArray(value.sourceIds)
    && JSON.stringify([...value.sourceIds].sort()) === JSON.stringify([...fixture.sources].sort())
    && typeof value.reason === 'string'
    && (language === 'zh' ? /[\u4e00-\u9fff]/.test(value.reason) : /[a-z]{3}/i.test(value.reason))
    && !messages.some(row => row.toolCalls?.length))
}
