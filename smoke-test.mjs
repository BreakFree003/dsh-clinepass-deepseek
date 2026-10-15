#!/usr/bin/env node
/**
 * Post-install / post-upgrade smoke test.
 *
 * Drives the real gateway through the route the Models page configures and
 * checks the things that can silently break:
 *
 *   1. the pin is injected in-process — the profile points straight at the
 *      gateway, this plugin opens no listener, and the running dsh's
 *      `dsh-clinepass-status.json` confirms the hook is installed and has been
 *      pinning requests
 *   2. the profile's model is actually served by what its pin demands — the
 *      evidence follows the model's pin shape: routing metadata (`finalProvider`)
 *      for a channel pin, the wire's top-level `provider` field for a provider
 *      pin (0.10.0); a strict refusal is a legitimate outcome and is asserted as one
 *   3. the credential the Models page stored is the one the route resolves
 *
 * Run it from the installed plugin directory (so `js-yaml` resolves alongside
 * dsh) or from the package directory. `--negative` additionally proves the pin
 * field is load-bearing by asking for a channel that cannot exist.
 *
 *   node smoke-test.mjs
 *   node smoke-test.mjs --negative
 *   DSH_HOME=/tmp/dsh node smoke-test.mjs
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const DSH_HOME = path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PROVIDER = 'cline-pass'
/** Port the old proxy transport would use; override with CLINE_PROXY_PORT. */
const LEGACY_PORT = Number(process.env.CLINE_PROXY_PORT ?? 8791)

/** Resolve js-yaml from wherever dsh keeps it. */
function yamlLoader() {
  const candidates = [
    import.meta.url,
    path.join(DSH_HOME, 'profiles', PROFILE, 'entry.js'),
    // The profile's own dependency link into the dsh install, which is where
    // js-yaml actually lives for every install method.
    path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(DSH_HOME, 'profiles', PROFILE, 'plugins', 'dsh-clinepass', 'smoke-test.mjs'),
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]
  for (const base of candidates) {
    try {
      return createRequire(base)('js-yaml')
    } catch {
      /* try the next location */
    }
  }
  return null
}

const yaml = yamlLoader()
if (yaml === null) {
  console.error('dsh-clinepass smoke: cannot find js-yaml. Run this from the installed plugin directory, or set DSH_HOME.')
  process.exit(1)
}

/**
 * 0.1.7 起补丁文档里会有 `!!js` 表达式（本机的本地 preset 是从随包 standard 冻结来的，
 * 带着 `disabled: !!js process.platform === 'win32'` 这类行）。js-yaml 默认 schema 遇到
 * 未知 tag 会对**整个文件**抛错，脚本一行断言都跑不到就退出 —— 这里把该 tag 认下来，
 * 构造一个标记对象（本脚本只读 `llm-pi-ai` 那条，不需要真的求值表达式）。
 */
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (expression) => ({ __js: expression }),
})
const YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsTag])

const readYaml = (file) =>
  fs.existsSync(file)
    ? yaml.load(fs.readFileSync(file, 'utf8'), { schema: YAML_SCHEMA })
    : undefined

/**
 * Where does this dsh version keep user settings?
 *
 * 0.1.6 and earlier: `$DSH_HOME/settings.yaml` (a standalone document).
 * 0.1.7+: the settings were merged into the **profile's patch document**
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, section id = loader entry id
 * (new package `dsh-config-editor` writes there). The old file is renamed to
 * `settings.yaml.imported` and may not exist at all.
 *
 * Both are checked, newest first, so this script keeps working across the move.
 * @returns the cline-pass provider profile and where it came from.
 */
function readProviderProfile() {
  const patchFile = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  const rows = readYaml(patchFile)
  if (Array.isArray(rows)) {
    const fromPatch = rows.find((row) => row?.id === 'llm-pi-ai')?.config?.providers?.[PROVIDER]
    if (fromPatch !== undefined) return { profile: fromPatch, source: patchFile, ns: 'llm-pi-ai' }
  }
  const legacyFile = path.join(DSH_HOME, 'settings.yaml')
  const fromLegacy = readYaml(legacyFile)?.['llm-pi-ai']?.providers?.[PROVIDER]
  if (fromLegacy !== undefined) return { profile: fromLegacy, source: legacyFile, ns: 'llm-pi-ai' }
  return { profile: undefined, source: patchFile, ns: 'llm-pi-ai' }
}

