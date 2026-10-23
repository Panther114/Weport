import assert from 'node:assert/strict'
import { test } from 'node:test'
import { passesGroundednessRubric } from './lib/groundedness-rubric.mjs'

const missing = { status: 'unknown', sources: [] }
const conflict = { status: 'uncertain', sources: ['new', 'old'] }
for (const language of ['en', 'zh']) {
  const reason = language === 'en' ? 'The current text is unavailable.' : '当前原文不可用。'
  const answer = { status: 'unknown', verified: false, sourceIds: [], reason }
  test(`${language}: changed/deleted source must be excluded even in an unverified answer`, () => {
    assert.equal(passesGroundednessRubric(answer, missing, language, []), true)
    // The observed Chinese DeepSeek failure must remain a failed receipt.
    assert.equal(passesGroundednessRubric({ ...answer, sourceIds: ['X'] }, missing, language, []), false)
    assert.equal(passesGroundednessRubric({ ...answer, verified: true }, missing, language, []), false)
    assert.equal(passesGroundednessRubric({ ...answer, status: 'uncertain' }, missing, language, []), false)
  })
  test(`${language}: a conflict retains both usable sources without claiming verification`, () => {
    const value = { ...answer, status: 'uncertain', sourceIds: ['old', 'new'] }
    assert.equal(passesGroundednessRubric(value, conflict, language, []), true)
    for (const sourceIds of [[], ['old'], ['new'], ['old', 'new', 'X'], ['old', 'new', 'new']]) {
      assert.equal(passesGroundednessRubric({ ...value, sourceIds }, conflict, language, []), false)
    }
  })
  test(`${language}: tool access, missing language evidence and malformed responses fail`, () => {
    assert.equal(passesGroundednessRubric(answer, missing, language, [{ toolCalls: [{}] }]), false)
    for (const value of [null, {}, { ...answer, sourceIds: null }, { ...answer, reason: '' }, { ...answer, reason: 2 }]) {
      assert.equal(passesGroundednessRubric(value, missing, language, []), false)
    }
    assert.equal(passesGroundednessRubric({ ...answer, reason: language === 'zh' ? 'No current text.' : '原文缺失。' }, missing, language, []), false)
  })
}
