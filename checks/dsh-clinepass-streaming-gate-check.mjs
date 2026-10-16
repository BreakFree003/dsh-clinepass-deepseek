/**
 * End-to-end check of the in-process **observer** against the REAL reader.
 *
 * The plugin's own tests read response bodies by hand. The part that can
 * silently break is the interaction with the OpenAI SDK (which is what
 * `@earendil-works/pi-ai` uses): if the pass-through stream reorders or delays
 * frames, or ends the body somewhere the SDK does not expect, messages stop
 * assembling. So the real SDK is driven through the installed observer, on a
 * mock gateway that streams exactly like the real one.
 *
 * What this proves, in observer terms (0.12.0):
 *   1. the SDK's request reaches the gateway **unmodified** — no injected
 *      routing field, same model id, one call;
 *   2. the stream still assembles into a complete assistant message, with the
 *      deltas arriving as they were produced;
 *   3. the observer still reads the real upstream out of that same response,
 *      including the anonymous fallback-net label.
 *
 * Run after deploying the package:  node checks/dsh-clinepass-streaming-gate-check.mjs
 */
import OpenAI from '/Users/breakfree/.dsh/profiles/web/node_modules/openai/index.mjs'
// 装在 node_modules 里的安装包（自 2026-09-27 起；此前是 profile 的 plugins/dsh-clinepass，
// 那条路径已经不存在了 —— 别把这里改回去）。手动安装路线才会落在 plugins/ 下。
import { createFetchObserver } from '/Users/breakfree/.dsh/profiles/web/node_modules/dsh-clinepass/index.js'

const GATEWAY = 'https://api.cline.bot'
const enc = (text) => new TextEncoder().encode(text)
const quiet = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const delta = (index) => `data: ${JSON.stringify({
  id: 'gen_test', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
  choices: [{ index: 0, delta: { content: `tok${index}` }, finish_reason: null }],
})}\n\n`

const flushFrame = `data: ${JSON.stringify({
  id: 'gen_test', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
})}\n\n`

const routingFrame = (provider) => `data: ${JSON.stringify({
  id: 'gen_test', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
  choices: [{
    index: 0, delta: {
      provider_metadata: {
        gateway: {
          routing: {
            finalProvider: provider,
            resolvedProvider: provider,
            fallbacksAvailable: [],
            modelAttempts: [{ providerAttempts: [{ provider, success: true }] }],
          },
        },
      },
    }, finish_reason: null,
  }],
})}\n\n`

/** A mock gateway that streams like the real one: deltas, a flush frame, routing, then [DONE]. */
function mockGateway(provider, received, { gapMs = 10, deltas = 6, holdMs = 150 } = {}) {
  return async (input, init) => {
    received.push({ input, init })
    const stream = new ReadableStream({
      async start(controller) {
        for (let index = 0; index < deltas; index += 1) {
          controller.enqueue(enc(delta(index)))
          await new Promise((r) => setTimeout(r, gapMs))
        }
        controller.enqueue(enc(flushFrame))
        await new Promise((r) => setTimeout(r, holdMs))
        controller.enqueue(enc(routingFrame(provider)))
        controller.enqueue(enc('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

async function run(label, provider) {
  const realFetch = globalThis.fetch
  const received = []
  globalThis.fetch = mockGateway(provider, received)
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: false }, quiet)
  observer.install()
  const client = new OpenAI({ apiKey: 'sk_test', baseURL: `${GATEWAY}/api/v1` })
  const arrivals = []
  let assembled = ''
  let failure = null
  let completed = false
  try {
    const stream = await client.chat.completions.create(
      { model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { signal: undefined },
    )
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? ''
      if (text !== '') {
        assembled += text
        arrivals.push({ text, at: Date.now() })
      }
    }
    completed = true
  } catch (error) {
    failure = error
  }
  await sleep(10)
  const observed = observer.status().lastVerified
  const counters = { ...observer.counters }
  observer.uninstall()
  globalThis.fetch = realFetch
  const spread = arrivals.length > 1 ? arrivals.at(-1).at - arrivals[0].at : 0
  const sentBody = typeof received[0]?.init?.body === 'string' ? received[0].init.body : null
  console.log(
    `${label.padEnd(26)} assembled=${JSON.stringify(assembled)}  chunks=${arrivals.length}` +
      `  spread=${String(spread).padStart(4)}ms  observed=${observed?.provider ?? '(none)'}` +
      `  anonymized=${String(observed?.anonymized ?? false)}  error=${failure === null ? 'none' : JSON.stringify(failure.message.slice(0, 60))}`,
  )
  return { assembled, failure, completed, arrivals, observed, received, sentBody, counters }
}

const ok = await run('deepseek (first-party)', 'deepseek')
const anon = await run('openai-compatible-private', 'openai-compatible-private')

const checks = [
  ['a verified stream completes through the SDK', ok.completed && ok.assembled === 'tok0tok1tok2tok3tok4tok5'],
  ['…with no SDK error', ok.failure === null],
  ['…and the deltas arrived spread over the stream, not in one lump', ok.arrivals.length === 6 && ok.arrivals.at(-1).at - ok.arrivals[0].at >= 40],
  ['the observer saw exactly one gateway call', ok.received.length === 1, String(ok.received.length)],
  ['…and the SDK body went out with no injected routing field', ok.sentBody !== null && !ok.sentBody.includes('providerOptions') && !ok.sentBody.includes('"provider"'), ok.sentBody],
  ['…and the model id reached the wire unchanged', ok.sentBody !== null && JSON.parse(ok.sentBody).model === 'cline-pass/deepseek-v4.1-flash'],
  ['the observer recorded the real provider', ok.observed?.provider === 'deepseek', JSON.stringify(ok.observed)],
  ['…and counted it as verified', ok.counters.verified === 1 && ok.counters.unknown === 0, JSON.stringify(ok.counters)],
  ['an anonymized upstream still completes through the SDK', anon.completed && anon.assembled === 'tok0tok1tok2tok3tok4tok5' && anon.failure === null],
  ['…and is reported as the anonymous label', anon.observed?.provider === 'openai-compatible-private' && anon.observed?.anonymized === true, JSON.stringify(anon.observed)],
  ['…counted separately', anon.counters.anonymized === 1, JSON.stringify(anon.counters)],
]
let failed = 0
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!pass) failed += 1
}
console.log(failed === 0 ? '\nE2E OK' : `\nE2E FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