const credentials = readYaml(path.join(DSH_HOME, '.credentials.yaml')) ?? {}
const { profile, source: settingsSource } = readProviderProfile()

/**
 * The clinepass loader row's own config (pins / providerPins / enforcement) —
 * §2 的证据面按它分派：渠道钉看 routing 元数据，provider 钉看 wire 顶层 provider
 * 字段。行缺席时落到插件默认（pin=deepseek），与插件自身行为一致。
 */
const pluginRows = readYaml(path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml'))
const pluginConfig = (Array.isArray(pluginRows) ? pluginRows.find((row) => row?.id === 'clinepass') : undefined)?.config ?? {}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

if (profile === undefined) {
  console.error(`dsh-clinepass smoke: ${settingsSource} has no llm-pi-ai.providers.${PROVIDER}.`)
  console.error('Start dsh once with the plugin mounted (it provisions the profile), or add it on Settings → Models.')
  console.error('If you just upgraded to 0.1.7+, check ~/.dsh/settings.yaml.imported: the settings migration')
  console.error('renames settings.yaml before its first write, so a failed import never retries.')
  process.exit(1)
}

const keyRef = profile.apiKeyEnv ?? 'CLINE_PASS_API_KEY'
const key = credentials.refs?.[keyRef]
const modelId = process.env.MODEL_ID ?? profile.models?.[0]?.id
const baseURL = String(profile.baseURL ?? '')
const origin = baseURL.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '')

console.log('── inputs ────────────────────────────────────────────────')
console.log(`  DSH_HOME     : ${DSH_HOME}`)
console.log(`  read from    : ${settingsSource}`)
console.log(`  profile      : llm-pi-ai.providers.${PROVIDER}`)
console.log(`  baseURL      : ${baseURL}`)
console.log(`  model        : ${modelId}`)
console.log(`  key ref      : ${keyRef} (${key === undefined ? 'MISSING' : `stored, len ${String(key).length}`})`)
console.log('')

// ── 1. the transport ────────────────────────────────────────────────────────
console.log('── 1. pin transport ──────────────────────────────────────')

/** The port a loader row would listen on, if it carries one at all. */
function configuredPort() {
  const patch = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  if (!fs.existsSync(patch)) return LEGACY_PORT
  const lines = fs.readFileSync(patch, 'utf8').split('\n')
  const start = lines.findIndex((line) => /id:\s*['"]?clinepass['"]?\s*$/.test(line))
  if (start === -1) return LEGACY_PORT
  for (let i = start; i < lines.length && i < start + 12; i += 1) {
    const match = /^\s*listen:\s*(\S+)/.exec(lines[i])
    if (match !== null) return Number(String(match[1]).split(':').pop())
    if (i > start && /^\s*-?\s*id:/.test(lines[i])) break
  }
  return LEGACY_PORT
}

/** True when nothing accepts a TCP connection on that loopback port. */
function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const done = (closed) => {
      socket.destroy()
      resolve(closed)
    }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.setTimeout(1500, () => done(true))
  })
}

const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(baseURL)
if (loopback) {
  // Only reachable from a card left over from the removed proxy transport: the
  // route would talk to a listener that no longer exists.
  check('the card points at the gateway, not at a local listener', false, `${baseURL} — the loopback transport was removed in 0.5.0; restart dsh so the card is repaired`)
}

/**
 * The fetch this process has not wrapped.
 *
 * The pin lives in the running dsh process, so this script installs the
 * plugin's own hook to exercise the installed code — and the negative control
 * below needs the unwrapped one.
 */
const nativeFetch = globalThis.fetch
let hook = null

