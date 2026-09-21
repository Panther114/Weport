import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { WeBotService, type WeBotDispatchResult } from './weBotService'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weport-webot-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch { /* noop */ }
  }
})

/** 允许测试完全掌控时钟：调度逻辑依赖「现在」。 */
function makeClock(start = new Date(2026, 2, 10, 7, 0, 0).getTime()) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
      return current
    },
    set: (ms: number) => {
      current = ms
      return current
    },
  }
}

function makeService(
  options: {
    clock?: ReturnType<typeof makeClock>
    dispatch?: (signal: AbortSignal) => Promise<WeBotDispatchResult>
    notify?: (note: unknown) => void
    onRunStarted?: (run: unknown) => void
  } = {}
) {
  const dir = makeDir()
  const clock = options.clock ?? makeClock()
  let maxConcurrent = 0
  let concurrent = 0
  const started: number[] = []

  const service = new WeBotService({
    dataDir: dir,
    now: clock.now,
    dispatch: async (_request, signal) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      started.push(clock.now())
      try {
        return options.dispatch ? await options.dispatch(signal) : { summary: '完成', title: '结果' }
      } finally {
        concurrent -= 1
      }
    },
    notify: options.notify as never,
    onRunStarted: options.onRunStarted as never,
  })

  return { service, clock, dir, stats: () => ({ maxConcurrent, started }) }
}

const daily = (hour: number, minute: number) => ({ kind: 'daily' as const, hour, minute })

describe('WeBotService — 任务 CRUD 与持久化', () => {
  it('创建任务时就算出下一次执行时间', () => {
    const { service } = makeService()
    const task = service.createTask({ title: '晨读总结', schedule: daily(8, 30) })
    expect(task.nextRunAt).toBe(new Date(2026, 2, 10, 8, 30).getTime())
    expect(task.enabled).toBe(true)
  })

  it('重启后任务、笔记与 nextRunAt 都能恢复', async () => {
    const clock = makeClock()
    const { service, dir } = makeService({ clock })
    service.createTask({ title: 'A', schedule: daily(8, 30) })
    clock.set(new Date(2026, 2, 10, 8, 30, 1).getTime())
    await service['tick']()

    const reopened = new WeBotService({
      dataDir: dir,
      now: clock.now,
      dispatch: async () => ({ summary: 'x' }),
    })
    const tasks = reopened.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('A')
    expect(reopened.listNotes()).toHaveLength(1)
    // nextRunAt 必须已经推进到下一次，而不是停在刚刚执行过的时刻
    expect(tasks[0].nextRunAt).toBe(new Date(2026, 2, 11, 8, 30).getTime())
  })

  it('状态文件损坏时从空状态启动，而不是整个功能崩掉', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'webot.json'), '{ this is not json', 'utf8')
    const service = new WeBotService({ dataDir: dir, dispatch: async () => ({ summary: 'x' }) })
    expect(service.listTasks()).toEqual([])
  })

  it('更新 schedule 会重算 nextRunAt；停用则清空', () => {
    const { service } = makeService()
    const task = service.createTask({ title: 'A', schedule: daily(8, 30) })
    const updated = service.updateTask(task.id, { schedule: daily(21, 0) })!
    expect(updated.nextRunAt).toBe(new Date(2026, 2, 10, 21, 0).getTime())

    const disabled = service.updateTask(task.id, { enabled: false })!
    expect(disabled.nextRunAt).toBeNull()
  })

  it('删除任务不会连带删除已有笔记（结果可能被用户长期保留）', async () => {
    const clock = makeClock()
    const { service } = makeService({ clock })
    const task = service.createTask({ title: 'A', schedule: daily(8, 30) })
    await service.runNow(task.id)
    expect(service.listNotes()).toHaveLength(1)

    expect(service.deleteTask(task.id)).toBe(true)
    expect(service.listNotes()).toHaveLength(1)
    expect(service.listNotes()[0].taskTitle).toBe('A')
  })
})

/**
 * 运行记录（v1.0.1）：用户要能看到任务**跑过什么**，而不只是最后一次的成败。
 *
 * 起因是那句「上次失败：fetch failed」——界面上只有一行截断过的错误，既没有
 * 时间、也没有历史，用户无从判断是一次网络抖动还是配置坏了。
 */
