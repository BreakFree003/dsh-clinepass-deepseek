#!/usr/bin/env node
/**
 * Post-install / post-upgrade smoke test.
 *
 * Drives the real gateway through the route the Models page configures and
 * checks the things that can silently break:
 *
 *   1. the observer runs in-process — the profile points straight at the
 *      gateway, this plugin opens no listener, and the running dsh's
 *      `dsh-clinepass-status.json` confirms the hook is installed and has been
 *      reading responses
 *   2. a real turn completes through the gateway, the observer sees the actual
 *      upstream that served it (a first-party name, or the anonymous
 *      `openai-compatible-private` label), and the response is delivered to the
 *      caller unmodified
 *   3. the credential the Models page stored is the one the route resolves
 *
 * Run it from the installed plugin directory (so `js-yaml` resolves alongside
 * dsh) or from the package directory. `--negative` additionally asks the
 * gateway for a channel that cannot exist, which documents why the request-side
 * pin was removed in 0.12.0: the gateway ignores that field.
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
 * The clinepass loader row's own config. 0.12.0 removed every request-side
 * option, so nothing here selects behaviour any more — but a row written by an
 * older version still carries them, and the plugin lists them in the status
 * file's `ignoredOptions`. This script reports that rather than failing it.
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
console.log('── 1. observer transport ─────────────────────────────────')

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

  // The running dsh writes this file: it is the proof that the observer is in
  // its process and that responses actually reach it.
  const statusPath = path.join(DSH_HOME, 'dsh-clinepass-status.json')
  let record = null
  try {
    record = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  } catch {
    record = null
  }
  if (record === null) {
    check(
      'the running dsh reports its observer state',
      false,
      `${statusPath} is missing — restart dsh with the plugin mounted, or set statusFile in the loader row`,
    )
  } else {
    console.log(`       ${statusPath}`)
    console.log(`       hook=${record.hook} transport=${record.transport} pid=${record.pid} seen=${record.counters?.seen} verified=${record.counters?.verified} unknown=${record.counters?.unknown}`)
    check('the running dsh uses the fetch transport', record.transport === 'fetch', String(record.transport))
    if (Array.isArray(record.ignoredOptions) && record.ignoredOptions.length > 0) {
      console.log(`       ignored options from an older install: ${record.ignoredOptions.join(', ')}`)
    }
    // A record outlives the process that wrote it, so only a live pid can
    // support a claim about the live hook.
    let alive = false
    if (Number.isInteger(record.pid) && record.pid > 0) {
      try {
        process.kill(record.pid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (!alive) {
      console.log(`       (dsh pid ${record.pid} is not running — this record is from a finished run, so the live hook could not be checked)`)
      console.log('       (start dsh, send one message, and re-run to verify the hook in the live process)')
    } else {
      check('the observer is installed in the running dsh', record.hook === 'installed', String(record.hook))
      // The record is written by whichever build is running. A pre-0.12.0 build
      // reports the pin-era counter set, and that is not a pass: the live hook
      // would then be a different one from the code under test.
      const observerCounters = record.counters?.verified !== undefined || record.counters?.unknown !== undefined
      check(
        'responses are actually reaching the observer',
        observerCounters &&
          ((record.counters?.seen ?? 0) === 0 || (record.counters?.verified ?? 0) > 0 || (record.counters?.unknown ?? 0) > 0),
        observerCounters
          ? `${record.counters?.verified ?? 0} verified + ${record.counters?.unknown ?? 0} unknown of ${record.counters?.seen ?? 0} gateway requests`
          : `this record has no verified/unknown counters (seen=${record.counters?.seen ?? '?'}): the running dsh still serves the pre-observer build — deploy 0.12.0, restart, and re-run`,
      )
      if ((record.counters?.seen ?? 0) === 0) console.log('       (no gateway request since boot; send one and re-run to see the counters move)')
      if (record.lastVerified !== undefined && record.lastVerified !== null) {
        console.log(
          `       last observed: ${record.lastVerified.at} ${record.lastVerified.provider}` +
            ` (${record.lastVerified.model ?? 'model unknown'})` +
            ` virtual=${record.lastVerified.virtualModel ?? '(not recorded)'}` +
            ` upstream=${record.lastVerified.upstreamModel ?? '(not recorded)'}`,
        )
      }
      if (record.lastAnonymized !== undefined && record.lastAnonymized !== null) {
        console.log(`       last anonymized channel: ${record.lastAnonymized.at} ${record.lastAnonymized.provider}`)
      }
    }
  }

  if (pluginConfig.pin !== undefined || pluginConfig.enforcement !== undefined || pluginConfig.retries !== undefined) {
    console.log('       note: the loader row still carries pin/enforcement/retries — harmless (the observer ignores them), but they can be deleted')
  }

  // Exercise the installed code end to end; its own status file is off so the
  // running dsh's record above is not overwritten.
  const { createFetchObserver } = await import('./index.js')
  hook = createFetchObserver(
    { upstream: origin, statusFile: false },
    { info: () => {}, warn: (line, ...rest) => console.log(`       ${String(line).replace(/%s/g, () => String(rest.shift() ?? ''))}`), error: () => {} },
  )
  check('the installed observer can be installed', hook.install() === 'installed', 'this process only; dsh installs its own at boot')
}

// ── 2. a real turn ──────────────────────────────────────────────────────────
console.log('\n── 2. a real turn through the gateway ────────────────────')

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
 * pass-through evidence shape. No recursion on purpose: nested `provider` keys
 * (routing attempts, delta fields) are not direct-route evidence.
 */
