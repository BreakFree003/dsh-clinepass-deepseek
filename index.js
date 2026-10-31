/**
 * dsh-clinepass — Cline Pass on the built-in pi-ai route: **observe, never touch**.
 *
 * Two jobs, and neither one changes a request:
 *
 *  1. **Show the real provider.** api.cline.bot answers a chat request with
 *     routing metadata naming the upstream that actually served it — including
 *     the anonymous label `openai-compatible-private` for the fallback net.
 *     This plugin watches those responses in-process (`globalThis.fetch` is
 *     wrapped for the lifetime of the process, and only this gateway's
 *     chat-completions calls are inspected), writes what it saw to a status
 *     file, and answers `?status=1` for the composer pill.
 *
 *     The wrapper is an **observer**: input, init, headers and body go to the
 *     original fetch byte-for-byte, no request is ever retried or added, and
 *     the response travels back frame by frame — the same object where nothing
 *     has to be read (non-SSE) or a pass-through stream that forwards each
 *     frame as it arrives (SSE, so chunk arrival times are unchanged).
 *
 *  2. **Cline Pass usage card** on Settings → Models: the plugin reads
 *     `GET <upstream>/api/v1/users/me/plan/usage-limits` with the credential it
 *     already has and renders the three windows inside the provider card.
 *
 * The route itself is a plain **pi-ai provider profile**
 * (`llm-pi-ai.providers.cline-pass`): an OpenAI-compatible endpoint whose API
 * key lives in the credential store, which is why the provider — and its key
 * field — appears natively on Settings → Models. The plugin **provisions** that
 * profile on first boot (create when absent, repair only the address, never
 * rewrite anything else), so mounting the plugin is the whole install.
 *
 * Finally, it keeps that prefix out of the **prompt**: the persona would
 * otherwise read "powered by the cline-pass/deepseek-v4.1-flash-1017 model", while
 * every first-party route shows a bare model id (the shipped `deepseek` route
 * declares `deepseek-v4-flash`, no prefix). The wire keeps the prefix; only the
 * display drops it — see `installPromptDisplay`, and `plainModelId` to turn it
 * off.
 *
 * Deliberately dependency-free: only Node built-ins, so the whole thing can be
 * read, tested and audited in one file.
 *
 * @module dsh-clinepass
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Stable plugin id used by loader diagnostics. */
export const name = 'clinepass'

/** The settings seam is required: the provider profile is provisioned through it. */
export const inject = ['settings']

/** Provider route this plugin observes. */
export const PROVIDER = 'cline-pass'

/** Model id as the gateway wants it (`type/model`), and as declared in the profile. */
export const MODEL = 'cline-pass/deepseek-v4.1-flash-1017'

/** Settings namespace the provider profile lives in — this is what puts the key field on the Models page. */
export const PROFILE_NS = 'llm-pi-ai'

/** Wire protocol of the Cline Pass endpoint. */
export const PROFILE_API = 'openai-completions'

/** Credential reference the Models page writes, and pi-ai resolves. */
export const KEY_REF = 'CLINE_PASS_API_KEY'

/** The path every OpenAI-compatible route appends to its base URL. */
export const PROFILE_PATH = '/api/v1'

/**
 * 反射式取 settings 服务。
 *
 * **不要直接读 `ctx.settings`**：cordis 会拒绝未在 `inject` 里声明过的属性读取
 * （`cannot get property "settings" without inject`），而**冷启动那一刻 settings 还没注册** ——
 * 直接读会让 `apply()` 当场中断，后面的登记一步都不跑（0.1.7 上的实测症状：状态文件里
 * `provision` 是 `pending`，设置页里没有卡片）。这里走反射式 `ctx.get()`：
 * 拿得到就当场用，拿不到交给 `ctx.inject()` 等它注册。
 *
 * @param ctx - 插件上下文（或测试替身）。
 * @returns settings 服务，未就位时为 `undefined`。
 */
function settingsService(ctx) {
  try {
    const candidate = ctx.get?.('settings')
    if (candidate !== undefined && candidate !== null && typeof candidate.mutate === 'function') return candidate
  } catch {
    /* 未声明 inject / 尚未注册：cordis 会抛，这里正是要兜住的情况 */
  }
  return undefined
}

/**
 * 读一个命名空间当前的 live 值。
 *
 * dsh 0.1.7 起，settings 服务（`SettingsForms`）暴露的是 `describe()` / `update()` /
 * `replace()` / `mutate()` —— **`get()` 被移除了**。0.1.7-rc.2 上直接调
 * `settings.get(ns)` 会抛 `settings.get is not a function`，于是 provider 卡片永远登记不上
 * （这正是 `provision: "failed"` 的真身）。`describe()` 的每一项自带 `value`
 * （类型注释：*"One Loader entry's live Config fields"*），所以读值走它；`get()` 只作为更早
 * 宿主的兜底留着。
 *
 * @param settings - settings 服务（或测试替身）。
 * @param ns - 命名空间 / profile entry id。
 * @returns 该命名空间的 live 值，读不到时为 `undefined`。
 */
function readNamespace(settings, ns) {
  try {
    const rows = settings.describe?.()
    const entry = Array.isArray(rows) ? rows.find((row) => row.ns === ns) : undefined
    if (entry !== undefined && entry.value !== undefined) return entry.value
  } catch {
    /* 读不到就走下面的兜底 */
  }
  return settings.get?.(ns)
}

/**
 * The ClinePass usage-limits endpoint, as a path below `upstream`.
 *
 * Cline's own dashboard reads this path; it is **not** in the public Enterprise
 * API reference, so the shape is pinned by `normalizeUsage` and by
 * `test-usage.mjs` rather than by documentation. CodexBar
 * (github.com/steipete/CodexBar, MIT) is the reference implementation this
 * matches: `GET`, no body, no query.
 */
export const USAGE_PATH = '/api/v1/users/me/plan/usage-limits'

/**
 * The one Fetch route the browser half reads usage through.
 *
 * Registered on dsh's **existing** `/api` channel (`ctx.connection.fetch`),
 * which the web server already owns: this adds a path, never a listener, a
 * port, or a socket. The channel applies dsh's own Host/Origin trust fence and
 * browser-cookie authentication before the handler runs, and only the usage
 * numbers ever travel back — the key is read on this side and never returned.
 *
 * `?status=1` rides the same path: it answers from the observer's memory, so it
 * never touches the credential store or the gateway.
 */
export const USAGE_ROUTE = '/api/clinepass.usage'

/**
 * The `globalThis` name the browser half reads `{ usageRoute }` from.
 *
 * The route is configurable, and the client half has to fetch the same path —
 * so the host announces it through the web server's own index-injection table
 * (the same mechanism `dsh-client-connection` uses for its recovery timing)
 * rather than letting the two halves drift with a hard-coded coincidence.
 */
export const USAGE_BOOT_GLOBAL = '__DSH_CLINEPASS__'

/**
 * The windows Cline reports, in the order the card shows them.
 *
 * Cline's payload names them `five_hour` / `weekly` / `monthly`; an unknown
 * `type` is skipped rather than rendered (CodexBar does the same, and Cline has
 * shipped experimental pool types before).
 */
export const USAGE_WINDOWS = ['five_hour', 'weekly', 'monthly']

const DEFAULT_USAGE_TIMEOUT_MS = 15_000
const DEFAULT_USAGE_CACHE_MS = 60_000

/**
 * How long a *failed* read is remembered.
 *
 * Successes are cached for `usageCacheMs`, but without this a persistent failure
 * (no network, gateway down, no key) costs one gateway round trip per card
 * mount — every entry into the Models pane. Short enough that fixing the key and
 * looking again is honest: the card also forces a refresh when the stored key
 * changes, so it never has to wait this out.
 */
const USAGE_ERROR_CACHE_MS = 5_000

/**
 * Resolve to `promise`'s value, or to a `timeout` failure after `ms`.
 *
 * Applied to the *whole* read rather than only to the gateway call inside it:
 * `credentials.resolve` is outside that signal, and a provider that never
 * settles would otherwise hold the dedupe slot open forever.
 *
 * @param promise - the read to bound.
 * @param ms - the budget.
 * @returns the read's result, or a synthetic timeout failure.
 */
function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', message: `the usage read did not finish within ${ms} ms` }), ms)
    // Never hold the host process open on behalf of a usage read.
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Marks a wrapper as ours, carrying the fetch it replaced.
 *
 * Re-mounting a plugin in one process (a reload, an HMR pass) would otherwise
 * leave a chain of wrappers, each holding the previous one as its "original";
 * reading the marker unwraps straight back to the real fetch.
 */
const FETCH_MARK = Symbol.for('dsh-clinepass.fetch-hook')

const DEFAULT_UPSTREAM = 'https://api.cline.bot'

/**
 * 网关给 VMC 回退网形状的**匿名渠道标签**（0.11.1）：2026-10-14 起 provider 元数据不再
 * 写出真名，`finalProvider` / `resolvedProvider` / 成功的 `providerAttempts` 一律是这个值
 * （实测与审计：`clinepass-deepseek-audit/`，权重同一性已验证 —— 正版 V4.1 Flash 的低噪声
 * 重部署，contributor 档）。观察者把它原样记下，胶囊据此切换成告警样式。
 */
const ANONYMIZED_CHANNEL = 'openai-compatible-private'

/**
 * 回退池（degraded pool）在**回显模型名**里的形状。
 *
 * 网关按**模型档位**决定走不走回退池，与 provider 选择是两条独立决策：同一次请求可以
 * `finalProvider=deepseek`，而帧里回显 `vmc/deepseek-v4p1-flash-1017-contributor-fallbacks`
 * （2026-10-31 实测：smoke-test 第 2 节这一轮就被服务成
 * `openai-compatible-private` + 该回显模型）。provider 元数据读不出这一层，模型名是唯一可靠的信号。
 *
 * 只匹配后缀、不做等值比较：主池回显的是 canonical slug
 * （`deepseek/deepseek-v4.1-flash-1017`），与请求 id（`cline-pass/…`）从来就不相等 ——
 * 等值比较会把每一次正常请求都判成异常。
 */
export const DEGRADED_MODEL_PATTERN = /contributor-fallbacks?$|\/fallbacks?$|-fallbacks?$/i

