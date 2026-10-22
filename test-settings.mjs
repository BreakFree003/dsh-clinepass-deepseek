/**
 * Tests for the transport-independent half of dsh-clinepass: the option surface
 * (including the options earlier versions removed) and profile provisioning.
 *
 * No dsh process and no network: a stub settings service stands in for
 * ctx.settings, so the write ops, their order and their expected revision are
 * asserted exactly.
 *
 * Run: node test-settings.mjs
 */
import { provisionProfile, withDefaults } from './index.js'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

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

/** Minimal settings service double. */
function makeSettings(value, { revision = 3, ns = 'llm-pi-ai' } = {}) {
  const writes = []
  return {
    writes,
    // 0.1.7 removed `get()`; the live value rides on the descriptor now. The
    // double models the host that is actually current, so the suite exercises
    // the path a running dsh takes.
    describe: () => [{ ns, revision, value }],
    mutate: async (target, ops, expectedRevision) => {
      writes.push({ ns: target, ops, expectedRevision })
      return { kind: 'written' }
    },
  }
}

/** A card the plugin itself would have written, plus the levels a patch adds. */
const OUR_CARD = {
  displayName: 'Cline Pass',
  api: 'openai-completions',
  apiKeyEnv: 'CLINE_PASS_API_KEY',
  baseURL: 'https://api.cline.bot/api/v1',
  models: [{ id: 'cline-pass/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', contextWindow: 921600, maxTokens: 384000, input: ['text', 'image'], reasoningEfforts: { high: 'high', max: 'max' } }],
}

