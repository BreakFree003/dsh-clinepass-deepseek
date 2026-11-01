/**
 * dsh-clinepass 的成本投影：按 DeepSeek 官方价（含峰谷）给每条对话算钱。
 *
 * ## 为什么是「投影」而不是别处
 *
 * 成本必须**逐请求**按发生时刻计价：同一次对话可以横跨 12:00 / 18:00 / 周末，
 * 拿「会话开始时间」或「当前时间」统一套一个价，跨界的会话就整段算错。dsh 的
 * `tokenUsage` 投影只折叠四桶总和，时间在这里已经丢了，所以本插件注册自己的投影
 * （`clinepassCost`），在折叠时用 `event.time`（Unix 毫秒）判峰谷。
 *
 * 投影的 `apply` 必须是**同步纯函数**：宿主会把它落进缓存、重启后重放。所以本文件里
 * 没有任何 `Date.now()` —— 一切以事件自带的 `time` 为准。
 *
 * ## 计价口径（用户 2026-11-02 定）
 *
 * - 只算 **DeepSeek 官方价**，不管 ClinePass 额度那边的口径（额度记账恒按高峰价，
 *   低峰期两者差 2 倍，见 README）。
 * - 币种 **人民币**。官方表是美元，按 1 USD = 6.6667 CNY 换算：
 *   缓存命中 $0.006 → ¥0.04，未命中 $0.30 → ¥2.00，输出 $1.20 → ¥8.00（每百万 tokens）。
 * - 低峰 = 高峰价 × 0.5。
 * - 高峰时段：北京时间（UTC+8）**周一至周五 09:00–12:00、14:00–18:00**；
 *   其余（含整个周末）都是低峰。**中国法定节假日官方是全天低峰，这里没有实现** ——
 *   节假日会按峰价算，最多高估 2 倍（见 README「已知边界」）。
 * - 只算 `provider === 'cline-pass'` 的请求；同一会话里换到别的 provider 的请求不套这张价表。
 *
 * ## 哪些事件计入
 *
 * - 计入：`assistant/message` / `assistant/attempt` 上携带的 usage（一次 LLM 调用一条）。
 * - `compaction/summary` 只在它自己带 usage 时计入。ACP（billion-context-dsh）的摘要是
 *   模型在普通回复里写的，不另发请求 —— 那条记录没有 usage，所以 ACP 下永不重复计费；
 *   若哪天换回内置压缩，那条记录会带 usage，这里也自动算上。
 * - 不计入：`session/title-llm-request`（有请求、无 usage，宿主没记这笔记账，我们不算）。
 *
 * ## seeded（fork）子代理
 *
 * fork 子代理的日志开头是从父会话整段复制的已完成轮次（前缀长度 = `inheritedEventCount`）。
 * 这些事件本来就算在父会话头上，这里必须跳过（`event.seq < inheritedEventCount`），
 * 否则「含子代理合计」会翻倍。
 *
 * @module dsh-clinepass/cost
 */

/** 本投影的 key。读方（client.js）按这个名字取。 */
export const COST_PROJECTION_KEY = 'clinepassCost'

/**
 * 状态版本。改 state 的形状必须 +1：旧缓存行会被读取方丢弃并按新形状重算。
 */
export const COST_STATE_VERSION = 1

/** 计价的 provider 前缀（模型 id 也以它开头）。 */
export const PROVIDER = 'cline-pass'

/**
 * 官方价目表（**人民币 / 百万 tokens，高峰时段**）。
 *
 * `cacheMiss` 同时用于「未命中输入」和「缓存写入」：DeepSeek 官方不单列缓存写入价，
 * 写入按未命中计。
 *
 * `version` 写进视图，让 UI/排查能说清这个数字是按哪版价表算的 —— 价表变过一次
 * （2026-10-27 网关记账口径调整），没有版本号的话历史会话的数字会莫名其妙地变。
 */
export const PRICING = {
  version: '2026-11-02',
  cacheRead: 0.04,
  cacheMiss: 2,
  output: 8,
  offPeakFactor: 0.5,
}

