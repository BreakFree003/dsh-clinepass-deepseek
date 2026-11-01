/**
 * `spend.js` 的单元测试：设置页「官方定价累计」。
 *
 * 只跑纯函数 + 临时目录，不碰真实 `$DSH_HOME`、不联网、不启宿主。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSpendHandler, readSpend, SPEND_ROUTE, spendFileFor, sumCachedCosts, writeSpend } from './spend.js'
import { COST_STATE_VERSION, costViewOf } from './cost.js'

let failures = 0
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return
  }
  failures += 1
  console.log(` FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** `costViewOf` 要的状态形状：一次高峰请求 = ¥0.00296。 */
const stateOf = (cacheRead = 4000, requests = 1) => ({
  inheritedEventCount: 0,
  route: { provider: 'cline-pass', model: 'cline-pass/deepseek-v4.1-flash-1017' },
  peak: { cacheRead, uncachedInput: 1000, cacheWrite: 0, output: 100, requests },
  off: { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0, requests: 0 },
  last: null,
})

const CNY_ONE = costViewOf(stateOf()).cny
const near = (a, b) => Math.abs(a - b) < 1e-9

/** 写一个投影缓存文件（形状与宿主落盘的 `{record:{identity,rows:{key:{seq,ver,val}}}}` 一致）。 */
const writeCache = (dir, id, value, extra = {}) => {
  const rows = { tokenUsage: { ver: 2, seq: 1, val: {} } }
  if (value !== undefined) rows.clinepassCost = { ver: COST_STATE_VERSION, seq: 2, val: value, ...extra }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ record: { identity: { id }, rows } }))
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clinepass-spend-'))
const cacheDir = path.join(tempRoot, 'sessions')
fs.mkdirSync(cacheDir)
const spendFile = path.join(tempRoot, 'spend.json')