{
  const expected = process.env.CLINE_UPSTREAM ?? 'https://api.cline.bot'
  check('the profile points at the gateway itself', baseURL === `${expected}/api/v1`, baseURL)
  // The removed transport used to listen here; a leftover listener is worth
  // knowing about, and on a healthy install there is none.
  const port = configuredPort()
  // The detail must report what was actually observed: an unconditional
  // "accepted a connection" printed next to an `ok` reads like the port is open.
  const oldPortClosed = await portIsClosed(port)
  check(
    `nothing is listening on the old proxy port ${port}`,
    oldPortClosed,
    oldPortClosed ? 'no listener (the plugin opens none)' : 'something is still listening, from an older install — stop it or free the port',
  )

  // The running dsh writes this file: it is the proof that the hook is in its
  // process and that requests actually reach it.
  const statusPath = path.join(DSH_HOME, 'dsh-clinepass-status.json')
  let pinned = null
  try {
    pinned = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  } catch {
    pinned = null
  }
  if (pinned === null) {
    check(
      'the running dsh reports its pin state',
      false,
      `${statusPath} is missing — restart dsh with the plugin mounted, or set statusFile in the loader row`,
    )
  } else {
    console.log(`       ${statusPath}`)
    console.log(`       hook=${pinned.hook} transport=${pinned.transport} pid=${pinned.pid} seen=${pinned.counters?.seen} pinned=${pinned.counters?.pinned} skipped=${pinned.counters?.skipped}`)
    check('the running dsh uses the fetch transport', pinned.transport === 'fetch', String(pinned.transport))
    // A record outlives the process that wrote it, so only a live pid can
    // support a claim about the live hook.
    let alive = false
    if (Number.isInteger(pinned.pid) && pinned.pid > 0) {
      try {
        process.kill(pinned.pid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (!alive) {
      console.log(`       (dsh pid ${pinned.pid} is not running — this record is from a finished run, so the live hook could not be checked)`)
      console.log('       (start dsh, send one message, and re-run to verify the hook in the live process)')
    } else {
      check('the hook is installed in the running dsh', pinned.hook === 'installed', String(pinned.hook))
      check(
        'requests are actually reaching the hook',
        (pinned.counters?.seen ?? 0) === 0 || (pinned.counters?.pinned ?? 0) > 0 || (pinned.counters?.providerPinned ?? 0) > 0,
        `${pinned.counters?.pinned ?? 0} pinned + ${pinned.counters?.providerPinned ?? 0} provider-pinned of ${pinned.counters?.seen ?? 0} gateway requests — the rest were skipped (see the dsh log)`,
      )
      if ((pinned.counters?.seen ?? 0) === 0) console.log('       (no gateway request since boot; send one and re-run to see the counters move)')
      if (pinned.lastPin !== undefined && pinned.lastPin !== null) console.log(`       last pin: ${pinned.lastPin.at} ${pinned.lastPin.model} -> ${pinned.lastPin.only?.join(', ')}`)
      if (pinned.lastProviderPin !== undefined && pinned.lastProviderPin !== null) console.log(`       last provider pin: ${pinned.lastProviderPin.at} ${pinned.lastProviderPin.model} -> ${pinned.lastProviderPin.expect?.join(', ')}${pinned.lastProviderPin.order?.length ? ` (wire order: ${pinned.lastProviderPin.order.join(', ')})` : ''}`)
    }
  }

  // Exercise the installed code end to end; its own status file is off so the
  // running dsh's record above is not overwritten.
  const { createFetchPin } = await import('./index.js')
  // The hook must judge this turn with the plugin's REAL pin configuration — a
  // default-pinned hook would fail closed on a provider-pinned pass-through
  // model (2026-10-14: glm-5.3-flash carries no routing metadata at all).
  hook = createFetchPin(
    { upstream: origin, statusFile: false, pin: pluginConfig.pin, pins: pluginConfig.pins, providerPins: pluginConfig.providerPins, enforcement: pluginConfig.enforcement },
    { info: () => {}, warn: (line, ...rest) => console.log(`       ${String(line).replace(/%s/g, () => String(rest.shift() ?? ''))}`), error: () => {} },
  )
  check('the installed pin hook can be installed', hook.install() === 'installed', 'this process only; dsh installs its own at boot')
}

// ── 2. a real pinned turn ───────────────────────────────────────────────────
console.log('\n── 2. pinned turn through the gateway ────────────────────')

/** Collect every routing record in a parsed SSE frame. */
function findRouting(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) findRouting(entry, out)
    return out
  }
  if (node.routing !== undefined && node.routing !== null && typeof node.routing === 'object') out.push(node.routing)
  for (const value of Object.values(node)) findRouting(value, out)
  return out
}

/**
 * Collect every **top-level** `provider` field in a parsed SSE frame — the
 * provider-pin evidence. No recursion on purpose: nested `provider` keys
 * (routing attempts, delta fields) are not direct-route evidence.
 */
function findProvider(node, out = []) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node) && typeof node.provider === 'string' && node.provider.length > 0) out.push(node.provider)
  return out
}

