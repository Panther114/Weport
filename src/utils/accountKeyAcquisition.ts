/** Persist the visible selection before the main process resolves its account directory. */
export async function acquireKeyForSelectedAccount<T>(
  config: { set: (key: string, value: string) => Promise<unknown> },
  selection: { dbPath: string; wxid: string },
  acquire: () => Promise<T>,
): Promise<T> {
  const dbPath = selection.dbPath.trim()
  const wxid = selection.wxid.trim()
  if (!dbPath) throw new Error('请先选择微信数据目录')
  if (!wxid) throw new Error('请先选择微信账号')

  // Automatic account selection only updates renderer state. Await the writes;
  // fire-and-forget persistence can leave acquisition using an empty/old account.
  for (const [key, value, label] of [
    ['dbPath', dbPath, '微信数据目录'],
    ['myWxid', wxid, '微信账号'],
  ]) {
    const result = await config.set(key, value)
    if (result && typeof result === 'object' && 'success' in result && result.success === false) {
      throw new Error(`保存${label}失败，请重试`)
    }
  }
  return acquire()
}