/**
 * 这个回显模型名是不是回退池。
 *
 * 注意 `vendor/fallbackless-model` 这类名字**不是**：只有 `-fallback(s)` 后缀才算，
 * 词中间的 "fallback" 是模型名的一部分，不是池子的标记。
 *
 * @param model - 上游回显的模型名（`null` / 空串都算否）。
 * @returns 是否由回退池服务。
 */
export function isDegradedModel(model) {
  return typeof model === 'string' && model.trim().length > 0 && DEGRADED_MODEL_PATTERN.test(model.trim())
}

const DEFAULT_CONTEXT_WINDOW = 921600
const DEFAULT_MAX_TOKENS = 384000

/** Coerce a configured number to the positive integer the model catalog requires. */
function positiveInteger(value, fallback) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

/**
 * Coerce a configured number to a non-negative integer.
 *
 * Usage caching is the one knob where `0` is meaningful — it means "always
 * refetch" — so `positiveInteger` is the wrong coercer for it.
 *
 * @param value - the configured value.
 * @param fallback - what an unreadable value becomes.
 * @returns the value, or the fallback.
 */
function nonNegativeInteger(value, fallback) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

/** True for a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Fill every unset field.
 *
 * Configuration can arrive from a patch row, a settings section, or a partial
 * edit, and not every path applies schema defaults — so nothing here trusts the
 * raw object to be complete.
 *
 * Options that only the removed loopback transport used (`transport`, `listen`,
 * `captureDir`, `address`, `baseURL`) are accepted and ignored: an old patch row
 * or an old settings file must not stop the plugin from loading. Each one is
 * reported once, and their names travel in `ignoredOptions` — so the status file
 * shows them too, for a front end where plugin `warn` lines are not visible.
 *
 * 0.12.0 removed the request-side pin, so its options (`pin`, `pins`,
 * `providerPins`, `enforcement`, `retries`, `alignReasoningEffort`) are also
 * accepted and dropped — but **silently**: there is no behaviour left for them to
 * select, and every stale row would otherwise warn on every boot. They are still
 * recorded in `ignoredOptions`, so a config that nobody has cleaned up stays
 * visible. (`plainModelId` was dropped along with them by mistake in 0.12.0; it
 * selects the prompt display and is a real option again since 0.12.2 — see
 * `installPromptDisplay`.)
 *
 * @param raw - whatever configuration arrived.
 * @param logger - where to report a removed option.
 * @returns a complete configuration.
 */
export function withDefaults(raw, logger = console) {
  const ignored = Array.isArray(raw?.ignoredOptions) ? [...raw.ignoredOptions] : []
  for (const removed of ['transport', 'listen', 'captureDir', 'address', 'baseURL']) {
    if (raw?.[removed] !== undefined) {
      if (!ignored.includes(removed)) ignored.push(removed)
      logger.warn?.(
        '[clinepass] "%s" is no longer used: the loopback proxy transport was removed in 0.5.0 and this plugin listens on nothing. Remove the option.',
        removed,
      )
    }
  }
  for (const retired of ['pin', 'pins', 'providerPins', 'enforcement', 'retries', 'alignReasoningEffort']) {
    if (raw?.[retired] !== undefined && !ignored.includes(retired)) ignored.push(retired)
  }
  const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  const rawUpstream = text(raw?.upstream, DEFAULT_UPSTREAM)
  let upstream = rawUpstream
  try {
    const parsed = new URL(rawUpstream)
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      // `upstream` is an origin: the profile appends `PROFILE_PATH` itself, so a
      // leftover path would be doubled while the observer still matched by origin.
      upstream = parsed.origin
      logger.warn?.('[clinepass] upstream "%s" carries a path; using its origin "%s" (the route already appends %s)', rawUpstream, upstream, PROFILE_PATH)
    }
  } catch {
    // Not a URL: `apply` reports it and installs nothing.
  }
  return {
    upstream: upstream.replace(/\/+$/, ''),
    provider: text(raw?.provider, PROVIDER),
    model: text(raw?.model, MODEL),
    displayName: text(raw?.displayName, 'Cline Pass'),
    contextWindow: positiveInteger(raw?.contextWindow, DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInteger(raw?.maxTokens, DEFAULT_MAX_TOKENS),
    apiKeyEnv: text(raw?.apiKeyEnv, KEY_REF),
    provision: raw?.provision !== false,
    // The persona shows the bare model id by default (`withoutRoutePrefix`); an
    // explicit `false` keeps the wire id in the prompt too.
    plainModelId: raw?.plainModelId !== false,
    usage: raw?.usage !== false,
    usageRoute: text(raw?.usageRoute, USAGE_ROUTE),
    usageTimeoutMs: positiveInteger(raw?.usageTimeoutMs, DEFAULT_USAGE_TIMEOUT_MS),
    usageCacheMs: nonNegativeInteger(raw?.usageCacheMs, DEFAULT_USAGE_CACHE_MS),
    statusFile: raw?.statusFile === false ? false : typeof raw?.statusFile === 'string' && raw.statusFile.length > 0 ? raw.statusFile : true,
    ignoredOptions: ignored,
  }
}

/**
 * Where the in-process observer reports what it has seen.
 *
 * There is no listener to ask, and plugin `info` lines are not shown by every
 * dsh front end, so a run whose observer quietly stopped reading responses
 * would look exactly like a healthy one. This file is the plain,
 * always-available answer: `hook: "installed"` says the wrapper is in the
 * global fetch, and the counters say whether responses are actually reaching it.
 *
 * @param cfg - the complete configuration.
 * @returns the path, or null when the status file is disabled.
 */
export function statusFileFor(cfg) {
  if (cfg.statusFile === false) return null
  if (typeof cfg.statusFile === 'string' && cfg.statusFile.length > 0) return cfg.statusFile
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-clinepass-status.json')
}

/**
 * Read one reset timestamp into a canonical ISO string, or null.
 *
 * The live endpoint answers with **nanosecond** precision
 * (`2026-09-16T11:38:00.490486029Z`). V8 parses that today, but it is outside
 * what `Date` is specified to accept, and the string is handed to a browser —
 * so this side (which is always Node) normalises it to milliseconds once and
 * the browser never has to be lenient.
 *
 * @param value - the `resetsAt` the endpoint sent.
 * @returns an ISO-8601 string, or null when there is none or it is unreadable.
 */
function resetInstant(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * Reduce the usage-limits payload to the three windows the card renders.
 *
 * Nothing here trusts the response: `success` must be exactly `true`,
 * `data.limits` must be an array, `percentUsed` must be a finite number
 * (clamped to 0–100), and a window is dropped when it is unreadable rather than
 * rendered as a wrong number. Unknown window types are skipped — Cline has
 * shipped experimental pool types that this card does not claim to understand.
 *
 * `percentUsed` is **used**, not remaining; the card turns it into a bar and a
 * remaining figure itself.
 *
 * @param payload - the parsed response body.
 * @returns `{ ok: true, limits }` or `{ ok: false, problem }`.
 */
export function normalizeUsage(payload) {
  if (!isPlainObject(payload)) return { ok: false, problem: 'the response is not a JSON object' }
  if (payload.success !== true) return { ok: false, problem: 'the response did not report success' }
  const raw = isPlainObject(payload.data) ? payload.data.limits : undefined
  if (!Array.isArray(raw)) return { ok: false, problem: 'the response carries no limits array' }
  const limits = []
  for (const type of USAGE_WINDOWS) {
    const entry = raw.find((candidate) => isPlainObject(candidate) && candidate.type === type)
    if (entry === undefined) continue
    const percent = typeof entry.percentUsed === 'number' && Number.isFinite(entry.percentUsed) ? entry.percentUsed : Number.NaN
    if (Number.isNaN(percent)) continue
    limits.push({ type, percentUsed: Math.min(100, Math.max(0, percent)), resetsAt: resetInstant(entry.resetsAt) })
  }
  return { ok: true, limits }
}

/**
 * Fetch this account's usage limits from the gateway.
 *
 * The key is used for exactly one thing — the `Authorization` header of this
 * request — and is never logged, cached, or returned. Failure is a *value*, not
 * a throw: every branch is something the card can render ("no key", "rejected",
 * "rate limited", "gateway down"), and a broken usage reader must never be able
 * to take the route down with it.
 *
 * The request is not a chat-completions call, so the observer passes it
 * through untouched.
 *
 * @param cfg - the complete plugin configuration.
 * @param apiKey - the resolved credential value.
 * @param options - `fetch` override (tests) and an abort signal.
 * @returns `{ ok: true, limits }` or `{ ok: false, reason, message, status? }`.
 */
export async function fetchUsage(cfg, apiKey, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'network', message: 'no fetch implementation is available' }
  const url = `${cfg.upstream}${USAGE_PATH}`
  const timeoutMs = positiveInteger(cfg.usageTimeoutMs, DEFAULT_USAGE_TIMEOUT_MS)
  // `AbortSignal.timeout` is Node 17.3+ and the engines floor is Node 20, but a
  // hand-supplied signal (tests) wins, and a runtime without it still gets a
  // request rather than a crash.
  const signal =
    options.signal ??
    (typeof AbortSignal === 'function' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    })
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      message: aborted ? `the gateway did not answer within ${timeoutMs} ms` : 'could not reach the gateway',
    }
  }
  const status = response.status
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'unauthorized', status, message: 'the gateway rejected the API key; re-enter it on Settings → Models' }
  }
  if (status === 429) return { ok: false, reason: 'rate-limited', status, message: 'the gateway is rate limiting usage reads; try again shortly' }
  if (status >= 500) return { ok: false, reason: 'unavailable', status, message: `the gateway answered ${status}` }
  if (status !== 200) return { ok: false, reason: 'http', status, message: `the gateway answered ${status}` }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    // The timeout covers the body too: a gateway that sends 200 + headers and
    // then stalls the body aborts *here*, not at the fetch. Reporting that as
    // "not JSON" would send the user hunting for a malformed gateway.
    const aborted = signal?.aborted === true || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    if (aborted) {
      return { ok: false, reason: 'timeout', status, message: `the gateway did not finish answering within ${timeoutMs} ms` }
    }
    return { ok: false, reason: 'parse', status, message: 'the gateway answered with something that is not JSON' }
  }
  const normalized = normalizeUsage(payload)
  if (!normalized.ok) return { ok: false, reason: 'parse', status, message: normalized.problem }
  return { ok: true, limits: normalized.limits }
}

