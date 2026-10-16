/**
 * Tests for the dsh-clinepass in-process **observer** (`globalThis.fetch`).
 *
 * No dsh process and no gateway: `globalThis.fetch` is replaced by a recording
 * stub, and responses are built by hand — SSE frames, single JSON documents,
 * failing reads — so every branch of the observer is exercised without a
 * network. The contract this file holds the observer to is narrow:
 *
 *   - a watched request is sent with the caller's own `input`/`init`, once,
 *     byte for byte, and is never retried;
 *   - everything else is passed through with the same arguments;
 *   - the response is delivered unchanged, and an SSE body keeps its per-frame
 *     arrival times (the reason the pass-through stream exists);
 *   - what was seen lands in the status file and in `?status=1`.
 *
 * Run: node test-fetch.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  createFetchObserver,
  createUsageHandler,
  apply,
  isGatewayChat,
  isTerminatorFrame,
  nextFrameEnd,
  observedProviderOf,
  providersOfText,
  routingOfText,
  routingsOfText,
  statusFileFor,
  withDefaults,
} from './index.js'

// The observer publishes a status file by default; keep every run's out of the
// user's real DSH_HOME (and let the default resolution be what is exercised).
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clinepass-fetch-'))
process.env.DSH_HOME = SCRATCH

const GATEWAY = 'https://api.cline.bot'
const CHAT = `${GATEWAY}/api/v1/chat/completions`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** A logger that records what was reported, with `%s` substituted like a real one. */
function recorder() {
  const lines = { info: [], warn: [], error: [] }
  const format = (template, args) => {
    let index = 0
    return String(template).replace(/%s/g, () => String(args[index++] ?? ''))
  }
  const record = (level) => (template, ...args) => lines[level].push(format(template, args))
  return { lines, info: record('info'), warn: record('warn'), error: record('error') }
}
const quiet = { info() {}, warn() {}, error() {} }

