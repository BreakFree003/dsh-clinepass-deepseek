/**
 * 设置页「官方定价累计」：把各会话的成本投影加总，给一个可重置的累计值。
 *
 * ## 数据从哪来
 *
 * 每个会话都有自己的 `clinepassCost` 投影（状态由 {@link module:./cost} 定义），宿主把
 * 它落盘到 `$DSH_HOME/storages/session_projcache/sessions/*.json`。设置页那张卡只拿到
 * provider 信息、dock 只拿到当前会话 + 子代理 —— 宿主是**唯一同时看得见全部会话**的地方，
 * 所以累计值在这里扫，浏览器只读数字、只发重置。
 *
 * seeded 会话（fork / 子代理）折叠时已跳过继承前缀，所以「把所有会话加起来」不会把父会话
 * 的历史算第二遍 —— 每个请求恰好属于一个会话的状态。
 *
 * ## 为什么是「按会话的基线」而不是一个总基线
 *
 * 投影缓存是**懒生成**的：只有投影注册之后被碰过（跑过、或打开过）的会话才有
 * `clinepassCost` 行。用一个全局基线 `total - baseline` 的话，每打开一个旧会话，它整段
 * 历史都会汇进 `total` —— 卡片上「自 X 起」的承诺当场破功，数字还会莫名跳涨。
 *
 * 所以基线记成 **per-session**：每个会话第一次被扫到时，把它当时的花费记成基线，之后只
 * 计它涨出来的部分。
 *
 * - 升级前就有、之后才被打开的旧会话：基线 = 它的全部历史 → 贡献 0，不会跳。
 * - 安装/重置之后新建的会话：第一次被扫到时花费还是 0 → 全额计入。
 * - 基线之后被用过的会话：只计增量。
 *
 * 代价是「某个会话在重置之后、第一次被扫到之前花掉的钱」不算（会话被用过就会被 checkpoint，
 * 所以这个窗口很小）。这是懒数据下唯一自洽的口径：**只记我们看得见之后的花费**。
 *
 * ## 状态文件
 *
 * `$DSH_HOME/dsh-clinepass-spend.json`：
 * `{ "version": 1, "since": <ISO>, "sessions": { "<sessionId>": <baselineCny> } }`。
 * 首次运行或重置时建立，之后只在「出现新会话」或重置时写。
 *
 * @module dsh-clinepass/spend
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COST_STATE_VERSION, costViewOf } from './cost.js'

/** 累计值的读/重置路由（挂在 dsh 自己的 server 上，不是新端口）。 */
export const SPEND_ROUTE = '/api/clinepass.spend'

/** 扫一遍投影缓存不便宜（902 个文件约 0.2–0.3 秒），这段时间内复用上一次结果。 */
export const SPEND_CACHE_MS = 30_000

/** `$DSH_HOME`（与 status 文件同一套约定）。 */
export function dshHome() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return home
}

/** 基线文件。 */
export function spendFileFor() {
  return path.join(dshHome(), 'dsh-clinepass-spend.json')
}

/** 宿主落投影缓存的地方。 */
export function sessionsCacheDir() {
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

/** 金额保留 8 位（与 cost.js 的 round 一致），避免浮点尾巴进入 JSON。 */
const round = (value) => Math.max(0, Math.round(value * 1e8) / 1e8)

/**
 * 读基线文件。
 *
 * 只认当前形状（带 `sessions` 映射）；旧的「单一 baseline」形状或读不懂的文件一律当作
 * 不存在 —— 调用方会按当前扫描重建，累计从 0 开始（宁可归零，也不把错口径继续滚下去）。
 *
 * @param file - 路径。
 * @returns `{ since, sessions: Map<string, number> }`，或 null。
 */
export function readSpend(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const since = typeof parsed.since === 'string' && parsed.since.length > 0 ? parsed.since : null
    const source = parsed.sessions
    if (since === null || source === null || typeof source !== 'object' || Array.isArray(source)) return null
    const sessions = new Map()
    for (const [id, value] of Object.entries(source)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) sessions.set(id, value)
    }
    return { since, sessions }
  } catch {
    return null
  }
}

/** 原子写基线（临时文件 + rename，宿主随时可能重启）。 */
export function writeSpend(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const sessions = {}
  for (const [id, cny] of value.sessions) sessions[id] = round(cny)
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, JSON.stringify({ version: 1, since: value.since, sessions }, null, 2))
  fs.renameSync(temp, file)
}

/**
 * 扫一遍投影缓存，返回**每个会话**的成本。
 *
 * 用异步 IO：这份路由挂在 dsh 自己的 server 上，同步读 900 个文件会把同进程的所有请求
 * 一起卡住（实测 233 ms）。
 *
 * 单个文件读坏/形状不认识只计入 `errors` —— 缓存是宿主写的，不能假设每个文件都完整；
 * 版本不匹配的行走 `skipped` 而不是硬折（`costViewOf` 只认当前 state 形状）。
 *
 * @param dir - 投影缓存目录。
 * @returns `{ sessions: Map<string, number>, scanned, errors, skipped }`。
 */
