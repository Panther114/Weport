import { beforeEach, describe, expect, it } from 'vitest'
import { ProviderProfileService } from './providerProfiles'
import type { ProviderConsumer } from './providerTypes'

/**
 * 每个功能面各自指向哪个服务。
 *
 * 这里防守的是一个具体的回归：v1.0.1 之前 WeClone 的 `ensureForcedProvider()` 会
 * 直接 `activate()` 一个它自己新建的 profile，而那是**全局**默认 —— 于是打开一次
 * 「人格克隆 · 新建」就把 WeportAI 与 WeBot 的服务一起换掉了。
 */

/** 只实现 ProviderProfileService 需要的那两个方法。 */
function makeConfig(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => { store.set(key, value) },
    dump: () => Object.fromEntries(store),
  }
}

const profileInput = (name: string, model: string) => ({
  id: '',
  name,
  providerId: 'deepseek',
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://api.deepseek.com',
  model,
  apiKey: `sk-${model}`,
})

describe('ProviderProfileService · 功能面服务分配', () => {
  let config: ReturnType<typeof makeConfig>
  let service: ProviderProfileService

  beforeEach(() => {
    config = makeConfig()
    service = new ProviderProfileService(config as never)
  })

  it('没有单独指定时，三个功能面都跟随默认服务', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    service.save(profileInput('服务 B', 'model-b'))
    service.activate(a.id)

    const assignments = service.consumerAssignments()
    expect(assignments.map((item) => item.consumer)).toEqual(['chat', 'weclone', 'webot'])
    for (const item of assignments) {
      expect(item.profileId).toBe(a.id)
      expect(item.followsDefault).toBe(true)
    }
  })

  it('单独指定一个功能面时，只有它改变，默认服务不受影响', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    const b = service.save(profileInput('服务 B', 'model-b'))
    service.activate(a.id)
    expect(service.assign('weclone', b.id)).toBe(true)

    const byConsumer = Object.fromEntries(service.consumerAssignments().map((item) => [item.consumer, item]))
    expect(byConsumer.weclone.profileId).toBe(b.id)
    expect(byConsumer.weclone.followsDefault).toBe(false)
    expect(byConsumer.chat.profileId).toBe(a.id)
    expect(byConsumer.webot.profileId).toBe(a.id)
    // 关键：默认服务本身没有被改写。
    expect(service.getActive()?.id).toBe(a.id)
  })

  it('getForConsumer 返回该功能面真正会用的 profile', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    const b = service.save(profileInput('服务 B', 'model-b'))
    service.activate(a.id)
    service.assign('webot', b.id)

    expect(service.getForConsumer('chat')?.id).toBe(a.id)
    expect(service.getForConsumer('webot')?.id).toBe(b.id)
    expect(service.getForConsumer('weclone')?.id).toBe(a.id)
  })

  it('传空字符串即恢复跟随默认', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    const b = service.save(profileInput('服务 B', 'model-b'))
    service.activate(a.id)
    service.assign('weclone', b.id)
    service.assign('weclone', '')

    expect(service.getForConsumer('weclone')?.id).toBe(a.id)
    expect(service.consumerAssignments().find((item) => item.consumer === 'weclone')?.followsDefault).toBe(true)
  })

  it('指定不存在的服务会被拒绝，不改动现有分配', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    service.activate(a.id)
    expect(service.assign('chat', 'profile-does-not-exist')).toBe(false)
    expect(service.getForConsumer('chat')?.id).toBe(a.id)
  })

  it('删除服务时，指向它的分配一起清掉（不留悬空 id）', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    const b = service.save(profileInput('服务 B', 'model-b'))
    service.activate(a.id)
    service.assign('weclone', b.id)
    service.remove(b.id)

    // 悬空 id 会让它悄悄回落到默认服务，而设置页仍显示"已单独指定"。
    const weclone = service.consumerAssignments().find((item) => item.consumer === 'weclone')
    expect(weclone?.followsDefault).toBe(true)
    expect(weclone?.profileId).toBe(a.id)
    expect(service.getForConsumer('weclone')?.id).toBe(a.id)
  })

  it('分配写入后重新读取仍然存在（走的是同一个加密 blob）', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    const b = service.save(profileInput('服务 B', 'model-b'))
    service.activate(a.id)
    service.assign('webot', b.id)

    const reopened = new ProviderProfileService(config as never)
    expect(reopened.getForConsumer('webot')?.id).toBe(b.id)
    expect(reopened.getActive()?.id).toBe(a.id)
  })

  it('删除默认服务后默认落到剩下的第一个，分配不受影响', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    const b = service.save(profileInput('服务 B', 'model-b'))
    service.activate(a.id)
    service.assign('weclone', b.id)
    service.remove(a.id)

    expect(service.getActive()?.id).toBe(b.id)
    expect(service.getForConsumer('weclone')?.id).toBe(b.id)
  })

  it('三个功能面可以指向三个不同的服务', () => {
    const a = service.save(profileInput('服务 A', 'model-a'))
    const b = service.save(profileInput('服务 B', 'model-b'))
    const c = service.save(profileInput('服务 C', 'model-c'))
    service.activate(a.id)
    service.assign('webot', b.id)
    service.assign('weclone', c.id)

    const consumers: ProviderConsumer[] = ['chat', 'webot', 'weclone']
    expect(consumers.map((consumer) => service.getForConsumer(consumer)?.id)).toEqual([a.id, b.id, c.id])
    // 默认服务仍是 A —— 单独指定不该顺带改默认。
    expect(service.getActive()?.id).toBe(a.id)
  })
})