/**
 * Build the usage route handler.
 *
 * One successful read is cached for `usageCacheMs` and shared between
 * concurrent callers, so opening the settings page (and every re-render of the
 * card) does not turn into a burst of gateway calls. Failures are cached only
 * for `USAGE_ERROR_CACHE_MS`.
 *
 * `?refresh=1` bypasses the cache — that is the card's refresh button.
 * `?status=1` answers from the observer's memory instead (no key, no gateway).
 *
 * @param routeCtx - the context the `connection` and `credentials` services resolved in.
 * @param cfg - the complete plugin configuration.
 * @param logger - where to report an unexpected failure.
 * @param options - a `fetch` override (tests) and the observer (`hook`).
 * @returns the Fetch handler.
 */
export function createUsageHandler(routeCtx, cfg, logger = console, options = {}) {
  let cache = null
  let inflight = null

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })

  async function read() {
    const credentials = routeCtx.credentials ?? routeCtx.get?.('credentials')
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      return { ok: false, reason: 'no-credentials', message: 'this dsh has no credential store to read the API key from' }
    }
    const resolved = await credentials.resolve(cfg.apiKeyEnv)
    if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value.length === 0) {
      return { ok: false, reason: 'no-key', message: `no key is stored for ${cfg.apiKeyEnv}; enter it on Settings → Models` }
    }
    const result = await fetchUsage(cfg, resolved.value, options)
    return result.ok ? { ...result, fetchedAt: new Date().toISOString() } : result
  }

  /**
   * One read, deduplicated against any read already in flight.
   *
   * The whole read — credential lookup included — is raced against the timeout,
   * not just the gateway call inside it: a credential provider whose `resolve`
   * never settles would otherwise wedge this slot forever, and every later
   * request (the refresh button included) would join the same dead promise.
   */
  async function load(force, waitMs) {
    const now = Date.now()
    const holdMs = nonNegativeInteger(cfg.usageCacheMs, DEFAULT_USAGE_CACHE_MS)
    if (!force && cache !== null && now - cache.at < (cache.body.ok ? holdMs : USAGE_ERROR_CACHE_MS)) {
      return cache.body
    }
    if (inflight === null) {
      inflight = (async () => {
        try {
          const body = await withDeadline(read(), waitMs)
          // Successes are cached for as long as configured; failures only long
          // enough to absorb a user flipping between settings panes, so a fixed
          // key still takes effect on the next deliberate look (and the card
          // forces a refresh when the stored key changes).
          cache = { at: Date.now(), body }
          return body
        } finally {
          inflight = null
        }
      })()
    }
    return inflight
  }

  /** The observer's read surface, or null when it was not handed in. */
  const observer = () => {
    const hook = options.hook ?? null
    if (hook === null || hook === undefined) return null
    if (typeof hook.status === 'function') return hook.status()
    if (typeof hook.state === 'function') return hook.state()
    return null
  }

  return async (request) => {
    let force = false
    let isStatus = false
    let sessionId = null
    let model = null
    try {
      const u = new URL(request.url)
      force = u.searchParams.get('refresh') === '1'
      isStatus = u.searchParams.get('status') === '1'
      sessionId = u.searchParams.get('sessionId')
      model = u.searchParams.get('model')
    } catch {
      // An unreadable URL is simply not a forced refresh.
    }
    if (isStatus) {
      const hook = options.hook ?? null
      const state = observer() ?? {}
      const verified =
        (sessionId && typeof hook?.verifiedBySession === 'function' ? hook.verifiedBySession(sessionId) : null) ||
        (model && typeof hook?.verifiedByModel === 'function' ? hook.verifiedByModel(model) : null) ||
        state.lastVerified ||
        null
      if (verified === null || verified.provider === null || verified.provider === undefined) {
        return json({ ok: false, reason: 'no-observation' })
      }
      return json({
        ok: true,
        provider: verified.provider,
        anonymized: verified.anonymized === true || verified.provider === ANONYMIZED_CHANNEL,
        model: verified.model ?? null,
        // 上游回显的实际服务模型与回退池标记：`provider` 说明「谁服务的」，这两个字段
        // 说明「按哪个模型档位服务的」—— 钉住 provider 也挡不住回退池。
        servedModel: verified.servedModel ?? null,
        degraded: verified.degraded === true,
        sessionId: verified.sessionId ?? null,
        at: verified.at ?? null,
      })
    }
    try {
      const waitMs = positiveInteger(cfg.usageTimeoutMs, DEFAULT_USAGE_TIMEOUT_MS)
      return json(await load(force, waitMs))
    } catch (error) {
      logger.warn?.('[clinepass] the usage read failed unexpectedly: %s', error instanceof Error ? error.message : String(error))
      return json({ ok: false, reason: 'internal', message: 'the usage read failed inside dsh; see the dsh log' }, 500)
    }
  }
}

/**
 * Publish the usage route on dsh's existing `/api` channel.
 *
 * Mounted only once both `connection` (the route registry) and `credentials`
 * (where the key lives) exist, which is why it is a `ctx.inject` child rather
 * than part of `apply`: a headless profile has neither, and a pending child
 * fiber is how that stays a no-op instead of an error. Nothing here opens a
 * listener — `ctx.connection.fetch.register` adds one path to the HTTP server
 * dsh already runs, behind dsh's own trust fence and browser cookie.
 *
 * @param routeCtx - context carrying `connection` and `credentials`.
 * @param cfg - the complete plugin configuration.
 * @param logger - where to report.
 * @returns `'installed' | 'failed'`.
 */
export function installUsageRoute(routeCtx, cfg, logger = console, options = {}) {
  const connection = routeCtx.connection ?? routeCtx.get?.('connection')
  const registry = connection?.fetch
  if (registry === undefined || typeof registry.register !== 'function') {
    logger.warn?.('[clinepass] no connection.fetch registry; the usage card will not load')
    return 'failed'
  }
  try {
    registry.register({
      path: cfg.usageRoute,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: createUsageHandler(routeCtx, cfg, logger, options),
    })
  } catch (error) {
    logger.warn?.(
      '[clinepass] could not register the usage route %s: %s',
      cfg.usageRoute,
      error instanceof Error ? error.message : String(error),
    )
    return 'failed'
  }
  logger.info?.('[clinepass] usage for Settings → Models is served at %s (a path on dsh\'s own server, no listener of ours)', cfg.usageRoute)
  return 'installed'
}

/**
 * The request URL a `fetch()` call is aimed at, or null when it cannot be read.
 *
 * `fetch` accepts a string, a `URL`, or a `Request`; anything else is left
 * alone rather than guessed at.
 *
 * @param input - the first argument of a fetch call.
 * @returns the absolute URL, or null.
 */
function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return null
}

/**
 * True when `url` is this gateway's chat-completions endpoint.
 *
 * Scoping matters more than it looks: a global observer sees *every* provider's
 * traffic, and this plugin has no business reading — or attributing — any of
 * it. So the origin has to match the configured upstream, and the path has to be
 * the completions endpoint.
 *
 * @param url - the request URL.
 * @param upstream - the configured gateway base (e.g. `https://api.cline.bot`).
 * @returns whether this request is one the observer watches.
 */
export function isGatewayChat(url, upstream) {
  let target
  let origin
  try {
    target = new URL(url)
    origin = new URL(upstream)
  } catch {
    return false
  }
  return target.origin === origin.origin && /\/chat\/completions\/?$/.test(target.pathname)
}

/**
 * 递归收集某个 JSON 文档里所有 `routing` 对象（网关把它放在
 * `choices[].delta|message.provider_metadata.gateway.routing`）。
 *
 * @param node - 任意 JSON 值。
 * @param out - 收集结果。
 * @returns `out`。
 */
function collectRouting(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) collectRouting(entry, out)
    return out
  }
  if (isPlainObject(node.routing)) out.push(node.routing)
  for (const value of Object.values(node)) collectRouting(value, out)
  return out
}

/**
 * 从一次响应里取出**所有** routing 对象（去重，保持出现顺序）。
 *
 * 行分隔符按 SSE 规范算，且**按事件组装**：同一事件里的多个 `data:` 行要用 `\n` 拼接后再解析
 * —— 只逐行 parse 会漏掉「一个 JSON 被拆到两行 data:」这种合法写法，而消费者看得懂。
 *
 * @param text - 响应体原文（SSE 或单个 JSON 文档）。
 * @returns 去重后的 routing 对象数组，可能为空。
 */
export function routingsOfText(text) {
  const raw = []
  for (const document of sseDocuments(text)) collectRouting(document, raw)
  const seen = new Set()
  const unique = []
  for (const routing of raw) {
    const key = JSON.stringify(routing)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(routing)
  }
  return unique
}

/**
 * 把一段响应文本按 SSE 规则拆成 JSON 文档。
 *
 * {@link routingsOfText} 与 {@link providersOfText} 的共享解析层；规则与 0.9.x 的
 * routingsOfText 内嵌解析逐字等价：
 *
 * - 空行分帧；同一事件里的多个 `data:` 行先用 `\n` 拼接再 parse（消费者 `data.join('\n')`
 *   的做法），拼不出合法 JSON 再逐行 parse 一次兜底。
 * - `data: [DONE]` 与空负载跳过。
 * - SSE 规则拆不出**任何**文档时，整段再按单个 JSON 文档 parse 一次兜底（非流式响应的
 *   形状）；拆得出文档就不再兜底 —— 帧里没有证据就是没有，拿整段硬 parse 也变不出来。
 *
 * @param text - 响应体原文（SSE 或单个 JSON 文档）。
 * @returns 解析成功的 JSON 文档数组，可能为空。
 */
