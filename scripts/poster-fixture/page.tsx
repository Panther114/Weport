/**
 * 海报页夹具（v1.2 §4，**不进产品包**）：把真正的 `<PosterPage/>` 挂起来跑一遍。
 *
 * 为什么需要它：`vitest` 的 environment 是 `node`（没有 DOM），所以组件树本身
 * 从来没被验证过 —— 只在浏览器里挂一次才能发现"渲染即报错""点一下没反应"
 * 这类问题（例如浮层的锚点为空、防抖 effect 死循环）。
 *
 * 桥接（`window.electronAPI`）在这里只实现**海报页真正会用的那几个通道**，
 * 并且刻意留两个缺口：
 *  - `chat:getMessages` 有 → 能验证"载入会话消息 → 归一化 → 预览里出现气泡与马赛克"；
 *  - `poster:saveImage` **故意不给** → 验证导出走 `<a download>` 回退时，
 *    界面上确实说出了"引擎保存通道未接入"，而不是假装保存成功。
 */
import { createRoot } from 'react-dom/client'
import PosterPage from '../../src/pages/PosterPage.tsx'
// 与 App.tsx 同一组样式入口（顺序照抄），否则截图里的骨架（.v09-page / .annual-head /
// .ghost-btn）会缺样式，看起来像页面坏了
import '../../src/styles.css'
import '../../src/styles/v09.scss'
import '../../src/styles/v1.scss'
import '../../src/styles/theme.scss'

const TS = 1_790_390_545_000

function fakeSessions() {
    return [
        { username: 'family@chatroom', displayName: '家庭群', sortTimestamp: TS / 1000, messageCountHint: 42, summary: '明天见' },
        { username: 'wxid_pal', displayName: '老李', sortTimestamp: TS / 1000 - 3600, messageCountHint: 12, summary: '收到' },
    ]
}

function fakeMessages(count = 14) {
    return Array.from({ length: count }, (_, index) => ({
        messageKey: `m${index}`,
        localId: 1000 + index,
        createTime: TS / 1000 + index * 60,
        isSend: index % 3 === 0 ? 1 : 0,
        senderUsername: index % 2 === 0 ? 'wxid_zhang' : 'wxid_li',
        senderDisplayName: index % 2 === 0 ? '张三丰' : '李四',
        localType: 1,
        parsedContent: [
            '明天下午三点在老地方见，我的手机号 13812345678。',
            '我的 wxid_abc1234xyz，你加一下我。',
            '收到，寄到北京市海淀区中关村大街1号就行。',
            '验证码 867530，别告诉别人。',
        ][index % 4],
    }))
}

type AnyRecord = Record<string, unknown>

function installBridge() {
    const bridge: AnyRecord = {
        chat: {
            getSessions: async () => ({ success: true, sessions: fakeSessions() }),
            getMessages: async (_sessionId: string, offset = 0, limit = 60) => {
                const all = fakeMessages(24)
                const slice = all.slice(offset, offset + limit)
                return { success: true, messages: slice, hasMore: offset + limit < all.length, nextOffset: offset + limit }
            },
        },
        sns: {},
        config: { get: async () => '', set: async () => ({ success: true }) },
        // 故意不给 poster.saveImage：验证回退路径的文案
    }
    ;(window as unknown as { electronAPI: AnyRecord }).electronAPI = bridge
}

installBridge()

const host = document.getElementById('root')
if (!host) throw new Error('缺少 #root')
createRoot(host).render(<PosterPage />)

// 页面挂载完成的信号（harness 等它）
window.setTimeout(() => {
    ;(window as unknown as { __posterPageReady?: boolean }).__posterPageReady = true
}, 0)
