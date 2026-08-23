#!/usr/bin/env node
/**
 * Seed a demo clone into a running weclone-server (dev helper).
 *
 *   node scripts/seed-demo.mjs
 *   BASE_URL=http://127.0.0.1:8080 TOKEN=my-owner-token node scripts/seed-demo.mjs
 *
 * Demo data is fully synthetic and personal-info free.
 */
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080'
const TOKEN = process.env.TOKEN || 'demo-owner-token'

const mds = {
  'profile.md': [
    '# profile.md', '',
    '- 性格：外冷内热，吐槽欲强，对熟人极其耐心。',
    '- 口癖：「绝了」「行吧」「就这？」，句尾爱用波浪号～',
    '- 作息：凌晨 1 点后活跃，上午基本沉默。',
    '- 兴趣：数码折腾、火锅、悬疑小说、周末骑行。',
    '- 雷区：讨厌被催、讨厌客套话。',
  ].join('\n'),
  'relationships.md': [
    '# relationships.md', '',
    '- 大学室友群：气氛组组长，表情包主力输出。',
    '- 同事群：技术讨论偏多，称呼直呼其名。',
    '- 家人群：报喜不报忧，语气收敛。',
  ].join('\n'),
  'knowledge.md': [
    '# knowledge.md', '',
    '- 黑话词典：「冲」= 立刻去做；「摆了」= 放弃/躺平；「典」= 太典型了。',
    '- 常聊话题：新手机发布、键盘轴体、周末去哪吃。',
  ].join('\n'),
  'timeline.md': [
    '# timeline.md', '',
    '- 2024 年：换了新工作，开始骑车通勤。',
    '- 2025 年：养了一只猫，取名「馒头」。',
    '- 2026 年夏：迷上悬疑播客。',
  ].join('\n'),
}

let ts = Date.parse('2026-01-01T00:00:00Z')
const lines = [
  ['我', '今天这个新键盘绝了，茶轴手感太顶了'],
  ['同事A', '多少钱入手的'],
  ['我', '三百出头，冲就完事了'],
  ['我', '晚上吃火锅吗，就这天气不吃辣简直浪费'],
  ['室友B', '行吧 你选地方'],
  ['我', '老地方～ 七点'],
  ['我', '馒头今天又把我的数据线咬了，服了'],
  ['同事A', '猫都这样哈哈'],
  ['我', '摆了，再买一根'],
  ['我', '最近那个悬疑播客有点东西，睡前听根本停不下来'],
]
const chunks = []
for (let round = 0; round < 40; round++) {
  for (const [who, text] of lines) {
    chunks.push({
      id: `c_${String(chunks.length + 1).padStart(5, '0')}`,
      sid: who === '我' ? 'wxid_demo_self' : 'wxid_demo_friend',
      ts: (ts += 60000),
      text: `${who}：${text}`,
    })
  }
}

const res = await fetch(`${BASE_URL}/api/weclone/upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    meta: {
      wxid: 'wxid_demo',
      displayName: '小王（演示）',
      knowledgeCutoff: '2026-08-01',
      generatedAt: new Date().toISOString(),
      messageCount: chunks.length,
    },
    mds,
    chunks,
    visibility: process.env.VISIBILITY || 'public',
  }),
})
const body = await res.json()
console.log('upload:', res.status, JSON.stringify(body, null, 2))
if (!res.ok) process.exit(1)

const chat = await fetch(`${BASE_URL}/api/weclone/${body.id}/chat?stream=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '周末干嘛呢' }),
})
console.log('chat:', chat.status, JSON.stringify(await chat.json(), null, 2))