function sseDocuments(text) {
  const documents = []
  const parse = (data) => {
    if (data.trim() === '' || data.trim() === '[DONE]') return
    try {
      documents.push(JSON.parse(data))
    } catch {
      // 半截帧：SSE 允许，跳过。
    }
  }
  let data = []
  const flush = () => {
    if (data.length === 0) return
    parse(data.join('\n'))
    if (data.length > 1) for (const line of data) parse(line)
    data = []
  }
  for (const line of String(text).split(/\r\n|\r|\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    else if (line === 'data') data.push('')
  }
  flush()
  if (documents.length === 0) {
    try {
      documents.push(JSON.parse(String(text)))
    } catch {
      // 不是 JSON：按「没有文档」处理。
    }
  }
  return documents
}

/**
 * 从一次响应里取出**顶层** `provider` 字段（去重，保持出现顺序）。
 *
 * api.cline.bot 的直通形状（实测 2026-10-14，glm-5.3-flash 由 Z.AI / InferenceNet /
 * Together 轮转服务）每个 chunk 都带顶层 `provider` 字段，而回退网形状（model 回显
 * `vmc/…-contributor-fallbacks`）没有。
 *
 * 刻意**只读顶层**：routing 元数据里的 `providerAttempts[].provider`、`delta.provider`
 * 之类的嵌套键不是直通证据，逐层收集会把「试过别家但失败」的 attempt 名也算进来。
 *
 * @param text - 响应体原文（SSE 或单个 JSON 文档）。
 * @returns 去重后的顶层 provider 字符串数组（原始拼写），可能为空。
 */
export function providersOfText(text) {
  const raw = []
  for (const document of sseDocuments(text)) {
    if (isPlainObject(document) && typeof document.provider === 'string' && document.provider.length > 0) raw.push(document.provider)
  }
  const seen = new Set()
  const unique = []
  for (const provider of raw) {
    if (seen.has(provider)) continue
    seen.add(provider)
    unique.push(provider)
  }
  return unique
}

/**
 * 从一次响应里读出上游**实际服务**的模型名（不是请求要的那个）。
 *
 * 网关在帧的回显 `model` 字段里写它真正按哪个 id 服务；最后一个非空值胜出（中间帧可能
 * 不带 `model`，空值不覆盖已知值）。原样返回（去首尾空白）—— 拼写是事实的一部分，
 * 是否回退池由 {@link isDegradedModel} 单独判断。
 *
 * @param text - 响应体原文（SSE 或单个 JSON 文档）。
 * @returns 模型名，或 null。
 */
export function servedModelOfText(text) {
  let served = null
  for (const document of sseDocuments(text)) {
    if (!isPlainObject(document)) continue
    const model = document.model
    if (typeof model === 'string' && model.trim().length > 0) served = model.trim()
  }
  return served
}

/**
 * {@link routingsOfText} 里最后出现的那一处。
 *
 * @param text - 响应体原文。
 * @returns 最后一个 routing 对象，没有则 null。
 */
export function routingOfText(text) {
  const all = routingsOfText(text)
  return all.length === 0 ? null : all[all.length - 1]
}

/**
 * `provider_metadata` 里那些**不是**基础设施的命名空间键。
 *
 * 网关在 `delta.provider_metadata` 下按上游命名空间分组（实测：deepseek 路由给出
 * `provider_metadata.deepseek{…native usage…}`，匿名回退网给出
 * `provider_metadata.gateway{…routing…}` 与 `provider_metadata["openai-compat"]`）。
 * 当一次响应里既没有 routing、也没有顶层 `provider` 时，剩余的命名空间键是最后一条能指出
 * 「它属于谁」的线索。
 *
 * @param node - 任意 JSON 值。
 * @param out - 收集结果。
 * @returns `out`。
 */
function collectProviderNamespaces(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) collectProviderNamespaces(entry, out)
    return out
  }
  if (isPlainObject(node.provider_metadata)) {
    for (const key of Object.keys(node.provider_metadata)) {
      // `gateway` 装的是 routing 本身，`openai-compat` 是**协议**名而不是上游 —— 两者都
      // 不是「谁服务的」的答案。
      if (key !== 'gateway' && key !== 'openai-compat' && key !== 'openai_compat') out.push(key)
    }
  }
  for (const value of Object.values(node)) collectProviderNamespaces(value, out)
  return out
}

/**
 * 从一次响应里读出真实上游 provider。
 *
 * 证据按可信度排序，第一处有结论的就用它：
 *
 *  1. routing 元数据（网关自己的路由结论）—— `finalProvider` → `resolvedProvider` →
 *     `affinity.pinnedProvider` → 第一个成功过的 `providerAttempts[].provider`；
 *  2. wire 顶层的 `provider` 字段（直通形状每帧都带，匿名回退网形状没有）；
 *  3. `provider_metadata.<x>` 命名空间键（最后一条线索，见 {@link collectProviderNamespaces}）。
 *
 * 一律归一化成小写、去首尾空白；读不出任何证据时返回 null（观察者不猜）。
 *
 * @param evidence - `{ routings, providers, namespaces }`，都可省略。
 * @returns 小写的 provider 名字，或 null。
 */
export function observedProviderOf(evidence = {}) {
  const clean = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null)
  const routings = Array.isArray(evidence.routings) ? evidence.routings : []
  const providers = Array.isArray(evidence.providers) ? evidence.providers : []
  const namespaces = Array.isArray(evidence.namespaces) ? evidence.namespaces : []
  for (let index = routings.length - 1; index >= 0; index -= 1) {
    const routing = routings[index]
    const direct = clean(routing?.finalProvider) ?? clean(routing?.resolvedProvider) ?? clean(routing?.affinity?.pinnedProvider)
    if (direct !== null) return direct
    for (const model of Array.isArray(routing?.modelAttempts) ? routing.modelAttempts : []) {
      for (const attempt of Array.isArray(model?.providerAttempts) ? model.providerAttempts : []) {
        const name = attempt?.success === true ? clean(attempt.provider) : null
        if (name !== null) return name
      }
    }
  }
  for (const provider of providers) {
    const name = clean(provider)
    if (name !== null) return name
  }
  for (const namespace of namespaces) {
    const name = clean(namespace)
    if (name !== null) return name
  }
  return null
}

/**
 * 从一次响应体原文里读证据（非流式路径与测试共用）。
 *
 * @param text - 响应体原文（SSE 或单个 JSON 文档）。
 * @returns `{ routings, providers, namespaces, servedModel }`。
 */
function evidenceOfText(text) {
  const namespaces = []
  for (const document of sseDocuments(text)) collectProviderNamespaces(document, namespaces)
  return { routings: routingsOfText(text), providers: providersOfText(text), namespaces, servedModel: servedModelOfText(text) }
}

/** SSE 帧以空行结束。分隔符按**字节**找：正文原样转发才有保真与节奏。 */
const SSE_NEWLINE = 0x0a
const SSE_CARRIAGE_RETURN = 0x0d

/**
 * 找到 `pending` 里第一个完整 SSE 帧的结束位置（含那个空行）。
 *
 * 空行有 LF LF 与 CR LF CR LF 两种写法（SSE 规范都允许），所以要看一个 `\n` 后面
 * 跟的是 `\n` 还是 `\r\n`。UTF-8 的多字节序列里不可能出现 0x0A / 0x0D，所以按字节
 * 切帧不会把一个字符劈成两半。
 *
 * @param pending - 尚未消费的字节。
 * @returns 帧结束的下标（不含），没有完整帧时返回 -1。
 */
export function nextFrameEnd(pending) {
  for (let index = 0; index < pending.length; index += 1) {
    if (pending[index] === SSE_NEWLINE) {
      if (pending[index + 1] === SSE_NEWLINE) return index + 2
      if (pending[index + 1] === SSE_CARRIAGE_RETURN && pending[index + 2] === SSE_NEWLINE) return index + 3
      continue
    }
    // 单独的 `\r` 在 SSE 规范里也是换行，openai 的 findDoubleNewlineIndex 认 `\r\r`。
    // 切帧的规则要和**消费者**一致：认不出它的边界，整条响应就会攒成一大块。
    if (pending[index] === SSE_CARRIAGE_RETURN && pending[index + 1] === SSE_CARRIAGE_RETURN) return index + 2
  }
  return -1
}

/**
 * 这一帧是不是 SSE 的终止帧（`data: [DONE]`）。
 *
 * 规则要和**消费者**逐字一致：openai 的解码器把一帧里的多个 `data:` 行用 `\n` 拼起来，
 * 再只看 `startsWith('[DONE]')`，而它的行分隔符是 `\r`、`\n` 或 `\r\n`。
 *
 * @param frame - 一帧原始字节。
 * @returns 是否是终止帧。
 */
export function isTerminatorFrame(frame) {
  const lines = []
  for (const line of new TextDecoder().decode(frame).split(/[\r\n]/)) {
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
    // 裸 `data` 行是**空**数据字段，不是「没有这一行」。
    else if (line === 'data') lines.push('')
  }
  return lines.length > 0 && lines.join('\n').startsWith('[DONE]')
}

/** 拼接字节块。帧很小（一条 delta），朴素的重新分配足够，不值得为它引入分片列表。 */
function concatBytes(left, right) {
  if (left.length === 0) return right
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left, 0)
  joined.set(right, left.length)
  return joined
}

/**
 * 从请求头里找出会话 id（观察者用它给结论建索引）。
 *
 * dsh 目前**不往上发**会话头，所以这一级通常读不到东西 —— model 索引才是常命中的那一级。
 * 两个来源都查：`init.headers` 优先，其次是 `Request` 自带的头。
 *
 * @param input - fetch 的第一个参数。
 * @param init - fetch 的第二个参数。
 * @returns 会话 id，或 null。
 */
function extractSessionId(input, init) {
  const readHeader = (bag, name) => {
    if (!bag) return null
    if (typeof bag.get === 'function') return bag.get(name)
    if (typeof bag === 'object') {
      const target = name.toLowerCase()
      for (const [key, value] of Object.entries(bag)) {
        if (key.toLowerCase() === target) return typeof value === 'string' ? value : String(value)
      }
    }
    return null
  }
  return (
    readHeader(init?.headers, 'x-session-id') ||
    readHeader(init?.headers, 'x-dsh-session-id') ||
    readHeader(init?.headers, 'session-id') ||
    readHeader(init?.headers, 'x-client-request-id') ||
    (typeof input === 'object' && input !== null ? readHeader(input.headers, 'x-session-id') : null) ||
    (typeof input === 'object' && input !== null ? readHeader(input.headers, 'x-dsh-session-id') : null) ||
    null
  )
}

