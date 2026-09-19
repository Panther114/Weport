import { useSyncExternalStore } from 'react'
import { liveTask, type LiveTaskState } from '../utils/liveTask'

/**
 * 订阅一个长任务的 store。
 *
 * 只做一件事：把 `LiveTask` 接到 React 上。任务本身的接线（IPC 订阅 +
 * 挂载时向主进程要一次状态）在 `utils/liveTaskWiring.ts` 里，由 `main.tsx`
 * 在**应用启动时**装好 —— 不等任何页面挂载。这是关键：接线必须比页面活得久，
 * 否则"切走再切回来"仍然会丢状态，只是丢得晚一点。
 */
export function useLiveTask(key: string): LiveTaskState {
  const task = liveTask(key)
  return useSyncExternalStore(task.subscribe, task.getState, task.getState)
}