/**
 * 高峰时段（北京时间，UTC+8，仅周一至周五）：`[开始分钟, 结束分钟)`。
 *
 * 12:00–14:00 午间是低峰，18:00 之后到次日 09:00 是低峰，周末整天低峰。
 */
export const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 北京时间相对 UTC 的偏移。判峰谷一律用它，不用宿主本地时区。 */
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 某个时刻是否落在高峰时段。
 *
 * 先把毫秒时间戳平移到 UTC+8，再用 `getUTC*` 读 —— 这样结果与宿主/浏览器的时区设置无关。
 *
 * @param timeMs - Unix 毫秒时间戳（`event.time`）。
 * @returns 峰价为 `true`，谷价为 `false`。
 */
export function isPeakTime(timeMs) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return false
  const shifted = new Date(timeMs + TZ_OFFSET_MS)
  // 平移之后用 UTC 读数，读到的就是北京时间的「星期 / 时 / 分」。
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
}

/** 一次 usage 记录的四个桶（token 数）。`cacheWrite` 视为未命中。 */
export function bucketsOfUsage(usage) {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
  return {
    cacheRead: num(usage?.cacheReadTokens),
    uncachedInput: num(usage?.inputTokens),
    cacheWrite: num(usage?.cacheWriteTokens),
    output: num(usage?.outputTokens),
  }
}

/** 零桶（不含 requests 计数）。 */
export function zeroBuckets() {
  return { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0, requests: 0 }
}

/** 两个桶相加。 */
export function addBuckets(left, right) {
  return {
    cacheRead: left.cacheRead + right.cacheRead,
    uncachedInput: left.uncachedInput + right.uncachedInput,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
    requests: left.requests + right.requests,
  }
}

/**
 * 一组 token 桶按高峰价算成人民币。
 *
 * @param buckets - {@link zeroBuckets} 形状（`requests` 不参与）。
 * @returns 人民币金额（未取整）。
 */
export function peakCostOf(buckets) {
  const miss = buckets.uncachedInput + buckets.cacheWrite
  return (buckets.cacheRead * PRICING.cacheRead + miss * PRICING.cacheMiss + buckets.output * PRICING.output) / 1e6
}

/**
 * 一组 token 桶按给定时段算成人民币。
 *
 * @param buckets - {@link zeroBuckets} 形状（`requests` 不参与）。
 * @param peak - 峰价 `true`，谷价 `false`。
 * @returns 人民币金额（未取整）。
 */
export function costOf(buckets, peak) {
  return peakCostOf(buckets) * (peak ? 1 : PRICING.offPeakFactor)
}

/** 这条请求是不是本路由发出的。provider 缺失时按模型前缀兜底。 */
export function routeOfRequest(provider, model) {
  if (provider === PROVIDER) return true
  return typeof model === 'string' && model.indexOf(PROVIDER + '/') === 0
}

/**
 * 从流式记录里取最后一个 `usage` 块。
 *
 * 失败/中断/被重试掉的 `assistant/attempt` 没有 `data.usage`：usage 只存在于
 * `data.stream` 的最后一帧（`{type:'chunk', chunk:{type:'usage', usage}}`）。
 * 上游 `tokenUsage` 正是这样兜底的 —— 不比它多读一处，就会漏掉这些尝试。
 *
 * @param stream - `data.stream`（不保证是数组）。
 * @returns usage 对象，或 undefined。
 */
function streamUsageOf(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object') continue
    const chunk = record.type === 'chunk' ? record.chunk : undefined
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage !== undefined) {
      return chunk.usage
    }
  }
  return undefined
}

/** 从事件里取 usage；拿不到返回 undefined。 */
function usageOfEvent(event) {
  const data = event?.data
  if (data === undefined || data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    if (data.usage !== undefined && data.usage !== null) return data.usage
    return streamUsageOf(data.stream)
  }
  if (event.type === 'compaction/summary') {
    if (data.usage !== undefined && data.usage !== null) return data.usage
  }
  return undefined
}