/**
 * 读出这次请求的 wire model id（观察者要按 model 建索引，胶囊就是按它查的）。
 *
 * 只读不碰：字符串 / Buffer / TypedArray 的 body 直接解析，**不消费**；`Request` 的 body
 * 走 `clone()`，原件的 body 仍归调用方与 fetch。读不出来就返回 null —— 观察者宁可少一个
 * 索引，也不改动请求。
 *
 * @param input - fetch 的第一个参数。
 * @param init - fetch 的第二个参数。
 * @returns `body.model`，或 null。
 */
async function requestModel(input, init) {
  const parse = (text) => {
    try {
      const body = JSON.parse(text)
      return isPlainObject(body) && typeof body.model === 'string' && body.model.length > 0 ? body.model : null
    } catch {
      return null
    }
  }
  try {
    const body = init?.body
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') return parse(body)
      if (body instanceof ArrayBuffer) return parse(Buffer.from(body).toString('utf8'))
      // `Buffer` 是 ArrayBuffer 视图，这一支也覆盖它。
      if (ArrayBuffer.isView(body)) return parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'))
      return null
    }
    if (typeof Request === 'function' && input instanceof Request) return parse(await input.clone().text())
  } catch {
    return null
  }
  return null
}

/**
 * Build the in-process **observer** without a plugin context (used by apply() and tests).
 *
 * Installing replaces `globalThis.fetch` with a wrapper that watches only this
 * gateway's chat-completions calls. The wrapper is a pure observer:
 *
 *   - every other call goes to the original function with the original
 *     arguments, synchronously and unmodified;
 *   - a watched call is sent with the same `input` and `init` objects, byte for
 *     byte — no body rewriting, no header changes, no retry, no extra request;
 *   - the response comes back the way it arrived: a non-SSE response is returned
 *     **unchanged** (evidence is read from a clone), and an SSE response is
 *     relayed by a pass-through stream that forwards every frame as it is read,
 *     so chunk arrival times — and with them dsh's TPS measurement — are
 *     untouched. The observer reads frames on the way past and never withholds
 *     or reorders one.
 *
 * Any failure inside the observer is caught and turns into a plain pass-through
 * plus a warning; a broken observer must not break the user's traffic.
 *
 * @param config - a complete configuration.
 * @param logger - optional logger ({info,warn,error}).
 * @returns the observer: `install()`, `uninstall()`, `counters`, `status()`,
 *   `verifiedBySession()`, `verifiedByModel()` and `profileBaseURL()`.
 */