describe('WeBotService — 运行记录', () => {
  it('开始时回调一次 running 记录，结束时同一条变成 ok', async () => {
    const clock = makeClock()
    const seen: Array<{ id: string; status: string; taskId: string }> = []
    const { service } = makeService({ clock, onRunStarted: (run) => seen.push(run as never) })
    const task = service.createTask({ title: '作业整理', schedule: daily(8, 30) })

    await service.runNow(task.id)

    expect(seen).toHaveLength(1)
    expect(seen[0].status).toBe('running')
    expect(seen[0].taskId).toBe(task.id)
    // 同一条记录在历史里变成 ok（不是新增一条），否则日志会把一次运行算成两次
    const runs = service.listRuns(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe(seen[0].id)
    expect(runs[0].status).toBe('ok')
    expect(runs[0].noteId).toBeTruthy()
  })

  it('失败时错误文本完整留档（不再只有一句话的截断），并且也有笔记', async () => {
    const clock = makeClock()
    const { service } = makeService({
      clock,
      dispatch: async () => {
        throw new Error('网络请求失败：api.example.com 域名解析失败（ENOTFOUND）')
      },
    })
    const task = service.createTask({ title: 'A', schedule: daily(8, 30) })
    await service.runNow(task.id)

    const [run] = service.listRuns(task.id)
    expect(run.status).toBe('error')
    expect(run.error).toContain('ENOTFOUND')
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
    expect(run.noteId).toBeTruthy()
    expect(service.listNotes()[0].status).toBe('error')
  })

  it('历史按任务分组时保留多次运行（listRuns 不折叠）', async () => {
    const clock = makeClock()
    const { service } = makeService({ clock })
    const task = service.createTask({ title: 'A', schedule: daily(8, 30) })
    await service.runNow(task.id)
    clock.advance(60_000)
    await service.runNow(task.id)

    const runs = service.listRuns(task.id)
    expect(runs).toHaveLength(2)
    // 最新在前，界面直接按顺序渲染
    expect(runs[0].startedAt).toBeGreaterThan(runs[1].startedAt)
  })
})

describe('WeBotService — 调度行为', () => {
  it('多个任务同时到期时默认**串行**执行', async () => {
    const clock = makeClock()
    const { service, stats } = makeService({ clock })
    // 三个任务同一时刻到期、都不允许并发
    for (const title of ['A', 'B', 'C']) {
      service.createTask({ title, schedule: daily(8, 0) })
    }
    clock.set(new Date(2026, 2, 10, 8, 0, 1).getTime())
    await service['tick']()

    expect(stats().started).toHaveLength(3)
    expect(stats().maxConcurrent).toBe(1)
  })

  it('显式勾选并发的任务可以重叠', async () => {
    const clock = makeClock()
    const { service, stats } = makeService({
      clock,
      dispatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { summary: 'x' }
      },
    })
    service.createTask({ title: 'A', schedule: daily(8, 0), allowParallel: true })
    service.createTask({ title: 'B', schedule: daily(8, 0), allowParallel: true })
    clock.set(new Date(2026, 2, 10, 8, 0, 1).getTime())
    await service['tick']()

    expect(stats().maxConcurrent).toBe(2)
  })

  it('同一时刻不会被第二个 tick 重复执行（nextRunAt 必须推进）', async () => {
    const clock = makeClock()
    const { service, stats } = makeService({ clock })
    service.createTask({ title: 'A', schedule: daily(8, 0) })
    clock.set(new Date(2026, 2, 10, 8, 0, 1).getTime())

    await service['tick']()
    await service['tick']()
    await service['tick']()

    expect(stats().started).toHaveLength(1)
  })

  it('停用的任务不会被执行', async () => {
    const clock = makeClock()
    const { service, stats } = makeService({ clock })
    service.createTask({ title: 'A', schedule: daily(8, 0), enabled: false })
    clock.set(new Date(2026, 2, 10, 8, 0, 1).getTime())
    await service['tick']()
    expect(stats().started).toHaveLength(0)
  })

  it('休眠多天后按 once 策略补最近一次，而不是把积压全部重放', async () => {
    // 07:00 创建（今天 08:30 还没到），08:30:01 时应当执行第一次。
    const clock = makeClock(new Date(2026, 2, 1, 7, 0, 0).getTime())
    const { service, stats } = makeService({ clock })
    service.createTask({ title: 'A', schedule: daily(8, 30), catchUp: 'once' })
    clock.set(new Date(2026, 2, 1, 8, 30, 1).getTime())
    await service['tick']()
    expect(stats().started).toHaveLength(1)

    // 休眠 9 天：只补最近一次，不是把 9 次全部重放
    clock.set(new Date(2026, 2, 10, 12, 0).getTime())
    await service['tick']()
    expect(stats().started).toHaveLength(2)
  })

  it('hasEnabledTasks 反映是否还有启用中的任务（退出前提醒用）', () => {
    const { service } = makeService()
    const task = service.createTask({ title: 'A', schedule: daily(8, 0) })
    expect(service.hasEnabledTasks()).toBe(true)
    service.updateTask(task.id, { enabled: false })
    expect(service.hasEnabledTasks()).toBe(false)
  })
})

