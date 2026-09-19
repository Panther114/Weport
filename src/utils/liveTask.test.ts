import { beforeEach, describe, expect, it } from 'vitest'
import { LIVE_TASK, LiveTask, appendLog, liveTask, resetAllLiveTasks } from './liveTask'

/**
 * 长任务进度存储（v1.0.1）。
 *
 * 这个 store 存在的唯一理由是**页面卸载不该丢掉进度**。所以这里的断言集中在
 * 三件会被误实现的事：终态必须显式、进度不能回退、日志不能无界增长。
 */

beforeEach(() => {
  resetAllLiveTasks()
})

describe('进度单调不减', () => {
  it('阶段切换导致百分比回跳时保持较大值', () => {
    const task = new LiveTask()
    task.update({ status: 'running', stage: 'scan', progress: 46 })
    task.update({ status: 'running', stage: 'generate', progress: 2 })
    expect(task.getState().progress).toBe(46)
    // 但 stage 要跟着变，否则步骤条会指错
    expect(task.getState().stage).toBe('generate')
  })

  it('没有传 progress 时保持原值（只推文案的进度不该把进度条打回 0）', () => {
    const task = new LiveTask()
    task.update({ status: 'running', progress: 70 })
    task.update({ message: '正在归并…' })
    expect(task.getState().progress).toBe(70)
  })

  it('被夹在 0-100 内', () => {
    const task = new LiveTask()
    task.update({ status: 'running', progress: 999 })
    expect(task.getState().progress).toBe(100)
  })

  it('resetProgress 才能把进度拉回 0（开始新一轮）', () => {
    const task = new LiveTask()
    task.update({ status: 'running', progress: 80 })
    task.update({ resetProgress: true, progress: 0 })
    expect(task.getState().progress).toBe(0)
  })
})

describe('终态与时间戳', () => {
  it('start() 清空日志与进度、状态置 running、记录开始时间', () => {
    const task = new LiveTask()
    task.update({ status: 'running', progress: 90, log: '旧的一行' })
    task.start('正在检查配置…')
    const state = task.getState()
    expect(state.status).toBe('running')
    expect(state.progress).toBe(0)
    expect(state.logs).toEqual([])
    expect(state.startedAt).toBeGreaterThan(0)
    expect(state.message).toBe('正在检查配置…')
  })

  it('done / failed / aborted 都会落下 finishedAt', () => {
    for (const status of ['done', 'failed', 'aborted'] as const) {
      const task = new LiveTask()
      task.update({ status: 'running' })
      task.update({ status })
      expect(task.getState().finishedAt, status).toBeGreaterThan(0)
    }
  })

  it('回到 running 时清掉上一次的错误（否则旧报错会挂在新一轮上）', () => {
    const task = new LiveTask()
    task.update({ status: 'failed', error: '网络断了' })
    task.update({ status: 'running', message: '重试中' })
    expect(task.getState().error).toBeUndefined()
  })

  it('状态没变化时不通知订阅者（避免无意义重渲染）', () => {
    const task = new LiveTask()
    let calls = 0
    task.subscribe(() => {
      calls += 1
    })
    task.update({ status: 'running', progress: 10, message: 'a' })
    const after = calls
    task.update({ status: 'running', progress: 10, message: 'a' })
    expect(calls).toBe(after)
  })
})

describe('hydrate：窗口重建后的恢复', () => {
  it('本地还是 idle 时，主进程的运行中快照会被完整灌进来', () => {
    const task = new LiveTask()
    task.hydrate({
      status: 'running',
      stage: 'generate',
      progress: 62,
      message: '已提炼 12/48 段历史',
      logs: ['扫描会话 1/189', '已提炼 12/48 段历史'],
      startedAt: 1000,
    })
    const state = task.getState()
    expect(state.status).toBe('running')
    expect(state.progress).toBe(62)
    expect(state.logs).toHaveLength(2)
    expect(state.startedAt).toBe(1000)
  })

  it('本地已经有更新（非 idle）时，旧的运行中快照不会把它盖回去', () => {
    const task = new LiveTask()
    task.update({ status: 'done', progress: 100, message: '生成完成' })
    task.hydrate({ status: 'running', progress: 30, message: '旧的' })
    expect(task.getState().status).toBe('done')
    expect(task.getState().progress).toBe(100)
  })

  it('终态快照可以覆盖运行中（主进程知道任务已经结束了）', () => {
    const task = new LiveTask()
    task.update({ status: 'running', progress: 80, message: '跑着呢' })
    task.hydrate({ status: 'failed', message: '生成失败', error: '配额超限' })
    expect(task.getState().status).toBe('failed')
    expect(task.getState().error).toBe('配额超限')
    // 进度不回退：80 是已经发生的事实
    expect(task.getState().progress).toBe(80)
  })

  it('空快照不会把已有的日志清掉', () => {
    const task = new LiveTask()
    task.update({ status: 'running', log: '一行' })
    task.hydrate({ status: 'running', progress: 5 })
    expect(task.getState().logs).toHaveLength(1)
  })
})

describe('日志折叠与上限', () => {
  it('连续同一条消息折叠成 ×N（扫描阶段会反复推同一句）', () => {
    let logs: string[] = []
    logs = appendLog(logs, '扫描中…')
    logs = appendLog(logs, '扫描中…')
    logs = appendLog(logs, '扫描中…')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/扫描中… ×3$/)
  })

  it('不同的消息各占一行', () => {
    let logs: string[] = []
    logs = appendLog(logs, '第一步')
    logs = appendLog(logs, '第二步')
    logs = appendLog(logs, '第一步')
    expect(logs).toHaveLength(3)
  })

  it('每行带 HH:MM:SS 时间前缀', () => {
    const logs = appendLog([], '开始')
    expect(logs[0]).toMatch(/^\d{2}:\d{2}:\d{2} 开始$/)
  })

  it('超过上限丢最旧的（一次生成可能推上千条）', () => {
    let logs: string[] = []
    for (let i = 0; i < 50; i += 1) logs = appendLog(logs, `第 ${i} 步`, 10)
    expect(logs).toHaveLength(10)
    expect(logs[logs.length - 1]).toContain('第 49 步')
  })
})

describe('注册表：同一件事只有一个 store', () => {
  it('同名 key 拿到同一个实例（订阅者和发布者不会各写一份）', () => {
    const a = liveTask(LIVE_TASK.wecloneGenerate)
    const b = liveTask(LIVE_TASK.wecloneGenerate)
    expect(a).toBe(b)
  })

  it('不同功能互不影响', () => {
    liveTask(LIVE_TASK.wecloneGenerate).update({ status: 'running', progress: 40 })
    expect(liveTask(LIVE_TASK.export).getState().status).toBe('idle')
  })

  it('resetAllLiveTasks 把所有 store 清回 idle', () => {
    liveTask(LIVE_TASK.export).update({ status: 'running', progress: 10 })
    resetAllLiveTasks()
    expect(liveTask(LIVE_TASK.export).getState().status).toBe('idle')
  })
})