/** 当前路由（provider/model），任一缺失返回 null。 */
function routeFromEvent(event) {
  const data = event.data ?? {}
  // `request/header` 每轮一条，带 `header.config`；`request/context` 只在上下文变化时写，
  // 两者都算「当前路由」。优先 header —— 它在每个 turn 开始时就落盘。
  if (event.type === 'request/header') {
    const config = data.header?.config
    if (config && typeof config === 'object') {
      const provider = typeof config.provider === 'string' ? config.provider : null
      const model = typeof config.model === 'string' ? config.model : null
      if (provider !== null || model !== null) return { provider, model }
    }
    return undefined
  }
  if (event.type === 'request/context') {
    const provider = typeof data.provider === 'string' ? data.provider : null
    const model = typeof data.model === 'string' ? data.model : null
    if (provider !== null || model !== null) return { provider, model }
  }
  return undefined
}

/** 初始状态。`inheritedEventCount` 由宿主按 seeded 会话的前缀长度传入。 */
export function initCostState(header, inheritedEventCount) {
  const boundary = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0 ? inheritedEventCount : 0
  return {
    inheritedEventCount: boundary,
    route: null,
    peak: zeroBuckets(),
    off: zeroBuckets(),
    last: null,
  }
}

/**
 * 从某个桶里减去上一次的样本（替换语义）。
 *
 * @returns 新桶（不改入参）。
 */
function subtractBuckets(buckets, previous) {
  // 下限 0：状态一旦为负就过不了 stateSchema（冷读 restore 直接抛），视图也过不了
  // viewSchema（每个事件一次异常）。正常状态走不到这里，但「构造不出来的状态」比
  // 「碰巧构造不出来」稳。
  const floor = (value) => Math.max(0, value)
  return {
    cacheRead: floor(buckets.cacheRead - previous.cacheRead),
    uncachedInput: floor(buckets.uncachedInput - previous.uncachedInput),
    cacheWrite: floor(buckets.cacheWrite - previous.cacheWrite),
    output: floor(buckets.output - previous.output),
    requests: floor(buckets.requests - 1),
  }
}

/**
 * 折叠一条事件。
 *
 * 替换语义与上游 `tokenUsage` 一致：同一个 turn/step 的重复样本（attempt 与 message）
 * 用**替换**而不是累加；`llm/retry-started` 把替换槽清空，重试的那次就重新累加。
 * 不这样的话，一次请求会被记两遍。
 *
 * @param state - 上一次的状态（不会被改写）。
 * @param event - 会话事件（`{type, seq, time, data}`）。
 * @returns 新状态；无变化时返回入参本身（注册表按引用判变化）。
 */
export function applyCostEvent(state, event) {
  // ① seeded 前缀：属于父会话的历史，不重复计。
  if (event.seq < state.inheritedEventCount) return state

  const route = routeFromEvent(event)
  if (route !== undefined) {
    const same = state.route !== null && state.route.provider === route.provider && state.route.model === route.model
    return same ? state : { ...state, route }
  }

  if (event.type === 'llm/retry-started') {
    if (state.last === null) return state
    const { turn, step } = event.data ?? {}
    if (state.last.turn !== turn || state.last.step !== step) return state
    return { ...state, last: null }
  }

  const usage = usageOfEvent(event)
  if (usage === undefined) return state
  // 不是本路由的请求：价表对不上，跳过（会话中途换过 provider 时只算 cline-pass 那部分）。
  if (state.route === null || !routeOfRequest(state.route.provider, state.route.model)) return state

  const turn = event.data?.turn
  const step = event.data?.step
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return state

  const peak = isPeakTime(event.time)
  const where = peak ? 'peak' : 'off'
  const nextBuckets = { ...bucketsOfUsage(usage), requests: 1 }

  // 取回上一份样本：同一 turn/step 说明这次是替换，不是新增。
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null

  let peakBuckets = state.peak
  let offBuckets = state.off
  if (previous !== null) {
    if (previous.where === 'peak') peakBuckets = subtractBuckets(peakBuckets, previous.buckets)
    else offBuckets = subtractBuckets(offBuckets, previous.buckets)
  }
  if (where === 'peak') peakBuckets = addBuckets(peakBuckets, nextBuckets)
  else offBuckets = addBuckets(offBuckets, nextBuckets)

  return {
    ...state,
    peak: peakBuckets,
    off: offBuckets,
    last: { turn, step, where, buckets: bucketsOfUsage(usage) },
  }
}