export function createFetchObserver(config, logger = console) {
  const cfg = withDefaults(config, logger)
  let original = null
  let installed = false
  let calling = false
  let hookState = 'absent'
  /**
   * The observation counters. Deliberately four:
   *
   *   - `seen`      watched chat requests (the wrapper matched this gateway);
   *   - `verified`  a response was read and its real upstream was identified;
   *   - `anonymized` …and that upstream was the anonymous `openai-compatible-private`;
   *   - `unknown`   a response came back and carried no provider metadata at all.
   *
   * A request that fails at the transport, or a stream the caller cancels before
   * it ends, is counted in `seen` only: nothing was observed to conclusion, so
   * there is no answer to count — and calling that "unknown" would blame a
   * response that never existed.
   */
  const counters = { seen: 0, verified: 0, anonymized: 0, unknown: 0 }
  /** 最近一次看到结论的响应（状态文件里的 `lastVerified`）。 */
  let lastVerified = null
  const lastVerifiedBySession = new Map()
  const lastVerifiedByModel = new Map()
  /** 最近一次由匿名渠道服务的响应（见 {@link ANONYMIZED_CHANNEL}）。 */
  let lastAnonymized = null
  /**
   * 观测序号：每落一条观测 +1，`lastVerifiedSeq` 记住当前记录是哪一条。
   *
   * 存在的理由只有一个：`provider` 在响应读完那一刻就已知，而 wire model 要等
   * 解析请求体的异步 promise settle 才知道（见 {@link conclude}）。没有序号，
   * 迟到的 model 会把**更新的**那条观测按回旧 provider —— 两次请求的
   * modelPromise 完全可能乱序 settle。
   */
  let observationSeq = 0
  let lastVerifiedSeq = 0
  let lastAnonymizedSeq = 0
  /** provider profile 的登记结果，由 {@link noteProvision} 在 apply 里填。 */
  let provision = null
  /** 与 `provision` 配套的一句话（`failed` / `mismatch` / `repaired` 的原因）。 */
  let provisionReason = null

  /** The base URL the provider profile must point at: the gateway itself. */
  const profileBaseURL = () => `${cfg.upstream}${PROFILE_PATH}`

  // ── the status file: how a silent blind spot becomes visible ──────────────
  const statusPath = statusFileFor(cfg)
  let writeWarned = false

  /**
   * Publish the current state. One small write per observed request (chat
   * requests are rare, and a synchronous write of a few hundred bytes is
   * cheaper than making this state unreachable), and never allowed to break a
   * request.
   *
   * A disposed instance stays reachable as the `original` of the hook that
   * replaced it (that is how a wrapper chain survives a reload), so **the
   * record belongs to the instance that owns the global fetch**: without this
   * guard the old one would keep rewriting the file with `hook: "uninstalled"`
   * and stale counters every time a request passed through its layer.
   */
  function publish() {
    if (statusPath === null) return
    if (installed && !owns() && ours()) return
    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true })
      const payload = `${JSON.stringify(
        {
          service: 'dsh-clinepass',
          transport: 'fetch',
          hook: hookState,
          provision,
          provisionReason,
          upstream: cfg.upstream,
          profileBaseURL: profileBaseURL(),
          counters: { ...counters },
          lastVerified,
          lastAnonymized,
          // Config keys that were read and ignored, so an upgrade from the pin
          // era (or the port era) is visible even where plugin warnings are not.
          ignoredOptions: cfg.ignoredOptions ?? [],
          pid: process.pid,
          at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`
      // Written through a temporary file and renamed: `cat` (the README) and
      // `JSON.parse` (smoke-test) must never catch a half-written file.
      const temporary = `${statusPath}.tmp`
      fs.writeFileSync(temporary, payload)
      fs.renameSync(temporary, statusPath)
    } catch (error) {
      if (!writeWarned) {
        writeWarned = true
        logger.warn?.('[clinepass] could not write %s: %s', statusPath, error instanceof Error ? error.message : String(error))
      }
    }
  }

  /**
   * 记一次「这一次是谁服务的」，并按 session → model 两级建索引（`?status=1` 查的就是它）。
   *
   * `model` 允许先记 `null`：provider 在响应读完那一刻就该可见，而 wire model 要等
   * 解析请求体的异步 promise settle 才知道。迟到的 model 由
   * {@link completeObservation} 用这里返回的序号补写。
   *
   * @param url - 请求 URL。
   * @param provider - 归一化小写的 provider 名字。
   * @param model - 这次请求的 wire model id（读不出时为 null）。
   * @param sessionId - 请求头里的会话 id（dsh 目前不发，通常为 null）。
   * @param servedModel - 上游回显的实际服务模型（响应帧里读的，可能为 null）。
   * @returns 这条观测的序号，交给 `completeObservation()`。
   */
  function recordObservation(url, provider, model, sessionId, servedModel = null) {
    const at = new Date().toISOString()
    const anonymized = provider === ANONYMIZED_CHANNEL
    // 回退池是**模型档位**的决策，与 provider 无关：`finalProvider=deepseek` 的请求也可能
    // 由 `vmc/…-contributor-fallbacks` 服务。判定只看回显模型名的后缀，见
    // {@link isDegradedModel}。
    const degraded = isDegradedModel(servedModel)
    observationSeq += 1
    lastVerifiedSeq = observationSeq
    lastVerified = { at, url, provider, model, servedModel, degraded, sessionId, anonymized }
    if (sessionId) lastVerifiedBySession.set(String(sessionId), lastVerified)
    if (model) lastVerifiedByModel.set(model, lastVerified)
    if (anonymized) {
      lastAnonymizedSeq = observationSeq
      lastAnonymized = { at, url, provider, model, servedModel, degraded, sessionId }
    }
    publish()
    if (anonymized) logger.warn?.('[clinepass] %s → %s (the upstream channel is anonymized; see the audit notes)', url, provider)
    if (degraded) {
      logger.warn?.(
        '[clinepass] %s was served by the degraded pool (%s); the pool is chosen by model tier, not by provider — pinning does not avoid it',
        url,
        servedModel,
      )
    }
    if (!anonymized && !degraded) logger.info?.('[clinepass] %s → %s', url, provider)
    return observationSeq
  }

  /**
   * 把迟到的 wire model 补进序号为 `seq` 的那条观测。
   *
   * 只在这条观测**仍是最新**时补：否则一个旧 provider 会覆盖更新的观测（两次请求的
   * modelPromise 可能乱序 settle）。补写走的是同一个对象引用，所以
   * `lastVerifiedBySession` 里的那条自动跟着更新；只有 model 索引需要显式登记。
   *
   * @param seq - `recordObservation()` 返回的序号。
   * @param model - 解析出的 wire model id（null/undefined 时什么都不做）。
   */
  function completeObservation(seq, model) {
    if (model === null || model === undefined) return
    if (seq !== lastVerifiedSeq || lastVerified === null || lastVerified.model === model) return
    lastVerified.model = model
    lastVerifiedByModel.set(model, lastVerified)
    if (seq === lastAnonymizedSeq && lastAnonymized !== null) lastAnonymized.model = model
    publish()
  }

  /**
   * 收下一次观测：有结论就记，没有就记 `unknown`。
   *
   * 记录**同步**落下（model 先为 null），不等 `modelPromise`：`[DONE]` 一到
   * `lastVerified.provider` 就必须可读 —— 胶囊在轮询、`?status=1` 是即时查询，
   * 晚一拍会让刚结束的那一轮答 `no-observation`。
   *
   * @param url - 请求 URL。
   * @param sessionId - 请求头里的会话 id。
   * @param modelPromise - `requestModel()` 的 promise（可能还没 settle）。
   * @param evidence - `{ routings, providers, namespaces, servedModel }`。
   */
  function conclude(url, sessionId, modelPromise, evidence) {
    const provider = observedProviderOf(evidence)
    if (provider === null) {
      counters.unknown += 1
      publish()
      logger.warn?.('[clinepass] %s carries no provider metadata; the upstream stays unknown', url)
      return
    }
    counters.verified += 1
    if (provider === ANONYMIZED_CHANNEL) counters.anonymized += 1
    // 回显模型在响应读完时已经见到，和 provider 一起同步落下；请求的 wire model 仍等
    // modelPromise（见上）。
    const servedModel = typeof evidence?.servedModel === 'string' ? evidence.servedModel : null
    const seq = recordObservation(url, provider, null, sessionId, servedModel)
    Promise.resolve(modelPromise).then(
      (model) => completeObservation(seq, model),
      () => {},
    )
  }

  /**
   * Relay an SSE body frame by frame, reading evidence on the way past.
   *
   * `pull` is what keeps the pacing honest: it forwards exactly the bytes the
   * upstream produced, in order, as the consumer asks for them — the same shape
   * as the un-wrapped response. The terminator frame is forwarded and then the
   * observation is closed out (the gateway may keep the socket open after
   * `[DONE]`, and waiting for a close the client never waits for would be a
   * different response, not an observation).
   */
  function relayStream(response, url, sessionId, modelPromise) {
    const decoder = new TextDecoder()
    let reader = null
    let pending = new Uint8Array(0)
    let sourceEnded = false
    let finished = false
    /** 证据去重与上界：正常响应只有一处 routing / 一个 provider 命名空间。 */
    const seenRouting = new Set()
    const seenProvider = new Set()
    const seenNamespace = new Set()
    const routings = []
    const providers = []
    const namespaces = []
    /** 最后一个带 `model` 的帧胜出（网关每帧回显，中间帧也可能不带）。 */
    let servedModel = null
    const MAX_EVIDENCE = 64

    const note = (frame) => {
      const text = decoder.decode(frame)
      for (const routing of routingsOfText(text)) {
        const key = JSON.stringify(routing)
        if (seenRouting.has(key) || seenRouting.size >= MAX_EVIDENCE) continue
        seenRouting.add(key)
        routings.push(routing)
      }
      for (const provider of providersOfText(text)) {
        if (seenProvider.has(provider) || seenProvider.size >= MAX_EVIDENCE) continue
        seenProvider.add(provider)
        providers.push(provider)
      }
      const served = servedModelOfText(text)
      if (served !== null) servedModel = served
      const found = []
      for (const document of sseDocuments(text)) collectProviderNamespaces(document, found)
      for (const namespace of found) {
        if (seenNamespace.has(namespace) || seenNamespace.size >= MAX_EVIDENCE) continue
        seenNamespace.add(namespace)
        namespaces.push(namespace)
      }
    }

    const finish = () => {
      if (finished) return
      finished = true
      conclude(url, sessionId, modelPromise, { routings, providers, namespaces, servedModel })
    }

    const body = new ReadableStream({
      async pull(controller) {
        for (;;) {
          if (finished) return
          if (pending.length > 0) {
            const end = nextFrameEnd(pending)
            if (end !== -1) {
              const frame = pending.slice(0, end)
              pending = pending.slice(end)
              note(frame)
              controller.enqueue(frame)
              // 终止帧之后通常什么都没有，而网关**不保证**关流：到 [DONE] 就收尾，与
              // 消费者（openai 的解码器在 [DONE] 处就结束）看齐。
              if (isTerminatorFrame(frame)) {
                finish()
                if (reader !== null) reader.cancel().catch(() => {})
                controller.close()
              }
              return
            }
            // 上游没发空行就关流：剩下的是最后一帧。
            if (sourceEnded) {
              const frame = pending
              pending = new Uint8Array(0)
              note(frame)
              controller.enqueue(frame)
              return
            }
          } else if (sourceEnded) {
            finish()
            controller.close()
            return
          }
          let chunk
          try {
            chunk = await (reader ??= response.body.getReader()).read()
          } catch (error) {
            // 读流失败（用户按停止、socket 断）时没有观测可言：原样抛回，不计数。
            finished = true
            throw error
          }
          if (chunk.done) {
            sourceEnded = true
            continue
          }
          pending = concatBytes(pending, chunk.value)
        }
      },
      cancel(reason) {
        // 消费者不要这条流了：没有观测到结论，也就没有可记的东西（`seen` 已经计过）。
        finished = true
        const target = reader ?? response.body
        target.cancel(reason).catch(() => {})
      },
    })
    const headers = new Headers(response.headers)
    // 正文已经过 fetch 解码；重建后不能再让下游按这两个头处理一遍。
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }

  /**
   * 非流式响应：**原样返回**，证据从 `clone()` 上读。
   *
   * 用 clone 而不是「读完再重建」，因为那会把一次 JSON 响应的交付推迟到整条 body 读完之后；
   * 观察者没有任何理由让调用方多等。clone 由运行时做 tee，原件的字节一个不改。
   */
  function tapJson(response, url, sessionId, modelPromise) {
    let copy
    try {
      copy = response.clone()
    } catch {
      // 没有可读的 body（或已被别处锁住）：不猜，算一次无法归因。
      conclude(url, sessionId, modelPromise, {})
      return response
    }
    copy.text().then(
      (text) => conclude(url, sessionId, modelPromise, evidenceOfText(text)),
      () => conclude(url, sessionId, modelPromise, {}),
    )
    return response
  }

  /**
   * 交给下一次发送的函数：把原始 fetch 的结果接过来观察，再原样交回去。
   *
   * `fetch` never throws synchronously — it returns a rejected promise — and this
   * wrapper must not change that.
   */
  function passThrough(input, init) {
    calling = true
    try {
      return original(input, init)
    } catch (error) {
      return Promise.reject(error)
    } finally {
      calling = false
    }
  }

  const wrapper = function observingFetch(input, init) {
    // Only reachable through `globalThis.fetch`, which is only replaced once
    // `original` is set; the guard keeps a hand-driven call readable.
    if (original === null) throw new Error('dsh-clinepass: the observer was called before it was installed')
    // A function we wrapped that calls `globalThis.fetch` synchronously would
    // re-enter us forever and starve the event loop. Refusing is loud; hanging
    // is not.
    if (calling) throw new Error('dsh-clinepass: the wrapped fetch calls globalThis.fetch synchronously; refusing to recurse')
    let url
    try {
      url = requestUrl(input)
    } catch {
      url = null
    }
    if (url === null || !isGatewayChat(url, cfg.upstream)) return passThrough(input, init)
    counters.seen += 1
    publish()
    const sessionId = extractSessionId(input, init)
    // 先把 model 读起来：`clone()` 不消费调用方的 body，而结论要等响应回来才写。
    const modelPromise = requestModel(input, init)
    let sent
    try {
      sent = passThrough(input, init)
    } catch (error) {
      return Promise.reject(error)
    }
    return Promise.resolve(sent).then(
      (response) => {
        if (!(response instanceof Response) || response.body === null || !response.ok) {
          // 上游自己的失败（429/5xx/…）：把它原样交回，不去读它的 body，也不冒充一次
          // 「归因失败」。这一格唯一的诚实说法是「这次没有可观察的成功响应」。
          return response
        }
        const type = (response.headers.get('content-type') ?? '').toLowerCase()
        if (type.includes('text/event-stream')) return relayStream(response, url, sessionId, modelPromise)
        return tapJson(response, url, sessionId, modelPromise)
      },
      (error) => {
        throw error
      },
    )
  }
  wrapper[FETCH_MARK] = () => original

  let ownershipTimer = null

  /** Keep an eye on the global fetch, so a post-install replacement shows up. */
  function startOwnershipCheck() {
    if (ownershipTimer !== null) return
    ownershipTimer = setInterval(() => checkOwnership(), OWNERSHIP_CHECK_MS)
    ownershipTimer.unref?.()
  }

  /** True when this instance is still the one the global fetch points at. */
  const owns = () => globalThis.fetch === wrapper

  /**
   * Is the current global fetch another of ours (a newer instance, after a
   * reload) rather than a foreign function?
   *
   * The distinction matters for the status file: a newer instance owns that
   * record, so this one must not overwrite it, and reporting "foreign" then
   * would be a lie that breaks the smoke test on a healthy reload.
   */
  const ours = () => typeof globalThis.fetch?.[FETCH_MARK] === 'function'

  /**
   * Record what the global fetch is now.
   *
   * Without this, an observer that was quietly unhooked would leave the status
   * file reading `installed` forever — exactly the silent failure the file
   * exists to expose. Three things it deliberately does *not* do: warn more than
   * once for the same replacement (this runs every 30 s for the life of the
   * process), keep claiming `foreign` after ownership comes back, and call a
   * native fetch that someone restored "foreign" — a newer instance of this
   * plugin standing down is not a bypass.
   *
   * @returns the state it observed, for tests and logs.
   */
  function checkOwnership() {
    if (!installed) return 'not-installed'
    const observed = owns() ? 'installed' : ours() ? 'replaced-by-us' : globalThis.fetch === original ? 'uninstalled' : 'foreign'
    const changed = observed !== hookState
    hookState = observed
    // A newer instance of this plugin holds the global fetch, so the status
    // record belongs to it: this one neither warns nor writes.
    if (observed === 'replaced-by-us') return observed
    // Otherwise act on the transition only — one warning per replacement, one
    // write per state change, never a rewrite every 30 s.
    if (changed) {
      publish()
      if (observed === 'foreign') logger.warn?.('[clinepass] globalThis.fetch is no longer the observer hook; the real provider will no longer be reported')
    }
    return observed
  }

  /**
   * 当前观测状态的一份快照（冒烟测试、排查与 `?status=1` 的全局兜底都用它）。
   *
   * @returns `{ counters, provision, provisionReason, lastVerified, lastAnonymized }`。
   */
  const status = () => ({
    counters: { ...counters },
    provision,
    provisionReason,
    lastVerified,
    lastAnonymized,
  })

  return {
    config: cfg,
    counters,
    profileBaseURL,
    /** `status()` 的历史名字；两处读取面逐字相同（见 `createUsageHandler`）。 */
    state: status,
    status,
    verifiedBySession: (sid) => (sid ? lastVerifiedBySession.get(sid) : undefined),
    verifiedByModel: (m) => (m ? lastVerifiedByModel.get(m) : undefined),
    /** Re-check whether the hook still owns `globalThis.fetch` (also runs on a timer). */
    checkOwnership,
    /**
     * Replace `globalThis.fetch` with the observer.
     *
     * @returns `'installed'`, or `'unavailable'` when there is no global fetch
     *   to wrap (in which case nothing was changed).
     */
    install() {
      // Idempotent: re-installing an installed hook must not capture anything
      // new as its "original", which is how a wrapper chain (or a cycle through
      // a delegate) would otherwise start.
      if (installed) return 'installed'
      const current = globalThis.fetch
      if (typeof current !== 'function') {
        hookState = 'unavailable'
        logger.error?.('[clinepass] there is no global fetch to hook; the real provider cannot be observed')
        publish()
        return 'unavailable'
      }
      // Reuse the fetch an earlier wrapper of ours replaced, so a reload cannot
      // grow a chain of wrappers.
      original = typeof current[FETCH_MARK] === 'function' ? current[FETCH_MARK]() : current
      globalThis.fetch = wrapper
      installed = true
      hookState = 'installed'
      publish()
      startOwnershipCheck()
      return 'installed'
    },
    /**
     * Put the original fetch back.
     *
     * @returns `'restored'`, `'absent'` when this hook was not installed, or
     *   `'foreign'` when someone else replaced fetch after us — in which case
     *   theirs is left alone, because restoring would silently discard it. A
     *   displaced instance also stops publishing: the record belongs to whoever
     *   holds the global now.
     */
    uninstall() {
      if (!installed) return 'absent'
      installed = false
      clearInterval(ownershipTimer)
      ownershipTimer = null
      if (!owns()) {
        logger.warn?.('[clinepass] another plugin replaced globalThis.fetch after this one; leaving that in place')
        return 'foreign'
      }
      globalThis.fetch = original
      hookState = 'uninstalled'
      publish()
      return 'restored'
    },
    /**
     * 记下 provider profile 的登记结果。
     *
     * 这个结论原本只出现在启动日志那一行里；宿主的 logger 不一定把插件日志写到用户看得到
     * 的地方，所以同一个结论也落进状态文件。
     *
     * @param value - `provisionProfile()` 的返回值，或 `'off'` / `'unavailable'`。
     * @param reason - 一句话说明，`'present'` / `'created'` 时为 null。
     */
    noteProvision(value, reason = null) {
      provision = value
      provisionReason = reason
      publish()
    },
    /** The status file path, or null when it is disabled. */
    statusPath,
  }
}