const enc = (text) => new TextEncoder().encode(text)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const frame = (payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
const contentFrame = (index = 0) => frame({ id: 'gen_1', object: 'chat.completion.chunk', model: 'cline-pass/deepseek-v4.1-flash', choices: [{ index: 0, delta: { content: `tok${index}` }, finish_reason: null }] })
const routingFrame = (routing) => frame({ choices: [{ index: 0, delta: { provider_metadata: { gateway: { routing } } } }] })
const DONE = 'data: [DONE]\n\n'

/** The routing metadata the live gateway writes for a first-party DeepSeek turn. */
const DEEPSEEK_ROUTING = {
  finalProvider: 'deepseek',
  resolvedProvider: 'deepseek',
  affinity: { pinnedProvider: 'deepseek' },
  fallbacksAvailable: ['fireworks', 'baseten'],
  modelAttempts: [{ providerAttempts: [{ provider: 'deepseek', success: true, statusCode: 200 }] }],
}

/** A response whose body is the given SSE frames, streamed one pull at a time. */
function sseResponse(frames, { gapMs = 0, keepOpen = false } = {}) {
  let sent = 0
  const stream = new ReadableStream({
    async pull(controller) {
      if (sent < frames.length) {
        controller.enqueue(enc(frames[sent]))
        sent += 1
        if (gapMs > 0) await sleep(gapMs)
        return
      }
      // A gateway that sent `[DONE]` and then simply never closes the socket is
      // the shape the terminator check exists for.
      if (keepOpen) return
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function readStatus(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  } catch {
    return null
  }
}

const chatInit = (body = { model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk_test' },
  body: JSON.stringify(body),
})

let counter = 0
/**
 * Run one scenario against a fresh observer.
 *
 * The stub is installed **before** `observer.install()` on purpose: the wrapper
 * captures whatever `globalThis.fetch` is at install time, so this is the only
 * order that proves the observer does not bypass the function it wrapped.
 *
 * @param handler - `(input, init) => Response | Promise<Response>`.
 * @param options - `{ config, url, init, drive, consume }`. `drive(response)`
 *   receives the response and may read it; `consume` (default true) drains the
 *   body as text when no `drive` is given.
 * @returns `{ response, text, driven, calls, observer, logger, statusPath, status }`.
 */
async function runObserved(handler, { config = {}, url = CHAT, init = chatInit(), drive = null, consume = true } = {}) {
  counter += 1
  const statusPath = path.join(SCRATCH, `status-${String(counter).padStart(3, '0')}.json`)
  const logger = recorder()
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = (input, second) => {
    calls.push({ input, init: second })
    return handler(input, second)
  }
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: statusPath, ...config }, logger)
  observer.install()
  let response = null
  let text = null
  let driven = null
  let status = null
  try {
    response = await globalThis.fetch(url, init === null ? undefined : init)
    if (drive !== null) driven = await drive(response)
    else if (consume) text = await response.text()
    // Let the fire-and-forget record land, and read the file while the hook is
    // still installed — `uninstall()` rewrites `hook` in the same file.
    await sleep(5)
    status = readStatus(statusPath)
  } finally {
    observer.uninstall()
    globalThis.fetch = real
  }
  return { response, text, driven, calls, observer, logger, statusPath, status }
}

// ── 1. where the observer looks ─────────────────────────────────────────────
console.log('\n── 1. scoping ────────────────────────────────────────────')
{
  check('the configured gateway chat endpoint is watched', isGatewayChat(CHAT, GATEWAY) === true)
  check('a trailing slash is the same endpoint', isGatewayChat(`${CHAT}/`, GATEWAY) === true)
  check('another path on the same origin is not', isGatewayChat(`${GATEWAY}/api/v1/models`, GATEWAY) === false)
  check('another origin is not', isGatewayChat('https://api.deepseek.com/chat/completions', GATEWAY) === false)
  check('an unparsable URL is not', isGatewayChat('not a url', GATEWAY) === false)
  check('an unparsable upstream is not', isGatewayChat(CHAT, 'api.cline.bot') === false)
}

// ── 2. the observer never changes a request ─────────────────────────────────
console.log('\n── 2. pure observation ───────────────────────────────────')
{
  const init = chatInit()
  const originalBody = init.body
  const originalHeaders = init.headers
  const frames = [contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE]
  const result = await runObserved(() => sseResponse(frames), { init })
  const call = result.calls[0]
  check('the watched request is sent exactly once', result.calls.length === 1, String(result.calls.length))
  check("…with the caller's own init object", call.init === init)
  check("…and the caller's own input string", call.input === CHAT, String(call.input))
  check('…an unchanged body, byte for byte', call.init.body === originalBody, String(call.init.body))
  check('…and unchanged headers', call.init.headers === originalHeaders)
  check('no routing field is ever written into the body', !call.init.body.includes('providerOptions') && !call.init.body.includes('"provider"'), call.init.body)
  check('the response bytes are untouched', result.text === frames.join(''), JSON.stringify(result.text?.slice(0, 60)))
}
{
  // Another origin: the stub sees the original arguments and nothing is counted.
  const init = { method: 'GET' }
  const result = await runObserved(
    () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    { url: 'https://api.deepseek.com/models', init },
  )
  check('a non-gateway request is passed through untouched', result.calls[0].input === 'https://api.deepseek.com/models' && result.calls[0].init === init)
  check('…and is not counted', result.observer.counters.seen === 0, JSON.stringify(result.observer.counters))
  check('…and its body is readable as-is', result.text === '{"ok":true}', result.text)
  check('…and it writes no observation', result.status?.lastVerified === null, JSON.stringify(result.status?.lastVerified))
}

// ── 3. the provider is read out of a streamed response ──────────────────────
console.log('\n── 3. streaming observation ──────────────────────────────')
{
  const result = await runObserved(() => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE]))
  const { observer, status } = result
  check('the request is counted as seen', observer.counters.seen === 1, JSON.stringify(observer.counters))
  check('…and as verified', observer.counters.verified === 1, JSON.stringify(observer.counters))
  check('…with no unknown', observer.counters.unknown === 0, JSON.stringify(observer.counters))
  check('the status file records the provider', status?.lastVerified?.provider === 'deepseek', JSON.stringify(status?.lastVerified))
  check('…the wire model it answered for', status?.lastVerified?.model === 'cline-pass/deepseek-v4.1-flash', JSON.stringify(status?.lastVerified))
  check('…the URL', status?.lastVerified?.url === CHAT, String(status?.lastVerified?.url))
  check('…and that it is not anonymized', status?.lastVerified?.anonymized === false, JSON.stringify(status?.lastVerified))
  check('the counters are in the status file', status?.counters?.seen === 1 && status?.counters?.verified === 1, JSON.stringify(status?.counters))
  check('the file names the service and transport', status?.service === 'dsh-clinepass' && status?.transport === 'fetch', JSON.stringify(status?.service))
  check('…and reports the hook as installed', status?.hook === 'installed', String(status?.hook))
  check('…with the profile address', status?.profileBaseURL === `${GATEWAY}/api/v1`, String(status?.profileBaseURL))
  check('the model index answers a lookup', observer.verifiedByModel('cline-pass/deepseek-v4.1-flash')?.provider === 'deepseek')
  check('an unknown model gets no answer', observer.verifiedByModel('cline-pass/glm-5.3-flash') === undefined)
  check('the status() snapshot carries the counters', observer.status().counters.verified === 1, JSON.stringify(observer.status()))
  check('state() is the same read surface', observer.state().counters.verified === 1)
}
{
  // The anonymous fallback-net label: recorded as a fact, flagged, counted.
  const routing = { finalProvider: 'openai-compatible-private', resolvedProvider: 'openai-compatible-private', affinity: { pinnedProvider: 'openai-compatible-private' } }
  const result = await runObserved(() => sseResponse([contentFrame(), routingFrame(routing), DONE]))
  check('the anonymous label is recorded as the provider', result.status?.lastVerified?.provider === 'openai-compatible-private', JSON.stringify(result.status?.lastVerified))
  check('…and flagged anonymized', result.status?.lastVerified?.anonymized === true, JSON.stringify(result.status?.lastVerified))
  check('…counted separately', result.observer.counters.anonymized === 1, JSON.stringify(result.observer.counters))
  check('…and remembered as the last anonymized turn', result.status?.lastAnonymized?.provider === 'openai-compatible-private', JSON.stringify(result.status?.lastAnonymized))
  check('the observer says so in the log', result.logger.lines.warn.some((line) => line.includes('openai-compatible-private')), JSON.stringify(result.logger.lines.warn))
}
{
  // No provider metadata at all: say so rather than guess.
  const result = await runObserved(() => sseResponse([contentFrame(), DONE]))
  check('no evidence counts as unknown', result.observer.counters.unknown === 1, JSON.stringify(result.observer.counters))
  check('…and no provider is invented', result.status?.lastVerified === null, JSON.stringify(result.status?.lastVerified))
  check('…and the log says so', result.logger.lines.warn.some((line) => line.includes('no provider metadata')), JSON.stringify(result.logger.lines.warn))
  check('the response is still delivered', result.text.endsWith(DONE), JSON.stringify(result.text?.slice(-20)))
}
{
  // The wire's top-level `provider` field (the pass-through shape, no routing).
  const topLevel = (provider) => frame({ id: 'gen_1', provider, choices: [{ index: 0, delta: { content: 'x' } }] })
  const result = await runObserved(() => sseResponse([topLevel('Z.AI'), topLevel('Z.AI'), DONE]))
  check('the top-level provider field is read', result.status?.lastVerified?.provider === 'z.ai', JSON.stringify(result.status?.lastVerified))
}
{
  // `provider_metadata.<x>` is the last clue, and only when the others are absent.
  const namespace = frame({ choices: [{ index: 0, delta: { provider_metadata: { kimi: { promptCacheHitTokens: 1 } } } }] })
  const named = await runObserved(() => sseResponse([namespace, DONE]))
  check('a provider namespace identifies the upstream', named.status?.lastVerified?.provider === 'kimi', JSON.stringify(named.status?.lastVerified))

  const infraOnly = frame({ choices: [{ index: 0, delta: { provider_metadata: { gateway: { routing: {} }, 'openai-compat': [] } } }] })
  const unnamed = await runObserved(() => sseResponse([infraOnly, DONE]))
  check('infrastructure namespaces are not provider names', unnamed.observer.counters.unknown === 1, JSON.stringify(unnamed.observer.counters))
}
{
  // Routing wins when both evidence shapes are present.
  const mixed = frame({ provider: 'wafer', choices: [{ index: 0, delta: { content: 'x' } }] })
  const result = await runObserved(() => sseResponse([mixed, routingFrame(DEEPSEEK_ROUTING), DONE]))
  check('routing is preferred over the top-level provider field', result.status?.lastVerified?.provider === 'deepseek', JSON.stringify(result.status?.lastVerified))
}