export async function sumCachedCosts(dir) {
  const sessions = new Map()
  let names
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    // 目录读不到要能和「真的没有花费」区分：调用方把 `reachable: false` 一路带到界面上。
    return { sessions, scanned: 0, errors: 1, skipped: 0, reachable: false }
  }
  let scanned = 0
  let errors = 0
  let skipped = 0
  const queue = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    scanned += 1
    queue.push(name)
  }
  const readOne = async (name) => {
    let record
    try {
      const text = await fs.promises.readFile(path.join(dir, name), 'utf8')
      record = JSON.parse(text)?.record
    } catch {
      errors += 1
      return
    }
    const row = record?.rows?.clinepassCost
    if (row === undefined || row === null || row.val === undefined) return
    if (typeof row.ver === 'number' && row.ver !== COST_STATE_VERSION) {
      skipped += 1
      return
    }
    let view
    try {
      view = costViewOf(row.val)
    } catch {
      errors += 1
      return
    }
    if (!(view.cny > 0)) return
    const id = typeof record?.identity?.id === 'string' && record.identity.id.length > 0 ? record.identity.id : name.slice(0, -5)
    sessions.set(id, (sessions.get(id) ?? 0) + view.cny)
  }
  // 控制并发：900 个文件一次性打开会撞 fd 上限。
  const limit = 32
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (cursor < queue.length) {
        const index = cursor
        cursor += 1
        await readOne(queue[index])
      }
    }),
  )
  return { sessions, scanned, errors, skipped, reachable: true }
}

/**
 * 构造累计值的请求处理函数。
 *
 * GET 读；POST 重置（把所有会话的当前花费记成新基线，起点 = 现在）。
 *
 * @param options - 依赖注入，全部可替换以便单测。
 * @returns `(request) => Promise<Response>`。
 */
export function createSpendHandler(options = {}) {
  const file = options.file ?? spendFileFor()
  const dir = options.dir ?? sessionsCacheDir()
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())
  const cacheMs = Number.isSafeInteger(options.cacheMs) ? options.cacheMs : SPEND_CACHE_MS
  let cache = null
  let inflight = null

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })

  /**
   * 读一次并套上基线；`force` 跳过结果缓存（重置后必须重算）。
   *
   * 同时进行中的多个请求共用一次扫描（设置页轮询 + 用户手点刷新不该各扫一遍）。
   *
   * @param force - 是否绕过结果缓存。
   * @returns 视图对象。
   */
  const snapshot = (force) => {
    const at = now()
    if (!force && cache !== null && at - cache.at < cacheMs) return Promise.resolve(cache.body)
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const scanned = await sumCachedCosts(dir)
        let spend = readSpend(file)
        let dirty = false
        if (spend === null) {
          // 第一次运行：每个会话的当前花费都是它的基线，显示的累计从 0 开始涨。
          spend = { since: new Date(at).toISOString(), sessions: new Map() }
          for (const [id, cny] of scanned.sessions) spend.sessions.set(id, cny)
          dirty = true
        } else {
          // 新出现的会话：把「第一次被看见时」的花费记成它的基线，历史不计、也不会跳。
          for (const [id, cny] of scanned.sessions) {
            if (!spend.sessions.has(id)) {
              spend.sessions.set(id, cny)
              dirty = true
            }
          }
        }
        if (dirty) {
          try {
            writeSpend(file, spend)
          } catch (error) {
            logger.warn?.('[clinepass] could not write the spend baseline %s: %s', file, error instanceof Error ? error.message : String(error))
          }
        }
        let cny = 0
        let counted = 0
        for (const [id, current] of scanned.sessions) {
          const baseline = spend.sessions.get(id) ?? current
          const delta = current - baseline
          if (delta > 0) {
            cny += delta
            counted += 1
          }
        }
        const body = {
          ok: true,
          cny: round(cny),
          since: spend.since,
          sessions: counted,
          seen: scanned.sessions.size,
          scanned: scanned.scanned,
          errors: scanned.errors,
          skipped: scanned.skipped,
          reachable: scanned.reachable,
          at: new Date(at).toISOString(),
        }
        cache = { at, body }
        return body
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return async (request) => {
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET'
    if (method === 'POST') {
      const before = await snapshot(true)
      // 重置 = 把「现在每个会话的花费」整体拍成新基线。逐会话记，旧会话以后被打开也不会倒灌。
      const scanned = await sumCachedCosts(dir)
      const sessions = new Map()
      for (const [id, cny] of scanned.sessions) sessions.set(id, cny)
      const next = { since: new Date(now()).toISOString(), sessions }
      try {
        writeSpend(file, next)
      } catch (error) {
        return json({ ok: false, reason: 'write-failed', message: error instanceof Error ? error.message : String(error) }, 500)
      }
      cache = null
      const after = await snapshot(true)
      return json({ ...after, reset: true, previous: before.cny })
    }
    return json(await snapshot(false))
  }
}