let routing = null
let content = ''
let streamError = null
let gateError = null
let providersSeen = []
if (key === undefined) {
  check('credential stored', false, `${keyRef} is missing — type it on Settings → Models`)
} else {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    // 0.11.2：首条的判定是「流式 + 无 assistant 历史 + max_tokens > 8192」—— 这份请求
    // 模拟会话首条，预算必须带足，否则提示帧不垫。
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 384000 }),
  })
  let text = ''
  try {
    const reader = response.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = dec.decode(value)
      text += chunk
      if (chunk.includes('[DONE]')) {
        reader.cancel().catch(() => {})
        break
      }
    }
  } catch (error) {
    // strict 闸拒绝时流会以 ClinePassPinViolation 中断 —— 这是**预期结局之一**，不是
    // 脚本故障（2026-10-14 实测网关把 glm-5.3-flash 轮转给 Z.AI / InferenceNet /
    // Together；providerPins 撞上不允许的 provider 就是这条路径）。下面按证据分支断言。
    gateError = error
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      const json = JSON.parse(data)
      if (json.error !== undefined) streamError = json.error.message ?? JSON.stringify(json.error)
      for (const found of findRouting(json)) routing = found
      providersSeen = findProvider(json, providersSeen)
      for (const choice of json.choices ?? []) content += choice.delta?.content ?? ''
    } catch {
      /* partial frame */
    }
  }
  check('gateway answered 200', response.status === 200, String(response.status))
  const providerPinList = (pluginConfig.providerPins?.[modelId] ?? []).map((entry) => String(entry).toLowerCase())
  const channelPinList = Array.isArray(pluginConfig.pins?.[modelId]) ? pluginConfig.pins[modelId] : (pluginConfig.pin ?? [])
  if (gateError !== null) {
    // 闸把这次调用作废了：断言它确实以「违规」收场，且记录里说得出是谁服务的。
    const violation = hook.state().lastViolation
    check(
      'the gate refused this turn (the pin held)',
      String(gateError.code) === 'PROVIDER_PIN_VIOLATION' && violation !== null,
      `${gateError.code ?? gateError.name}: ${String(gateError.message ?? '').slice(0, 110)}`,
    )
    check(
      '…and the refusal is explained',
      String(violation?.reason ?? '').length > 0,
      String(violation?.reason ?? '').slice(0, 140),
    )
  } else {
    check('no stream error', streamError === null, String(streamError).slice(0, 120))
    check('model answered', content.trim().length > 0, JSON.stringify(content.trim().slice(0, 40)))
    if (providerPinList.length > 0 && channelPinList.length === 0) {
      // provider 级钉选（0.10.0）：证据是每帧顶层的 provider 字段。
      const unique = [...new Set(providersSeen)]
      check(
        'served by an allowed provider (wire provider field)',
        unique.length > 0 && unique.every((name) => providerPinList.includes(name.toLowerCase())),
        JSON.stringify(unique),
      )
      const gateSawIt = hook.state().lastVerified
      check(
        'the local gate verified this response',
        gateSawIt !== null && gateSawIt.provider === unique[0]?.toLowerCase(),
        JSON.stringify(gateSawIt ?? null).slice(0, 140),
      )
    } else {
      // 0.11.1：渠道名自 2026-10-14 起被网关匿名化为 `openai-compatible-private`（允许
      // 列表已放行它，并保留 deepseek —— 哪天改回真名校验自动恢复）。断言改成「由允许
      // 列表里的渠道服务」，而不是点名 deepseek。
      check('served by an allowed channel', channelPinList.includes(routing?.finalProvider), String(routing?.finalProvider))
      // 2026-09-22 起 api.cline.bot **不再执行** providerOptions.gateway.only：钉真渠道、钉假
      // 渠道、完全不钉，routing 元数据逐字相同，fallbacksAvailable 永远列出全部渠道。所以这里
      // 不再断言网关的钉选行为（那个行为已经不存在，断言它只会永远红），而是把事实打出来，
      // 并断言「这条响应确实通过了本地闸」—— 闸的拒绝行为由第 3 节证明。
      if (Array.isArray(routing?.fallbacksAvailable) && routing.fallbacksAvailable.length > 0) {
        console.log(`       注意：网关的 routing 仍列出 ${routing.fallbacksAvailable.length} 个 fallback 渠道 —— only 已不被执行，钉选由本地闸兑现`)
      }
      const gateSawIt = hook.state().lastVerified
      check(
        'the local gate verified this response',
        gateSawIt !== null && channelPinList.includes(gateSawIt.provider),
        JSON.stringify(gateSawIt ?? null).slice(0, 140),
      )
      // 0.11.2：这份请求是会话首条消息（流式 + 无 assistant 历史 + max_tokens > 8192）
      // —— 允许列表里有匿名渠道时，回复开头应该垫着提示帧。
      if (channelPinList.includes('openai-compatible-private')) {
        check(
          'the first message opens with the anonymized-channel notice',
          content.startsWith('⚠️') && content.includes('openai-compatible-private'),
          JSON.stringify(content.slice(0, 60)),
        )
        console.log(`       (提示帧之后的内容: ${JSON.stringify(content.slice(content.indexOf('⚠️') === 0 ? content.indexOf('\n') : 0, 80))})`)
      }
      if (routing?.planningReasoning !== undefined) console.log(`       planningReasoning: ${String(routing.planningReasoning).slice(0, 110)}`)
    }
  }
}