// ── 4. non-streaming responses ──────────────────────────────────────────────
console.log('\n── 4. non-streaming observation ──────────────────────────')
{
  const payload = JSON.stringify({ id: 'gen_2', choices: [{ index: 0, message: { role: 'assistant', content: 'hi', provider_metadata: { gateway: { routing: DEEPSEEK_ROUTING } } } }] })
  const result = await runObserved(() => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }))
  check('a JSON response is returned to the caller unchanged', result.text === payload, JSON.stringify(result.text?.slice(0, 40)))
  check('…and its routing metadata is still read', result.status?.lastVerified?.provider === 'deepseek', JSON.stringify(result.status?.lastVerified))
  check("…with the model from the request's own body", result.status?.lastVerified?.model === 'cline-pass/deepseek-v4.1-flash', JSON.stringify(result.status?.lastVerified))
}
{
  // A `Request` carries its own body: the model comes from a clone, the request
  // goes out as the caller's own object, and the body survives for the caller.
  const request = new Request(CHAT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'cline-pass/glm-5.3-flash', stream: false }) })
  const text = JSON.stringify({ id: 'gen_3', provider: 'Wafer', choices: [] })
  const result = await runObserved(
    () => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }),
    // `init: null` is "no second argument at all" — the helper's own default is a
    // chat init, which would mask the Request-body path this case is about.
    { url: request, init: null },
  )
  check('a Request object is forwarded as the caller passed it', result.calls[0].input === request)
  check('…and its body is still readable afterwards', (await request.clone().text()).includes('glm-5.3-flash'))
  check('…while the model is read from a clone', result.status?.lastVerified?.model === 'cline-pass/glm-5.3-flash', JSON.stringify(result.status?.lastVerified))
  check('…and the provider comes with it', result.status?.lastVerified?.provider === 'wafer', JSON.stringify(result.status?.lastVerified))
}

// ── 5. pacing: frames are relayed as they arrive ────────────────────────────
console.log('\n── 5. per-frame relay ────────────────────────────────────')
{
  const frames = []
  for (let index = 0; index < 8; index += 1) frames.push(contentFrame(index))
  frames.push(routingFrame(DEEPSEEK_ROUTING), DONE)
  const gapMs = 20
  const result = await runObserved(
    () => sseResponse(frames, { gapMs }),
    {
      consume: false,
      drive: async (response) => {
        const t0 = Date.now()
        const reader = response.body.getReader()
        const arrivals = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          arrivals.push({ at: Date.now() - t0, bytes: value.byteLength })
        }
        return arrivals
      },
    },
  )
  const arrivals = result.driven
  const span = arrivals.length > 1 ? arrivals[arrivals.length - 1].at - arrivals[0].at : 0
  check('every frame arrives as its own chunk', arrivals.length === frames.length, `${arrivals.length} arrivals for ${frames.length} frames`)
  check('…spread over the upstream timeline', span >= gapMs * (frames.length - 2), `span=${span}ms`)
  check('…with the first frame not held back to the end', arrivals[0].at <= gapMs * 2, `first=${arrivals[0].at}ms`)
  check('…and each frame carries exactly its own bytes', arrivals.slice(0, 8).every((entry) => entry.bytes === enc(frames[0]).length), JSON.stringify(arrivals.slice(0, 3)))
  check('the observation still lands when the caller reads by hand', result.status?.lastVerified?.provider === 'deepseek', JSON.stringify(result.status?.lastVerified))
}
{
  // `[DONE]` must end the downstream stream even when the upstream never closes.
  const result = await runObserved(() => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE], { keepOpen: true }))
  check('a gateway that never closes the socket still ends its stream', result.text.endsWith(DONE), JSON.stringify(result.text?.slice(-20)))
  check('…and the observation is recorded', result.status?.lastVerified?.provider === 'deepseek', JSON.stringify(result.status?.lastVerified))
}
{
  // Cancelling the consumer records nothing: the response never finished, so
  // there is no answer to attribute.
  const result = await runObserved(
    () => sseResponse([contentFrame(), contentFrame(), DONE], { gapMs: 5 }),
    {
      consume: false,
      drive: async (response) => {
        const reader = response.body.getReader()
        await reader.read()
        await reader.cancel('user stopped')
        return 'cancelled'
      },
    },
  )
  check('a cancelled stream is counted as seen, not as unknown', result.observer.counters.seen === 1 && result.observer.counters.unknown === 0, JSON.stringify(result.observer.counters))
  check('…and records no provider', result.status?.lastVerified === null, JSON.stringify(result.status?.lastVerified))
}