function findProvider(node, out = []) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node) && typeof node.provider === 'string' && node.provider.length > 0) out.push(node.provider)
  return out
}

let routing = null
let content = ''
let streamError = null
let providersSeen = []
/** The last top-level `model` this test read off the wire itself (independent of the observer). */
let echoedSeen = null
if (key === undefined) {
  check('credential stored', false, `${keyRef} is missing — type it on Settings → Models`)
} else {
  const body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 384000 })
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body,
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
    streamError = error
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
      if (typeof json.model === 'string' && json.model.trim().length > 0) echoedSeen = json.model.trim()
      for (const choice of json.choices ?? []) content += choice.delta?.content ?? ''
    } catch {
      /* partial frame */
    }
  }
  check('gateway answered 200', response.status === 200, String(response.status))
  check('the stream ended without an error', streamError === null, String(streamError).slice(0, 120))
  check('model answered', content.trim().length > 0, JSON.stringify(content.trim().slice(0, 40)))
  check('the observer saw exactly one request', hook.counters.seen === 1, JSON.stringify(hook.counters))

  // The observer's own conclusion, from the same response the caller just read.
  const observed = hook.status().lastVerified
  const expectedProvider = (routing?.finalProvider ?? providersSeen[0] ?? null)
  check(
    'the observer read the real upstream from the response',
    observed !== null && typeof observed.provider === 'string' && observed.provider.length > 0,
    JSON.stringify(observed ?? null).slice(0, 160),
  )
  check(
    '…and it agrees with the routing metadata on the wire',
    observed !== null && (expectedProvider === null || observed.provider === String(expectedProvider).trim().toLowerCase()),
    `observed=${observed?.provider ?? '(none)'} wire=${String(expectedProvider ?? '(none)')}`,
  )
  // The echoed model is checked against this process's own reading of the same
  // frames, not against the observer's own parser: if the two disagree, the
  // observer is looking at something other than the wire.
  check(
    '…and the virtual model it recorded matches the frames this test read',
    observed !== null && (observed.virtualModel ?? null) === echoedSeen,
    `observed=${String(observed?.virtualModel ?? null)} wire=${String(echoedSeen)}`,
  )
  check(
    '…and the canonical upstream model matches the routing metadata',
    observed !== null && (observed.upstreamModel ?? null) === (routing?.canonicalSlug ?? null),
    `observed=${String(observed?.upstreamModel ?? null)} wire=${String(routing?.canonicalSlug ?? null)}`,
  )
  // The wire model is the one part of an observation that lands a moment later
  // (it needs the request body), so it gets its own wait and its own assertion —
  // never a wait on the whole `lastVerified`.
  if (observed !== null && observed.model !== modelId) {
    let followed = observed.model
    for (let i = 0; i < 20 && (followed === null || followed === undefined); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      followed = hook.status().lastVerified?.model ?? null
    }
    check('the wire model follows on the same record', followed === modelId, `${String(followed)} vs ${String(modelId)}`)
  }
  if (observed?.anonymized === true) {
    console.log(`       the channel is anonymized as ${observed.provider} — the contributor-tier fallback net (see clinepass-deepseek-audit/)`)
  } else if (observed !== null) {
    console.log(`       routed by the gateway to: ${observed.provider}`)
  }
  if (observed !== null && observed.upstreamModel) {
    console.log(`       canonical upstream model: ${observed.upstreamModel}`)
  }
  if (observed !== null && observed.virtualModel) {
    console.log(`       virtual model echoed by the alias: ${observed.virtualModel}`)
  }
  if (Array.isArray(routing?.fallbacksAvailable) && routing.fallbacksAvailable.length > 0) {
    console.log(`       note: the routing metadata still lists ${routing.fallbacksAvailable.length} fallback channels (this is a fact about the gateway, not a decision this plugin makes)`)
  }
  // 0.11.3：0.11.1/0.11.2 曾在会话首条消息的回复前垫一条匿名渠道提示帧，现在删了
  // —— 合成帧会进模型上下文。这条断言因此**反过来**：内容必须逐字来自网关。
  check(
    'the first message carries no synthetic notice frame',
    !(content.startsWith('⚠️') && content.includes('openai-compatible-private')),
    JSON.stringify(content.slice(0, 60)),
  )
  if (routing?.planningReasoning !== undefined) console.log(`       planningReasoning: ${String(routing.planningReasoning).slice(0, 110)}`)
}