// ── 3. the local gate ───────────────────────────────────────────────────────
//
// 网关不再执行 providerOptions.gateway.only（见 README「网关不再执行 only」一节），
// 所以「钉住官方渠道」现在由插件在本地兑现：边流边读 routing，读出真正服务它的渠道，
// 不在允许列表里就让这条流在收尾前**中断**。这一节用一个**不可能存在**的渠道当允许
// 列表来证明闸是活的：网关再怎么挑也挑不到它 → 必须拒。
//
// ⚠️ 2026-10-03 实测：拿一个**真渠道**当「必然错配」是错的 —— 网关自行挑渠道（routing 的
// `fallbacksAvailable` 里就含 alibaba 等），有一次真的由 alibaba 服务，闸按契约放行、
// 这一节却报红（`blocked=0`、流正常收尾）。所以改用 `__no_such_upstream__`，不留概率。
console.log('\n── 3. the gate refuses a non-pinned response ─────────────')
{
  const { createFetchPin: makeHook } = await import('./index.js')
  hook?.uninstall()
  const gate = makeHook(
    { upstream: origin, statusFile: false, pin: ['__no_such_upstream__'] },
    {
      info: () => {},
      warn: () => {},
      error: (line, ...rest) => console.log(`       ${String(line).replace(/%s/g, () => String(rest.shift() ?? ''))}`),
    },
  )
  gate.install()
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 64 }),
  })
  // SSE 的拒法是**中断响应体**：HTTP 状态在第一帧内容出去时就定死了，所以状态仍是 200；
  // 内容边流边显示，但终止帧被扣住，消费端读到的是失败而不是一次正常收尾。
  let refusal = null
  let received = ''
  try {
    const reader = response.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += dec.decode(value)
    }
  } catch (error) {
    refusal = error
  }
  check('a streamed response from a channel we did not allow fails', refusal !== null, String(refusal?.message ?? '').slice(0, 120))
  check(
    'the failure is identifiable',
    String(refusal?.code) === 'PROVIDER_PIN_VIOLATION' && /渠道校验未通过/.test(String(refusal?.message)),
    `${refusal?.code}: ${String(refusal?.message ?? '').slice(0, 100)}`,
  )
  check('the refused stream never reaches a completion', !/\[DONE\]/.test(received), received.slice(-140))
  check('the refusal is counted', gate.counters.blocked === 1, String(gate.counters.blocked))
  const state = gate.state()
  // 拒绝理由按 wire 形状分派：带 routing 元数据的形状（deepseek）能点名渠道；直通形状
  // （glm-5.3-flash，2026-10-14 起）wire 上根本没有 routing 元数据，「无法证明」本身就是
  // 拒绝理由 —— 闸照样 fail closed，只是没有渠道名可点名。
  let receivedRouting = null
  for (const line of received.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      for (const found of findRouting(JSON.parse(data))) receivedRouting = found
    } catch {
      /* partial frame */
    }
  }
  const actualProvider = receivedRouting?.finalProvider ?? state.lastViolation?.finalProvider
  if (actualProvider !== undefined && actualProvider !== null) {
    check(
      'the violation records who actually served it',
      state.lastViolation !== null && state.lastViolation.finalProvider === actualProvider,
      JSON.stringify(state.lastViolation ?? null).slice(0, 160),
    )
    check('the violation records why it was refused', /__no_such_upstream__/.test(String(state.lastViolation?.reason)), String(state.lastViolation?.reason ?? ''))
  } else {
    check(
      'the violation records why it was refused (no routing metadata on the wire)',
      state.lastViolation !== null && /没有 gateway\.routing 元数据/.test(String(state.lastViolation?.reason)),
      String(state.lastViolation?.reason ?? ''),
    )
  }
  gate.uninstall()
  hook?.install()
}