// ── 6. failures do not break the caller ─────────────────────────────────────
console.log('\n── 6. robustness ─────────────────────────────────────────')
{
  // The upstream itself fails: the same rejection, nothing observed.
  const failure = new Error('gateway exploded')
  const real = globalThis.fetch
  const statusPath = path.join(SCRATCH, 'status-reject.json')
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: statusPath }, quiet)
  globalThis.fetch = () => Promise.reject(failure)
  observer.install()
  let thrown = null
  try {
    await globalThis.fetch(CHAT, chatInit())
  } catch (error) {
    thrown = error
  }
  observer.uninstall()
  globalThis.fetch = real
  check('a failing request rejects with the same error', thrown === failure, String(thrown))
  check('…and is only counted as seen', observer.counters.seen === 1 && observer.counters.verified === 0 && observer.counters.unknown === 0, JSON.stringify(observer.counters))
}
{
  // A synchronous throw from the wrapped fetch must stay a rejected promise.
  const real = globalThis.fetch
  const statusPath = path.join(SCRATCH, 'status-sync.json')
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: statusPath }, quiet)
  globalThis.fetch = () => {
    throw new Error('sync boom')
  }
  const install = observer.install()
  let rejected = null
  try {
    await globalThis.fetch(CHAT, chatInit())
  } catch (error) {
    rejected = error
  }
  globalThis.fetch = real
  check('a synchronous throw still surfaces as a rejection', install === 'installed' && rejected !== null && rejected.message === 'sync boom', String(rejected))
}
{
  // A non-2xx response belongs to the upstream: passed through, not read, not
  // reported as an unattributable success.
  const body = '{"error":"rate limited"}'
  const result = await runObserved(
    () => new Response(body, { status: 429, headers: { 'content-type': 'application/json' } }),
    { consume: false, drive: async (response) => ({ status: response.status, text: await response.text() }) },
  )
  check('a 429 reaches the caller with its body', result.driven.status === 429 && result.driven.text === body, JSON.stringify(result.driven))
  check('…and is not reported as an unknown provider', result.observer.counters.unknown === 0, JSON.stringify(result.observer.counters))
}
{
  // A body the observer cannot inspect must not damage the response. Locking the
  // body before the observer sees it makes `clone()` throw; the caller's own
  // reader is then still the one that gets the bytes.
  let locked = null
  const result = await runObserved(
    () => {
      const response = new Response('{"provider":"wafer"}', { status: 200, headers: { 'content-type': 'application/json' } })
      locked = response.body.getReader()
      return response
    },
    { consume: false, drive: async () => 'locked' },
  )
  const chunk = await locked.read()
  check('an uninspectable response is still delivered', new TextDecoder().decode(chunk.value) === '{"provider":"wafer"}', String(new TextDecoder().decode(chunk.value)))
  check('…and counts as unknown rather than crashing', result.observer.counters.unknown === 1, JSON.stringify(result.observer.counters))
}
{
  // A status file that cannot be written must not break the request either.
  const real = globalThis.fetch
  const logger = recorder()
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: path.join(SCRATCH, 'nope', '\0bad') }, logger)
  globalThis.fetch = () => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE])
  observer.install()
  const text = await (await globalThis.fetch(CHAT, chatInit())).text()
  observer.uninstall()
  globalThis.fetch = real
  check('an unwritable status file leaves the traffic alone', text.endsWith(DONE), JSON.stringify(text.slice(-20)))
  check('…and warns once', logger.lines.warn.filter((line) => line.includes('could not write')).length === 1, JSON.stringify(logger.lines.warn))
}
{
  // A body that is not JSON must not stop the response from being observed.
  const result = await runObserved(() => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE]), { init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' } })
  check('a body that is not JSON still gets observed', result.status?.lastVerified?.provider === 'deepseek', JSON.stringify(result.status?.lastVerified))
  check('…with no model recorded', result.status?.lastVerified?.model === null, JSON.stringify(result.status?.lastVerified))
}

