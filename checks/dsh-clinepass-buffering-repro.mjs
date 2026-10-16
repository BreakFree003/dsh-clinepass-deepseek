/**
 * Stream pacing check for the dsh-clinepass observer.
 *
 * The observer must relay the body **exactly as it arrived**: every frame
 * forwarded on its own, as soon as the upstream produced it. If it ever
 * collapses to a single late chunk, someone has reintroduced "read the whole
 * response, then release it" — which would destroy the chunk arrival times dsh
 * measures output speed (TPS) from. That risk is the whole reason the observer
 * wraps the body in a pull-driven stream instead of returning a buffered clone.
 *
 * A mock upstream streams 40 SSE frames, 25 ms apart (~1 s total), then the
 * routing metadata and `[DONE]`.
 *
 * Run after deploying the package:  node checks/dsh-clinepass-buffering-repro.mjs
 */

// 同 dsh-clinepass/checks/dsh-clinepass-streaming-gate-check.mjs：路径是安装包（2026-09-27 起），不是
// profile 的 plugins/dsh-clinepass。
import { createFetchObserver } from '/Users/breakfree/.dsh/profiles/web/node_modules/dsh-clinepass/index.js'

const GATEWAY = 'https://api.cline.bot'
const CHAT = `${GATEWAY}/api/v1/chat/completions`
const FRAMES = 40
const GAP_MS = 25

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = { info() {}, warn() {}, error() {} }

const routingFrame = `data: ${JSON.stringify({
  choices: [{
    delta: {},
    provider_metadata: {
      gateway: {
        routing: {
          finalProvider: 'deepseek',
          resolvedProvider: 'deepseek',
          fallbacksAvailable: [],
          modelAttempts: [{ providerAttempts: [{ provider: 'deepseek', success: true }] }],
        },
      },
    },
  }],
})}\n\n`

function mockUpstream() {
  let sent = 0
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (sent < FRAMES) {
          const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`
          controller.enqueue(new TextEncoder().encode(frame))
          sent += 1
          await sleep(GAP_MS)
          return
        }
        controller.enqueue(new TextEncoder().encode(routingFrame))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const init = {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk_test' },
  body: JSON.stringify({
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    max_tokens: 512,
  }),
}

async function run(label) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => mockUpstream()
  const observer = createFetchObserver({ upstream: GATEWAY, statusFile: false }, quiet)
  observer.install()
  const t0 = Date.now()
  const response = await globalThis.fetch(CHAT, init)
  const reader = response.body.getReader()
  const arrivals = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    arrivals.push({ at: Date.now() - t0, bytes: value.byteLength })
  }
  await sleep(10)
  const observed = observer.status().lastVerified
  observer.uninstall()
  globalThis.fetch = realFetch
  const span = arrivals.at(-1) ? arrivals.at(-1).at - arrivals[0].at : 0
  console.log(
    `${label.padEnd(26)} status=${response.status}  chunks=${String(arrivals.length).padStart(3)}` +
      `  first=${String(arrivals[0]?.at ?? -1).padStart(5)}ms  last=${String(arrivals.at(-1)?.at ?? -1).padStart(5)}ms` +
      `  spread=${String(span).padStart(5)}ms  upstream spread=${FRAMES * GAP_MS}ms  observed=${observed?.provider ?? '(none)'}`,
  )
  console.log('   first 5 arrivals (ms since request):', arrivals.slice(0, 5).map((a) => a.at).join(', '))
  return { arrivals, span, status: response.status, observed }
}

const plain = await run('observer installed')

const checks = [
  ['every frame is relayed as its own chunk', plain.arrivals.length === FRAMES + 2, `${plain.arrivals.length} chunks for ${FRAMES + 2} frames`],
  ['…spread over the upstream timeline, not in one lump', plain.span >= GAP_MS * (FRAMES - 2), `span=${plain.span}ms`],
  ['…with the first frame delivered immediately', plain.arrivals[0].at <= GAP_MS * 2, `first=${plain.arrivals[0].at}ms`],
  ['…and the observer still records the provider', plain.observed?.provider === 'deepseek', JSON.stringify(plain.observed)],
]
let failed = 0
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!pass) failed += 1
}
console.log(failed === 0 ? '\nPACING OK' : `\nPACING FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