// ── 3. the observer is transparent ──────────────────────────────────────────
//
// The observer must not change what the caller receives. This sends a second,
// deliberately tiny turn through a freshly installed observer and asserts that
// the body arrives intact — frames and terminator included — while the observer
// still records who served it.
console.log('\n── 3. a second turn is relayed untouched ─────────────────')
{
  const { createFetchObserver: makeObserver } = await import('./index.js')
  hook?.uninstall()
  const observer = makeObserver({ upstream: origin, statusFile: false }, { info: () => {}, warn: () => {}, error: () => {} })
  observer.install()
  let received = ''
  let streamFailure = null
  if (key === undefined) {
    check('a relayed turn is delivered intact', false, 'no credential — cannot drive the gateway')
  } else {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 64 }),
    })
    check('the gateway answered 200', response.status === 200, String(response.status))
    try {
      const reader = response.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += dec.decode(value)
      }
    } catch (error) {
      streamFailure = error
    }
    check('the relayed stream ends normally', streamFailure === null && received.includes('[DONE]'), String(streamFailure?.message ?? received.slice(-40)))
    check('…with model content in it', /"delta"/.test(received) || /"content"/.test(received), JSON.stringify(received.slice(0, 80)))
    check('…and the observer still counted it', observer.counters.seen === 1, JSON.stringify(observer.counters))
    check('…and it came back with a provider', observer.status().lastVerified !== null, JSON.stringify(observer.status().lastVerified ?? null).slice(0, 140))
  }
  observer.uninstall()
  hook?.install()
}

// ── 4. the request-side pin field (optional) ────────────────────────────────
if (argv.includes('--negative')) {
  console.log('\n── 4. why the request field was removed ──────────────────')
  const gateway = String(profile.baseURL ?? '').replace(new RegExp(`^${origin}`), '')
  const upstream = process.env.CLINE_UPSTREAM ?? 'https://api.cline.bot'
  // Deliberately through the unwrapped fetch: this is about what the gateway
  // does with the field, not about the plugin — which no longer writes one.
  const nativeFetch = globalThis.fetch
  const response = await nativeFetch(`${upstream}${gateway}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], providerOptions: { gateway: { only: ['__no_such_upstream__'] } } }),
  })
  const text = await response.text()
  // 这一节以前断言网关回 `No available providers match the 'only' filter`。那是 2026-09-22
  // **之前**的行为：网关此后整个忽略 provider 路由选项块（实测钉真渠道 / 钉假渠道 / 完全不钉，
  // routing 元数据逐字相同）。所以这条负控制证明的正好相反：**请求字段不承担任何钉选** ——
  // 这正是 0.12.0 把请求改写整块删掉的理由。
  const { routingsOfText } = await import('./index.js')
  const found = routingsOfText(text)[0] ?? null
  check(
    'the gateway ignores an impossible pin — the request field is dead',
    response.status === 200 && found !== null && found.finalProvider !== '__no_such_upstream__',
    `${response.status} finalProvider=${found?.finalProvider ?? 'no routing metadata'}`,
  )
  console.log(
    found !== null && Array.isArray(found.fallbacksAvailable)
      ? `       fallbacksAvailable=${found.fallbacksAvailable.length === 0 ? '[]（0.11.1 匿名化形状：渠道名已隐藏）' : `${found.fallbacksAvailable.length} 个`}`
      : '       no routing metadata on the wire',
  )
}

hook?.uninstall()

console.log(`\nRESULT: ${failures.length === 0 ? 'SMOKE OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