// ── 7. install / uninstall / ownership ──────────────────────────────────────
console.log('\n── 7. install and ownership ──────────────────────────────')
{
  const real = globalThis.fetch
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: false }, quiet)
  check('uninstalling before installing is a no-op', observer.uninstall() === 'absent')
  check('installing reports success', observer.install() === 'installed')
  check('…and replaces the global fetch', globalThis.fetch !== real)
  check('installing twice is idempotent', observer.install() === 'installed')
  check('checkOwnership agrees', observer.checkOwnership() === 'installed')
  check('uninstalling restores the original', observer.uninstall() === 'restored' && globalThis.fetch === real)
}
{
  // A reload must not grow a chain of wrappers.
  const real = globalThis.fetch
  const first = createFetchObserver({ upstream: GATEWAY, statusFile: false }, quiet)
  first.install()
  const second = createFetchObserver({ upstream: GATEWAY, statusFile: false }, quiet)
  second.install()
  check('a second instance is the one holding the global fetch', second.checkOwnership() === 'installed')
  check('…and the first instance knows it was displaced', first.checkOwnership() === 'replaced-by-us', first.checkOwnership())
  second.uninstall()
  check('unwinding the second restores the native fetch', globalThis.fetch === real, String(globalThis.fetch === real))
}
{
  // A foreign replacement is reported once and left alone.
  const real = globalThis.fetch
  const logger = recorder()
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: false }, logger)
  observer.install()
  const foreign = async () => new Response('foreign')
  globalThis.fetch = foreign
  check('a foreign fetch is reported as foreign', observer.checkOwnership() === 'foreign', observer.checkOwnership())
  check('…with one warning naming the observer', logger.lines.warn.some((line) => line.includes('no longer the observer hook')), JSON.stringify(logger.lines.warn))
  check('…and the second check does not warn again', (observer.checkOwnership(), logger.lines.warn.length === 1), String(logger.lines.warn.length))
  check('uninstall leaves a foreign fetch in place', observer.uninstall() === 'foreign' && globalThis.fetch === foreign)
  globalThis.fetch = real
}
{
  // A missing global fetch is reported, not thrown.
  const real = globalThis.fetch
  const logger = recorder()
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: false }, logger)
  delete globalThis.fetch
  const result = observer.install()
  globalThis.fetch = real
  check('a runtime with no global fetch degrades', result === 'unavailable', result)
  check('…with one error line', logger.lines.error.length === 1, JSON.stringify(logger.lines.error))
}
{
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: false }, quiet)
  check('statusFile: false disables the file', observer.statusPath === null, String(observer.statusPath))
  check('withDefaults resolves the default path under DSH_HOME', statusFileFor(withDefaults({})) === path.join(SCRATCH, 'dsh-clinepass-status.json'), statusFileFor(withDefaults({})))
  const home = process.env.DSH_HOME
  delete process.env.DSH_HOME
  check('…and falls back to ~/.dsh', statusFileFor(withDefaults({})).endsWith(path.join('.dsh', 'dsh-clinepass-status.json')), statusFileFor(withDefaults({})))
  process.env.DSH_HOME = home
}

// ── 8. the status route reads the observer ──────────────────────────────────
console.log('\n── 8. ?status=1 ──────────────────────────────────────────')
{
  const real = globalThis.fetch
  const statusPath = path.join(SCRATCH, 'status-route.json')
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: statusPath }, quiet)
  const handler = createUsageHandler({}, withDefaults({ usageCacheMs: 0 }), quiet, { hook: observer })

  const before = await handler(new Request('http://127.0.0.1:3080/api/clinepass.usage?status=1&model=cline-pass/deepseek-v4.1-flash'))
  const beforeBody = await before.json()
  check('no observation answers ok:false', beforeBody.ok === false && beforeBody.reason === 'no-observation', JSON.stringify(beforeBody))

  // Observe one turn through the same observer the route is holding.
  globalThis.fetch = () => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE])
  observer.install()
  await (await globalThis.fetch(CHAT, chatInit())).text()
  await sleep(5)
  observer.uninstall()
  globalThis.fetch = real

  const hit = await handler(new Request('http://127.0.0.1:3080/api/clinepass.usage?status=1&model=cline-pass/deepseek-v4.1-flash'))
  const hitBody = await hit.json()
  check('the status route reports the observed provider', hitBody.ok === true && hitBody.provider === 'deepseek', JSON.stringify(hitBody))
  check('…with the anonymous flag', hitBody.anonymized === false, JSON.stringify(hitBody))
  check('…the model it belongs to', hitBody.model === 'cline-pass/deepseek-v4.1-flash', JSON.stringify(hitBody))
  check('…and when it was seen', typeof hitBody.at === 'string' && hitBody.at.length > 0, JSON.stringify(hitBody))
  check('…and no gating fields leak in', !('warn' in hitBody) && !('allowed' in hitBody) && !('attempts' in hitBody), JSON.stringify(hitBody))
}
{
  // An unknown session and model still answer honestly.
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: false }, quiet)
  const handler = createUsageHandler({}, withDefaults({}), quiet, { hook: observer })
  const response = await handler(new Request('http://127.0.0.1:3080/api/clinepass.usage?status=1&sessionId=sess-1&model=m'))
  const body = await response.json()
  check('an unknown session and model answer ok:false', body.ok === false && body.reason === 'no-observation', JSON.stringify(body))
}