/** How often an installed hook re-checks that it still owns the global fetch. */
const OWNERSHIP_CHECK_MS = 30_000

/**
 * Ensure the pi-ai provider profile exists and points at the right place.
 *
 * Create when absent; repair only the address when the profile is recognisably
 * ours (same protocol and credential ref) — anything else is left untouched and
 * reported, because silently rewriting a user's provider is worse than a warning.
 *
 * The address is always the gateway itself: there is no local listener.
 *
 * The declared model entry carries the id, the display name and the capacity.
 * It deliberately declares **no reasoning levels**: which effort a session runs
 * at is a profile-patch decision (`agent-default-model.reasoningEffort`), and a
 * card that is already there keeps whatever levels its owner gave it — this
 * plugin does not rewrite that field.
 *
 * @param settings - the settings service.
 * @param cfg - the complete plugin configuration.
 * @param logger - where to report.
 * @param note - 收到「值得写进状态文件的一句话」时被调用（见 `hook.noteProvision`）。
 *   日志行有两个问题：宿主的 logger 不一定落到用户看得到的地方，而 `'failed'` / `'mismatch'`
 *   单看一个词也说明不了什么。所以同一个结论走两条路：日志照旧，状态文件拿这句话。
 * @returns `'created' | 'present' | 'repaired' | 'mismatch' | 'failed'`.
 */
export async function provisionProfile(settings, cfg, logger = console, note = () => {}) {
  const revision = () => settings.describe?.({ redactSecrets: true })?.find((entry) => entry.ns === PROFILE_NS)?.revision
  const attempt = async () => {
    const profile = {
      displayName: cfg.displayName,
      apiKeyEnv: cfg.apiKeyEnv,
      api: PROFILE_API,
      baseURL: `${cfg.upstream}${PROFILE_PATH}`,
      models: [
        {
          id: cfg.model,
          name: 'DeepSeek V4.1 Flash',
          contextWindow: cfg.contextWindow,
          maxTokens: cfg.maxTokens,
          input: ['text', 'image'],
        },
      ],
    }
    const existing = readNamespace(settings, PROFILE_NS)?.providers?.[cfg.provider]
    if (existing === undefined) {
      await settings.mutate(PROFILE_NS, [{ op: 'set', path: ['providers', cfg.provider], value: profile }], revision())
      logger.info?.('[clinepass] provisioned "%s" on Settings → Models (%s) — add your API key there', cfg.provider, profile.baseURL)
      return 'created'
    }
    // A scalar where a profile belongs is a broken route, not a healthy one.
    if (typeof existing !== 'object' || existing === null) {
      const detail = `the "${cfg.provider}" provider profile is not an object (${JSON.stringify(existing)}); fix it on Settings → Models`
      note(detail)
      logger.warn?.('[clinepass] %s', detail)
      return 'mismatch'
    }

    const ours = existing.api === PROFILE_API && existing.apiKeyEnv === cfg.apiKeyEnv
    const ourModel = profile.models[0]
    const models = Array.isArray(existing.models) ? existing.models : []
    const at = models.findIndex((entry) => isPlainObject(entry) && entry.id === cfg.model)

    // Bring the model entry up to date — the advertised capacity — without
    // dropping anything else the entry declares (its `reasoningEfforts`, any
    // extra fields a hand-written card carries).
    let nextModels = models
    if (at === -1) nextModels = [...models, ourModel]
    else {
      const entry = { ...models[at] }
      let changed = false
      for (const field of ['contextWindow', 'maxTokens']) {
        if (entry[field] !== ourModel[field]) {
          entry[field] = ourModel[field]
          changed = true
        }
      }
      if (changed) nextModels = models.map((candidate, index) => (index === at ? entry : candidate))
    }

    const addressSame = existing.baseURL === profile.baseURL
    const modelsSame = nextModels === models
    const displaySame = existing.displayName === profile.displayName
    if (addressSame && modelsSame && displaySame) return 'present'
    if (!ours) {
      // A card this plugin did not write is left alone — with one exception. An
      // address on loopback is the footprint of the transport this plugin used
      // to offer, nothing listens there any more, and a card pointing at it
      // reports nothing at all: repair exactly that, and say so.
      const stranded = typeof existing.baseURL === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(existing.baseURL)
      if (!addressSame && stranded) {
        await settings.mutate(PROFILE_NS, [{ op: 'set', path: ['providers', cfg.provider, 'baseURL'], value: profile.baseURL }], revision())
        note(
          `the "${cfg.provider}" profile pointed at a local address nothing listens on (${String(existing.baseURL)}); moved it to ${profile.baseURL}. Its api/apiKeyEnv are not the ones this plugin writes, so nothing else was touched — check the key on Settings → Models`,
        )
        logger.warn?.(
          '[clinepass] the "%s" profile points at a local address nothing listens on (%s); moved it to %s. Its api/apiKeyEnv are not the ones this plugin writes, so nothing else was touched — check the key on Settings → Models',
          cfg.provider,
          existing.baseURL,
          profile.baseURL,
        )
        return 'repaired'
      }
      note(
        `the "${cfg.provider}" provider profile is not the one this plugin wrote (api/apiKeyEnv differ), so it is left alone; it points at ${String(existing.baseURL)}, not ${profile.baseURL} — fix it on Settings → Models or the route will point somewhere else`,
      )
      logger.warn?.(
        '[clinepass] the "%s" provider profile is not the one this plugin wrote (api/apiKeyEnv differ), so it is left alone; it points at %s, not %s — fix it on Settings → Models or the route will point somewhere else',
        cfg.provider,
        String(existing.baseURL),
        profile.baseURL,
      )
      return 'mismatch'
    }
    const ops = []
    if (!addressSame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'baseURL'], value: profile.baseURL })
    if (!displaySame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'displayName'], value: profile.displayName })
    if (!modelsSame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'models'], value: nextModels })
    await settings.mutate(PROFILE_NS, ops, revision())
    const repaired = [!addressSame ? `address → ${profile.baseURL}` : null, !displaySame ? 'display name' : null, !modelsSame ? 'model entry' : null].filter(Boolean).join(', ')
    note(`repaired the "${cfg.provider}" profile (${repaired})`)
    logger.info?.(
      '[clinepass] repaired the "%s" profile (%s)',
      cfg.provider,
      repaired,
    )
    return 'repaired'
  }

  try {
    return await attempt()
  } catch (error) {
    // A concurrent settings write, or llm-pi-ai not registered yet, is worth one
    // retry: without the profile the route never reaches the gateway.
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      return await attempt()
    } catch (retryError) {
      note(`could not provision the "${cfg.provider}" profile: ${retryError instanceof Error ? retryError.message : String(retryError)}`)
      logger.warn?.('[clinepass] could not provision the "%s" profile: %s', cfg.provider, retryError instanceof Error ? retryError.message : String(retryError))
      return 'failed'
    }
  }
}

/**
 * Prompt sections whose `{{model}}` reference *displays* the model id: the two
 * persona lines, spelled as the `PERSONA_PREFIX_SECTION` / `PERSONA_SUFFIX_SECTION`
 * ids of `@deepseek-ai/dsh-system-prompt`.
 *
 * Spelled out rather than imported because this package ships no dependencies on
 * purpose; `test-fetch.mjs` pins the behavior that depends on them.
 */
const PERSONA_SECTIONS = ['deployment:persona-prefix', 'deployment:persona-suffix']

