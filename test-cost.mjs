/**
 * dsh-clinepass 成本投影的测试：峰谷边界、逐请求折叠语义、真实日志回放。
 *
 * 跑法：
 *
 *   node test-cost.mjs
 *
 * 想用真实会话日志再验一次（可选）：
 *
 *   CLINEPASS_SESSION_LOG=/tmp/clinepass-session.jsonl node test-cost.mjs
 *
 * 这里不 import zod：投影定义工厂收的是 zod 实例，仓库里没有 node_modules 也能跑。
 * 注册路径（zod 动态加载、注册表探活）由宿主的真实启动验证，不在单测里造假。
 */
import fs from 'node:fs'

import { pathToFileURL } from 'node:url'

import {
  applyCostEvent,
  bucketsOfUsage,
  costOf,
  costViewOf,
  initCostState,
  isPeakTime,
  peakCostOf,
  PRICING,
} from './cost.js'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon

/** 北京时间转 Unix 毫秒（测试里写死偏移，不依赖宿主时区）。 */
const beijing = (text) => Date.parse(`${text}+08:00`)

// ═══════════════════════════ 峰谷边界 ═══════════════════════════

console.log('\n# 峰谷边界（北京时间）')
const peakCases = [
  ['2026-11-02T08:59:59', false, '周一 08:59:59 早于高峰'],
  ['2026-11-02T09:00:00', true, '周一 09:00 高峰开始'],
  ['2026-11-02T11:59:59', true, '周一 11:59:59 仍在高峰'],
  ['2026-11-02T12:00:00', false, '周一 12:00 午间低峰'],
  ['2026-11-02T13:59:59', false, '周一 13:59:59 仍是低峰'],
  ['2026-11-02T14:00:00', true, '周一 14:00 下午高峰开始'],
  ['2026-11-02T17:59:59', true, '周一 17:59:59 仍在高峰'],
  ['2026-11-02T18:00:00', false, '周一 18:00 晚间低峰'],
  ['2026-11-02T00:29:36', false, '周一凌晨低峰（本对话）'],
  ['2026-10-30T10:00:00', true, '周五 10:00 高峰'],
  ['2026-10-31T10:00:00', false, '周六 10:00 低峰'],
  ['2026-11-01T10:00:00', false, '周日 10:00 低峰'],
]
for (const [text, expected, why] of peakCases) {
  const actual = isPeakTime(beijing(text))
  check(`${text} → ${expected ? '峰' : '谷'}（${why}）`, actual === expected, `实际 ${actual}`)
}
// 非数字 / 非有限值一律按低峰，不抛错。
check('非法时间戳按低峰处理', isPeakTime(undefined) === false && isPeakTime(NaN) === false)

// ═══════════════════════════ 价目表算术 ═══════════════════════════

console.log('\n# 价目表算术（人民币 / 百万 tokens）')
const oneM = { cacheRead: 1_000_000, uncachedInput: 0, cacheWrite: 0, output: 0 }
check('1M 缓存命中 = ¥0.04', near(costOf(oneM, true), 0.04), String(costOf(oneM, true)))
check(
  '1M 未命中输入 = ¥2.00',
  near(costOf({ ...oneM, cacheRead: 0, uncachedInput: 1_000_000 }, true), 2),
)
check('1M 输出 = ¥8.00', near(costOf({ ...oneM, cacheRead: 0, output: 1_000_000 }, true), 8))
check('缓存写入按未命中计', near(costOf({ ...oneM, cacheRead: 0, cacheWrite: 1_000_000 }, true), 2))
check('低峰是高峰的一半', near(costOf(oneM, false), 0.02))
check('峰谷系数与价目表一致', PRICING.offPeakFactor === 0.5)

// ═══════════════════════════ 折叠语义 ═══════════════════════════

console.log('\n# 折叠语义')
const PEAK_TIME = beijing('2026-11-02T10:00:00')
const OFF_TIME = beijing('2026-11-02T20:00:00')

const event = (type, seq, time, data) => ({ type, seq, time, data })

const header = (seq, time, provider = 'cline-pass', model = 'cline-pass/deepseek-v4.1-flash-1017') =>
  event('request/header', seq, time, { header: { config: { provider, model } } })