// ── 9. helper units ────────────────────────────────────────────────────────
console.log('\n── 9. parsing helpers ────────────────────────────────────')
{
  check('a frame ends at a blank line', nextFrameEnd(enc('data: 1\n\n')) === 9, String(nextFrameEnd(enc('data: 1\n\n'))))
  check('CRLF blank lines work', nextFrameEnd(enc('data: 1\r\n\r\n')) === 11, String(nextFrameEnd(enc('data: 1\r\n\r\n'))))
  check('a lone CR CR ends a frame', nextFrameEnd(enc('data: 1\r\r')) === 9, String(nextFrameEnd(enc('data: 1\r\r'))))
  check('an incomplete frame reports -1', nextFrameEnd(enc('data: 1\n')) === -1, String(nextFrameEnd(enc('data: 1\n'))))
  check('a [DONE] frame is a terminator', isTerminatorFrame(enc('data: [DONE]\n\n')) === true)
  check('a content frame is not', isTerminatorFrame(enc('data: {"a":1}\n\n')) === false)
  check('a split [DONE] across data lines is not a terminator', isTerminatorFrame(enc('data: [DO\ndata: NE]\n\n')) === false)
  check('a bare data line before [DONE] is not a terminator', isTerminatorFrame(enc('data\n\ndata: x\n\n')) === false)
}
{
  const text = `data: ${JSON.stringify({ choices: [{ delta: { provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } } }] })}\n\n${DONE}`
  check('routing is found in a stream', routingsOfText(text)[0]?.finalProvider === 'deepseek', JSON.stringify(routingsOfText(text)))
  check('routingOfText returns the last one', routingOfText(text)?.finalProvider === 'deepseek')
  check('top-level providers keep their spelling', providersOfText('data: {"provider":"Wafer"}\n\n').join(',') === 'Wafer', JSON.stringify(providersOfText('data: {"provider":"Wafer"}\n\n')))
  check('duplicate providers collapse', providersOfText('data: {"provider":"a"}\n\ndata: {"provider":"a"}\n\n').length === 1)
  check('a single JSON document is parsed too', routingsOfText(JSON.stringify({ routing: { finalProvider: 'x' } })).length === 1)
  check('an empty body has no evidence', routingsOfText('').length === 0 && providersOfText('').length === 0)
}
{
  check('routing wins over the top-level field', observedProviderOf({ routings: [{ finalProvider: 'DeepSeek' }], providers: ['wafer'], namespaces: ['kimi'] }) === 'deepseek')
  check('the top-level field wins over a namespace', observedProviderOf({ routings: [], providers: ['Wafer'], namespaces: ['kimi'] }) === 'wafer')
  check('resolvedProvider is used when finalProvider is absent', observedProviderOf({ routings: [{ resolvedProvider: 'Baseten' }] }) === 'baseten')
  check('affinity.pinnedProvider is the next fallback', observedProviderOf({ routings: [{ affinity: { pinnedProvider: 'Fireworks' } }] }) === 'fireworks')
  check('a successful attempt is the last routing fallback', observedProviderOf({ routings: [{ modelAttempts: [{ providerAttempts: [{ provider: 'Together', success: true }] }] }] }) === 'together')
  check('a failed attempt is not evidence', observedProviderOf({ routings: [{ modelAttempts: [{ providerAttempts: [{ provider: 'Together', success: false }] }] }] }) === null)
  check('nothing at all is null', observedProviderOf({}) === null && observedProviderOf() === null)
}

// ── 10. a real HTTP round trip, through undici ──────────────────────────────
console.log('\n── 10. through a real server ─────────────────────────────')
{
  let received = null
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received = body
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { provider_metadata: { gateway: { routing: DEEPSEEK_ROUTING } } } }] })}\n\n`)
      response.write(DONE)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const statusPath = path.join(SCRATCH, 'status-http.json')
  const observer = createFetchObserver({ upstream: origin, statusFile: statusPath }, quiet)
  observer.install()
  const body = JSON.stringify({ model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
  const text = await globalThis
    .fetch(`${origin}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    .then((response) => response.text())
  observer.uninstall()
  await new Promise((resolve) => server.close(resolve))
  check('a real gateway round trip relays the stream', text.endsWith(DONE), JSON.stringify(text.slice(-20)))
  check('…and the body reached the server byte for byte', received === body, JSON.stringify(received?.slice(0, 60)))
  await sleep(5)
  check('…and the observer recorded the provider', readStatus(statusPath)?.lastVerified?.provider === 'deepseek', JSON.stringify(readStatus(statusPath)?.lastVerified))
  check('…and reported no unknown', readStatus(statusPath)?.counters?.unknown === 0, JSON.stringify(readStatus(statusPath)?.counters))
}