/**
 * The model id without this route's own prefix (`cline-pass/x` → `x`).
 *
 * Only the exact `<provider>/` prefix is dropped: a bare id, or a slash that
 * belongs to the model's own name, is left alone.
 *
 * @param provider - the route id whose prefix is a wire requirement.
 * @param model - the configured or selected model id.
 * @returns the id to show, or the id unchanged.
 */
function withoutRoutePrefix(provider, model) {
  if (typeof model !== 'string') return model
  const prefix = `${provider}/`
  return model.startsWith(prefix) && model.length > prefix.length ? model.slice(prefix.length) : model
}

/**
 * Keep this route's wire prefix out of the model-facing prompt.
 *
 * Cline's gateway requires `type/model` in the request body (a bare id is
 * rejected: "invalid model format. Expected format: modelType/model"), and dsh
 * sends a catalog id to the wire verbatim — so this route's id has to carry the
 * prefix even though it is a *transport* detail. `{{model}}` then renders it
 * into the persona as if it were the model's name, which no first-party route
 * does.
 *
 * Three ways this must not be done, each for a concrete reason:
 *
 *   - **Not by changing the catalog id.** Every existing session's
 *     `model/selection` and `request/header` record the prefixed id, and
 *     `dsh-llm-pi-ai` resolves a selection against the catalog, so a renamed id
 *     fails as `UNKNOWN_MODEL` until each session re-picks its model.
 *   - **Not by re-registering the `model` prompt variable.** `installModelSelection`
 *     in `@deepseek-ai/dsh-agent` overwrites `variables.provider`/`variables.model`
 *     with the session's live selection after every inner listener returns, so no
 *     registration — global or scoped — survives it.
 *   - **Not by editing `variables.model` here.** `@deepseek-ai/dsh-session-reference`
 *     snapshots `assembly.variables` to size its reference budget; an id it cannot
 *     resolve drops that budget to its default without a word.
 *
 * So the rewrite lands on the persona *templates*, which are still unrendered at
 * assembly time (`{{…}}` groups resolve later, in `renderPrompt`): replacing the
 * reference token leaves every other variable in the section working, and the
 * variables stay exactly as they were.
 *
 * The listener is prepended to sit *outside* the per-agent `installModelSelection`
 * listener, which is what makes it see the model the next request will actually
 * use — including for agents that already existed when this plugin mounted, where
 * registration order alone would have put it inside.
 *
 * @param ctx - host plugin context.
 * @param cfg - the complete configuration.
 */
export function installPromptDisplay(ctx, cfg) {
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, _context, next) => {
      const assembly = await next()
      const variables = assembly?.variables
      // Only this route's own ids, and only a session actually on this route:
      // a bare official id, another provider, or another route's prefix is not
      // this plugin's business. An unreadable assembly is left alone too — a
      // display rule must never break the prompt it decorates.
      if (!Array.isArray(assembly?.sections)) return assembly
      if (variables?.provider !== cfg.provider) return assembly
      const model = variables.model
      const plain = withoutRoutePrefix(cfg.provider, model)
      if (plain === model) return assembly
      let changed = false
      const sections = assembly.sections.map((section) => {
        if (!PERSONA_SECTIONS.includes(section.name)) return section
        // `interpolate: false` marks literal prose, where `{{model}}` is meant to
        // survive as exactly those characters.
        if (section.interpolate === false) return section
        if (typeof section.text !== 'string' || !section.text.includes('{{model}}')) return section
        changed = true
        return { ...section, text: section.text.replaceAll('{{model}}', plain) }
      })
      return changed ? { ...assembly, sections } : assembly
    },
    { prepend: true },
  )
}

/**
 * Install the in-process observer and provision the provider profile.
 *
 * The settings seam is required: provisioning must finish before the first turn
 * resolves the model, and waiting on it here is what makes the provider card
 * exist by the time dsh starts serving.
 *
 * @param ctx - host plugin context.
 * @param config - the resolved plugin config (defaults are complete).
 */
export async function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const cfg = withDefaults(config, logger)
  let status = 'n/a'
  try {
    new URL(cfg.upstream)
  } catch {
    // A typo here would otherwise mean "the observer never matches anything"
    // *and* a broken address written into the card, which is exactly the kind of
    // silence this plugin is supposed to avoid. Leave everything alone and say so.
    logger.error?.('[clinepass] upstream "%s" is not a URL; nothing was installed or provisioned', cfg.upstream)
    return
  }

  // Registered only once the address is known to be usable: a misconfigured
  // plugin should change nothing at all, prompt included.
  if (cfg.plainModelId) installPromptDisplay(ctx, cfg)

  const observer = createFetchObserver(cfg, logger)
  status = observer.install()
  if (status === 'installed') {
    ctx.effect?.(() => () => {
      observer.uninstall()
    })
  } else {
    logger.error?.(
      '[clinepass] could not hook the global fetch, so the real provider cannot be observed. Something replaced globalThis.fetch before this plugin loaded.',
    )
  }

  // 登记结果先落一个 `pending`：状态文件里「还没跑」和「跑失败了」从此长得不一样。
  let provision = 'pending'
  let provisionReason = null
  const publishProvision = () => observer.noteProvision(provision, provisionReason)
  const provisionWith = async (settings) => {
    try {
      provision = await provisionProfile(settings, cfg, logger, (reason) => {
        provisionReason = reason
      })
    } catch (error) {
      provision = 'failed'
      provisionReason = `provisioning threw: ${error instanceof Error ? error.message : String(error)}`
    }
    publishProvision()
  }
  /**
   * 把 provisioning 推到**树 settle 之后**再跑，绝不在 `apply()` 里 await 它。
   *
   * 0.2.1-alpha.2 起 `settings.mutate` 走 `configEditor.edit`：先拿 profile
   * `package.json` 的写锁，再 `reconcileProfilePatches()` —— 那一步要等 loader
   * **settle**。在 apply 里 await 它就成了自锁：本 fiber 停在 LOADING → 树永不
   * settle → `appReady` 不 commit → Web 客户端的 `/api/remote.mux` 升级路由根本
   * 不注册（页面永远 "Reconnecting"，而且 `dsh web:` 那行带 token 的启动横幅也
   * 不打）。同一时刻 `describe()` 只列 fiber 已 ACTIVE 的条目 —— `llm-pi-ai` 还没
   * 进去，读出来是「卡片缺失」，于是这次必然写盘，正好撞上那把锁。
   * 推迟到 settle 之后：describe 完整（已有卡片 → 什么都不写），真要写也不是从
   * apply 里写，锁能拿到、reconcile 能跑完。上游 `dsh-settings` 自己就是这么做的
   * （构造器里 `ctx.root.loader.await().then(() => this.importLegacyDocument())`）。
   * @param run - settle（或本宿主压根没有 loader 服务）之后执行的动作。
   * @returns 没有 loader 时是 `run()` 的 promise（调用方仍旧 await，行为与旧版一致）；
   *   有 loader 时是 `undefined` —— 调用方绝不能 await 它，那正是这次要避开的自锁。
   */
  const afterSettle = (run) => {
    let loader
    try {
      loader = ctx.root?.loader ?? ctx.loader
    } catch {
      /* 未声明 inject / 服务缺席：cordis 会抛，这里正是要兜住的情况 */
    }
    if (loader?.await === undefined) return run()
    Promise.resolve(loader.await()).then(() => run(), () => run())
    return undefined
  }
  if (!cfg.provision) {
    provision = 'off'
    publishProvision()
  } else {
    publishProvision()
    const settings = settingsService(ctx)
    if (settings !== undefined) await afterSettle(() => provisionWith(settings))
    else if (typeof ctx.inject === 'function') {
      logger.info?.('[clinepass] the settings service is not up yet; provisioning the "%s" profile when it registers', cfg.provider)
      ctx.inject(['settings'], (scoped) => {
        void afterSettle(() => provisionWith(scoped.settings))
      })
    } else {
      provision = 'unavailable'
      provisionReason = 'the settings service is not available in this composition, and this host has no ctx.inject to wait on it, so the provider profile was neither read nor written'
      logger.warn?.('[clinepass] settings service unavailable; the "%s" provider profile was not provisioned', cfg.provider)
      publishProvision()
    }
  }

  // `pending` until the child fiber below reports, `off` when the option is
  // disabled; only `installed` is announced as a route the browser may call.
  let mounted = cfg.usage ? 'pending' : 'off'

  // The announcement is unconditional, and that is the point: the browser half
  // is loaded from `package.json`, not from this config, so `usage: false` does
  // not remove the card from the page — it only stops the host mounting the
  // route. Without this the card would then GET an unregistered path, get a 404
  // page, and tell the user "could not reach the gateway" forever. Announcing
  // `enabled: false` lets it render nothing instead, which is what the option
  // has always claimed to do.
  //
  // `ctx.on` is owned by this fiber, so a reload re-registers it and an unload
  // removes it. The event fires only where a web server renders a page, which is
  // also why `webServer` is not injected: a headless composition is unaffected.
  ctx.on?.('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: USAGE_BOOT_GLOBAL, value: { usageRoute: mounted === 'installed' ? cfg.usageRoute : null, enabled: mounted === 'installed' } })
  })

  // The usage card is a web-only extra: it needs the route registry (where the
  // path is published) and the credential store (where the key lives), so it is
  // mounted through a child fiber that simply stays pending in a profile that
  // has neither.
  if (cfg.usage) {
    if (typeof ctx.inject !== 'function') {
      // A context double, or a host that predates `ctx.inject`: observation is
      // unaffected, so this is a warning rather than a failed activation.
      logger.warn?.('[clinepass] this context cannot inject services; the Settings → Models usage card was not mounted')
    } else {
      ctx.inject(['connection', 'credentials'], (routeCtx) => {
        mounted = installUsageRoute(routeCtx, cfg, logger, { hook: observer })
      })
    }
  }

  logger.info?.(
    '[clinepass] route "%s" served by pi-ai via %s; %s (observer only — requests and responses are not modified); profile %s; prompt shows %s',
    cfg.provider,
    observer.profileBaseURL(),
    status === 'installed' ? 'in-process fetch observer installed, no listener' : `observer ${status}`,
    provision,
    cfg.plainModelId ? `${withoutRoutePrefix(cfg.provider, cfg.model)} (no route prefix)` : 'the configured model id',
  )
}