describe('WeBotService — 笔记', () => {
  it('成功与失败都留下笔记，并把状态带上', async () => {
    const clock = makeClock()
    let fail = false
    const { service } = makeService({
      clock,
      dispatch: async () => {
        if (fail) throw new Error('模型调用失败：429')
        return { summary: '今天的作业是第 3-5 题', title: '作业' }
      },
    })
    const task = service.createTask({ title: '作业整理', schedule: daily(8, 0), references: [{ id: 'g1', label: '化学', kind: 'group' }] })

    await service.runNow(task.id)
    fail = true
    await service.runNow(task.id)

    const notes = service.listNotes()
    expect(notes).toHaveLength(2)
    expect(notes[0].status).toBe('error')
    expect(notes[0].summary).toContain('429')
    expect(notes[1].status).toBe('ok')
    expect(notes[1].summary).toContain('第 3-5 题')
    // 引用随笔记一起保存：外部集成需要知道这份笔记是关于哪些会话的
    expect(notes[1].references).toEqual([{ id: 'g1', label: '化学', kind: 'group' }])
  })

  it('笔记默认未读，可标记已读与置顶', async () => {
    const clock = makeClock()
    const { service } = makeService({ clock })
    const task = service.createTask({ title: 'A', schedule: daily(8, 0) })
    await service.runNow(task.id)

    expect(service.unreadNoteCount()).toBe(1)
    const note = service.listNotes()[0]
    service.updateNote(note.id, { read: true, pinned: true })
    expect(service.unreadNoteCount()).toBe(0)
    expect(service.getNote(note.id)?.pinned).toBe(true)
  })

  it('置顶的笔记不会被淘汰', async () => {
    const clock = makeClock()
    const dir = makeDir()
    // 用很小的保留上限来验证淘汰规则，而不是真写 500 条。
    const service = new WeBotService({
      dataDir: dir,
      now: clock.now,
      maxNotes: 5,
      dispatch: async () => ({ summary: '完成' }),
    })
    const task = service.createTask({ title: 'A', schedule: daily(8, 0) })
    await service.runNow(task.id)
    const pinnedId = service.listNotes()[0].id
    service.updateNote(pinnedId, { pinned: true })

    for (let i = 0; i < 20; i += 1) {
      clock.advance(1000)
      await service.runNow(task.id)
    }

    const notes = service.listNotes({ limit: 500 })
    expect(notes.length).toBeLessThanOrEqual(6)
    expect(notes.some((note) => note.id === pinnedId)).toBe(true)
  })

  it('notify 回调在每次运行后触发（用于右上角弹窗）', async () => {
    const clock = makeClock()
    const seen: string[] = []
    const { service } = makeService({ clock, notify: (note) => seen.push((note as { status: string }).status) })
    const task = service.createTask({ title: 'A', schedule: daily(8, 0) })
    await service.runNow(task.id)
    expect(seen).toEqual(['ok'])
  })

  it('运行历史记录状态与耗时', async () => {
    const clock = makeClock()
    const { service } = makeService({ clock })
    const task = service.createTask({ title: 'A', schedule: daily(8, 0) })
    await service.runNow(task.id)
    const runs = service.listRuns(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('ok')
    expect(runs[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(runs[0].noteId).toBeTruthy()
  })
})

describe('WeBotService — 状态文件', () => {
  it('写入是原子的（存在 .tmp 中转，最终文件始终是合法 JSON）', async () => {
    const clock = makeClock()
    const { service, dir } = makeService({ clock })
    service.createTask({ title: 'A', schedule: daily(8, 0) })
    const raw = readFileSync(join(dir, 'webot.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(JSON.parse(raw).tasks).toHaveLength(1)
  })

  it('stop() 会中止正在运行的任务', async () => {
    const clock = makeClock()
    let aborted = false
    const { service } = makeService({
      clock,
      dispatch: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('已中止'))
          })
        }),
    })
    const task = service.createTask({ title: 'A', schedule: daily(8, 0) })
    const running = service.runNow(task.id)
    service.stop()
    await running
    expect(aborted).toBe(true)
    expect(service.listRuns(task.id)[0].status).toBe('skipped')
  })
})
