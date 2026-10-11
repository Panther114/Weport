import { afterEach, describe, expect, it } from 'vitest'
import { exportTaskControlService as service } from './exportTaskControlService'

const ids = ['lifecycle-cancel', 'lifecycle-pause']
afterEach(() => ids.forEach(id => service.releaseTask(id)))

describe('export task lifetime guards', () => {
  it('keeps cancellation requested tasks active until their finally releases them', () => {
    service.createControl(ids[0], '/fixture-export')
    expect(service.cancelTask(ids[0])).toBe(true)
    expect(service.hasActiveTasks()).toBe(true)
    service.releaseTask(ids[0])
    expect(service.hasActiveTasks()).toBe(false)
  })

  it('keeps paused tasks active and accounts for another task released first', () => {
    service.createControl(ids[0], '/fixture-export')
    service.createControl(ids[1], '/fixture-export')
    expect(service.pauseTask(ids[1])).toBe(true)
    service.releaseTask(ids[0])
    expect(service.hasActiveTasks()).toBe(true)
    service.releaseTask(ids[1])
    expect(service.hasActiveTasks()).toBe(false)
  })
})