// ── 11. apply(): the observer is what a mounted plugin installs ─────────────
console.log('\n── 11. apply() ───────────────────────────────────────────')
{
  /** A minimal settings double (same shape as test-settings.mjs). */
  const makeSettings = (value) => {
    const writes = []
    return {
      writes,
      describe: () => [{ ns: 'llm-pi-ai', revision: 3, value }],
      mutate: async (ns, ops, revision) => {
        writes.push({ ns, ops, revision })
        return { kind: 'written' }
      },
    }
  }
  /** A plugin context double: `settings` is reachable only through get()/inject(). */
  const applyCtx = ({ settings, logger = quiet, loader } = {}) => {
    const effects = []
    const listeners = new Map()
    const ctx = {
      logger,
      effect: (register) => effects.push(register()),
      on: (event, listener) => listeners.set(event, listener),
      get: (name) => (name === 'settings' ? settings : undefined),
      inject: () => Promise.resolve(),
      ...(loader === undefined ? {} : { root: { loader } }),
    }
    return { ctx, effects, listeners }
  }
  const MARK = Symbol.for('dsh-clinepass.fetch-hook')

  {
    // A healthy mount: the observer goes into the process, a disposer comes back,
    // and the provisioning outcome lands in the status file.
    const real = globalThis.fetch
    const statusPath = path.join(SCRATCH, 'apply-status.json')
    const settings = makeSettings({ providers: {} })
    const { ctx, effects } = applyCtx({ settings })
    await apply(ctx, { statusFile: statusPath, usage: false })
    check('apply installs the observer into the process', globalThis.fetch !== real && typeof globalThis.fetch[MARK] === 'function')
    check('…and registers exactly one disposer', effects.length === 1 && typeof effects[0] === 'function', String(effects.length))
    check('…leaving the profile it provisioned', settings.writes.length === 1, JSON.stringify(settings.writes.length))
    check('…with the outcome in the status file', readStatus(statusPath)?.provision === 'created', JSON.stringify(readStatus(statusPath)?.provision))
    check('…and the hook reported installed', readStatus(statusPath)?.hook === 'installed', String(readStatus(statusPath)?.hook))
    effects[0]()
    check('the disposer restores the original fetch', globalThis.fetch === real)
    check('…and the record says so', readStatus(statusPath)?.hook === 'uninstalled', String(readStatus(statusPath)?.hook))
  }

  {
    // A mistyped upstream must change nothing at all — no hook, no card.
    const real = globalThis.fetch
    const logger = recorder()
    const settings = makeSettings({ providers: {} })
    const { ctx, effects } = applyCtx({ settings, logger })
    await apply(ctx, { upstream: 'api.cline.bot', statusFile: false })
    check('a bad upstream installs nothing', globalThis.fetch === real && effects.length === 0)
    check('…and provisions nothing', settings.writes.length === 0)
    check('…saying why', logger.lines.error.some((line) => line.includes('is not a URL')), JSON.stringify(logger.lines.error))
  }

  {
    // The self-lock contract: provisioning must wait for the loader tree to
    // settle, and `apply()` must NOT await it (a fiber parked in LOADING keeps
    // the tree from settling forever — see the comment on `afterSettle`).
    const real = globalThis.fetch
    const statusPath = path.join(SCRATCH, 'apply-loader.json')
    const settings = makeSettings({ providers: {} })
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { ctx, effects } = applyCtx({ settings, loader: { await: () => gate } })
    const applied = apply(ctx, { statusFile: statusPath, usage: false })
    const raced = await Promise.race([applied.then(() => 'returned'), sleep(50).then(() => 'waiting')])
    check('apply returns while the tree is still loading', raced === 'returned', raced)
    check('…having written no provider card yet', settings.writes.length === 0, String(settings.writes.length))
    check('…with provisioning recorded as pending', readStatus(statusPath)?.provision === 'pending', String(readStatus(statusPath)?.provision))
    release()
    await sleep(20)
    check('…and provisioning runs once the tree settles', settings.writes.length === 1, String(settings.writes.length))
    check('…recording the outcome', readStatus(statusPath)?.provision === 'created', String(readStatus(statusPath)?.provision))
    for (const dispose of effects) dispose()
    globalThis.fetch = real
  }

  {
    // `provision: false` is reported as off, not as a failure.
    const real = globalThis.fetch
    const statusPath = path.join(SCRATCH, 'apply-off.json')
    const { ctx, effects } = applyCtx({ settings: makeSettings({ providers: {} }) })
    await apply(ctx, { provision: false, statusFile: statusPath, usage: false })
    check('provision: false is recorded as off', readStatus(statusPath)?.provision === 'off', String(readStatus(statusPath)?.provision))
    for (const dispose of effects) dispose()
    globalThis.fetch = real
  }
}

// ── 12. when the observation lands ──────────────────────────────────────────
//
// The provider is known the moment the response is read; the wire model needs a
// promise over the request body, which can settle much later (a streamed body,
// or a slow reader). These two blocks hold that split to its contract: the
// provider is readable at `[DONE]`, the model is patched into the *same* record
// afterwards, and a late model never lands on a newer observation.
console.log('\n── 12. observation timing ────────────────────────────────')

/** A request whose body stays open until `release()`, so `requestModel()` cannot settle. */
function gatedRequest() {
  let controller = null
  const stream = new ReadableStream({
    start(inner) {
      controller = inner
    },
  })
  const request = new Request(CHAT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk_test' },
    body: stream,
    duplex: 'half',
  })
  return {
    request,
    /** Finish the body, letting the observer's model promise settle. */
    release: (model) => {
      controller.enqueue(enc(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })))
      controller.close()
    },
  }
}

/** Read an SSE response only as far as the `[DONE]` frame. */
async function readToDone(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value)
    if (text.includes('[DONE]')) break
  }
  return { text, cancel: () => reader.cancel().catch(() => {}) }
}

{
  const statusPath = path.join(SCRATCH, 'status-timing.json')
  const real = globalThis.fetch
  const gated = gatedRequest()
  globalThis.fetch = () => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE])
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: statusPath }, recorder())
  observer.install()
  try {
    const read = await readToDone(await globalThis.fetch(gated.request))
    check(
      'the provider is readable the moment [DONE] arrives',
      observer.status().lastVerified?.provider === 'deepseek',
      JSON.stringify(observer.status().lastVerified),
    )
    check(
      '…and is already in the status file',
      readStatus(statusPath)?.lastVerified?.provider === 'deepseek',
      JSON.stringify(readStatus(statusPath)?.lastVerified),
    )
    check(
      '…while the wire model is still unknown (its body is still open)',
      observer.status().lastVerified?.model === null,
      JSON.stringify(observer.status().lastVerified?.model),
    )
    gated.release('cline-pass/deepseek-v4.1-flash')
    await sleep(5)
    check(
      '…and the model is filled into the same record',
      observer.status().lastVerified?.provider === 'deepseek' && observer.status().lastVerified?.model === 'cline-pass/deepseek-v4.1-flash',
      JSON.stringify(observer.status().lastVerified),
    )
    check('…which the model index then answers for', observer.verifiedByModel('cline-pass/deepseek-v4.1-flash')?.provider === 'deepseek')
    read.cancel()
  } finally {
    observer.uninstall()
    globalThis.fetch = real
  }
}