const message = (seq, time, turn, step, usage) => event('assistant/message', seq, time, { turn, step, usage, message: {} })

const usage = (input, output, cacheRead, cacheWrite) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
  ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
})

{
  // 一次高峰请求。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME))
  state = applyCostEvent(state, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  const view = costViewOf(state)
  const expected = (4000 * 0.04 + 1000 * 2 + 100 * 8) / 1e6
  check('高峰请求按峰价计', near(view.cny, expected), `${view.cny} vs ${expected}`)
  check('视图的请求数 = 1', view.requests === 1)
  check('视图带 token 四桶', view.tokens.cacheRead === 4000 && view.tokens.uncachedInput === 1000 && view.tokens.output === 100)
  check('全高峰时 peakCny = cny、offCny = 0', near(view.peakCny, view.cny) && view.offCny === 0, `peak=${view.peakCny} off=${view.offCny}`)
  check('cnyPeak 与 cny 相等（本次就是峰价）', near(view.cnyPeak, view.cny))
}

{
  // 一次低峰请求：同样 token，价钱一半，但 cnyPeak 仍是峰价口径。
  let peakState = initCostState({}, 0)
  peakState = applyCostEvent(peakState, header(1, PEAK_TIME))
  peakState = applyCostEvent(peakState, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  let offState = initCostState({}, 0)
  offState = applyCostEvent(offState, header(1, OFF_TIME))
  offState = applyCostEvent(offState, message(2, OFF_TIME, 1, 1, usage(1000, 100, 4000)))
  const peakView = costViewOf(peakState)
  const offView = costViewOf(offState)
  check('低峰价 = 峰价一半', near(offView.cny, peakView.cny / 2), `${offView.cny} vs ${peakView.cny}`)
  check('低峰视图的 cnyPeak 仍是峰价口径', near(offView.cnyPeak, peakView.cny), `${offView.cnyPeak} vs ${peakView.cny}`)
  check('全低峰时 offCny = cny、peakCny = 0', near(offView.offCny, offView.cny) && offView.peakCny === 0, `off=${offView.offCny} peak=${offView.peakCny}`)
  check('峰谷拆分相加等于合计', near(offView.peakCny + offView.offCny, offView.cny), `${offView.peakCny}+${offView.offCny} vs ${offView.cny}`)
}

{
  // 同一 turn/step 的重复样本是「替换」而不是「累加」。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME))
  state = applyCostEvent(state, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  const once = costViewOf(state).cny
  state = applyCostEvent(state, event('assistant/attempt', 3, PEAK_TIME, { turn: 1, step: 1, usage: usage(1000, 100, 4000) }))
  check('重复样本不翻倍', near(costViewOf(state).cny, once), `${costViewOf(state).cny} vs ${once}`)
  check('重复样本后请求数仍是 1', costViewOf(state).requests === 1)
}

{
  // 重试：llm/retry-started 清空替换槽，重试的那次重新累加（真的花了两次钱）。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME))
  state = applyCostEvent(state, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  const once = costViewOf(state).cny
  state = applyCostEvent(state, event('llm/retry-started', 3, PEAK_TIME, { turn: 1, step: 1 }))
  state = applyCostEvent(state, message(4, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  check('重试后累加', near(costViewOf(state).cny, once * 2), `${costViewOf(state).cny} vs ${once * 2}`)
  check('重试后请求数 = 2', costViewOf(state).requests === 2)
}

{
  // 失败/中断/被重试掉的 attempt：宿主不发 data.usage，usage 只在流里。
  // 与上游 tokenUsage 同一兜底（lastAssistantStreamChunk）—— 不读流就永远漏记。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME))
  const stream = [
    { type: 'chunk', chunk: { type: 'text', text: '…' } },
    { type: 'chunk', chunk: { type: 'usage', usage: usage(1000, 100, 4000) } },
  ]
  state = applyCostEvent(state, event('assistant/attempt', 2, PEAK_TIME, { turn: 1, step: 1, stream }))
  const attemptView = costViewOf(state)
  check('流里的 usage 也计入（中断/重试的 attempt）', attemptView.requests === 1 && near(attemptView.cny, 0.00296), JSON.stringify(attemptView))
  // 同一 turn/step 随后的成功样本是替换，不是第二笔。
  state = applyCostEvent(state, message(3, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  check('attempt 与 message 是同一次请求（不翻倍）', costViewOf(state).requests === 1 && near(costViewOf(state).cny, attemptView.cny))
}

{
  // 同一 turn/step 的样本从峰区换到谷区：钱要从峰桶挪到谷桶，请求数不变。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME))
  state = applyCostEvent(state, event('assistant/attempt', 2, PEAK_TIME, { turn: 1, step: 1, usage: usage(1000, 100, 4000) }))
  state = applyCostEvent(state, message(3, OFF_TIME, 1, 1, usage(1000, 100, 4000)))
  const view = costViewOf(state)
  check('跨峰谷的替换：峰桶清空、谷桶接手', view.peakRequests === 0 && view.requests === 1, JSON.stringify({ peak: view.peakRequests, requests: view.requests }))
  check('…金额按谷价、峰价为 0', near(view.offCny, view.cny) && view.peakCny === 0, `off=${view.offCny} peak=${view.peakCny} cny=${view.cny}`)
}

{
  // 会话中途换到别的 provider：只算 cline-pass 的那些请求。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME))
  state = applyCostEvent(state, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 0)))
  state = applyCostEvent(state, header(3, PEAK_TIME, 'deepseek', 'deepseek/deepseek-v4'))
  state = applyCostEvent(state, message(4, PEAK_TIME, 1, 2, usage(1_000_000, 0, 0)))
  const view = costViewOf(state)
  check('非本路由的请求不计价', view.requests === 1 && near(view.cny, 0.0028), `requests=${view.requests} cny=${view.cny}`)
  check('非本路由的请求也不污染 cnyPeak', near(view.cnyPeak, 0.0028), String(view.cnyPeak))
}

{
  // seeded 前缀（seq < inheritedEventCount）不重复计。
  let seeded = initCostState({}, 10)
  seeded = applyCostEvent(seeded, header(1, PEAK_TIME))
  seeded = applyCostEvent(seeded, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 0)))
  check('继承前缀不计价', costViewOf(seeded).requests === 0 && seeded.route === null)
  seeded = applyCostEvent(seeded, header(11, PEAK_TIME))
  seeded = applyCostEvent(seeded, message(12, PEAK_TIME, 1, 1, usage(1000, 100, 0)))
  check('前缀之后的事件正常计', costViewOf(seeded).requests === 1)
}

{
  // request/context 只在上下文变化时出现；缺失时沿用 request/header 判定的路由。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, OFF_TIME))
  state = applyCostEvent(state, event('request/context', 2, OFF_TIME, { provider: 'cline-pass', model: 'cline-pass/deepseek-v4.1-flash-1017', contextWindow: 921600 }))
  state = applyCostEvent(state, message(3, OFF_TIME, 1, 1, usage(0, 0, 1_000_000)))
  check('request/context 与 header 混用时仍计价', near(costViewOf(state).cny, 0.02), String(costViewOf(state).cny))
}

{
  // 视图字段类型（宿主会用 wire.viewSchema 校验它）。
  const view = costViewOf(initCostState({}, 0))
  check(
    '空会话视图为 0',
    view.cny === 0 && view.cnyPeak === 0 && view.requests === 0 && typeof view.pricing === 'string',
    JSON.stringify(view),
  )
  check(
    '空会话的 token 桶全 0',
    view.tokens.cacheRead === 0 && view.tokens.uncachedInput === 0 && view.tokens.cacheWrite === 0 && view.tokens.output === 0,
    JSON.stringify(view.tokens),
  )
  check('usage 缺字段按 0 处理', JSON.stringify(bucketsOfUsage({ inputTokens: 3 })) === '{"cacheRead":0,"uncachedInput":3,"cacheWrite":0,"output":0}')
}

// ═══════════════════════════ 真实日志回放 ═══════════════════════════

const logPath = process.env.CLINEPASS_SESSION_LOG
if (logPath) {
  console.log(`\n# 真实日志回放：${logPath}`)
  if (!fs.existsSync(logPath)) {
    check('日志存在', false, logPath)
  } else {
    const events = fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
    let state = initCostState({}, 0)
    for (const item of events) state = applyCostEvent(state, item)
    const view = costViewOf(state)

    // 独立口径：只累加 cline-pass 的 assistant/message，不做替换去重（这份日志没有 attempt）。
    let expectedPeak = 0
    let expectedCny = 0
    let expectedCount = 0
    let route = null
    for (const item of events) {
      if (item.type === 'request/header') {
        const config = item.data?.header?.config
        if (config) route = { provider: config.provider, model: config.model }
      } else if (item.type === 'request/context') {
        route = { provider: item.data?.provider, model: item.data?.model }
      } else if (item.type === 'assistant/message' && item.data?.usage && route?.provider === 'cline-pass') {
        const buckets = bucketsOfUsage(item.data.usage)
        expectedPeak += peakCostOf(buckets)
        expectedCny += costOf(buckets, isPeakTime(item.time))
        expectedCount += 1
      }
    }
    check('请求数与独立口径一致', view.requests === expectedCount, `${view.requests} vs ${expectedCount}`)
    check('峰价口径与独立口径一致', near(view.cnyPeak, expectedPeak, 1e-8), `${view.cnyPeak} vs ${expectedPeak}`)
    check('实际价与独立口径一致', near(view.cny, expectedCny, 1e-8), `${view.cny} vs ${expectedCny}`)
    console.log(`  实际 ¥${view.cny.toFixed(6)} / 全按高峰 ¥${view.cnyPeak.toFixed(6)} / ${view.requests} 次请求 / 峰时 ${view.peakRequests} 次`)
  }
} else {
  console.log('\n# 真实日志回放：跳过（设置 CLINEPASS_SESSION_LOG=<解压后的 jsonl> 可跑）')
}

// ═══════════════════════════ 投影 schema 自检 ═══════════════════════════
//
// 这段只在能解析到 zod 时跑：仓库里没有 node_modules（跳过），而安装到 profile 的
// 副本里 zod 由宿主提供（真跑）。2026-11-02 的回归正是「view 形状与 viewSchema 不一致
// → 注册表丢掉整个投影、界面上只剩 Provider、日志里没有线索」，这里就是那道闸。

let zod = null
try {
  const module = await import('zod')
  zod = module.default ?? module
} catch {
  zod = null
}
// 仓库里没有 node_modules，但本机的宿主 profile 里有 zod（插件运行时用的就是它）。
// 显式指过去，让这条**回归断言在本机跑仓库测试时也生效** —— 2026-11-02 的 bug
// 就是「状态算对了、视图没对齐 schema」没人验。
if (zod === null && process.env.HOME) {
  const candidates = [
    process.env.ZOD_PATH,
    process.env.HOME + '/.dsh/profiles/web/node_modules/zod/index.js',
  ].filter((item) => typeof item === 'string' && item.length > 0)
  for (const candidate of candidates) {
    try {
      const module = await import(pathToFileURL(candidate).href)
      zod = module.default ?? module
      break
    } catch {
      /* 换下一个候选；都失败就跳过 */
    }
  }
}

if (zod === null || typeof zod.object !== 'function') {
  console.log('\n# schema 自检：跳过（当前目录解析不到 zod；安装到 profile 的副本里会跑）')
} else {
  console.log('\n# schema 自检（真实 zod）')
  const { makeCostProjection } = await import('./cost.js')
  const definition = makeCostProjection(zod)
  let state = definition.init({}, 0)
  state = definition.apply(state, header(1, PEAK_TIME))
  state = definition.apply(state, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  const parsedState = definition.stateSchema.parse(state)
  check('state 通过 stateSchema', parsedState.last !== null && parsedState.off.requests + parsedState.peak.requests === 1)
  const view = definition.wire.view(parsedState)
  let parsedView = null
  try {
    parsedView = definition.wire.viewSchema.parse(view)
    check('view 通过 viewSchema', parsedView.cny === view.cny && parsedView.tokens.cacheRead === 4000, JSON.stringify(parsedView))
  } catch (error) {
    check('view 通过 viewSchema', false, error instanceof Error ? error.message : String(error))
  }
  // 负值必须被拒：不能只测「缺字段被拒」—— 那与负数/类型无关，恒真。
  const rejects = (schema, value) => {
    try {
      schema.parse(value)
      return false
    } catch {
      return true
    }
  }
  const goodState = definition.init({}, 0)
  const goodView = costViewOf(goodState)
  check('非法 state 被拒（负桶）', rejects(definition.stateSchema, { ...goodState, peak: { ...goodState.peak, cacheRead: -1 } }))
  check('非法 state 被拒（缺字段）', rejects(definition.stateSchema, { inheritedEventCount: 0 }))
  check('非法 view 被拒（负金额）', rejects(definition.wire.viewSchema, { ...goodView, cny: -1 }))
  check('非法 view 被拒（缺 requests）', rejects(definition.wire.viewSchema, { ...goodView, requests: undefined }), '这是 2026-11-02 事故的形状')
}

{
  // 边界：前缀只到 inheritedEventCount - 1，所以 seq === inheritedEventCount 的那条**要算**。
  let state = initCostState({}, 5)
  state = applyCostEvent(state, header(5, PEAK_TIME))
  state = applyCostEvent(state, message(6, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  check('seq 等于 inheritedEventCount 的 header 计入（路由建立）', costViewOf(state).requests === 1, JSON.stringify(costViewOf(state)))
  let skipped = initCostState({}, 5)
  skipped = applyCostEvent(skipped, header(4, PEAK_TIME))
  skipped = applyCostEvent(skipped, message(4, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  check('…而 seq 小于它的一律跳过（连路由都不建立）', costViewOf(skipped).requests === 0 && skipped.route === null, JSON.stringify(costViewOf(skipped)))
}

{
  // 价表只覆盖 flash 快照：同路由换 v4-pro 时不能拿 flash 的价去算（会低估 3–7 倍）。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME, 'cline-pass', 'cline-pass/deepseek-v4-pro'))
  state = applyCostEvent(state, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  check('未覆盖的模型不计价（不按 flash 低估）', costViewOf(state).requests === 0 && costViewOf(state).cny === 0, JSON.stringify(costViewOf(state)))
  check('flash 快照仍然计价', (() => {
    let ok = initCostState({}, 0)
    ok = applyCostEvent(ok, header(1, PEAK_TIME))
    ok = applyCostEvent(ok, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
    return costViewOf(ok).requests === 1
  })())
  let switched = initCostState({}, 0)
  switched = applyCostEvent(switched, header(1, PEAK_TIME))
  switched = applyCostEvent(switched, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  switched = applyCostEvent(switched, header(3, PEAK_TIME, 'cline-pass', 'cline-pass/deepseek-v4-pro'))
  switched = applyCostEvent(switched, message(4, PEAK_TIME, 1, 2, usage(9_000_000, 0, 0)))
  check('中途换到未覆盖模型时只保留已计价的那条', costViewOf(switched).requests === 1, JSON.stringify(costViewOf(switched)))
}

{
  // 不依赖 zod 的形状闸：view 的字段集合是契约，改了就必须同步改这里。
  // 2026-11-02 那次事故就是「状态算对了、视图少一个字段」，宿主的 viewSchema 直接拒绝。
  let state = initCostState({}, 0)
  state = applyCostEvent(state, header(1, PEAK_TIME))
  state = applyCostEvent(state, message(2, PEAK_TIME, 1, 1, usage(1000, 100, 4000)))
  const view = costViewOf(state)
  const viewKeys = Object.keys(view).sort().join(',')
  check(
    'view 的字段集合固定',
    viewKeys === 'cny,cnyPeak,offCny,peakCny,peakRequests,pricing,requests,tokens',
    viewKeys,
  )
  const tokenKeys = Object.keys(view.tokens).sort().join(',')
  check('view.tokens 只有四个桶（没有 requests）', tokenKeys === 'cacheRead,cacheWrite,output,uncachedInput', tokenKeys)
  check(
    'view 里所有数值都是非负有限数',
    ['cny', 'cnyPeak', 'peakCny', 'offCny', 'requests', 'peakRequests'].every((key) => Number.isFinite(view[key]) && view[key] >= 0),
    JSON.stringify(view),
  )
}

// ═══════════════════════════ 结果 ═══════════════════════════

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