// ── 4. the pin field itself (optional) ──────────────────────────────────────
if (argv.includes('--negative')) {
  console.log('\n── 4. negative control (impossible channel) ──────────────')
  const gateway = String(profile.baseURL ?? '').replace(new RegExp(`^${origin}`), '')
  const upstream = process.env.CLINE_UPSTREAM ?? 'https://api.cline.bot'
  // Deliberately through the unwrapped fetch: a hook would overwrite the
  // impossible pin with the real one and prove nothing.
  const response = await nativeFetch(`${upstream}${gateway}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], providerOptions: { gateway: { only: ['__no_such_upstream__'] } } }),
  })
  const text = await response.text()
  // 这一节以前断言网关回 `No available providers match the 'only' filter`。那是 2026-09-22
  // **之前**的行为：网关此后整个忽略 provider 路由选项块（实测钉真渠道 / 钉假渠道 / 完全不钉，
  // routing 元数据逐字相同 —— 见 README 那张表与 2026-09-30 复测）。所以这条负控制现在证明的
  // 正好相反：**请求字段不再承担任何钉选**，唯一还在兑现的是本地闸（第 3 节）。
  // 旧断言让 `--negative` 静默红了 8 天 —— 那比没有断言更糟，所以按事实改掉它。
  const { routingsOfText } = await import('./index.js')
  const routing = routingsOfText(text)[0] ?? null
  check(
    'the gateway no longer refuses an impossible pin — the request field is dead',
    response.status === 200 && routing !== null && routing.finalProvider !== '__no_such_upstream__',
    `${response.status} finalProvider=${routing?.finalProvider ?? 'no routing metadata'}`,
  )
  // 0.11.1：匿名化形状的 `fallbacksAvailable` 是**空列表**（不再列出渠道），旧断言
  // 「fallbacks > 1」会永远红。请求字段已死这一点由上一条 check 证明；这里只把形状打出来。
  console.log(
    routing !== null && Array.isArray(routing.fallbacksAvailable)
      ? `       fallbacksAvailable=${routing.fallbacksAvailable.length === 0 ? '[]（0.11.1 匿名化形状：渠道名已隐藏）' : `${routing.fallbacksAvailable.length} 个`}`
      : '       no routing metadata on the wire',
  )
}

hook?.uninstall()

console.log(`\nRESULT: ${failures.length === 0 ? 'SMOKE OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
