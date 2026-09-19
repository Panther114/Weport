import { beforeEach, describe, expect, it } from 'vitest'
import { hydrateFromSnapshots } from './liveTaskWiring'
import { LIVE_TASK, liveTask, resetAllLiveTasks } from './liveTask'

/**
 * 主进程快照 → 本地 store 的灌入规则（v1.0.1）。
 *
 * 这是"窗口被销毁重建后进度还在不在"的唯一入口。两条规则必须分开：
 * - **运行中的快照永远灌**：那正是要找回来的东西；
 * - **过期的终态不灌**：主进程里躺着一个三天前的"生成完成"，重建后的界面
 *   不该冒出一张属于上个世纪的完成卡片。
 */

beforeEach(() => {
  resetAllLiveTasks()
})

describe('运行中的快照总是被采纳', () => {
  it('空 store 会被填成运行中（这正是窗口重建的场景）', () => {
    hydrateFromSnapshots({
      [LIVE_TASK.wecloneGenerate]: {
        status: 'running',
        stage: 'generate',
        progress: 62,
        message: '已提炼 12/48 段历史',
        logs: ['扫描会话 1/189'],
        startedAt: 1000,
      },
    })
    const state = liveTask(LIVE_TASK.wecloneGenerate).getState()
    expect(state.status).toBe('running')
    expect(state.progress).toBe(62)
    expect(state.logs).toEqual(['扫描会话 1/189'])
  })

  it('本地更新的状态不会被旧快照盖回去', () => {
    liveTask(LIVE_TASK.export).update({ status: 'done', progress: 100, message: '导出完成' })
    hydrateFromSnapshots({
      [LIVE_TASK.export]: { status: 'running', progress: 20, message: '旧的' },
    })
    expect(liveTask(LIVE_TASK.export).getState().status).toBe('done')
  })
})

describe('终态快照有有效期', () => {
  const now = 10_000_000

  it('刚结束的终态会被采纳（用户刚点完取消，马上切回来）', () => {
    hydrateFromSnapshots(
      { [LIVE_TASK.wecloneGenerate]: { status: 'aborted', message: '已取消', finishedAt: now - 5_000, progress: 40 } },
      now
    )
    expect(liveTask(LIVE_TASK.wecloneGenerate).getState().status).toBe('aborted')
  })

  it('几小时前的终态不会被灌进来（否则界面会冒出一张过期的完成卡片）', () => {
    hydrateFromSnapshots(
      {
        [LIVE_TASK.wecloneGenerate]: {
          status: 'done',
          message: '生成完成',
          finishedAt: now - 3 * 60 * 60 * 1000,
          progress: 100,
        },
      },
      now
    )
    expect(liveTask(LIVE_TASK.wecloneGenerate).getState().status).toBe('idle')
  })

  it('没有 finishedAt 的终态也当作过期（时间不明就不敢显示）', () => {
    hydrateFromSnapshots({ [LIVE_TASK.export]: { status: 'done', message: '导出完成', progress: 100 } }, now)
    expect(liveTask(LIVE_TASK.export).getState().status).toBe('idle')
  })
})

describe('坏输入不影响其它任务', () => {
  it('null / 非对象 / 未知状态一律忽略', () => {
    expect(() => hydrateFromSnapshots(null)).not.toThrow()
    expect(() => hydrateFromSnapshots(undefined)).not.toThrow()
    expect(() => hydrateFromSnapshots({ [LIVE_TASK.export]: { status: 'weird' } })).not.toThrow()
    expect(liveTask(LIVE_TASK.export).getState().status).toBe('idle')
  })

  it('idle 的快照不会把本地运行中的状态清掉（快照可能比本地旧）', () => {
    liveTask(LIVE_TASK.connect).update({ status: 'running', message: '正在连接…' })
    hydrateFromSnapshots({ [LIVE_TASK.connect]: { status: 'idle', progress: 0, message: '' } })
    expect(liveTask(LIVE_TASK.connect).getState().status).toBe('running')
  })

  it('只灌认识的任务键，未知键被忽略', () => {
    hydrateFromSnapshots({ 'some.other.task': { status: 'running', progress: 50, message: 'x' } })
    expect(liveTask(LIVE_TASK.export).getState().status).toBe('idle')
  })
})
