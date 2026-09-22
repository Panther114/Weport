import { describe, expect, it } from 'vitest'
import { TASK_KEY, TaskStatusService } from './taskStatusService'

/**
 * 主进程侧的任务状态快照（v1.0.1）。
 *
 * 它是"窗口被销毁重建后还能看到进度"这件事的**唯一**依据：渲染进程可以被
 * 整个换掉（托盘隐藏销毁窗口 / 最小化 unload），主进程不会。所以这里的每条
 * 断言都在守一个具体的可见故障。
 */

describe('终态必须显式写入', () => {
  it('从未 begin 过的任务读出来是 idle，而不是 running', () => {
    const svc = new TaskStatusService()
    expect(svc.get('nope').status).toBe('idle')
    expect(svc.get('nope').progress).toBe(0)
  })

  it('进度到 100 不等于完成（一次生成有三个阶段，每段都可能到 100）', () => {
    const svc = new TaskStatusService()
    svc.begin(TASK_KEY.wecloneGenerate, '开始')
    svc.progress(TASK_KEY.wecloneGenerate, { stage: 'scan', progress: 100 })
    expect(svc.get(TASK_KEY.wecloneGenerate).status).toBe('running')
    svc.progress(TASK_KEY.wecloneGenerate, { stage: 'generate', progress: 0 })
    expect(svc.get(TASK_KEY.wecloneGenerate).status).toBe('running')
  })

  it('end(done) 才把状态置为 done 并把进度钉在 100', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { message: '跑到一半' })
    svc.end('t', 'done', { message: '完成' })
    const snap = svc.get('t')
    expect(snap.status).toBe('done')
    expect(snap.progress).toBe(100)
    expect(snap.finishedAt).toBeGreaterThan(0)
    expect(snap.message).toBe('完成')
  })

  it('取消是 aborted，不是 done —— 一次取消不该显示成成功', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { progress: 80 })
    svc.end('t', 'aborted', { message: '已取消' })
    expect(svc.get('t').status).toBe('aborted')
    // 取消时不该把进度顶到 100（那会读成"跑完了"）
    expect(svc.get('t').progress).toBe(80)
  })

  it('失败带上原因，界面才能说出来', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.end('t', 'failed', { error: '网络断了', message: '生成失败' })
    expect(svc.get('t').status).toBe('failed')
    expect(svc.get('t').error).toBe('网络断了')
  })
})

describe('进度单调不减', () => {
  it('阶段切换导致百分比回跳时，存下来的是较大的那个', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { stage: 'scan', progress: 46 })
    svc.progress('t', { stage: 'generate', progress: 2 }) // 回跳
    expect(svc.get('t').progress).toBe(46)
  })

  it('被夹在 0-100 内（主进程算错也不会把界面顶出界）', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { progress: 9999 })
    expect(svc.get('t').progress).toBe(100)
    svc.progress('t', { progress: -5 })
    expect(svc.get('t').progress).toBe(100)
  })

  it('begin 会把进度清零（新一轮任务从 0 开始）', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { progress: 100 })
    svc.begin('t', '再来一次')
    expect(svc.get('t').progress).toBe(0)
    expect(svc.get('t').logs).toEqual(['再来一次'])
  })
})

describe('日志环形缓冲', () => {
  it('连续重复的消息只记一次（防止一条进度刷屏）', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { message: '扫描中…' })
    svc.progress('t', { message: '扫描中…' })
    svc.progress('t', { message: '扫描中…' })
    expect(svc.get('t').logs).toEqual(['扫描中…'])
  })

  it('log:false 的进度只更新文案、不进日志（导出每 400ms 一条会冲掉全部日志）', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { message: '第 1/189 个会话', log: false })
    expect(svc.get('t').message).toBe('第 1/189 个会话')
    expect(svc.get('t').logs).toEqual([])
  })

  it('日志有上限，超出的丢最旧的', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    for (let i = 0; i < 260; i += 1) svc.progress('t', { message: `第 ${i} 步` })
    const logs = svc.get('t').logs
    expect(logs.length).toBeLessThanOrEqual(200)
    expect(logs[logs.length - 1]).toBe('第 259 步')
  })
})

describe('all() 是窗口重建时的唯一来源', () => {
  it('返回每个任务各自的快照，且是深拷贝（调用方改不坏内部状态）', () => {
    const svc = new TaskStatusService()
    svc.begin(TASK_KEY.export, '准备中')
    svc.progress(TASK_KEY.export, { progress: 50, message: '一半' })
    svc.begin(TASK_KEY.connect, '连接中')

    const all = svc.all()
    expect(all[TASK_KEY.export].progress).toBe(50)
    expect(all[TASK_KEY.connect].message).toBe('连接中')

    all[TASK_KEY.export].logs.push('伪造的一行')
    all[TASK_KEY.export].progress = 1
    expect(svc.get(TASK_KEY.export).logs).not.toContain('伪造的一行')
    expect(svc.get(TASK_KEY.export).progress).toBe(50)
  })

  it('detail 累积合并（导出要分多次把 taskId / total / phase 补齐）', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.progress('t', { detail: { taskId: 'export-1' } })
    svc.progress('t', { detail: { total: 189 } })
    expect(svc.get('t').detail).toEqual({ taskId: 'export-1', total: 189 })
  })

  it('reset 回到 idle（测试与手动清理用）', () => {
    const svc = new TaskStatusService()
    svc.begin('t')
    svc.reset('t')
    expect(svc.get('t').status).toBe('idle')
    expect(svc.get('t').logs).toEqual([])
  })
})