// ── 1. the option surface ───────────────────────────────────────────────────
console.log('\n── 1. option surface ─────────────────────────────────────')
{
  const cfg = withDefaults({})
  check('the defaults name the official gateway and this route', cfg.upstream === 'https://api.cline.bot' && cfg.provider === 'cline-pass' && cfg.model === 'cline-pass/deepseek-v4.1-flash-1017', JSON.stringify({ upstream: cfg.upstream, provider: cfg.provider, model: cfg.model }))
  check('no pin/enforcement/retry option exists any more', cfg.pin === undefined && cfg.pins === undefined && cfg.providerPins === undefined && cfg.enforcement === undefined && cfg.retries === undefined, JSON.stringify(Object.keys(cfg)))
  check('no transport option exists any more', cfg.transport === undefined && cfg.listen === undefined && cfg.captureDir === undefined, JSON.stringify(Object.keys(cfg)))
  check('withDefaults strips a trailing slash', withDefaults({ upstream: 'https://x.test/' }).upstream === 'https://x.test')
  const pathCfg = withDefaults({ upstream: 'https://x.test/api/v1' }, { warn: () => {}, info: () => {}, error: () => {} })
  check('an upstream with a path keeps only its origin', pathCfg.upstream === 'https://x.test', pathCfg.upstream)
  const pathLogs = recorder()
  withDefaults({ upstream: 'https://x.test/api/v1' }, pathLogs)
  check('…in one warning', pathLogs.lines.warn.filter((line) => line.includes('carries a path')).length === 1, JSON.stringify(pathLogs.lines.warn))
  check('a non-URL upstream is left for apply to refuse', withDefaults({ upstream: 'api.cline.bot' }).upstream === 'api.cline.bot')
  check('a boolean is not accepted as a size', withDefaults({ maxTokens: true }).maxTokens === 384000, String(withDefaults({ maxTokens: true }).maxTokens))
  check('a numeric string is accepted as a size', withDefaults({ maxTokens: '4096' }).maxTokens === 4096, String(withDefaults({ maxTokens: '4096' }).maxTokens))
  check('provision: false is respected', withDefaults({ provision: false }).provision === false)
  check('usage can be turned off', withDefaults({ usage: false }).usage === false)
  check('usage caching stays a non-negative number', withDefaults({ usageCacheMs: 0 }).usageCacheMs === 0 && withDefaults({ usageCacheMs: 'x' }).usageCacheMs === 60000)

  // An install written for the removed loopback transport must still boot: the
  // option is reported once and ignored, never fatal.
  const logs = recorder()
  const legacy = withDefaults({ transport: 'proxy', listen: '127.0.0.1:8791', captureDir: '/tmp/caps', baseURL: 'http://127.0.0.1:8791/api/v1', address: '127.0.0.1:8791' }, logs)
  check('every removed transport option is reported', ['transport', 'listen', 'captureDir', 'baseURL', 'address'].every((name) => logs.lines.warn.some((line) => line.includes(`"${name}"`))), JSON.stringify(logs.lines.warn))
  check('…and none of them survives into the config', ['transport', 'listen', 'captureDir', 'baseURL', 'address'].every((name) => legacy[name] === undefined), JSON.stringify(Object.keys(legacy)))
  check('…and the ignored names are carried for the status file', JSON.stringify(legacy.ignoredOptions) === '["transport","listen","captureDir","address","baseURL"]', JSON.stringify(legacy.ignoredOptions))
  check('a clean config carries none', JSON.stringify(cfg.ignoredOptions) === '[]', JSON.stringify(cfg.ignoredOptions))

  // 0.12.0 retired the request-side pin: its options load and are dropped, and
  // they are recorded rather than warned about — every stale row would otherwise
  // warn on every boot. `plainModelId` was dropped along with them by mistake and
  // is a real option again since 0.12.2 (the prompt display), so it is NOT in
  // this list.
  const retiredLogs = recorder()
  const retired = withDefaults({ pin: ['deepseek'], pins: { m: [] }, providerPins: { m: ['z.ai'] }, enforcement: 'warn', retries: 2, alignReasoningEffort: false }, retiredLogs)
  check('the retired pin options are recorded, not fatal', ['pin', 'pins', 'providerPins', 'enforcement', 'retries', 'alignReasoningEffort'].every((name) => retired.ignoredOptions.includes(name)), JSON.stringify(retired.ignoredOptions))
  check('…silently, so a stale row does not warn on every boot', retiredLogs.lines.warn.length === 0, JSON.stringify(retiredLogs.lines.warn))
  check('…and they are not part of the config', retired.pin === undefined && retired.enforcement === undefined && retired.retries === undefined)

  // The prompt display is on by default and selects `withoutRoutePrefix`; only an
  // explicit `false` turns it off, and it is never a retired key.
  check('the prompt display is on by default', withDefaults({}).plainModelId === true)
  check('plainModelId: false turns it off', withDefaults({ plainModelId: false }).plainModelId === false)
  check('…and it is a real option, not a retired one', !withDefaults({ plainModelId: false }).ignoredOptions.includes('plainModelId'), JSON.stringify(withDefaults({ plainModelId: false }).ignoredOptions))
  check('a non-false value leaves the display on', withDefaults({ plainModelId: true }).plainModelId === true && withDefaults({ plainModelId: 'no' }).plainModelId === true)

  // Passing an already-normalised config through again (apply does) must not
  // re-warn or lose the record.
  const again = recorder()
  check('re-normalising is silent and keeps the record', JSON.stringify(withDefaults(legacy, again).ignoredOptions) === JSON.stringify(legacy.ignoredOptions) && again.lines.warn.length === 0, JSON.stringify(again.lines.warn))
}

