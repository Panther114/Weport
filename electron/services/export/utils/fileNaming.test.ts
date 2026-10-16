import { describe, expect, it } from 'vitest'
import { isWeChatSuffixRenamedEntry, pickWeChatSuffixRenamedEntries } from './fileNaming'

/**
 * 微信落地附件时会自动追加 `(1)` / `(3)` 这类后缀，聊天消息里却仍记原始文件名。
 * 只按精确名找附件会让这些文件整批丢失。
 *
 * 下面用例里的文件名均为**构造的示例**，只用于覆盖识别规则的各个分支。
 */
describe('isWeChatSuffixRenamedEntry', () => {
  it('认得微信自动追加的单层后缀', () => {
    expect(isWeChatSuffixRenamedEntry('课程报告(1).docx', '课程报告.docx')).toBe(true)
    expect(isWeChatSuffixRenamedEntry('课程讲义(3).pdf', '课程讲义.pdf')).toBe(true)
    expect(isWeChatSuffixRenamedEntry('作业-0001网页跳转路线(1).docx', '作业-0001网页跳转路线.docx')).toBe(true)
  })

  it('认得累加的多层后缀', () => {
    expect(isWeChatSuffixRenamedEntry(
      '附件名(1)(3)(1)(1).docx',
      '附件名.docx'
    )).toBe(true)
  })

  it('原文件名里本来就有中文括号时仍然正确', () => {
    expect(isWeChatSuffixRenamedEntry(
      '实验报告（从A到B）(1).docx',
      '实验报告（从A到B）.docx'
    )).toBe(true)
  })

  it('不把无关的相似文件名当成同名后缀', () => {
    expect(isWeChatSuffixRenamedEntry('报告(1) - 副本.docx', '报告.docx')).toBe(false)
    expect(isWeChatSuffixRenamedEntry('报告终稿.docx', '报告.docx')).toBe(false)
    expect(isWeChatSuffixRenamedEntry('报告(a).docx', '报告.docx')).toBe(false)
    expect(isWeChatSuffixRenamedEntry('报告(1).pdf', '报告.docx')).toBe(false)
    expect(isWeChatSuffixRenamedEntry('', '报告.docx')).toBe(false)
    expect(isWeChatSuffixRenamedEntry('报告(1).docx', '')).toBe(false)
  })

  it('完全同名时不算后缀变体（交给精确匹配）', () => {
    expect(isWeChatSuffixRenamedEntry('报告(1).docx', '报告(1).docx')).toBe(false)
  })

  it('无扩展名的文件也能识别', () => {
    expect(isWeChatSuffixRenamedEntry('README(1)', 'README')).toBe(true)
    expect(isWeChatSuffixRenamedEntry('README', 'README')).toBe(false)
  })
})

describe('pickWeChatSuffixRenamedEntries', () => {
  it('只挑出后缀变体，并按序号升序排列', () => {
    const entries = [
      '课程报告.docx',
      '课程报告(10).docx',
      '课程报告(2).docx',
      '无关文件.docx',
    ]
    expect(pickWeChatSuffixRenamedEntries(entries, '课程报告.docx')).toEqual([
      '课程报告(2).docx',
      '课程报告(10).docx',
    ])
  })

  it('没有变体时返回空数组', () => {
    expect(pickWeChatSuffixRenamedEntries(['示例文件.docx'], '示例文件.docx')).toEqual([])
    expect(pickWeChatSuffixRenamedEntries([], '示例文件.docx')).toEqual([])
  })
})