/**
 * 把状态折成浏览器要看的视图。
 *
 * - `cny`：按实际时段算出的官方价（这是要显示的数字）。
 * - `cnyPeak`：这些 token 若全按高峰价会是多少（= ClinePass 额度那边的口径，
 *   放在 tooltip 里解释「为什么额度扣得比这个多」）。
 * - `requests`：计入的请求数。
 *
 * @param state - 投影状态。
 * @returns 视图对象（纯 JSON）。
 */
export function costViewOf(state) {
  const all = addBuckets(state.peak, state.off)
  const peakCny = costOf(state.peak, true)
  const offCny = costOf(state.off, false)
  const round = (value) => Math.max(0, Math.round(value * 1e8) / 1e8)
  return {
    cny: round(peakCny + offCny),
    cnyPeak: round(peakCostOf(all)),
    peakCny: round(peakCny),
    offCny: round(offCny),
    requests: all.requests,
    peakRequests: state.peak.requests,
    tokens: {
      cacheRead: all.cacheRead,
      uncachedInput: all.uncachedInput,
      cacheWrite: all.cacheWrite,
      output: all.output,
    },
    pricing: PRICING.version,
  }
}

/**
 * 用给定的 zod 实例构造投影定义。
 *
 * zod 由调用方注入而不是在本文件顶层 `import 'zod'`：本包在仓库里跑测试时没有
 * node_modules，而运行时 zod 由宿主 profile 提供。把依赖做成参数，仓库内的单测可以
 * 不碰 zod，运行时再由 `index.js` 动态加载。
 *
 * @param z - zod 实例（`z.object` / `z.number` / `z.enum`）。
 * @returns `ProjectionDefinition`。
 */
export function makeCostProjection(z) {
  const count = () => z.number().int().nonnegative()
  const bucketSchema = z.object({
    cacheRead: count(),
    uncachedInput: count(),
    cacheWrite: count(),
    output: count(),
    requests: count(),
  })
  const sampleSchema = z.object({
    cacheRead: count(),
    uncachedInput: count(),
    cacheWrite: count(),
    output: count(),
  })
  // 视图里的 token 桶**没有** `requests` 字段（那是状态里的计数）。必须单独建一个
  // schema：2026-11-02 这里图省事复用了带 requests 的 bucketSchema，视图解析失败，
  // 注册表直接把整个投影丢掉了 —— 界面上只剩 Provider、没有任何报错。
  const tokenSchema = z.object({
    cacheRead: count(),
    uncachedInput: count(),
    cacheWrite: count(),
    output: count(),
  })
  const stateSchema = z.object({
    inheritedEventCount: count(),
    route: z
      .object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
      })
      .nullable(),
    peak: bucketSchema,
    off: bucketSchema,
    last: z
      .object({
        turn: count(),
        step: count(),
        where: z.enum(['peak', 'off']),
        buckets: sampleSchema,
      })
      .nullable(),
  })
  const viewSchema = z.object({
    cny: z.number().nonnegative(),
    cnyPeak: z.number().nonnegative(),
    peakCny: z.number().nonnegative(),
    offCny: z.number().nonnegative(),
    requests: count(),
    peakRequests: count(),
    tokens: tokenSchema,
    pricing: z.string(),
  })
  return {
    key: COST_PROJECTION_KEY,
    stateVersion: COST_STATE_VERSION,
    stateSchema,
    init: (header, inheritedEventCount) => initCostState(header, inheritedEventCount),
    apply: (state, event) => applyCostEvent(state, event),
    wire: {
      viewSchema,
      view: (state) => costViewOf(state),
    },
  }
}