// ── 2. profile provisioning ────────────────────────────────────────────────
console.log('\n── 2. profile provisioning ───────────────────────────────')
{
  const cfg = withDefaults({})
  const empty = makeSettings({ providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } })
  check('creates the profile when absent', (await provisionProfile(empty, cfg, quiet)) === 'created')
  check('writes into llm-pi-ai at providers.cline-pass', empty.writes[0]?.ns === 'llm-pi-ai' && JSON.stringify(empty.writes[0]?.ops[0]?.path) === '["providers","cline-pass"]', JSON.stringify(empty.writes[0]?.ops[0]?.path))
  check('write carries the settings revision', empty.writes[0]?.expectedRevision === 3, String(empty.writes[0]?.expectedRevision))
  const written = empty.writes[0].ops[0].value
  check('profile points at the gateway itself, with no port', written.baseURL === 'https://api.cline.bot/api/v1', written.baseURL)
  check('profile uses an OpenAI-compatible protocol', written.api === 'openai-completions', written.api)
  check('profile names the credential ref', written.apiKeyEnv === 'CLINE_PASS_API_KEY', written.apiKeyEnv)
  check('profile declares the model id the gateway expects', written.models[0].id === 'cline-pass/deepseek-v4.1-flash-1017', written.models[0].id)
  check('profile declares the capacity', written.models[0].contextWindow === 921600 && written.models[0].maxTokens === 384000, JSON.stringify(written.models[0]))
  check('profile declares no reasoning levels — the profile patch owns that', written.models[0].reasoningEfforts === undefined, JSON.stringify(written.models[0]))
  check('nothing loopback is written anywhere', JSON.stringify(empty.writes).includes('127.0.0.1') === false)

  const present = makeSettings({ providers: { 'cline-pass': structuredClone(OUR_CARD) } })
  check('leaves an up-to-date profile alone', (await provisionProfile(present, cfg, quiet)) === 'present' && present.writes.length === 0, JSON.stringify(present.writes))

  const stale = makeSettings({ providers: { 'cline-pass': { ...structuredClone(OUR_CARD), baseURL: 'http://127.0.0.1:8791/api/v1' } } })
  check('repoints a stale address — the 0.3.0 migration', (await provisionProfile(stale, cfg, quiet)) === 'repaired' && stale.writes[0].ops[0].path.join('.') === 'providers.cline-pass.baseURL' && stale.writes[0].ops[0].value === 'https://api.cline.bot/api/v1', JSON.stringify(stale.writes[0]?.ops))

  // The levels and any extra field an existing card declares are not this
  // plugin's to rewrite: 0.12.0 stopped managing effort entirely.
  const customised = structuredClone(OUR_CARD)
  customised.models[0].contextWindow = 1000
  customised.models[0].reasoningEfforts = { high: 'high', max: 'max', medium: 'medium' }
  customised.models[0].vendor = 'x'
  const custom = makeSettings({ providers: { 'cline-pass': customised } })
  check('a capacity change is repaired', (await provisionProfile(custom, cfg, quiet)) === 'repaired' && custom.writes[0].ops[0].value[0].contextWindow === 921600, JSON.stringify(custom.writes[0]?.ops))
  check('…and only the models array is touched', JSON.stringify(custom.writes[0].ops.map((op) => op.path.join('.'))) === '["providers.cline-pass.models"]', JSON.stringify(custom.writes[0].ops.map((op) => op.path.join('.'))))
  check('…with the levels the card already declared left alone', JSON.stringify(custom.writes[0].ops[0].value[0].reasoningEfforts) === '{"high":"high","max":"max","medium":"medium"}', JSON.stringify(custom.writes[0].ops[0].value[0].reasoningEfforts))
  check('…and unrelated fields preserved', custom.writes[0].ops[0].value[0].vendor === 'x', JSON.stringify(custom.writes[0].ops[0].value[0]))

  const missingModel = makeSettings({ providers: { 'cline-pass': { displayName: 'Cline Pass', api: 'openai-completions', apiKeyEnv: 'CLINE_PASS_API_KEY', baseURL: 'https://api.cline.bot/api/v1' } } })
  check('a model entry that went missing is restored', (await provisionProfile(missingModel, cfg, quiet)) === 'repaired', JSON.stringify(missingModel.writes))
  check('…as the only change', JSON.stringify(missingModel.writes[0]?.ops.map((op) => op.path.join('.'))) === '["providers.cline-pass.models"]', JSON.stringify(missingModel.writes[0]?.ops.map((op) => op.path.join('.'))))
  check('…with the gateway model id and capacity', missingModel.writes[0].ops[0].value[0].id === 'cline-pass/deepseek-v4.1-flash-1017' && missingModel.writes[0].ops[0].value[0].contextWindow === 921600, JSON.stringify(missingModel.writes[0].ops[0].value[0]))

  const foreign = makeSettings({ providers: { 'cline-pass': { apiKeyEnv: 'SOMEONE_ELSES_KEY', baseURL: 'https://elsewhere.test/v1' } } })
  check('a profile that is not ours is left alone', (await provisionProfile(foreign, cfg, quiet)) === 'mismatch' && foreign.writes.length === 0)

  // …unless it is stranded on a loopback address the removed transport left
  // behind: nothing listens there, so leaving it means the route goes nowhere.
  const stranded = makeSettings({ providers: { 'cline-pass': { api: 'openai-completions', apiKeyEnv: 'MY_RENAMED_KEY', baseURL: 'http://127.0.0.1:8791/api/v1' } } })
  const strandedLogs = recorder()
  check('a stranded card is moved to the gateway even when its keys differ', (await provisionProfile(stranded, cfg, strandedLogs)) === 'repaired' && JSON.stringify(stranded.writes[0]?.ops) === '[{"op":"set","path":["providers","cline-pass","baseURL"],"value":"https://api.cline.bot/api/v1"}]', JSON.stringify(stranded.writes[0]?.ops))
  check('…and the user is told why', strandedLogs.lines.warn.some((line) => line.includes('nothing listens on')), JSON.stringify(strandedLogs.lines.warn))
  const elsewhere = makeSettings({ providers: { 'cline-pass': { apiKeyEnv: 'MY_RENAMED_KEY', baseURL: 'https://elsewhere.test/v1' } } })
  check("a card on someone else's address is still left alone", (await provisionProfile(elsewhere, cfg, quiet)) === 'mismatch' && elsewhere.writes.length === 0)

  const renamed = makeSettings({ providers: { 'cline-pass': { ...structuredClone(OUR_CARD), displayName: 'Old Name' } } })
  check('a changed display name is repaired', (await provisionProfile(renamed, cfg, quiet)) === 'repaired' && JSON.stringify(renamed.writes[0]?.ops) === '[{"op":"set","path":["providers","cline-pass","displayName"],"value":"Cline Pass"}]', JSON.stringify(renamed.writes[0]?.ops))
  const upsized = structuredClone(OUR_CARD)
  upsized.models[0].maxTokens = 1000
  const capacity = makeSettings({ providers: { 'cline-pass': upsized } })
  check('a changed output capacity is repaired', (await provisionProfile(capacity, cfg, quiet)) === 'repaired' && capacity.writes[0].ops[0].value[0].maxTokens === 384000, JSON.stringify(capacity.writes[0]?.ops))

  for (const scalar of ['oops', 42, null]) {
    const broken = makeSettings({ providers: { 'cline-pass': scalar } })
    check(`a scalar profile (${JSON.stringify(scalar)}) is reported as a mismatch`, (await provisionProfile(broken, cfg, quiet)) === 'mismatch' && broken.writes.length === 0)
  }

  const flaky = makeSettings({ providers: {} })
  let calls = 0
  const realMutate = flaky.mutate
  flaky.mutate = async (...args) => {
    calls += 1
    if (calls === 1) throw new Error('settings conflict')
    return realMutate(...args)
  }
  check('a conflicted write is retried once', (await provisionProfile(flaky, cfg, quiet)) === 'created' && calls === 2, `calls=${calls}`)

  const refused = makeSettings({ providers: {} })
  refused.mutate = async () => {
    throw new Error('settings is read-only')
  }
  const failedLogs = recorder()
  check('a write that keeps failing is reported, not thrown', (await provisionProfile(refused, cfg, failedLogs)) === 'failed' && failedLogs.lines.warn.length === 1, JSON.stringify(failedLogs.lines.warn))
  const note = []
  await provisionProfile(refused, cfg, quiet, (reason) => note.push(reason))
  check('…and the reason travels to the status file', note.length === 1 && note[0].includes('read-only'), JSON.stringify(note))

  // A custom upstream has to reach the card.
  const customUpstream = makeSettings({ providers: {} })
  await provisionProfile(customUpstream, withDefaults({ upstream: 'https://gateway.test/' }), quiet)
  check('a custom upstream is honoured on the card', customUpstream.writes[0].ops[0].value.baseURL === 'https://gateway.test/api/v1', customUpstream.writes[0].ops[0].value.baseURL)
}

console.log(`\nRESULT: ${failures.length === 0 ? 'SETTINGS OK' : `FAILED (${failures.join(' | ')})`}`)
process.exit(failures.length === 0 ? 0 : 2)
