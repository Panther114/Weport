/**
 * 回复草稿的最终排版（v1.3.3）。
 *
 * ## 为什么要在生成后做一次确定性整理
 *
 * 模型（以及 WeClone 的「形态整形」）会按"连发多条"的习惯输出 `\n\n`。聊天抽屉
 * 需要那些空行来渲染多个气泡；但阅读器里的回复草稿是一段要复制到微信输入框的
 * 文本 —— 空行和换行会让它读起来像一首分行诗，粘过去还要手动删。
 *
 * 这里做三件事，全部可测试：
 * - 去掉所有空行与换行；
 * - 行与行之间补上正确的句末标点（中文 `。` / 英文 `.`），不把两句话粘成一句；
 * - 去掉列表符号、多余空格和重复标点。
 *
 * 不改变文字内容、表情、英文缩写与专有名词。
 */

const CJK_RE = /[㐀-䶿一-鿿]/
const SENTENCE_END_RE = /[。！？!?…~～；;，,、：:）)】」』"'”’]$/
const LIST_MARKER_RE = /^\s*(?:[-*•]|\d+[.)、])\s*/
const HEADING_RE = /^\s*#{1,6}\s*/

function isCjkDominant(text: string): boolean {
  let cjk = 0
  let latin = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0
    if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)) cjk += 1
    else if (/[A-Za-z]/.test(ch)) latin += 1
  }
  return cjk > 0 && cjk >= latin
}

function stripMarkers(line: string): string {
  return line
    .replace(LIST_MARKER_RE, '')
    .replace(HEADING_RE, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .trim()
}

/**
 * 把任意模型输出整理成一段无换行、标点正确的草稿。
 *
 * 空输入返回空串；否则保证返回的文本没有 `\n`，并以句末标点收尾。
 */
export function normalizeDraftText(input: string): string {
  const raw = String(input || '').replace(/\r\n?/g, '\n')
  const lines = raw
    .split('\n')
    .map(stripMarkers)
    .filter(Boolean)
  if (lines.length === 0) return ''

  const cjk = isCjkDominant(lines.join(''))
  const joined = lines
    .map((line, index) => {
      const value = line.replace(/[ \t]+$/g, '')
      if (!value) return ''
      const last = index === lines.length - 1
      if (last || SENTENCE_END_RE.test(value)) return value
      return `${value}${cjk ? '。' : '.'}`
    })
    .filter(Boolean)
    .join(cjk ? '' : ' ')

  let text = joined
  if (cjk) {
    // 中文语境里把紧跟在汉字后的半角句读改成全角；英文单词/缩写保持原样。
    text = text
      .replace(/([㐀-䶿一-鿿])\s*,\s*/g, '$1，')
      .replace(/([㐀-䶿一-鿿])\s*\.\s*/g, '$1。')
      .replace(/([㐀-䶿一-鿿])\s*\?\s*/g, '$1？')
      .replace(/([㐀-䶿一-鿿])\s*!\s*/g, '$1！')
  }

  text = text
    .replace(/[ \t]+([，。！？；：、,.!?;:])/g, '$1')
    .replace(/([，。！？；：、])\1+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (text && !SENTENCE_END_RE.test(text)) text += cjk ? '。' : '.'
  return text
}

/** 单行预览（用于底部草稿条）。 */
export function draftPreview(input: string, max = 80): string {
  const text = normalizeDraftText(input)
  return text.length > max ? `${text.slice(0, max)}…` : text
}