{
  // Two overlapping requests, the first one's body settling last: its late model
  // must not be stitched onto the second request's observation.
  const statusPath = path.join(SCRATCH, 'status-race.json')
  const real = globalThis.fetch
  const gated = gatedRequest()
  const anonymous = { finalProvider: 'openai-compatible-private', resolvedProvider: 'openai-compatible-private' }
  const responses = [() => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE]), () => sseResponse([contentFrame(), routingFrame(anonymous), DONE])]
  let served = 0
  globalThis.fetch = () => responses[served++]()
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: statusPath }, quiet)
  observer.install()
  try {
    const first = await readToDone(await globalThis.fetch(gated.request))
    const second = await readToDone(await globalThis.fetch(CHAT, chatInit()))
    await sleep(5)
    check('the newest observation wins', observer.status().lastVerified?.provider === 'openai-compatible-private', JSON.stringify(observer.status().lastVerified))
    check('…with its own model', observer.status().lastVerified?.model === 'cline-pass/deepseek-v4.1-flash', JSON.stringify(observer.status().lastVerified?.model))
    gated.release('cline-pass/model-of-the-first-request')
    await sleep(5)
    check(
      'a late model does not overwrite the newer observation',
      observer.status().lastVerified?.provider === 'openai-compatible-private',
      JSON.stringify(observer.status().lastVerified),
    )
    check('…nor replace its model', observer.status().lastVerified?.model === 'cline-pass/deepseek-v4.1-flash', JSON.stringify(observer.status().lastVerified?.model))
    check('…and the stale model is not indexed', observer.verifiedByModel('cline-pass/model-of-the-first-request') === undefined)
    first.cancel()
    second.cancel()
  } finally {
    observer.uninstall()
    globalThis.fetch = real
  }
}

// ── 13. the status file carries no secret material ─────────────────────────
//
// The README promises the status file holds no key and no request headers, and
// this is the assertion behind that sentence. The file is searched as *text*, so
// any future change that starts copying headers, credentials or an options bag
// into the payload turns it red without anyone having to list fields.
//
// (The one header value the contract does record is the session id, which is not
// a secret and is indexed on purpose — this block sends none, so the claim can be
// stated without exceptions.)
console.log('\n── 13. no secret material ────────────────────────────────')
{
  const SECRET = 'sk-clinepass-DO-NOT-ECHO-9f3a2b7c4d5e6f'
  const API_KEY = 'ck-api-key-DO-NOT-ECHO-1122334455'
  const COOKIE = 'cookie-value-DO-NOT-ECHO-abcdef'
  const BUILD = 'client-build-DO-NOT-ECHO-7c7c7c'
  const statusPath = path.join(SCRATCH, 'status-secrets.json')
  const real = globalThis.fetch
  globalThis.fetch = () => sseResponse([contentFrame(), routingFrame(DEEPSEEK_ROUTING), DONE])
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: statusPath }, quiet)
  const handler = createUsageHandler({}, withDefaults({ usageCacheMs: 0 }), quiet, { hook: observer })
  observer.install()
  try {
    const response = await globalThis.fetch(CHAT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SECRET}`,
        'x-api-key': API_KEY,
        cookie: `dsh=${COOKIE}`,
        'x-client-build': BUILD,
      },
      body: JSON.stringify({ model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    await response.text()
    await sleep(5)
  } finally {
    observer.uninstall()
    globalThis.fetch = real
  }

  const text = fs.readFileSync(statusPath, 'utf8')
  const present = (needles) => needles.filter((needle) => text.includes(needle))
  // Positive control first: searching an empty document for absent strings would
  // pass while proving nothing.
  check('the status file was written and describes the turn', text.includes('deepseek') && text.includes('cline-pass/deepseek-v4.1-flash'), JSON.stringify(text.slice(0, 80)))
  check('…and carries none of the request credentials', present([SECRET, API_KEY, COOKIE]).length === 0, JSON.stringify(present([SECRET, API_KEY, COOKIE])))
  check(
    '…nor any request header (name, prefix or value)',
    present(['authorization', 'Authorization', 'Bearer', 'x-api-key', 'cookie', 'x-client-build', BUILD]).length === 0,
    JSON.stringify(present(['authorization', 'Authorization', 'Bearer', 'x-api-key', 'cookie', 'x-client-build', BUILD])),
  )
  // The browser half is served from the same state, so it gets the same search.
  const bodyText = await (await handler(new Request('http://127.0.0.1:3080/api/clinepass.usage?status=1&model=cline-pass/deepseek-v4.1-flash'))).text()
  const leakedInBody = [SECRET, API_KEY, COOKIE, BUILD, 'authorization', 'x-api-key'].filter((needle) => bodyText.includes(needle))
  check('?status=1 still answers with the provider', JSON.parse(bodyText).provider === 'deepseek', bodyText)
  check('…and its body carries no credential or header either', leakedInBody.length === 0, JSON.stringify(leakedInBody))
}

console.log(`\nRESULT: ${failures.length === 0 ? 'FETCH OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