try {
  // ── 求和（按会话）─────────────────────────────────────
  writeCache(cacheDir, 'a', stateOf())
  writeCache(cacheDir, 'b', stateOf(8000, 2))
  writeCache(cacheDir, 'c', undefined) // 没有本投影的会话
  fs.writeFileSync(path.join(cacheDir, 'd.json'), '{broken')
  writeCache(cacheDir, 'e', stateOf(), { ver: COST_STATE_VERSION + 1 }) // 版本不匹配的行
  const sum = await sumCachedCosts(cacheDir)
  check('按会话给出成本', sum.sessions.size === 2 && near(sum.sessions.get('a'), CNY_ONE) && near(sum.sessions.get('b'), costViewOf(stateOf(8000, 2)).cny), JSON.stringify([...sum.sessions]))
  check('每个文件都扫到', sum.scanned === 5, String(sum.scanned))
  check('坏文件只计错误、不进总数', sum.errors === 1, String(sum.errors))
  check('版本不匹配的行被跳过而不是硬折', sum.skipped === 1, String(sum.skipped))
  check('目录不存在时是空表而不是抛错', (await sumCachedCosts(path.join(tempRoot, 'nope'))).sessions.size === 0)

  // ── 首次运行：每个会话记基线 ─────────────────────────
  let clock = 1_700_000_000_000
  const handler = createSpendHandler({ file: spendFile, dir: cacheDir, cacheMs: 0, now: () => clock, logger: { warn() {} } })

  const first = await (await handler({ method: 'GET' })).json()
  check('首次运行从 0 开始', first.ok === true && first.cny === 0 && first.seen === 2, JSON.stringify({ cny: first.cny, seen: first.seen }))
  check('起点 = 现在', first.since === new Date(clock).toISOString())
  const persisted = readSpend(spendFile)
  check('每个会话都落了基线', persisted !== null && persisted.sessions.size === 2 && near(persisted.sessions.get('a'), CNY_ONE), JSON.stringify([...(persisted?.sessions ?? [])]))

  // ── 旧会话后来才出现：不跳 ───────────────────────────
  writeCache(cacheDir, 'old', stateOf(8000, 5)) // 一段"升级前"的历史
  clock += 1000
  const afterOld = await (await handler({ method: 'GET' })).json()
  check('新出现的旧会话不倒灌历史', afterOld.cny === 0, JSON.stringify(afterOld))
  check('…但它的基线被记住了', afterOld.seen === 3 && readSpend(spendFile).sessions.has('old'))

  // ── 已有会话继续花：只计增量 ─────────────────────────
  writeCache(cacheDir, 'a', stateOf(8000, 2)) // 从 ¥0.00296 涨到 ¥0.00608
  clock += 1000
  const grown = await (await handler({ method: 'GET' })).json()
  const grownDelta = costViewOf(stateOf(8000, 2)).cny - CNY_ONE
  check('会话增长只计增量', near(grown.cny, grownDelta), `${grown.cny} vs ${grownDelta}`)
  check('计数的会话数', grown.sessions === 1, String(grown.sessions))

  // ── 重置 ─────────────────────────────────────────────
  clock += 1000
  const reset = await (await handler({ method: 'POST' })).json()
  check('重置后显示 0', reset.ok === true && reset.reset === true && reset.cny === 0, JSON.stringify(reset))
  check('重置返回了重置前的值', near(reset.previous, grown.cny), `${reset.previous} vs ${grown.cny}`)
  check('重置后起点更新', reset.since === new Date(clock).toISOString())
  const afterResetFile = readSpend(spendFile)
  check('重置把每个会话的当前花费拍成基线', near(afterResetFile.sessions.get('a'), costViewOf(stateOf(8000, 2)).cny))

  // ── 重置后继续累计 ───────────────────────────────────
  writeCache(cacheDir, 'a', stateOf(12000, 3))
  clock += 1000
  const third = await (await handler({ method: 'GET' })).json()
  const expected = costViewOf(stateOf(12000, 3)).cny - costViewOf(stateOf(8000, 2)).cny
  check('重置后新花费重新计数', near(third.cny, expected), `${third.cny} vs ${expected}`)
  check('起点没再变', third.since === new Date(clock - 1000).toISOString())

  // ── 结果缓存 ─────────────────────────────────────────
  const caching = createSpendHandler({ file: spendFile, dir: cacheDir, cacheMs: 60000, now: () => clock, logger: { warn() {} } })
  const baselineRead = await (await caching({ method: 'GET' })).json()
  writeCache(cacheDir, 'a', stateOf(16000, 4))
  const cached = await (await caching({ method: 'GET' })).json()
  check('cacheMs 内不重扫', cached.cny === baselineRead.cny, `${cached.cny} vs ${baselineRead.cny}`)
  clock += 60001
  const forced = await (await caching({ method: 'GET' })).json()
  const delta = costViewOf(stateOf(16000, 4)).cny - costViewOf(stateOf(12000, 3)).cny
  check('…过期后重扫', near(forced.cny, cached.cny + delta), `${forced.cny} vs ${cached.cny + delta}`)

  // ── 损坏/旧形状的基线文件：重建 ──────────────────────
  fs.writeFileSync(spendFile, JSON.stringify({ baseline: 4.4, since: 'x' })) // 旧形状
  const fresh = createSpendHandler({ file: spendFile, dir: cacheDir, cacheMs: 0, now: () => clock, logger: { warn() {} } })
  const rebuilt = await (await fresh({ method: 'GET' })).json()
  check('旧形状基线被丢弃、按当前重建', rebuilt.ok === true && rebuilt.cny === 0, JSON.stringify(rebuilt))
  check('…重建后是新形状', readSpend(spendFile).sessions.size > 0)

  // ── 写失败不崩 ───────────────────────────────────────
  const broken = createSpendHandler({ file: path.join(tempRoot, 'nope', 'deep', 'spend.json'), dir: cacheDir, cacheMs: 0, now: () => clock, logger: { warn() {} } })
  const brokenRead = await (await broken({ method: 'GET' })).json()
  check('写失败时 GET 仍可读（只是没有基线）', brokenRead.ok === true && brokenRead.cny === 0)

  // ── 常量与往返 ───────────────────────────────────────
  check('路由常量', SPEND_ROUTE === '/api/clinepass.spend')
  check('writeSpend/readSpend 往返', (() => {
    const file = path.join(tempRoot, 'roundtrip.json')
    writeSpend(file, { since: '2026-11-02T00:00:00.000Z', sessions: new Map([['x', 1.5], ['y', 0]]) })
    const back = readSpend(file)
    return back.since === '2026-11-02T00:00:00.000Z' && near(back.sessions.get('x'), 1.5) && back.sessions.get('y') === 0
  })())
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

// 默认路径跟随 DSH_HOME（用临时值，不碰真实目录）。
process.env.DSH_HOME = path.join(os.tmpdir(), 'clinepass-home-probe')
check('spendFileFor 跟随 DSH_HOME', spendFileFor() === path.join(process.env.DSH_HOME, 'dsh-clinepass-spend.json'), spendFileFor())

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
