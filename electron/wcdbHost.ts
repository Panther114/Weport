/**
 * WCDB 宿主进程入口（Electron IPC 消息协议）。
 *
 * wcdb_api.dll 的安全检查（-1006）要求宿主可执行文件名为 WeFlow.exe。
 * 主进程通过"硬链接 WeFlow.exe -> 当前 exe"（同目录，零磁盘开销）启动本进程，
 * 本进程只做 WCDB 工作，不创建可见窗口。
 *
 * 传输层说明：Electron 主进程的 process.stdin 在 Windows 上会立即 EOF
 * （即便父进程提供了管道），因此不使用 stdio JSON-lines，改用
 * child_process 的 IPC 通道（stdio: [..., 'ipc']），协议与
 * wcdbWorker.ts 的 worker_threads 消息协议一致：
 *
 * 请求: { id, type, payload }
 * 响应: { id, result } | { id, error }
 * 监控事件: { id: -1, type: 'monitor', payload: { type, json } }
 *
 * 由主进程以 env WEFLOW_WORKER=1 启动（config.ts 据此跳过 electron 导入）。
 */
import { WcdbCore } from './services/wcdbCore'

// 宿主进程不创建任何窗口：阻止 Electron 默认的"所有窗口关闭即退出"。
// （IPC 通道本身保持事件循环存活，零窗口时只需注册 window-all-closed 监听；
// 不创建隐藏窗口可省掉一个渲染进程约 40MB 内存。独立 Node 控制测试时
// electron 不可用，包一层 try/catch）
let electronGuard = false
try {
  const { app } = require('electron') as typeof import('electron')
  app.on('window-all-closed', () => {
    /* keep host alive */
  })
  // 宿主不渲染任何窗口：关掉 GPU 进程（省 ~80-100MB）与硬件加速。
  // 实测（Electron 43 / Chromium）：仅 disableHardwareAcceleration 或
  // disable-gpu 仍会拉起软件 GPU 子进程，必须叠加 --in-process-gpu 让 GPU
  // 并入宿主进程内（宿主零渲染，纯省进程）；网络服务 utility 子进程是
  // Chromium 默认进程模型的组成部分，Electron 43 无法关闭（试过
  // NetworkServiceInProcess / disable-features=NetworkService 均无效）。
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('in-process-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.disableHardwareAcceleration()
  electronGuard = true
} catch { /* 非 Electron 环境（node 控制测试） */ }

const core = new WcdbCore()

let shutdownRequested = false

async function dispatch(type: string, payload: any): Promise<{ result?: any; error?: string }> {
  let result: any
  try {
    switch (type) {
      case 'setPaths':
        core.setPaths(payload.resourcesPath, payload.userDataPath)
        // wcdb_api.dll 的依赖（msvcp140 / vcruntime140 等）按 exe 目录 + PATH 解析，
        // 宿主是当前 exe 的硬链接（同目录），这里再兜底把 DLL 目录加入 PATH
        try {
          const { join, delimiter } = require('path')
          const dllDir = join(payload.resourcesPath, 'wcdb', process.platform, process.arch)
          const runtimeDir = join(payload.resourcesPath, 'runtime', process.platform)
          const parts: string[] = []
          for (const part of [dllDir, runtimeDir]) {
            if (typeof part === 'string' && part && !process.env.PATH?.includes(part)) {
              parts.push(part)
            }
          }
          if (parts.length > 0) {
            process.env.PATH = parts.join(delimiter) + delimiter + (process.env.PATH || '')
          }
        } catch { /* PATH 预处理失败不致命 */ }
        result = { success: true }
        break
      case 'setLogEnabled':
        core.setLogEnabled(payload.enabled)
        result = { success: true }
        break
      case 'setMonitor':
        {
          const monitorOk = core.setMonitor((monType, json) => {
            if (!shutdownRequested) {
              try {
                process.send!({ id: -1, type: 'monitor', payload: { type: monType, json } })
              } catch { /* 父进程已断开 */ }
            }
          })
          result = { success: monitorOk }
          break
        }
      case 'testConnection':
        result = await core.testConnection(payload.accountDir, payload.hexKey)
        break
      case 'open':
        result = await core.open(payload.accountDir, payload.hexKey)
        break
      case 'getLastInitError':
        result = core.getLastInitError()
        break
      case 'close':
        core.close()
        result = { success: true }
        break
      case 'isConnected':
        result = core.isConnected()
        break
      case 'getSessions':
        result = await core.getSessions()
        break
      case 'markAllSessionsRead':
        result = await core.markAllSessionsRead()
        break
      case 'getMessages':
        result = await core.getMessages(payload.sessionId, payload.limit, payload.offset)
        break
      case 'getNewMessages':
        result = await core.getNewMessages(payload.sessionId, payload.minTime, payload.limit)
        break
      case 'getMessageCount':
        result = await core.getMessageCount(payload.sessionId)
        break
      case 'getMessageByServerId':
        result = await core.getMessageByServerId(payload.sessionId, payload.svrid)
        break
      case 'getMessageCounts':
        result = await core.getMessageCounts(payload.sessionIds)
        break
      case 'getSessionMessageCounts':
        result = await core.getSessionMessageCounts(payload.sessionIds)
        break
      case 'getSessionMessageTypeStats':
        result = await core.getSessionMessageTypeStats(payload.sessionId, payload.beginTimestamp, payload.endTimestamp)
        break
      case 'getSessionMessageTypeStatsBatch':
        result = await core.getSessionMessageTypeStatsBatch(payload.sessionIds, payload.options)
        break
      case 'getSessionMessageDateCounts':
        result = await core.getSessionMessageDateCounts(payload.sessionId)
        break
      case 'getSessionMessageDateCountsBatch':
        result = await core.getSessionMessageDateCountsBatch(payload.sessionIds)
        break
      case 'getMessagesByType':
        result = await core.getMessagesByType(payload.sessionId, payload.localType, payload.ascending, payload.limit, payload.offset)
        break
      case 'getMediaStream':
        result = await core.getMediaStream(payload.options)
        break
      case 'getDisplayNames':
        result = await core.getDisplayNames(payload.usernames)
        break
      case 'getAvatarUrls':
        result = await core.getAvatarUrls(payload.usernames)
        break
      case 'getGroupMemberCount':
        result = await core.getGroupMemberCount(payload.chatroomId)
        break
      case 'getGroupMemberCounts':
        result = await core.getGroupMemberCounts(payload.chatroomIds)
        break
      case 'getGroupMembers':
        result = await core.getGroupMembers(payload.chatroomId)
        break
      case 'getGroupNicknames':
        result = await core.getGroupNicknames(payload.chatroomId)
        break
      case 'getMessageTables':
        result = await core.getMessageTables(payload.sessionId)
        break
      case 'getMessageTableStats':
        result = await core.getMessageTableStats(payload.sessionId)
        break
      case 'getMessageDates':
        result = await core.getMessageDates(payload.sessionId)
        break
      case 'getMessageMeta':
        result = await core.getMessageMeta(payload.dbPath, payload.tableName, payload.limit, payload.offset)
        break
      case 'getMessageTableColumns':
        result = await core.getMessageTableColumns(payload.dbPath, payload.tableName)
        break
      case 'listTables':
        result = await core.listTables(payload.kind, payload.dbPath)
        break
      case 'getTableSchema':
        result = await core.getTableSchema(payload.kind, payload.dbPath, payload.tableName)
        break
      case 'exportTableSnapshot':
        result = await core.exportTableSnapshot(payload.kind, payload.dbPath, payload.tableName, payload.outputPath)
        break
      case 'importTableSnapshot':
        result = await core.importTableSnapshot(payload.kind, payload.dbPath, payload.tableName, payload.inputPath)
        break
      case 'importTableSnapshotWithSchema':
        result = await core.importTableSnapshotWithSchema(payload.kind, payload.dbPath, payload.tableName, payload.inputPath, payload.createTableSql)
        break
      case 'getMessageTableTimeRange':
        result = await core.getMessageTableTimeRange(payload.dbPath, payload.tableName)
        break
      case 'getContact':
        result = await core.getContact(payload.username)
        break
      case 'getContactStatus':
        result = await core.getContactStatus(payload.usernames)
        break
      case 'getContactTypeCounts':
        result = await core.getContactTypeCounts()
        break
      case 'getContactsCompact':
        result = await core.getContactsCompact(payload.usernames)
        break
      case 'getContactAliasMap':
        result = await core.getContactAliasMap(payload.usernames)
        break
      case 'getContactFriendFlags':
        result = await core.getContactFriendFlags(payload.usernames)
        break
      case 'getChatRoomExtBuffer':
        result = await core.getChatRoomExtBuffer(payload.chatroomId)
        break
      case 'getAggregateStats':
        result = await core.getAggregateStats(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp)
        break
      case 'getAvailableYears':
        result = await core.getAvailableYears(payload.sessionIds)
        break
      case 'getAnnualReportStats':
        result = await core.getAnnualReportStats(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp)
        break
      case 'getAnnualReportExtras':
        result = await core.getAnnualReportExtras(payload.sessionIds, payload.beginTimestamp, payload.endTimestamp, payload.peakDayBegin, payload.peakDayEnd)
        break
      case 'getDualReportStats':
        result = await core.getDualReportStats(payload.sessionId, payload.beginTimestamp, payload.endTimestamp)
        break
      case 'getGroupStats':
        result = await core.getGroupStats(payload.chatroomId, payload.beginTimestamp, payload.endTimestamp)
        break
      case 'getMyFootprintStats':
        result = await core.getMyFootprintStats(payload.options || {})
        break
      case 'openMessageCursor':
        result = await core.openMessageCursor(payload.sessionId, payload.batchSize, payload.ascending, payload.beginTimestamp, payload.endTimestamp)
        break
      case 'fetchMessageBatch':
        result = await core.fetchMessageBatch(payload.cursor)
        break
      case 'closeMessageCursor':
        result = await core.closeMessageCursor(payload.cursor)
        break
      case 'execQuery':
        result = await core.execQuery(payload.kind, payload.path, payload.sql, payload.params)
        break
      case 'getEmoticonCdnUrl':
        result = await core.getEmoticonCdnUrl(payload.dbPath, payload.md5)
        break
      case 'getEmoticonCaption':
        result = await core.getEmoticonCaption(payload.dbPath, payload.md5)
        break
      case 'getEmoticonCaptionStrict':
        result = await core.getEmoticonCaptionStrict(payload.md5)
        break
      case 'listMessageDbs':
        result = await core.listMessageDbs()
        break
      case 'listMediaDbs':
        result = await core.listMediaDbs()
        break
      case 'getMessageById':
        result = await core.getMessageById(payload.sessionId, payload.localId)
        break
      case 'searchMessages':
        result = await core.searchMessages(payload.keyword, payload.sessionId, payload.limit, payload.offset, payload.beginTimestamp, payload.endTimestamp)
        break
      case 'getVoiceData':
        result = await core.getVoiceData(payload.sessionId, payload.createTime, payload.candidates, payload.localId, payload.svrId)
        break
      case 'getVoiceDataBatch':
        result = await core.getVoiceDataBatch(payload.requests)
        break
      case 'getMediaSchemaSummary':
        result = await core.getMediaSchemaSummary(payload.dbPath)
        break
      case 'getHeadImageBuffers':
        result = await core.getHeadImageBuffers(payload.usernames)
        break
      case 'resolveImageHardlink':
        result = await core.resolveImageHardlink(payload.md5, payload.accountDir)
        break
      case 'resolveImageHardlinkBatch':
        result = await core.resolveImageHardlinkBatch(payload.requests)
        break
      case 'resolveVideoHardlinkMd5':
        result = await core.resolveVideoHardlinkMd5(payload.md5, payload.dbPath)
        break
      case 'resolveVideoHardlinkMd5Batch':
        result = await core.resolveVideoHardlinkMd5Batch(payload.requests)
        break
      case 'getSnsTimeline':
        result = await core.getSnsTimeline(payload.limit, payload.offset, payload.usernames, payload.keyword, payload.startTime, payload.endTime)
        break
      case 'getSnsAnnualStats':
        result = await core.getSnsAnnualStats(payload.beginTimestamp, payload.endTimestamp)
        break
      case 'getSnsUsernames':
        result = await core.getSnsUsernames()
        break
      case 'getSnsExportStats':
        result = await core.getSnsExportStats(payload.myWxid)
        break
      case 'checkMessageAntiRevokeTriggers':
        result = await core.checkMessageAntiRevokeTriggers(payload.sessionIds)
        break
      case 'installMessageAntiRevokeTriggers':
        result = await core.installMessageAntiRevokeTriggers(payload.sessionIds)
        break
      case 'uninstallMessageAntiRevokeTriggers':
        result = await core.uninstallMessageAntiRevokeTriggers(payload.sessionIds)
        break
      case 'installSnsBlockDeleteTrigger':
        result = await core.installSnsBlockDeleteTrigger()
        break
      case 'uninstallSnsBlockDeleteTrigger':
        result = await core.uninstallSnsBlockDeleteTrigger()
        break
      case 'checkSnsBlockDeleteTrigger':
        result = await core.checkSnsBlockDeleteTrigger()
        break
      case 'deleteSnsPost':
        result = await core.deleteSnsPost(payload.postId)
        break
      case 'getLogs':
        result = await core.getLogs()
        break
      case 'verifyUser':
        result = await core.verifyUser(payload.message, payload.hwnd)
        break
      case 'updateMessage':
        result = await core.updateMessage(payload.sessionId, payload.localId, payload.createTime, payload.newContent)
        break
      case 'deleteMessage':
        result = await core.deleteMessage(payload.sessionId, payload.localId, payload.createTime, payload.dbPathHint)
        break
      case 'cloudInit':
        result = await core.cloudInit(payload.intervalSeconds)
        break
      case 'cloudReport':
        result = await core.cloudReport(payload.statsJson)
        break
      case 'cloudStop':
        result = core.cloudStop()
        break
      case 'shutdown':
        result = { success: true }
        break
      default:
        result = { success: false, error: `Unknown method: ${type}` }
    }
  } catch (e) {
    return { error: String(e) }
  }
  return { result }
}

function reply(msg: { id: number }, resp: { result?: any; error?: string }) {
  if (shutdownRequested) return
  try {
    if (resp.error) {
      process.send!({ id: msg.id, error: resp.error })
    } else {
      process.send!({ id: msg.id, result: resp.result })
    }
  } catch { /* 父进程已断开 */ }
}

process.on('message', (msg: { id?: number; type?: string; payload?: any }) => {
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return
  const type = String(msg.type || '')
  const payload = msg.payload || {}

  if (type === 'shutdown') {
    shutdownRequested = true
    try { core.close() } catch { /* noop */ }
    try { process.send!({ id: msg.id, result: { success: true } }) } catch { /* noop */ }
    // 等待响应送达后退出
    setTimeout(() => process.exit(0), 50)
    return
  }

  void dispatch(type, payload).then((resp) => reply(msg as { id: number }, resp))
})

// 父进程断开（退出/崩溃）后立即收尾，避免残留
process.on('disconnect', () => {
  try { core.close() } catch { /* noop */ }
  process.exit(0)
})

void electronGuard
