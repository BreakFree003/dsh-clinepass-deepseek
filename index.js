/**
 * dsh-clinepass — Cline Pass on the built-in pi-ai route, pinned to DeepSeek.
 *
 * Two pieces, each doing the thing it is good at:
 *
 *  1. The route itself is a plain **pi-ai provider profile**
 *     (`llm-pi-ai.providers.cline-pass`): an OpenAI-compatible endpoint whose
 *     API key lives in the credential store. That is why the provider — and its
 *     key field — appears natively on Settings → Models; no custom UI, and no
 *     hand-written streaming adapter that can drift from the harness contract.
 *
 *  2. This plugin adds the pins themselves, on the way out, without touching the
 *     route's proven request path. api.cline.bot speaks two routing dialects:
 *     the Vercel AI Gateway field (`providerOptions.gateway.only`) and the
 *     OpenRouter top-level `provider` object. As of 2026-09-22 the gateway only
 *     honors the latter, so 0.11.0 writes both (the provider pin slug-ified:
 *     "z.ai" → "z-ai"). dsh deliberately withholds pi-ai's `openRouterRouting`
 *     / `vercelGatewayRouting` compat switches, so neither field can be
 *     expressed in settings.
 *
 *     The injection is **in-process**: wrap `globalThis.fetch` for the lifetime
 *     of the process and rewrite the body of the gateway's own
 *     chat-completions calls. No socket, no port, no second copy of the
 *     traffic; every other request (and every other provider's endpoint) stays
 *     byte-for-byte on the original path. SSE, tool calls, reasoning, usage and
 *     images are left to pi-ai unchanged.
 *
 *     A loopback reverse proxy used to be offered as a second transport; it was
 *     removed in 0.5.0 so that this plugin never opens a listener at all. A
 *     configuration that still asks for it is reported and served by the
 *     in-process hook instead (see `withDefaults`).
 *
 * The plugin also **provisions** the pi-ai profile on first boot (create when
 * absent, repair a stale address, never rewrite anything else), so mounting the
 * plugin is the whole install.
 *
 * Finally, it keeps that prefix out of the **prompt**: the persona would
 * otherwise read "powered by the cline-pass/deepseek-v4.1-flash model", while
 * every first-party route shows a bare model id (the shipped `deepseek` route
 * declares `deepseek-v4-flash`, no prefix). The wire keeps the prefix; only the
 * display drops it — see `installPromptDisplay`.
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

/** Provider route this plugin pins. */
export const PROVIDER = 'cline-pass'

/** Model id as the gateway wants it (`type/model`), and as declared in the profile. */
export const MODEL = 'cline-pass/deepseek-v4.1-flash'

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
 * `lastSkipped.reason` 里那条「配置本来就是空的」的文案。
 *
 * `pin: []` 是**合法**配置（纯透传，README 的配置项一节写着），所以它不该被读成一次故障；
 * 但它确实会让 `seen` 涨而 `pinned` 不涨，所以状态文件里得说清是哪一种。
 */
const NOTHING_TO_PIN = 'nothing to pin: the allowed-channel list for this model is empty (pin: [] is a pass-through)'

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
const DEFAULT_PIN = ['deepseek']
/**
 * What to do when the gateway reports that the request was **not** served by the
 * pinned channel. `strict` (the default) never hands that response to the model:
 * it is discarded and the call fails. `warn` lets it through after recording the
 * violation, `off` skips the check (and the buffering it needs).
 */
const DEFAULT_ENFORCEMENT = 'strict'
const ENFORCEMENT_VALUES = ['strict', 'warn', 'off']

/**
 * 网关给 VMC 回退网形状的**匿名渠道标签**（0.11.1）：2026-10-14 起 provider 元数据不再
 * 写出真名，`finalProvider` / `resolvedProvider` / 成功的 `providerAttempts` 一律是这个值
 * （实测与审计：`clinepass-deepseek-audit/`，权重同一性已验证 —— 正版 V4.1 Flash 的低噪声
 * 重部署，contributor 档）。把它写进渠道钉的允许列表即视为放行。
 *
 * 0.11.1/0.11.2 曾据此在会话首条消息前垫一条合成提示帧（`withAnonymousNotice`）；
 * 0.11.3 已删除 —— 合成帧会进模型上下文，代价大于收益。它不再影响任何行为。
 */
const ANONYMIZED_CHANNEL = 'openai-compatible-private'

/**
 * 自动重试的默认次数（0.10.0）。语义是「校验失败后再补发几次」，总尝试数 = `retries + 1`。
 *
 * 默认开是 0.10.0 的立场：glm-5.3-flash 在 Z.AI / InferenceNet / Together 之间轮转，钉
 * `[z.ai]` 意味着相当比例的轮次会被闸拦下 —— 而轮转是**按请求**的，补发一次大概率就落到
 * 允许的 provider 上。拦下的尝试从未交付（缓冲路径内容没离开网关，流式路径在首个证据帧
 * 就裁决），重试对调用方完全透明；`retries: 0` 恢复「拦下即结束」。
 */
const DEFAULT_RETRIES = 2
const DEFAULT_CONTEXT_WINDOW = 921600
const DEFAULT_MAX_TOKENS = 131072

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

/** Shallow equality that ignores key order (for two level→wire maps). */
function sameEntries(a, b) {
  const left = Object.keys(a ?? {})
  const right = Object.keys(b ?? {})
  return left.length === right.length && left.every((key) => key in b && a[key] === b[key])
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
        '[clinepass] "%s" is no longer used: the loopback proxy transport was removed in 0.5.0 and the pin is injected in-process, with no listener. Remove the option.',
        removed,
      )
    }
  }
  const pin = Array.isArray(raw?.pin) ? raw.pin.map(String).filter((entry) => entry.length > 0) : DEFAULT_PIN
  const pins = {}
  if (isPlainObject(raw?.pins)) {
    for (const [model, channels] of Object.entries(raw.pins)) {
      if (Array.isArray(channels)) pins[model] = channels.map(String).filter((entry) => entry.length > 0)
    }
  }
  // provider 级钉选（0.10.0）：对「网关不执行渠道钉、直通响应也没有 routing 元数据」的
  // 模型（实测 2026-10-14：glm-5.3-flash 由 Z.AI / InferenceNet / Together 轮转服务，
  // gateway.only 被无视），改用响应**每帧顶层的 `provider` 字段**兑现本地钉选。网关在
  // wire 上自己决定大小写（实测 "Z.AI"），所以配置在这里就归一化成小写，判定时两侧
  // 都按小写比；非字符串条目是配置错误，丢弃而不是 String() 成一个假渠道名。
  // 0.11.0：钉选同时上请求线 —— 显示名经 providerSlug 换成 slug，写进顶层
  // provider.order（实测被执行：带 order 的 glm-5.3-flash 5/5 由 Z.AI 服务）。
  const providerPins = {}
  if (isPlainObject(raw?.providerPins)) {
    for (const [model, providers] of Object.entries(raw.providerPins)) {
      if (!Array.isArray(providers)) continue
      providerPins[model] = [
        ...new Set(
          providers
            .filter((entry) => typeof entry === 'string')
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0),
        ),
      ]
    }
  }
  const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  const rawUpstream = text(raw?.upstream, DEFAULT_UPSTREAM)
  let upstream = rawUpstream
  try {
    const parsed = new URL(rawUpstream)
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      // `upstream` is an origin: the profile appends `PROFILE_PATH` itself, so a
      // leftover path would be doubled while the hook still matched by origin.
      upstream = parsed.origin
      logger.warn?.('[clinepass] upstream "%s" carries a path; using its origin "%s" (the route already appends %s)', rawUpstream, upstream, PROFILE_PATH)
    }
  } catch {
    // Not a URL: `apply` reports it and installs nothing.
  }
  let enforcement = DEFAULT_ENFORCEMENT
  if (raw?.enforcement !== undefined) {
    if (ENFORCEMENT_VALUES.includes(raw.enforcement)) enforcement = raw.enforcement
    else {
      logger.warn?.(
        '[clinepass] unknown enforcement "%s"; using "%s" (expected one of %s)',
        String(raw.enforcement),
        DEFAULT_ENFORCEMENT,
        ENFORCEMENT_VALUES.join(', '),
      )
    }
  }
  return {
    upstream: upstream.replace(/\/+$/, ''),
    pin,
    pins,
    providerPins,
    enforcement,
    // 自动重试（0.10.0）：校验失败后补发的次数，0 = 拦下即结束（旧行为）。
    retries: nonNegativeInteger(raw?.retries, DEFAULT_RETRIES),
    provider: text(raw?.provider, PROVIDER),
    model: text(raw?.model, MODEL),
    displayName: text(raw?.displayName, 'Cline Pass'),
    contextWindow: positiveInteger(raw?.contextWindow, DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInteger(raw?.maxTokens, DEFAULT_MAX_TOKENS),
    apiKeyEnv: text(raw?.apiKeyEnv, KEY_REF),
    provision: raw?.provision !== false,
    alignReasoningEffort: raw?.alignReasoningEffort !== false,
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
 * Where the in-process hook reports what it has done.
 *
 * There is no listener to ask, and plugin `info` lines are not shown by every
 * dsh front end, so a run that silently stopped pinning would look exactly like
 * a healthy one. This file is the plain, always-available answer:
 * `hook: "installed"` says the wrapper is in the global fetch, and the counters
 * say whether requests are actually reaching it.
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

/** The pin list that applies to one wire model. */
export function pinFor(config, model) {
  const perModel = model === undefined ? undefined : config.pins?.[model]
  if (Array.isArray(perModel)) return perModel
  return config.pin ?? []
}

/**
 * The allowed wire-provider list for one wire model (provider 级钉选的证据面).
 *
 * 空数组表示这个模型**没有** provider 级钉选 —— 与 {@link pinFor} 不同，这里没有全局
 * 兜底：providerPins 只按模型配置，不存在「默认 provider」可言。
 *
 * @param config - the complete configuration.
 * @param model - wire model id（带路由前缀）。
 * @returns 允许的 provider 列表（已归一化小写），可能为空。
 */
export function providerPinFor(config, model) {
  const perModel = model === undefined ? undefined : config.providerPins?.[model]
  return Array.isArray(perModel) ? perModel : []
}

/**
 * Add the gateway pin to a parsed chat request body.
 *
 * @param body - the parsed request body (not mutated).
 * @param only - the upstream channels to restrict to.
 * @returns the body to send, and whether the pin was written.
 */
export function withPin(body, only) {
  if (!isPlainObject(body)) return { body, pinned: false }
  if (!Array.isArray(only) || only.length === 0) return { body, pinned: false }
  const existing = isPlainObject(body.providerOptions) ? body.providerOptions : {}
  const gateway = isPlainObject(existing.gateway) ? existing.gateway : {}
  return {
    body: { ...body, providerOptions: { ...existing, gateway: { ...gateway, only } } },
    pinned: true,
  }
}

/**
 * Render a providerPins display name as the OpenRouter wire slug.
 *
 * 网关在 wire 上自报的名字（"Z.AI"）与请求 `provider.order` 认的 slug（"z-ai"）不是
 * 同一种词形：实测（2026-10-14）`order: ["z.ai"]` 会让网关摈断连接或静默换道，slug
 * 才是请求线语言。规则取保守近似：小写、非字母数字各串折成一个连字符、去首尾连字符 ——
 * "z.ai" → "z-ai"，"openai-compatible-private" 原样。显示名里的大小写分词（如
 * "InferenceNet"）推不出官方连字符位置，这里不做词典：配了就按规则给，而响应侧闸门
 * 仍 fail closed —— slug 钉错只会整轮失败，不会放进别家。
 *
 * @param name - the configured (display) provider name.
 * @returns the wire slug; empty for a name made of punctuation only.
 */
export function providerSlug(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Add the OpenRouter-protocol wire pin (top-level `provider.order`) to a parsed
 * chat request body.
 *
 * 与 {@link withPin} 并列的第二种请求线钉法：渠道钉写给 Gateway 协议
 * （`providerOptions.gateway.only`，实测被无视但留着无害），provider 钉写给
 * OpenRouter 协议（顶层 `provider.order`，实测被执行）。请求自带非空 `order` 时
 * **尊重不覆盖**（与 pi 侧 guard 同一取舍）；`allow_fallbacks` 一律关死 —— 轮转
 * 正是这里要防的事。
 *
 * @param body - the parsed request body (not mutated).
 * @param providers - the allowed providers (display names, already lower-cased).
 * @returns the body to send, and the slugs actually written (`[]` when none were).
 */
export function withProviderOrder(body, providers) {
  if (!isPlainObject(body)) return { body, order: [] }
  const slugs = (Array.isArray(providers) ? providers : []).map(providerSlug).filter((slug) => slug.length > 0)
  if (slugs.length === 0) return { body, order: [] }
  const existing = isPlainObject(body.provider) ? body.provider : {}
  if (Array.isArray(existing.order) && existing.order.length > 0) return { body, order: [] }
  return { body: { ...body, provider: { ...existing, order: slugs, allow_fallbacks: false } }, order: slugs }
}

/**
 * Thinking levels this model advertises.
 *
 * These are pi-ai's own level ids, and the wire spelling is whatever the profile
 * declares for each (`dsh-llm-pi-ai` turns `reasoningEfforts` into
 * `model.thinkingLevelMap`, and pi-ai sends `thinkingLevelMap[level]` verbatim as
 * `reasoning_effort`).
 *
 * Exactly two levels are offered, and both are pi-ai ids a profile may declare:
 * `high` dispatches `reasoning_effort: "high"` and `max` dispatches
 * `reasoning_effort: "max"`. `max` is in pi-ai's escalation order
 * (`off/minimal/low/medium/high/xhigh/max`), so it needs no alias.
 */
export const EFFORT_LEVELS = ['high', 'max']

/** The declared levels and the wire value each one dispatches (identity here). */
const EFFORT_MAP = Object.fromEntries(EFFORT_LEVELS.map((level) => [level, level]))

/**
 * Level ids this plugin used to declare and no longer offers.
 *
 * `xhigh` was an earlier alias for the top level (it also dispatched `"max"`).
 * It is retired so the composer lists `high` / `max` only: provisioning drops it
 * from an existing card, and a stored `xhigh` is moved to the level that means
 * the same thing on the wire rather than silently losing effort.
 */
const RETIRED_EFFORTS = { xhigh: 'max' }

/**
 * Realign a stored reasoning effort that the installed model cannot serve.
 *
 * `high` and `max` are valid; a retired id is moved to the level it used to
 * dispatch; anything else (a level belonging to another model, or a hand-edited
 * typo) would fail every turn with UNSUPPORTED_REASONING_EFFORT, so it is
 * realigned to `high`. Disable with `alignReasoningEffort: false`.
 *
 * @param settings - the settings service.
 * @param cfg - the complete plugin configuration.
 * @param logger - where to report.
 * @returns `'ok' | 'aligned' | 'absent' | 'other-provider' | 'other-model' | 'failed'`.
 */
export async function alignReasoningEffort(settings, cfg, logger = console) {
  const ns = 'agent-default-model'
  try {
    const current = readNamespace(settings, ns)
    if (current === null || typeof current !== 'object') return 'absent'
    if (current.provider !== cfg.provider) return 'other-provider'
    // The effort belongs to a model; another model on the same route may well
    // declare different levels, so leave it alone.
    if (typeof current.model === 'string' && current.model.length > 0 && current.model !== cfg.model) return 'other-model'
    const effort = current.reasoningEffort
    if (typeof effort !== 'string' || effort.length === 0 || EFFORT_LEVELS.includes(effort)) return 'ok'
    // A retired id keeps its old meaning (top effort); everything else is not a
    // level this model serves and falls back to the safe middle.
    const mapped = RETIRED_EFFORTS[effort] ?? 'high'
    const revision = settings.describe?.({ redactSecrets: true })?.find((entry) => entry.ns === ns)?.revision
    await settings.mutate(ns, [{ op: 'set', path: ['reasoningEffort'], value: mapped }], revision)
    if (effort in RETIRED_EFFORTS) {
      logger.warn?.(
        '[clinepass] agent-default-model.reasoningEffort "%s" is a retired level id; it was moved to "%s" (the same effort). Re-pick a level in the composer if a session was saved with "%s".',
        effort,
        mapped,
        effort,
      )
    } else {
      logger.warn?.(
        '[clinepass] agent-default-model.reasoningEffort "%s" is not a level this model serves; set it to "%s". Re-pick a level in the composer if a session was saved with "%s".',
        effort,
        mapped,
        effort,
      )
    }
    return 'aligned'
  } catch (error) {
    logger.warn?.('[clinepass] could not align the stored reasoning effort: %s', error instanceof Error ? error.message : String(error))
    return 'failed'
  }
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
 * The request deliberately bypasses the pin hook's concerns (it is not a
 * chat-completions call, so the hook passes it through untouched).
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
 * card) does not turn into a burst of gateway calls. Failures are deliberately
 * **not** cached: fixing the key in the editor must take effect on the next
 * look, not after a minute.
 *
 * `?refresh=1` bypasses the cache — that is the card's refresh button.
 *
 * @param routeCtx - the context the `connection` and `credentials` services resolved in.
 * @param cfg - the complete plugin configuration.
 * @param logger - where to report an unexpected failure.
 * @param options - a `fetch` override, threaded to {@link fetchUsage} (tests).
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
      const state = typeof hook?.state === 'function' ? hook.state() : {}
      const verified = (sessionId && typeof hook?.verifiedBySession === 'function' ? hook.verifiedBySession(sessionId) : null)
        || (model && typeof hook?.verifiedByModel === 'function' ? hook.verifiedByModel(model) : null)
        || state.lastVerified
        || null

      return json({
        ok: true,
        provider: verified?.provider ?? null,
        model: verified?.model ?? null,
        at: verified?.at ?? null,
        anonymized: verified?.provider === ANONYMIZED_CHANNEL,
        warn: verified?.warn === true,
        reason: verified?.reason ?? null,
        allowed: verified?.allowed ?? [],
        attempts: verified?.attempts ?? 0,
        lastAnonymized: state.lastAnonymized ?? null,
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
 * Scoping matters more than it looks: a global hook sees *every* provider's
 * traffic, and `providerOptions` is not a field every OpenAI-compatible API
 * accepts — a host that rejects unknown arguments would start failing the
 * moment an unrelated route was rewritten. So the origin has to match the
 * configured upstream, and the path has to be the completions endpoint.
 *
 * @param url - the request URL.
 * @param upstream - the configured gateway base (e.g. `https://api.cline.bot`).
 * @returns whether the pin applies to this request.
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
 * Drop a body-length header that no longer describes the rewritten body.
 *
 * The OpenAI SDK sends no `content-length` (undici computes it), which is why
 * this is not load-bearing today — but a caller that does set one would declare
 * a length that no longer matches its body, and `fetch` refuses a
 * `transfer-encoding` that arrives alongside a body. Cheap to get right.
 *
 * @param headers - `init.headers` (plain object, `Headers`, or [name, value] pairs).
 * @returns the same headers when there is nothing to fix, otherwise a copy.
 */
function withoutBodyLength(headers) {
  if (headers === undefined || headers === null || typeof headers !== 'object') return headers
  const pattern = /^(content-length|transfer-encoding)$/i
  if (typeof Headers === 'function' && headers instanceof Headers) {
    if (!headers.has('content-length') && !headers.has('transfer-encoding')) return headers
    const copy = new Headers(headers)
    copy.delete('content-length')
    copy.delete('transfer-encoding')
    return copy
  }
  const found = Object.keys(headers).filter((key) => pattern.test(key))
  if (found.length === 0) return headers
  const copy = { ...headers }
  for (const key of found) delete copy[key]
  return copy
}

/**
 * The body of a fetch call as text, when this hook can rewrite it.
 *
 * Strings are what the OpenAI SDK sends (`body: JSON.stringify(...)`), so that
 * is the path that matters; buffers are accepted because a hand-rolled caller
 * may send them. A stream, `FormData` or `Blob` cannot be inspected without
 * buffering it, and buffering a request is a worse idea than skipping it.
 *
 * @param body - `init.body`.
 * @returns `{ text }` when rewritable, `{ skip }` with a reason otherwise.
 */
function bodyText(body) {
  if (typeof body === 'string') return { text: body }
  if (body instanceof ArrayBuffer) return { text: Buffer.from(body).toString('utf8') }
  // `Buffer` is an ArrayBuffer view, so this branch covers it too.
  if (ArrayBuffer.isView(body)) return { text: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8') }
  if (body === undefined || body === null) return { skip: 'no body' }
  return { skip: `a ${body.constructor?.name ?? typeof body} body` }
}

/**
 * Render the pinned body, or say why it was left alone.
 *
 * A body with no pin configured (`pin: []`) is a legitimate "pass through" and
 * is deliberately *not* a problem; an unreadable one is.
 *
 * @param text - the request body as text.
 * @param cfg - the complete configuration.
 * @returns `{ text, only, expect, order, model }` when rewritten, else `{ problem }`; a
 *   body where neither pin lands (no channel pin, or a provider pin whose names render
 *   no slug) gets `{ untouched: true, expect?, model? }` — the request is sent as-is,
 *   and its *response* is verified instead.
 */
function pinnedBody(text, cfg) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { problem: 'the body is not JSON' }
  }
  if (!isPlainObject(body)) return { problem: 'the body is not a JSON object' }
  const model = typeof body.model === 'string' ? body.model : undefined
  const only = pinFor(cfg, model)
  const expect = providerPinFor(cfg, model)
  const applied = withPin(body, only)
  // 0.11.0：provider 钉不再只守响应 —— wire 顶层 `provider.order`（显示名 slug 化）
  // 一并写上。deepseek 形状（回退网）对 order 无感（实测 routing 不变），两侧同配也安全。
  const wired = withProviderOrder(applied.body, expect)
  // 0.11.3 诊断：把请求形状留给状态文件 —— 「这条请求长什么样」从此有据可查。
  // （0.11.1/0.11.2 的「会话首条消息垫提示帧」已在 0.11.3 删除：合成的 assistant
  // 帧会进上下文，代价比收益大。诊断字段保留，它不依赖那个功能。）
  const shapeMessages = Array.isArray(body.messages) ? body.messages : null
  const shape = {
    at: new Date().toISOString(),
    model: body.model ?? null,
    stream: body.stream === true,
    maxTokens: body.max_tokens ?? null,
    maxCompletionTokens: body.max_completion_tokens ?? null,
    roles: shapeMessages === null ? null : shapeMessages.map((m) => (isPlainObject(m) ? m.role : '?')).join(','),
  }
  if (applied.pinned || wired.order.length > 0) {
    return { text: JSON.stringify(wired.body), only, expect, order: wired.order, model: body.model ?? null, shape }
  }
  return expect.length > 0 ? { untouched: true, expect, model: body.model ?? null, shape } : { untouched: true, shape }
}

// ── 校验：网关到底把这次请求交给了谁 ────────────────────────────────────────
//
// `providerOptions.gateway.only` 是 Vercel AI Gateway 文档里的「钉住渠道」写法，
// 但 api.cline.bot 自 2026-09-22 起**不再执行它**：钉真渠道、钉假渠道、完全不钉，
// 响应体里的 routing 元数据逐字相同，`fallbacksAvailable` 永远列出全部 16 个渠道。
// 也就是说「钉选」只是请求里的一段装饰，真正的路由由网关自己决定。
//
// 但同一网关对 OpenRouter 协议的顶层 `provider` 字段是**执行**的（实测 2026-10-14，
// 各 5 发：glm-5.3-flash 带 order:["z-ai"] 5/5 由 Z.AI 服务，不带 2/5；"z.ai" 这种
// 显示名拼法则会让网关掐断连接 —— 请求线只认 slug）。所以 0.11.0 起两层并用：
// 请求侧把 provider.order 写上（slug 化），响应侧的本地闸照旧 fail closed。
//
// 渠道钉（deepseek 那套）没有可执行的请求线字段，仍只能在本地兑现：读完响应，从
// routing 里读出真正服务它的渠道，不在允许列表里就整条丢掉、让这次调用失败 ——
// 而不是把一个非官方渠道的答案交给模型。

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
 * 为什么是「每一处」而不是「最后一处」：`routing` 通常是网关写在最后那一帧，但同一个响应
 * 体里的字节**也流经被审的那一方** —— 服务这次请求的渠道控制着自己那部分帧的结构，于是可以
 * 在网关的 routing 之后再塞一个自称「由允许渠道提供」的 routing，把判决改成它想要的那个。
 * 只信最后一处，等于把结论交给被审的一方。规则：**任何一处指向别家就拒**。
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
 *   的做法），拼不出合法 JSON 再逐行 parse 一次兜底 —— 更严只会 fail closed，不会放行。
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
 * 这是 provider 级钉选的证据源：api.cline.bot 的直通形状（实测 2026-10-14，
 * glm-5.3-flash 由 Z.AI / InferenceNet / Together 轮转服务）每个 chunk 都带顶层
 * `provider` 字段，而回退网形状（model 回显 `vmc/…-contributor-fallbacks`）没有 ——
 * 缺失就是「无法证明」，与渠道钉读不到 routing 元数据同等处理（fail closed）。
 *
 * 刻意**只读顶层**：routing 元数据里的 `providerAttempts[].provider`、`delta.provider`
 * 之类的嵌套键不是直通证据 —— 逐层收集会把「试过别家但失败」的 attempt 名也算进来，
 * 语义就滑回渠道钉那套 attempt 判定了。
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
 * {@link routingsOfText} 里最后出现的那一处。
 *
 * 单处 routing 的响应（网关今天的形态）用这个足够；判定请用 {@link judgeRoutings}，
 * 它会逐处都查。
 *
 * @param text - 响应体原文。
 * @returns 最后一个 routing 对象，没有则 null。
 */
export function routingOfText(text) {
  const all = routingsOfText(text)
  return all.length === 0 ? null : all[all.length - 1]
}

/**
 * 判定一次 routing 是否证明「请求由允许的渠道提供」。
 *
 * 三个条件缺一不可：有 `finalProvider`、它在允许列表里、**每个成功过的
 * providerAttempt 都在允许列表里**（中途换过渠道的话，前半段内容来自别家）。
 *
 * @param routing - {@link routingOfText} 的返回值。
 * @param allowed - 允许的渠道 slug 列表。
 * @returns `{ ok: true, provider }` 或 `{ ok: false, reason }`。
 */
export function judgeRouting(routing, allowed) {
  const allow = new Set(allowed)
  const list = allowed.join('/')
  const provider = routing?.finalProvider
  if (typeof provider !== 'string' || provider.length === 0) {
    return { ok: false, reason: `响应里没有 finalProvider，无法证明它由 ${list} 提供` }
  }
  if (!allow.has(provider)) {
    return { ok: false, reason: `finalProvider=${provider}，允许的是 ${list}` }
  }
  // 网关同时给出 `resolvedProvider`（实测与 finalProvider 同值）。两个字段只要有一个
  // 指向别家就拒 —— 它们哪天开始不一致，正是该停下来看的时候。
  const resolved = routing?.resolvedProvider
  if (typeof resolved === 'string' && resolved.length > 0 && !allow.has(resolved)) {
    return { ok: false, reason: `resolvedProvider=${resolved}，允许的是 ${list}` }
  }
  const attempts = []
  for (const model of Array.isArray(routing.modelAttempts) ? routing.modelAttempts : []) {
    for (const attempt of Array.isArray(model?.providerAttempts) ? model.providerAttempts : []) attempts.push(attempt)
  }
  // 只看**成功过**的 attempt。网关会不会把「已经吐过字节、然后失败」的那次也算一次
  // attempt（`success: false`）没法离线验证；真出现这种形状，这条规则要收紧成「出现任何
  // 非允许渠道的 attempt 就拒」。现在不能那样做：那会把「先试别家失败、再由官方渠道
  // 服务」这种正常重试一起拒掉。
  const served = attempts.filter((attempt) => attempt?.success === true)
  const foreign = served.filter((attempt) => typeof attempt.provider === 'string' && !allow.has(attempt.provider))
  if (foreign.length > 0) {
    return { ok: false, reason: `有非允许渠道成功服务过这次请求：${foreign.map((attempt) => attempt.provider).join(', ')}` }
  }
  if (served.length === 0) {
    return { ok: false, reason: `响应里没有任何成功的 providerAttempt，无法证明它由 ${list} 提供` }
  }
  return { ok: true, provider, attempts: attempts.length }
}

/**
 * 这条响应是不是 SSE（chat 的正常形态）。
 *
 * 只看 `content-type`：判断错了不会漏掉校验，只会换一条拒法（SSE 走中断响应体，
 * 非 SSE 走 400）。
 *
 * @param response - 上游响应。
 * @returns 是否是事件流。
 */
function isEventStream(response) {
  const type = response.headers.get('content-type') ?? ''
  return type.toLowerCase().includes('text/event-stream')
}

/**
 * 逐处判定这次响应里的 routing。**任何一处**指向别家就整条拒 —— 这个响应体里出现过
 * 「别家服务」的说法，无论出现在哪一帧，都不该被另一处的说法盖过去。
 *
 * 读不到任何元数据同样是**不可证明**，与读出一个不允许的渠道同等处理（fail closed），
 * 否则网关哪天不再发元数据就等于自动放行。
 *
 * @param routings - {@link routingsOfText} 的返回值。
 * @param allowed - 允许的渠道列表。
 * @returns `{ ok: true, provider, attempts, seen }` 或 `{ ok: false, reason, seen }`。
 */
export function judgeRoutings(routings, allowed) {
  const list = Array.isArray(routings) ? routings : []
  if (list.length === 0) {
    return { ok: false, reason: '响应里没有 gateway.routing 元数据，无法证明它由允许的渠道提供', seen: 0, culprit: null }
  }
  let first = null
  for (const routing of list) {
    const verdict = judgeRouting(routing, allowed)
    if (!verdict.ok) {
      const note = list.length > 1 ? `（这条响应里出现了 ${list.length} 处 routing，逐处都查了）` : ''
      // 把**被拒的那一处**带出去：状态文件里必须记它。否则伪造者能用一个自称「由允许渠道
      // 提供」的 routing，把「这次是谁服务的」这个诊断也一并改掉。
      return { ...verdict, seen: list.length, reason: verdict.reason + note, culprit: routing }
    }
    first ??= verdict
  }
  return { ...first, seen: list.length }
}

/**
 * 判定一次响应的顶层 `provider` 字段是否证明「这次响应由允许的 provider 提供」。
 *
 * 与 {@link judgeRouting} 的渠道判定**并列**的第二种证据：直通模型（`pins: []`）的响应
 * 没有 routing 元数据可查，但每帧都带网关写的顶层 `provider`（见 {@link providersOfText}
 * 的说明）。判定规则沿用同一套直觉：
 *
 * - 一个证据都没有 = 不可证明 = 拒（fail closed）；
 * - 任何一处的 provider 不在允许列表里就拒（按出现顺序，第一个越界的当被告）；
 * - 比较大小写不敏感（网关在 wire 上自己决定大小写：实测 "Z.AI" / "InferenceNet" /
 *   "Together"），但 reason 与 culprit 保留**原始拼写**，状态文件里才对得上网关的说法。
 *
 * @param providers - {@link providersOfText} 的返回值。
 * @param expected - 允许的 provider 列表（已归一化小写）。
 * @param routings - 同一响应里的 routing 对象；仅用于「无证据」时点名回退网渠道。
 * @returns `{ ok: true, provider }` 或 `{ ok: false, reason, culprit }`。
 */
export function judgeProviders(providers, expected, routings = []) {
  const list = expected.join('/')
  if (providers.length === 0) {
    // 直通形状没有 routing 元数据，但**回退网形状**有：把它当被告带出去，状态文件里
    // 能直接看到这次实际落在了哪个渠道。
    const culprit = routings.length > 0 ? routings[routings.length - 1] : null
    return { ok: false, reason: `响应里没有顶层 provider 字段，无法证明它由 ${list} 提供`, culprit }
  }
  for (const provider of providers) {
    if (!expected.includes(provider.trim().toLowerCase())) {
      return { ok: false, reason: `provider=${provider}，允许的是 ${list}`, culprit: { finalProvider: provider } }
    }
  }
  return { ok: true, provider: providers[0].trim().toLowerCase() }
}

/**
 * 从响应提取出的实际 provider（顶层 provider 字段、routing finalProvider 或 culprit）。
 *
 * @param providers - {@link providersOfText} 的返回值。
 * @param routings - {@link routingsOfText} 的返回值。
 * @param culprit - 判定失败时的 culprit 对象。
 * @returns 归一化后的小写 provider 字符串，无法确定时返回 null。
 */
export function detectedProviderOf(providers = [], routings = [], culprit = null) {
  if (typeof culprit?.finalProvider === 'string' && culprit.finalProvider.length > 0) {
    return culprit.finalProvider.trim().toLowerCase()
  }
  if (Array.isArray(providers) && providers.length > 0 && typeof providers[0] === 'string' && providers[0].length > 0) {
    return providers[0].trim().toLowerCase()
  }
  if (Array.isArray(routings) && routings.length > 0) {
    const last = routings[routings.length - 1]
    const p = last?.finalProvider ?? last?.resolvedProvider
    if (typeof p === 'string' && p.length > 0) return p.trim().toLowerCase()
  }
  return null
}

/**
 * 两种证据的合并判定：渠道钉看 routing 元数据，provider 钉看顶层 provider 字段；同一
 * 模型两侧都配置了就必须**都**过关（语义取严）。失败时先到的被告先出场（provider 在
 * 前 —— 它是「这次由谁直接服务」的直接说法）。成功结论合并：`provider` 取 provider
 * 字段的归一化值，`attempts` 仍来自 routing。
 *
 * @param routings - {@link routingsOfText} 的返回值。
 * @param providers - {@link providersOfText} 的返回值。
 * @param channels - 渠道钉的允许列表（空 = 不查 routing）。
 * @param expectedProviders - provider 钉的允许列表（空 = 不查 provider 字段）。
 * @returns `{ ok: true, provider, attempts }` 或 `{ ok: false, reason, culprit }`。
 */
function judgeEvidence(routings, providers, channels, expectedProviders) {
  const providerVerdict = expectedProviders.length > 0 ? judgeProviders(providers, expectedProviders, routings) : null
  const routingVerdict = channels.length > 0 ? judgeRoutings(routings, channels) : null
  if (providerVerdict !== null && !providerVerdict.ok) return providerVerdict
  if (routingVerdict !== null && !routingVerdict.ok) return routingVerdict
  const detected = detectedProviderOf(providers, routings)
  if (providerVerdict !== null && routingVerdict !== null) return { ok: true, provider: providerVerdict.provider ?? detected, attempts: routingVerdict.attempts ?? 0 }
  return providerVerdict ?? routingVerdict ?? { ok: true, provider: detected, attempts: 0 }
}

/**
 * 早期裁决（自动重试用，0.10.0）：**只看已有证据，能给结论就给，给不了就是悬而未决**。
 *
 * 与 {@link judgeEvidence} 的差别在「无证据」的语义上。收尾裁决读不到任何证据就是
 * fail closed —— 那是整条响应读完后的最终发言；而早期裁决发生在流的中途，「还没读到
 * 证据」只说明证据帧没到，不是缺席。所以这里每个证据面只在**已经收到证据**时才参与：
 *
 * - provider 面有证据且失败，或 routing 面有证据且失败 → 返回那个失败（可重试 ——
 *   此刻还没有任何字节交付给消费者）；
 * - 有证据且**都**过关 → 返回成功（「到此为止的证据都合格」—— 后面若翻脸，由收尾
 *   裁决兜底，那时内容已交付，不再重试）；
 * - 任何一面没有证据 → null（悬而未决，继续等下一帧）。
 *
 * @param routings - 已收到的 routing 证据。
 * @param providers - 已收到的顶层 provider 证据。
 * @param channels - 渠道钉的允许列表（空 = 该面不参与）。
 * @param expectedProviders - provider 钉的允许列表（空 = 该面不参与）。
 * @returns `{ ok, … }`（有证据可判）或 null（悬而未决）。
 */
function earlyVerdict(routings, providers, channels, expectedProviders) {
  const providerVerdict = expectedProviders.length > 0 && providers.length > 0 ? judgeProviders(providers, expectedProviders, routings) : null
  const routingVerdict = channels.length > 0 && routings.length > 0 ? judgeRoutings(routings, channels) : null
  if (providerVerdict !== null && !providerVerdict.ok) return providerVerdict
  if (routingVerdict !== null && !routingVerdict.ok) return routingVerdict
  return providerVerdict ?? routingVerdict
}

/**
 * 状态文件与错误文案里的「允许列表」：provider 钉在场时把两侧的期望合并展示 —— 只用
 * 渠道钉时与旧行为逐字一致。
 *
 * @param allowed - 渠道钉的允许列表。
 * @param expectedProviders - provider 钉的允许列表。
 * @returns 合并后的展示列表。
 */
function expectedList(allowed, expectedProviders) {
  return expectedProviders.length > 0 ? (allowed.length > 0 ? [...allowed, ...expectedProviders] : [...expectedProviders]) : allowed
}

/**
 * 一个渠道名要进错误文案，必须**形状像网关的 slug**（小写字母数字 + `.` `_` `-`）。
 */
const CHANNEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,31}$/

/**
 * 会踩到 dsh 那几套判定的词根：可重试分类（rate / timeout / network / 5xx）、配额，
 * 以及**会触发会话压缩**的上下文溢出。
 *
 * 渠道名是**网关给的数据**，而 dsh 会在错误文案上跑多套正则判定。文案允许插值的前提是
 * 「插的必须是形状合规且不含这些词根的名字」——否则退回一句不含动态内容的说法（原始名
 * 仍进 `detail` 与状态文件的 `violations`）。这是护栏不是证明：判定随时会增补，所以规则
 * 保持「宁可少显示，也不让被审的那一方有机会写判词」。
 */
const CHANNEL_RISKY = /(context|overflow|exceed|token|length|limit|rate|quota|balance|credit|insufficient|timeout|network|transport|server|error|fail|abort|cancel|retry|busy|overload|capacity|invalid|unauthor|forbidden|unavailable|internal|5\d\d)/i

/**
 * 这个渠道名能不能安全地写进错误文案。
 *
 * @param raw - routing 里读到的渠道名。
 * @returns 可展示的名字，或 null（此时文案只说「名称未通过展示检查」）。
 */
export function displayableChannel(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.trim().toLowerCase()
  if (name.length === 0 || !CHANNEL_SLUG.test(name)) return null
  if (CHANNEL_RISKY.test(name)) return null
  return name
}

/**
 * 从被拒的那处 routing 里读出**这次到底是谁服务的**：`finalProvider` → `resolvedProvider`
 * → 第一个成功过的非允许渠道 attempt。三者都指向允许渠道（或根本没有元数据）时返回 null。
 *
 * @param routing - {@link judgeRoutings} 给出的 `culprit`。
 * @param allowed - 允许的渠道列表。
 * @returns 违规渠道的**原始**名字，或 null。
 */
export function offenderOf(routing, allowed) {
  const allow = new Set(allowed)
  const foreign = (value) => (typeof value === 'string' && value.length > 0 && !allow.has(value) ? value : null)
  const direct = foreign(routing?.finalProvider) ?? foreign(routing?.resolvedProvider)
  if (direct !== null) return direct
  for (const model of Array.isArray(routing?.modelAttempts) ? routing.modelAttempts : []) {
    for (const attempt of Array.isArray(model?.providerAttempts) ? model.providerAttempts : []) {
      if (attempt?.success === true) {
        const name = foreign(attempt.provider)
        if (name !== null) return name
      }
    }
  }
  return null
}

/**
 * 用已缓冲的原文重建响应。
 *
 * `content-encoding` / `content-length` 必须删掉：body 已经被解码成文本，留着
 * 这两个头会让下游再解一次压缩、或按错误的长度去读。
 *
 * @param text - 已解码的响应体。
 * @param response - 上游响应（取其状态与其余头）。
 * @returns 重建的响应。
 */
function bufferedResponse(text, response) {
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(text, { status: response.status, statusText: response.statusText, headers })
}

/**
 * 拒绝一条没被允许渠道服务的响应。
 *
 * 状态码刻意不用 5xx：dsh 的重试策略默认只重试 `EMPTY_RESPONSE` / `RATE_LIMIT` /
 * `SERVER` / `TIMEOUT` / `TRANSPORT`，而 5xx 会被 pi-ai 归类成 `SERVER` —— 那就会把
 * 同一条注定被拒的请求重试 8 次。4xx 归类成 `INVALID_REQUEST`（不在默认集合里），于是
 * 「拦下即结束」，不浪费往返。文案也刻意避开 rate / timeout / network 这类关键词。
 *
 * @param reason - 判定失败的说明。
 * @param allowed - 允许的渠道列表。
 * @returns 400 响应。
 */
function refusalResponse(reason, allowed, culprit = null) {
  const message = refusalMessage(false, offenderOf(culprit, allowed), allowed)
  return new Response(
    JSON.stringify({ error: { code: 'PROVIDER_PIN_VIOLATION', type: 'provider_pin_violation', message, allowed } }),
    {
      status: 400,
      statusText: 'Provider Pin Violation',
      headers: { 'content-type': 'application/json', 'x-dsh-clinepass-refused': 'provider-pin' },
    },
  )
}

/**
 * 违规文案。**点名渠道，但只点得起名的渠道**。
 *
 * dsh 会在错误文案上跑**多个**判定：`mapStopReason` 先用 pi-ai 的上下文溢出模式与
 * `isContextWindowExceededError`，再是配额，最后才是 `classifyPiAiError`。它们决定要不要
 * 重试，溢出那条**还会触发会话压缩**。渠道名由网关给 —— 把被审方的字符串原样喂给裁判，
 * 就是给对手改判词的机会：一个叫 `context_length_exceeded` 的渠道名足以让 dsh 去压缩你的
 * 会话。所以插值只走 {@link displayableChannel} 的闸：形状像 slug、且不含任何判定词根的
 * 名字才写进文案；闸外的一律退回固定说法，原始名仍旧进 `detail`、状态文件的 `violations`
 * 与插件日志 —— 这三处都不参与判定。
 *
 * 这不是「加个正则就安全了」的证明，判定随时会增补；它保证的是**被审方无法自己选择写进
 * 文案的字符串**（能写进去的只有网关那 16 个 slug 形状的名字）。测试钉两件事：安全名必须
 * 出现，恶意名必须一个字都不出现、且彼此逐字相同。
 *
 * 流式与缓冲两种拒法的后果不同，文案必须说清：缓冲（非流式响应）时内容从未离开网关；
 * 流式时内容已经边流边显示过，只是在**装配之前**把这次调用作废了 —— 模型上下文里没有
 * 它、工具也不会执行。含糊其辞会让用户以为「看见了就等于模型用过」。
 *
 * 同样刻意避开 rate / timeout / network / 5xx 这类关键词：dsh 用正则给 pi-ai 的失败
 * 分类，命中就会被默认重试策略当成可重试错误。
 *
 * @param streamed - 是否是「已经流出去过」的那条路径。
 * @param offender - 违规渠道的原始名（{@link offenderOf}），读不出时 null。
 * @param allowed - 允许的渠道列表（来自本地配置，不是网关数据）。
 * @returns 展示给用户的文案。
 */
function refusalMessage(streamed, offender, allowed) {
  const allowList = allowed.length > 0 ? allowed.join('/') : '（空）'
  const shown = displayableChannel(offender)
  const who =
    offender === null
      ? '没能证明来源（响应里没有可用的来源证据）'
      : shown === null
        ? '由允许列表之外的渠道提供（名称未通过展示检查，原始名见状态文件的 violations 与错误 detail）'
        : `由 ${shown} 提供`
  const tail = streamed
    ? '这次调用已作废：内容没有进入模型上下文、工具也不会执行（可能已在窗口里闪现）。enforcement=strict；想只告警就设 enforcement: "warn"。'
    : '已丢弃这条响应、没有交给模型（enforcement=strict；想只告警就设 enforcement: "warn"）。'
  return `cline-pass 渠道校验未通过：本次响应${who}，允许列表是 ${allowList}。${tail}`
}

/**
 * 流式路径的拒法：把响应体**中断**掉。
 *
 * 不能像缓冲路径那样返回 400 —— HTTP 状态在第一帧内容出去时就定死了。改为让响应体
 * 报错：pi-ai 的 openai 适配器把读流异常转成 `error` 事件，agent loop 据此只落一条
 * `assistant/attempt`（无 surface op，不进上下文）并结束这一步，绝不装配 `assistant/message`
 * —— 于是工具不会执行。注意**终止帧必须扣住**：只要 `data: [DONE]` 先到了消费者手里，
 * 适配器就会当成正常收尾去装配消息，那时候再报错已经晚了。
 *
 * @param reason - 判定失败的说明（只放进 `detail` 与日志）。
 * @param allowed - 允许的渠道列表。
 * @param culprit - 被拒的那处 routing（用来在文案里点名渠道）。
 * @returns 抛进响应流的错误。
 */
function refusalError(reason, allowed, culprit = null) {
  const error = new Error(refusalMessage(true, offenderOf(culprit, allowed), allowed))
  error.name = 'ClinePassPinViolation'
  error.code = 'PROVIDER_PIN_VIOLATION'
  error.allowed = [...allowed]
  // 诊断走属性，不走 message：message 会被 dsh 拿去分类（重试、甚至触发会话压缩）。
  error.detail = reason
  return error
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
 * 解码只用于判断，转发的是原始字节；整帧都是 ASCII，不存在半个字符的问题。
 *
 * @param frame - 一帧原始字节。
 * @returns 是否是终止帧。
 */
export function isTerminatorFrame(frame) {
  // 规则要和**消费者**逐字一致，否则会出现「我们以为扣住了、它以为结束了」这种错位：
  // openai 的解码器把一帧里的多个 `data:` 行用 `\n` 拼起来，再只看 `startsWith('[DONE]')`，
  // 而它的行分隔符是 `\r`、`\n` 或 `\r\n`。所以这里也是「拼数据行、判前缀」，
  // 不是在任意一行里搜 `[DONE]`，也不只认 `\n` 开头的行。
  const lines = []
  for (const line of new TextDecoder().decode(frame).split(/[\r\n]/)) {
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
    // 裸 `data` 行是**空**数据字段，不是「没有这一行」：它会把拼接结果顶成 `\n…`，消费者
    // 因此不认为这是终止帧。少认这一个会让「我们扣住了、它报错了」两边对不上。
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
 * Build the in-process pin hook without a plugin context (used by apply() and tests).
 *
 * Installing replaces `globalThis.fetch` with a wrapper that inspects only this
 * gateway's chat-completions calls; every other call is passed to the original
 * function with the original arguments, synchronously and unmodified. Any
 * failure inside the hook is caught and turns into an ordinary unpinned request
 * plus a warning — a broken hook must not break the user's traffic.
 *
 * @param config - a complete configuration.
 * @param logger - optional logger ({info,warn,error}).
 * @returns the hook: `install()`, `uninstall()`, counters and `profileBaseURL()`.
 */
export function createFetchPin(config, logger = console) {
  const cfg = withDefaults(config, logger)
  let original = null
  let installed = false
  let calling = false
  let hookState = 'absent'
  let lastPin = null
  /** 最近一次 provider 级钉选请求（providerPins 模型；0.11.0 起请求线也带 provider.order，响应由 wire 顶层的 provider 字段裁决）。 */
  let lastProviderPin = null
  const counters = { seen: 0, pinned: 0, providerPinned: 0, skipped: 0, blocked: 0, unverified: 0, retried: 0, anonymized: 0 }
  /** 最近一次校验通过 / 被拦下的记录（status 文件里能直接看到「网关把它交给了谁」）。 */
  let lastVerified = null
  const lastVerifiedBySession = new Map()
  const lastVerifiedByModel = new Map()
  /** 最近一次由匿名渠道服务的请求（0.11.1；渠道名已被网关匿名化，见 {@link ANONYMIZED_CHANNEL}）。 */
  let lastAnonymized = null
  let lastViolation = null
  /**
   * 违规**历史**：只留最后一条的 `lastViolation` 答不了「今天被拦的那几次各自路由去哪」。
   * 有界，免得一次网关抽风把状态文件撑大。
   */
  let violations = []
  const VIOLATION_HISTORY_LIMIT = 20
  let lastUnverified = null
  /** 最近一次「这个请求没被钉上」以及原因（README 让用户按 seen/pinned 查的就是它）。 */
  let lastSkipped = null
  /** 最近一次 chat 请求的判定相关形状（0.11.3 诊断；状态文件 `lastRequestShape`）。 */
  let lastRequestShape = null
  /** provider profile 的登记结果，由 {@link noteProvision} 在 apply 里填。 */
  let provision = null
  /** 与 `provision` 配套的一句话（`failed` / `mismatch` / `repaired` 的原因）。 */
  let provisionReason = null

  /** The base URL the provider profile must point at: the gateway itself. */
  const profileBaseURL = () => `${cfg.upstream}${PROFILE_PATH}`

  // ── the status file: how a silent bypass becomes visible ──────────────────
  const statusPath = statusFileFor(cfg)
  let writeWarned = false

  /**
   * Publish the current state. One small write per pinned request (chat
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
          pin: cfg.pin,
          providerPins: cfg.providerPins,
          profileBaseURL: profileBaseURL(),
          counters: { ...counters },
          lastPin,
          lastProviderPin,
          enforcement: cfg.enforcement,
          // 自动重试的配置值（0.10.0）：0 = 拦下即结束；与 counters.retried 对读。
          retries: cfg.retries,
          lastVerified,
          lastAnonymized,
          lastViolation,
          // 最近 {@link VIOLATION_HISTORY_LIMIT} 条违规，按时间正序（最新在最后）。
          violations: [...violations],
          lastUnverified,
          lastSkipped,
          // 0.11.3 诊断：最近一次 chat 请求的判定相关形状（提示垫没垫、为什么）。
          lastRequestShape,
          // Config keys that were read and ignored, so an upgrade from the
          // port era is visible even where plugin warnings are not.
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
   * Decide what to send. Resolves `null` to mean "send the request untouched".
   *
   * @param input - fetch input.
   * @param init - fetch init.
   * 返回值里 `{ kind: 'skip', reason }` 是**唯一**的「没钉上」形状：原因在这里产生，由调用方
   * 记进状态文件并打日志。计数与落盘都只发生在调用方那一处，免得两边各加一次。
   *
   * 每种可校验的形状都带 `resend(attempt) → [input, init]`（自动重试，0.10.0）：第 0 次
   * 返回的就是首次发送要用的参数，第 ≥1 次返回**可重发**的等价参数 —— `Request` 的 body
   * 会被 fetch 消费掉，重发必须用留存的 body 文本重建（字符串/Buffer 的 init body 不会被
   * 消费，可原样重发）。
   *
   * @returns `{ kind: 'init', init, resend }`、`{ kind: 'request', request, resend }`、
   *   `{ kind: 'provider', next, resend }` 或 `{ kind: 'skip', reason }`。
   */
  async function rewrite(input, init) {
    const direct = init ?? {}
    const hasOwnBody = direct.body !== undefined
    if (hasOwnBody) {
      const { text, skip } = bodyText(direct.body)
      if (skip !== undefined) return { kind: 'skip', reason: skip }
      const next = pinnedBody(text, cfg)
      if (next.shape !== undefined) lastRequestShape = next.shape
      if (next.text === undefined) {
        // provider 级钉选的兜底形状（0.11.0 起罕见：providerPins 配了但 slug 推不出，
        // 请求线没得注入）：body 一字不动地发（`{ kind: 'provider' }`），由响应侧兑现
        // 校验 —— 与 skip 的区别在于它的响应仍受闸管，不算「没钉上」。
        // init body（字符串/Buffer）不会被 fetch 消费，重试原样重发。
        if (next.untouched && next.expect?.length > 0) return { kind: 'provider', next, resend: () => [input, init] }
        return { kind: 'skip', reason: next.problem ?? NOTHING_TO_PIN }
      }
      const pinned = { ...direct, body: next.text, headers: withoutBodyLength(direct.headers ?? input?.headers) }
      return { kind: 'init', init: pinned, next, resend: () => [input, pinned] }
    }
    // A `Request` carries its own body; rebuild it with the pinned one, keeping
    // the method, headers and signal it was constructed with. The body text is
    // kept for rebuilds: a Request's body stream is consumed by the first send,
    // so a retry needs a fresh Request.
    if (typeof Request === 'function' && input instanceof Request) {
      const raw = await input.clone().text()
      const next = pinnedBody(raw, cfg)
      if (next.shape !== undefined) lastRequestShape = next.shape
      if (next.text === undefined) {
        if (next.untouched && next.expect?.length > 0) {
          const rebuilt = () => new Request(input, { ...direct, body: raw, headers: withoutBodyLength(direct.headers ?? input.headers) })
          return { kind: 'provider', next, resend: (attempt) => (attempt === 0 ? [input, init] : [rebuilt(), undefined]) }
        }
        return { kind: 'skip', reason: next.problem ?? NOTHING_TO_PIN }
      }
      const headers = withoutBodyLength(direct.headers ?? input.headers)
      const rebuilt = () => new Request(input, { ...direct, body: next.text, headers })
      const request = rebuilt()
      return { kind: 'request', request, next, resend: (attempt) => [attempt === 0 ? request : rebuilt(), undefined] }
    }
    return { kind: 'skip', reason: 'it carries no readable body' }
  }

  /** Log the request the way a capture would. */
  function report(url, next) {
    const id = String(counters.seen).padStart(3, '0')
    logger.info?.(
      '[clinepass] → #%s POST %s pinned to %s (model %s, in-process)',
      id,
      url,
      next.only.join(', '),
      next.model ?? '?',
    )
  }

  /**
   * Hand a call to the function this hook replaced.
   *
   * `fetch` never throws synchronously — it returns a rejected promise — and a
   * wrapper must not change that, whatever implementation it happened to wrap.
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

  /**
   * 记一次「网关没把请求交给允许的渠道」。
   *
   * 两种结局共用这一处，靠 `retried` 区分：
   *
   * - **retried: false（最终拒绝）**：这次响应不会交付，调用方拿到拒绝。`blocked` 计数、
   *   `lastViolation` 单槽都只属于它 —— 「上次被拦的是谁」必须指向调用方真的看到的拒绝，
   *   被重试掉的中途尝试不能占这个槽。
   * - **retried: true（被重试掉的尝试）**：这次响应同样被拦下、内容同样没有交付，但紧接着
   *   会补发一次（自动重试，0.10.0）。计入 `retried` 而不是 `blocked`，`lastViolation`
   *   不动；violations 历史照记 —— 审计面要回答的是「网关把它交给了谁」，被重试掉的那次
   *   也是网关的一次真实路由。
   *
   * @param reason - 判定失败的说明。
   * @param allowed - 允许的渠道列表（合并 provider 期望后的展示面）。
   * @param routing - 读出（或读不出）的 routing / culprit。
   * @param url - 这次被拦下的请求地址（进历史，便于对上「哪一轮」）。
   * @param retried - 这次拦下之后是否紧接着自动重试。
   */
  function recordViolation(reason, allowed, routing, url = null, retried = false) {
    if (retried) counters.retried += 1
    else counters.blocked += 1
    const entry = {
      at: new Date().toISOString(),
      url,
      allowed: [...allowed],
      reason,
      finalProvider: typeof routing?.finalProvider === 'string' ? routing.finalProvider : null,
      fallbacksAvailable: Array.isArray(routing?.fallbacksAvailable) ? routing.fallbacksAvailable.slice(0, 20) : null,
      retried,
    }
    if (!retried) lastViolation = { ...entry }
    // 历史比单槽多答一个问题：**今天被拦的每一次**各自路由去哪。`at` 是唯一能把它和
    // dsh 会话日志里那条 `turn/end` 错误对上的字段，所以必须写。
    violations = [...violations, entry].slice(-VIOLATION_HISTORY_LIMIT)
    publish()
    if (retried) logger.warn?.('[clinepass] ↻ 拦下一条不是 %s 提供的响应（%s），自动重试…', allowed.join('/'), reason)
    else logger.error?.('[clinepass] ✗ 拦下一条不是 %s 提供的响应：%s', allowed.join('/'), reason)
  }

  /**
   * 记一次「没能校验」：流没有正常收尾（用户按停止、socket 断），裁决从未发生。
   *
   * 既不是违规（没有证据说它来自别家），也**不能算通过** —— 单列一格，免得被读成
   * 「一切正常」。中止那种情况里已经显示出去的内容可能已进上下文，见 README。
   *
   * @param url - 请求 URL。
   * @param reason - `aborted`（用户/父级取消）或 `stream failed`（其它读流失败）。
   * @param error - 引发它的错误。
   */
  function recordUnverified(url, reason, error) {
    counters.unverified += 1
    lastUnverified = {
      at: new Date().toISOString(),
      url,
      reason,
      detail: error instanceof Error ? error.message : String(error),
    }
    publish()
    logger.warn?.('[clinepass] ⚠ 一条流没有正常收尾（%s），渠道没能校验：%s', reason, lastUnverified.detail)
  }

  /**
   * 直通形状的**早期取证**：把 SSE 流的头几帧读出来，凑齐第一份证据就提前裁决 ——
   * 这是自动重试能对**流式**响应生效的全部依据。
   *
   * 渠道钉做不到这一点：routing 元数据在响应体**最后一帧**（信息论下界，见
   * {@link streamedVerification} 的说明），早期取证等于把整条流缓冲掉，流式就没了。
   * 所以调用方只在 **provider 钉在场**（`expectedProviders.length > 0`）时才走到这里 ——
   * 直通形状实测每帧都带顶层 `provider` 字段，通常第一帧就够裁决。渠道侧的证据若恰好
   * 也在早期出现（两种钉选并存的形状），{@link earlyVerdict} 同样会看到它。
   *
   * 三种出口：
   *
   * - **读到证据帧就停**（`done: false`）：裁决是 {@link earlyVerdict} 的结论 —— 失败
   *   → 调用方补发重试（没有字节交付过，完全透明）；成功 → 调用方把 `consumed` 字节
   *   连同 reader 一起移交 {@link streamedVerification}，流式照常继续。
   * - **读到终止帧 / 上游关流**（`done: true`）：整条响应都进了 `consumed`，用
   *   {@link judgeEvidence} 做收尾裁决 —— 通过 → 调用方按缓冲路径放行；失败 → 也还能
   *   重试（同样没有字节交付过），重试额度用尽才拒绝。
   * - **读流失败**：记 `unverified`（裁决根本没发生），原样抛回 —— 与
   *   {@link streamedVerification} 的读流失败同语义，只是发生在响应交付之前。
   *
   * @param response - 上游 2xx SSE 响应（body 尚未被读过）。
   * @param allowed - 渠道钉的允许列表。
   * @param expectedProviders - provider 钉的允许列表。
   * @param url - 请求 URL（记录用）。
   * @param signal - 调用方的取消信号。
   * @returns `{ done, verdict, consumed, reader, text }`；`text` 仅在 `done: true` 时有效（整条响应的解码文本）。
   */
  async function peekStreamEvidence(response, allowed, expectedProviders, url, signal) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = new Uint8Array(0)
    let consumed = new Uint8Array(0)
    const routings = []
    const providers = []
    /** 处理一帧：收证据，然后停在「证据已出现」或「终止帧」上。 */
    const take = (frame) => {
      const text = decoder.decode(frame)
      for (const routing of routingsOfText(text)) routings.push(routing)
      for (const provider of providersOfText(text)) providers.push(provider)
      if (isTerminatorFrame(frame)) {
        const verdict = judgeEvidence(routings, providers, allowed, expectedProviders)
        return { done: true, verdict, consumed, reader, text: new TextDecoder().decode(consumed) }
      }
      const early = earlyVerdict(routings, providers, allowed, expectedProviders)
      if (early !== null) return { done: false, verdict: early, consumed, reader, text: null }
      return null
    }
    for (;;) {
      while (pending.length > 0) {
        const end = nextFrameEnd(pending)
        if (end === -1) break
        const frame = pending.slice(0, end)
        pending = pending.slice(end)
        const stopped = take(frame)
        if (stopped !== null) return stopped
      }
      let chunk
      try {
        chunk = await reader.read()
      } catch (error) {
        // 取消（用户按停止）或 socket 断：裁决没发生，记 unverified 后原样抛回。
        const aborted = signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
        recordUnverified(url, aborted ? 'aborted' : 'stream failed', error)
        throw error
      }
      if (chunk.done) {
        // 上游没发空行就关流：剩下的是最后一帧，证据与文本都要算上。
        if (pending.length > 0) {
          const text = decoder.decode(pending)
          pending = new Uint8Array(0)
          for (const routing of routingsOfText(text)) routings.push(routing)
          for (const provider of providersOfText(text)) providers.push(provider)
        }
        const verdict = judgeEvidence(routings, providers, allowed, expectedProviders)
        return { done: true, verdict, consumed, reader, text: new TextDecoder().decode(consumed) }
      }
      pending = concatBytes(pending, chunk.value)
      consumed = concatBytes(consumed, chunk.value)
    }
  }

  /**
   * 发送一次「钉选」请求并校验响应确实由允许的渠道（routing 元数据）或允许的 provider
   * （wire 顶层的 `provider` 字段）提供；校验失败时按 `cfg.retries` **自动补发**，把结论
   * 落到状态文件。
   *
   * 为什么要重试（0.10.0）：glm-5.3-flash 这类直通模型由网关在多家 provider 之间**按请求
   * 轮转**，钉住其中一家意味着固定比例的轮次被闸拦下 —— 而下一次请求大概率就轮到允许的
   * provider。补发对调用方完全透明：重试只发生在**没有任何内容交付**的时刻 ——
   *
   * - **缓冲路径**：整条响应读完再判，失败时内容从未离开网关，补发无痕。
   * - **SSE + provider 钉**：{@link peekStreamEvidence} 在第一个证据帧上提前裁决，失败时
   *   还没有任何帧交付过；成功（或渠道面证据未到）就移交 {@link streamedVerification}
   *   照常流式。
   * - **SSE + 仅渠道钉**：证据在最后一帧，内容必然已经流出 —— **不重试**（重试只会造成
   *   内容重复），维持「边流边校验、违规中断」的原状。
   *
   * 补发请求由 `resend(attempt)` 生成（{@link rewrite} 为每种请求形状准备好重发闭包），
   * 与首次发送逐字同参。每条被拦下的尝试都进 violations 历史（`retried` 字段区分结局）；
   * 重试额度用尽才以 {@link refusalResponse} / 流中断收场。`warn` 从不重试（它的契约是
   * 「只记录、照常交付」），`off` 根本不会走到这里。
   *
   * 非 2xx 一律原样放行（任何一次尝试上都成立）：那是一次失败的调用（429/5xx/…），没有
   * 内容会被「使用」，而把网关的错误改写成自己的错误会掩盖配额、限流这些 dsh 需要看到的
   * 东西。
   *
   * @param resend - `(attempt) => fetch 参数`：第 `attempt` 次发送的 `(input, init)`。
   * @param allowed - 这次请求的允许渠道列表（渠道钉的证据面）。
   * @param url - 请求 URL（记录用）。
   * @param signal - 调用方的取消信号（用户中止这一轮时不该被记成一次「渠道违规」）。
   * @param expectedProviders - 这次请求的允许 provider 列表（provider 钉的证据面；空 = 不查）。
   * @param attempt - 当前是第几次尝试（0 起）；递归补发时 +1。
   * @returns 放行的响应，或被拒/被中断的响应。
   */
  async function sendVerified(resend, allowed, url, signal, expectedProviders = [], attempt = 0, model = null, sessionId = null) {
    const expected = expectedList(allowed, expectedProviders)
    const response = await Promise.resolve(resend(attempt))
    if (!response.ok) return response
    if (isEventStream(response) && response.body !== null) {
      // 流式 + strict + provider 钉在场：**总是**先做早期取证（此阶段没有任何字节交付），
      // 裁决决定去向：失败 → 额度内无痕补发；额度用尽后按证据形状分流 —— 有证据帧的
      //（早期就判了失败）移交流式照常走「违规中断」，证据缺席的（回退网形状）以缓冲
      // 400 收场 —— 中断只在内容已流出时才有意义，这里内容从未流出。证据合格 → 移交流
      // 式。无 provider 钉（纯渠道钉）或非 strict：与旧行为逐字一致。
      if (cfg.enforcement === 'strict' && expectedProviders.length > 0) {
        const early = await peekStreamEvidence(response, allowed, expectedProviders, url, signal)
        const canRetry = attempt < cfg.retries
        if (!early.done && !early.verdict.ok) {
          if (canRetry) {
            // 第一个证据帧就判了失败，而且还没有任何字节交付 —— 无痕补发。
            recordViolation(early.verdict.reason, expected, early.verdict.culprit ?? null, url, true)
            early.reader.cancel().catch(() => {})
            return sendVerified(resend, allowed, url, signal, expectedProviders, attempt + 1, model, sessionId)
          }
          // 额度用尽：退回旧流式语义 —— 已读字节一并移交，内容照常流出，收尾裁决违规中断。
          return streamedVerification(response, allowed, url, signal, expectedProviders, { pending: early.consumed, reader: early.reader }, model, sessionId)
        }
        if (early.done) {
          // 整条流都进了缓冲（终止帧已到或上游先关了流）：按缓冲路径收尾。
          if (early.verdict.ok) {
            recordVerified(url, early.verdict, expected, model, sessionId)
            return bufferedResponse(early.text, response)
          }
          // 证据缺席（回退网形状）或越界：同样没有**任何字节交付**过，额度内无痕补发，
          // 用尽才缓冲 400 拒绝。0.11.0 修正：此前 peek 条件带着 `attempt < retries`，
          // 最后一次尝试直接落到流式收尾，`retried` 恒 0、以流中断收场 —— 与设计意图
          // （「照样补发 2 次，最终以 400 拒绝收场」）相悖，见 test-fetch.mjs §15 的重试
          // 预算用例。
          recordViolation(early.verdict.reason, expected, early.verdict.culprit ?? null, url, canRetry)
          if (canRetry) return sendVerified(resend, allowed, url, signal, expectedProviders, attempt + 1, model, sessionId)
          return refusalResponse(early.verdict.reason, expected, early.verdict.culprit ?? null)
        }
        // 早期证据合格：把已读字节与 reader 一起移交，流式照常（收尾裁决仍会兜底）。
        return streamedVerification(response, allowed, url, signal, expectedProviders, { pending: early.consumed, reader: early.reader }, model, sessionId)
      }
      return streamedVerification(response, allowed, url, signal, expectedProviders, null, model, sessionId)
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      // 用户自己按了停止：这是取消，不是渠道违规 —— 原样抛回去，让 dsh 走它自己的
      // 「已中止」路径（否则会显示成一条莫名其妙的 400，还污染 blocked 计数）。
      if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error
      const reason = `响应体读取失败（${error instanceof Error ? error.message : String(error)}），无法确认它由允许的渠道提供`
      recordViolation(reason, expected, null, url)
      return refusalResponse(reason, expected)
    }
    let routings = []
    let providers = []
    try {
      routings = routingsOfText(text)
    } catch {
      routings = []
    }
    try {
      providers = providersOfText(text)
    } catch {
      providers = []
    }
    const verdict = judgeEvidence(routings, providers, allowed, expectedProviders)
    if (verdict.ok) {
      recordVerified(url, verdict, expected, model, sessionId)
      return bufferedResponse(text, response)
    }
    const retried = cfg.enforcement === 'strict' && attempt < cfg.retries
    recordViolation(verdict.reason, expected, verdict.culprit ?? null, url, retried)
    if (retried) return sendVerified(resend, allowed, url, signal, expectedProviders, attempt + 1, model, sessionId)
    if (cfg.enforcement === 'warn') {
      const actualProv = detectedProviderOf(providers, routings, verdict.culprit)
      const isAnonymized = actualProv === ANONYMIZED_CHANNEL
      if (isAnonymized) counters.anonymized += 1
      const at = new Date().toISOString()
      const warnEntry = {
        at,
        url,
        model,
        sessionId,
        provider: actualProv,
        allowed: [...expected],
        attempts: 1,
        warn: true,
        reason: verdict.reason,
      }
      lastVerified = { ...warnEntry }
      // 两个索引都要写 —— 与 {@link recordVerified} 逐字对齐。查询侧
      // （{@link createUsageHandler} 的 `?status=1`）的优先级是 session → model →
      // 全局，而 session 这一级在本机永远是空的（dsh 不对上游发会话头，见
      // {@link extractSessionId}），于是 model 索引是唯一会命中的一级：漏写它，
      // 这个模型上一次**通过**的记录就会盖住这次的新鲜告警，胶囊显示"正常"。
      if (sessionId) lastVerifiedBySession.set(String(sessionId), lastVerified)
      if (model) lastVerifiedByModel.set(model, lastVerified)
      if (isAnonymized) lastAnonymized = { at, url, provider: actualProv, model, sessionId }
      publish()
      logger.warn?.('[clinepass] ⚠ 响应由 %s 提供（配置允许 %s），已放行（仅告警）：%s', actualProv || '未知提供方', expected.join('/'), verdict.reason)
      return bufferedResponse(text, response)
    }
    return refusalResponse(verdict.reason, expected, verdict.culprit ?? null)
  }

  /**
   * 边流边校验：内容立刻交给消费者，**只扣住 SSE 终止帧**。
   *
   * 为什么这是唯一能同时保住「钉选」和「TPS/逐字流式」的形状：网关的
   * `providerOptions.gateway.only` 自 2026-09-22 起已不再被执行（钉真渠道、钉假渠道、
   * 完全不钉，响应体逐字相同），真正服务这次请求的渠道只能从响应体**最后一帧**的
   * `gateway.routing` 读出来 —— 这是信息论上的下界，早不了。
   *
   * 所以「不把非官方渠道的答案交给模型」只能靠**撤回**兑现：内容照常流出去，但终止帧
   * 扣在手里；等 routing 到了再裁决，通过才放行终止帧，违规就把响应体报错。dsh 侧
   * （pi-ai `error` 事件 → agent loop）只落一条 `assistant/attempt`（无 surface op，
   * 不进上下文），**绝不装配 `assistant/message`，于是工具不会执行**。
   *
   * 代价要说清：违规时内容已经显示过（然后这一步失败），不像缓冲路径那样从未离开网关。
   * `warn` 不扣终止帧、不拒，只记录 —— 于是它也重获流式。
   *
   * 收尾必须是 `controller.error()`，不能改成 TransformStream 里 `flush` 时 `throw`：那样
   * 抛出的异常走流内部的收尾算法，消费者没同时在读时就成了**未捕获异常**，会把宿主进程
   * 带走。手动 ReadableStream 的 `pull` 天然按背压取数，错误也只落在流的读取端。
   *
   * 取消（用户按停止）不是违规：上游 body 会先报错，裁决根本不会发生，所以不会污染
   * `blocked` 计数。
   *
   * `pre` 是自动重试（0.10.0）的接缝：{@link sendVerified} 的早期取证可能已经读走了流的
   * 头几个字节（并把 reader 锁住），通过这里移交 —— `pending` 先垫上已读字节，`reader`
   * 复用同一个（body 已锁，不能再次 `getReader()`）。已垫的字节会照常走 `note()` 与逐帧
   * 转发，证据去重靠 `seen*` 集合，不会重复计数。不传（默认 null）就是从零开始，行为与
   * 0.9.x 逐字一致。
   *
   * @param response - 上游 2xx SSE 响应。
   * @param allowed - 允许的渠道列表。
   * @param url - 请求 URL（记录用）。
   * @param expectedProviders - 允许的 provider 列表（provider 钉的证据面；空 = 不查）。
   * @param pre - 早期取证移交的 `{ pending, reader }`；不传 = 从零开始。
   * @returns 逐帧放行、按裁决收尾的响应。
   */
  function streamedVerification(response, allowed, url, signal, expectedProviders = [], pre = null, model = null, sessionId = null) {
    // 错误文案与状态文件里的「允许列表」：provider 钉在场时把两侧的期望一起说清。
    const expected = expectedList(allowed, expectedProviders)
    const holdTerminator = cfg.enforcement === 'strict'
    /** 保留的 routing 处数上界：正常响应只有一处，超界按「无法证明」处理。 */
    const MAX_ROUTINGS = 64
    /** 顶层 provider 个数上界：直通形状每帧同值（去重后 1 个），超界按「无法证明」处理。 */
    const MAX_PROVIDERS = 64
    const decoder = new TextDecoder()
    let reader = null
    let pending = pre?.pending ?? new Uint8Array(0)
    const routings = []
    const seenRouting = new Set()
    let routingOverflow = false
    const providers = []
    const seenProvider = new Set()
    let providerOverflow = false
    let sourceEnded = false
    let concluded = false
    let cancelled = false

    /** 按背压向上游要字节；第一次真正要数据时才把 body 锁成 reader（早期取证可能已锁）。 */
    const source = () => (reader ??= pre?.reader ?? response.body.getReader())
    /**
     * 记下这一帧里出现的**每一处** routing（按内容去重）。
     *
     * 去重只挡完全相同的重复；一个渠道仍能造出无数个各不相同的 routing 对象，而这是整个
     * 响应里唯一会随长度增长的内存。上界取得很宽松（正常响应只有一处），超界就按「无法证明」
     * 处理（见 conclude），不再继续攒。
     */
    const note = (frame) => {
      // 两种证据都要在这一帧里收齐：TextDecoder 是有状态的（跨帧的多字节切分靠它），
      // 一帧只解码一次，routing 与 provider 各自过闸。
      const text = decoder.decode(frame)
      for (const routing of routingsOfText(text)) {
        const key = JSON.stringify(routing)
        if (seenRouting.has(key)) continue
        if (seenRouting.size >= MAX_ROUTINGS) {
          routingOverflow = true
          continue
        }
        seenRouting.add(key)
        routings.push(routing)
      }
      for (const provider of providersOfText(text)) {
        if (seenProvider.has(provider)) continue
        if (seenProvider.size >= MAX_PROVIDERS) {
          providerOverflow = true
          continue
        }
        seenProvider.add(provider)
        providers.push(provider)
      }
    }
    /**
     * 收尾：裁决，然后放行扣住的那一帧，或按违规中断响应体。
     *
     * @param controller - 下游流的控制器。
     * @param heldFrame - 被扣住的终止帧（没有终止帧就不传）。
     */
    const conclude = (controller, heldFrame = null) => {
      // 下游已经取消（用户按停止）就没有「收尾」可言：这时候 routing 往往还没到，
      // 硬判会得到一条**假的违规**。取消由 cancel() 记成 unverified。
      if (concluded || cancelled) return
      concluded = true
      // 判决做完了，上游剩下的字节不再需要（消费者也在 [DONE] 处停了）：顺手放掉 socket。
      if (reader !== null) reader.cancel().catch(() => {})
      // 溢出按**在用的证据面**判定：provider 钉在场看 provider 溢出，渠道钉在场看
      // routing 溢出；两者都在场时任一溢出都按无法证明处理。
      const overflows = []
      if (expectedProviders.length > 0 && providerOverflow) {
        overflows.push(`响应里出现了超过 ${MAX_PROVIDERS} 个各不相同的顶层 provider 字段，无法证明它由 ${expectedProviders.join('/')} 提供`)
      }
      if (allowed.length > 0 && routingOverflow) {
        overflows.push(`响应里出现了超过 ${MAX_ROUTINGS} 处各不相同的 routing 元数据，无法证明它由允许的渠道提供`)
      }
      const verdict = overflows.length > 0 ? { ok: false, reason: overflows[0], culprit: null } : judgeEvidence(routings, providers, allowed, expectedProviders)
      if (verdict.ok) {
        recordVerified(url, verdict, expected, model, sessionId)
        if (heldFrame !== null) controller.enqueue(heldFrame)
        controller.close()
        return
      }
      recordViolation(verdict.reason, expected, verdict.culprit ?? null, url)
      if (!holdTerminator) {
        // warn：终止帧早就放行了，这里只需要收尾。
        const actualProv = detectedProviderOf(providers, routings, verdict.culprit)
        const isAnonymized = actualProv === ANONYMIZED_CHANNEL
        if (isAnonymized) counters.anonymized += 1
        const at = new Date().toISOString()
        const warnEntry = {
          at,
          url,
          model,
          sessionId,
          provider: actualProv,
          allowed: [...expected],
          attempts: 1,
          warn: true,
          reason: verdict.reason,
        }
        lastVerified = { ...warnEntry }
        // 同 {@link sendVerified} 的缓冲分支：model 索引必须一起写，否则这个模型
        // 上一次通过的记录会盖住这次的新鲜告警（查询侧的优先级是 session → model
        // → 全局，而 session 级永远是空的）。
        if (sessionId) lastVerifiedBySession.set(String(sessionId), lastVerified)
        if (model) lastVerifiedByModel.set(model, lastVerified)
        if (isAnonymized) lastAnonymized = { at, url, provider: actualProv, model, sessionId }
        publish()
        logger.warn?.('[clinepass] ⚠ 响应由 %s 提供（配置允许 %s），已放行（仅告警）：%s', actualProv || '未知提供方', expected.join('/'), verdict.reason)
        controller.close()
        return
      }
      // 扣住的终止帧就此丢掉：消费者看到的是流中断，而不是一次正常收尾。
      controller.error(refusalError(verdict.reason, expected, verdict.culprit ?? null))
    }
    /**
     * 处理一帧：先读它的每一处 routing，再决定转发还是扣住。
     *
     * `note()` **必须在扣帧之前**：扣住的是「留着待放」的字节，不是丢弃的字节 —— 里面装着
     * routing 而不扫，就等于拿别处的结论替它背书。
     *
     * 终止帧一到就收尾，**不等上游关流**：消费者在 `[DONE]` 处就结束了，等下去只会在
     * 「网关发完却不关连接」时把这一轮吊到空闲超时（实测客户端一直等不到 `[DONE]`）。
     *
     * @param controller - 下游流的控制器。
     * @param frame - 一帧原始字节。
     */
    const emitFrame = (controller, frame) => {
      note(frame)
      if (!isTerminatorFrame(frame)) {
        controller.enqueue(frame)
        return
      }
      if (holdTerminator) conclude(controller, frame)
      else {
        controller.enqueue(frame)
        conclude(controller)
      }
    }

    const body = new ReadableStream({
      async pull(controller) {
        for (;;) {
          // 取消是「消费者不要了」：不能再往上游要数据，也不能再往一个已取消的流里塞。
          if (cancelled) return
          if (pending.length > 0) {
            const end = nextFrameEnd(pending)
            if (end !== -1) {
              const frame = pending.slice(0, end)
              pending = pending.slice(end)
              emitFrame(controller, frame)
              return
            }
            // 上游没发空行就关流：剩下的是最后一帧。
            if (sourceEnded) {
              const frame = pending
              pending = new Uint8Array(0)
              emitFrame(controller, frame)
              return
            }
          } else if (sourceEnded) {
            conclude(controller)
            return
          }
          let chunk
          try {
            chunk = await source().read()
          } catch (error) {
            // 读流失败（用户按停止、socket 断）时**裁决根本不会发生**：渠道没能校验，
            // 而这次已经显示出去的部分内容可能被 dsh 当成「被打断的回复」记进上下文
            // （见 README「中止的流不受保护」）。记一笔，别让它悄悄发生。
            if (!concluded) {
              concluded = true
              const aborted = signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
              recordUnverified(url, aborted ? 'aborted' : 'stream failed', error)
            }
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
        cancelled = true
        // 消费者不要这条流了（dsh 中止、或自己 break）：渠道没校验成，记 unverified ——
        // 但**不是违规**。这也是「中止的流不受保护」那条限制在状态文件里的痕迹。
        if (!concluded) {
          concluded = true
          recordUnverified(url, signal?.aborted === true ? 'aborted' : 'cancelled', reason)
        }
        // reader 还没建就直接取消源；建了就只能经 reader 取消（body 已被锁住）。
        const target = reader ?? pre?.reader ?? response.body
        target.cancel(reason).catch(() => {})
      },
    })
    const headers = new Headers(response.headers)
    // 正文已经过 fetch 解码；重建后不能再让下游按这两个头处理一遍。
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }
  /** 记一次校验通过，并立刻落盘（状态文件里的 lastVerified 不该慢一拍）。 */
  function recordVerified(url, verdict, allowed, model = null, sessionId = null) {
    lastVerified = {
      at: new Date().toISOString(),
      url,
      model,
      sessionId,
      provider: verdict.provider,
      allowed: [...allowed],
      attempts: verdict.attempts,
    }
    if (sessionId) lastVerifiedBySession.set(sessionId, lastVerified)
    if (model) lastVerifiedByModel.set(model, lastVerified)
    // 0.11.1：匿名渠道单独计数 —— 「今天的请求有多少走了被匿名的渠道」是这次行为变更
    // 之后最有用的一格，跟 pinned/blocked 一样一眼可读。
    if (verdict.provider === ANONYMIZED_CHANNEL) {
      counters.anonymized += 1
      lastAnonymized = { at: lastVerified.at, url, provider: verdict.provider, model, sessionId }
    }
    logger.info?.('[clinepass] ✓ %s 由 %s 提供（允许 %s），已放行', url, verdict.provider, allowed.join(', '))
    // 校验发生在响应到达之后，而请求发起时的那次 publish() 早于它 —— 不补这一次，
    // 状态文件里的 lastVerified 会永远慢一拍。
    publish()
  }

  const wrapper = function pinnedFetch(input, init) {
    // Only reachable through `globalThis.fetch`, which is only replaced once
    // `original` is set; the guard keeps a hand-driven call readable.
    if (original === null) throw new Error('dsh-clinepass: the pin hook was called before it was installed')
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
    return rewrite(input, init).then(
      (next) => {
        if (next.kind === 'skip') {
          // 唯一的 skipped 计数与落盘处：状态文件里的 lastSkipped 正是「seen 涨、pinned 不涨」
          // 时要看的那条原因（日志行是附带的，宿主的 logger 不一定显示给用户）。
          counters.skipped += 1
          lastSkipped = { at: new Date().toISOString(), url, reason: next.reason }
          publish()
          logger.warn?.('[clinepass] not pinning request #%s: %s', counters.seen, next.reason)
          return passThrough(input, init)
        }
        function extractSessionId(reqInput, reqInit) {
          const readHeader = (bag, name) => {
            if (!bag) return null
            if (typeof bag.get === 'function') return bag.get(name)
            if (typeof bag === 'object') {
              const target = name.toLowerCase()
              for (const [k, v] of Object.entries(bag)) {
                if (k.toLowerCase() === target) return typeof v === 'string' ? v : String(v)
              }
            }
            return null
          }
          return (
            readHeader(reqInit?.headers, 'x-session-id') ||
            readHeader(reqInit?.headers, 'x-dsh-session-id') ||
            readHeader(reqInit?.headers, 'session-id') ||
            readHeader(reqInit?.headers, 'x-client-request-id') ||
            (typeof reqInput === 'object' && reqInput !== null ? readHeader(reqInput.headers, 'x-session-id') : null) ||
            (typeof reqInput === 'object' && reqInput !== null ? readHeader(reqInput.headers, 'x-dsh-session-id') : null) ||
            null
          )
        }
        const sessionId = extractSessionId(input, init)
        // 自动重试（0.10.0）：rewrite 为每种请求形状准备好 `resend(attempt)` 重发闭包，
        // 三种形状共用一条「发送 → 校验 → 失败补发」的路径。首次发送也走 resend(0)，
        // 保证重试与首发**逐字同参**。
        const resendCall = (attempt) => {
          const [one, two] = next.resend(attempt)
          // passThrough 可能同步返回 Response（测试桩、手装 fetch 都有这种形状），
          // Promise.resolve 抹平 —— 与调用方 await 两侧的兼容语义一致。
          return Promise.resolve(passThrough(one, two))
        }
        if (next.kind === 'provider') {
          // provider 级钉选的兜底路径（slug 推不出，请求线没得注入）：没有渠道可注入
          // （pins: []），但响应必须用 wire 顶层的 provider 字段自证。请求按**原参**发
          // （body 一字不动）；计数单列 —— 既不是 pinned（没注入），也不是 skipped（响应仍受闸管）。
          const expect = next.next.expect ?? []
          counters.providerPinned += 1
          lastProviderPin = { at: new Date().toISOString(), url, model: next.next.model, expect }
          publish()
          logger.info?.(
            '[clinepass] → #%s POST %s provider-pinned to %s (model %s, in-process)',
            String(counters.seen).padStart(3, '0'),
            url,
            expect.join(', '),
            next.next.model ?? '?',
          )
          if (cfg.enforcement === 'off' || expect.length === 0) return resendCall(0)
          const signal = init?.signal ?? input?.signal
          return sendVerified(resendCall, [], url, signal, expect, 0, next.next.model, sessionId)
        }
        const expect = next.next.expect ?? []
        const only = next.next.only ?? []
        const signal = next.kind === 'request' ? next.request.signal : (next.init.signal ?? input?.signal)
        if (expect.length > 0 && only.length === 0) {
          // provider 级钉选（0.11.0 起连请求线一起钉：wire 顶层 provider.order）：证据面
          // 仍是 wire 顶层的 provider 字段，所以计数单列 —— 不进 pinned（那是渠道钉，
          // 看 routing 元数据），也不是 skipped（响应受闸管）。order 记进状态文件，
          // 「配置写的是 z.ai、请求线上发的是 z-ai」在对数时一目了然。
          counters.providerPinned += 1
          lastProviderPin = {
            at: new Date().toISOString(),
            url,
            model: next.next.model,
            expect,
            order: next.next.order ?? [],
          }
          publish()
          logger.info?.(
            '[clinepass] → #%s POST %s provider-pinned to %s (wire order: %s, model %s, in-process)',
            String(counters.seen).padStart(3, '0'),
            url,
            expect.join(', '),
            (next.next.order ?? []).join(', ') || 'absent',
            next.next.model ?? '?',
          )
        } else {
          counters.pinned += 1
          lastPin = { at: new Date().toISOString(), url, model: next.next.model, only }
          publish()
          report(url, next.next)
        }
        // 校验只对「带着钉选要求的 chat 请求」有意义：两侧都空表示用户没要求钉选（走到
        // 这里不可能 —— 要么注入了 only，要么带 expect，要么早在 rewrite 就 skip 了）。
        if (cfg.enforcement === 'off' || (only.length === 0 && expect.length === 0)) return resendCall(0)
        return sendVerified(resendCall, only, url, signal, expect, 0, next.next.model, sessionId)
      },
      (error) => {
        counters.skipped += 1
        lastSkipped = {
          at: new Date().toISOString(),
          url,
          reason: `pin hook failed: ${error instanceof Error ? error.message : String(error)}`,
        }
        publish()
        logger.warn?.(
          '[clinepass] ✗ pin hook failed (%s); sending the request unpinned',
          error instanceof Error ? error.message : String(error),
        )
        return passThrough(input, init)
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
   * Without this, a hook that was quietly unhooked would leave the status file
   * reading `installed` forever — exactly the silent failure the file exists to
   * expose. Three things it deliberately does *not* do: warn more than once for
   * the same replacement (this runs every 30 s for the life of the process),
   * keep claiming `foreign` after ownership comes back, and call a native fetch
   * that someone restored "foreign" — a newer instance of this plugin standing
   * down is not a bypass.
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
      if (observed === 'foreign') logger.warn?.('[clinepass] globalThis.fetch is no longer the pin hook; requests are going out unpinned')
    }
    return observed
  }

  return {
    config: cfg,
    counters,
    profileBaseURL,
    /**
     * 当前校验状态的一份快照（冒烟测试与排查用；status 文件写的是同一批字段）。
     *
     * @returns `{ counters, enforcement, provision, provisionReason, lastPin, lastProviderPin, lastVerified, lastViolation, lastUnverified, lastSkipped }`。
     */
    state: () => ({
      counters: { ...counters },
      enforcement: cfg.enforcement,
      provision,
      provisionReason,
      lastPin,
      lastProviderPin,
      lastVerified,
      lastAnonymized,
      lastViolation,
      violations: [...violations],
      lastUnverified,
      lastSkipped,
      lastRequestShape,
    }),
    verifiedBySession: (sid) => (sid ? lastVerifiedBySession.get(sid) : undefined),
    verifiedByModel: (m) => (m ? lastVerifiedByModel.get(m) : undefined),
    /** Re-check whether the hook still owns `globalThis.fetch` (also runs on a timer). */
    checkOwnership,
    /**
     * Replace `globalThis.fetch` with the hook.
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
        logger.error?.('[clinepass] there is no global fetch to hook; the pin cannot be injected')
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
     * 的地方（README「验证」一节记了这条），所以同一个结论也落进状态文件。
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
          // The level ids this route offers and the `reasoning_effort` each one
          // dispatches: exactly `high` and `max`.
          reasoningEfforts: { ...EFFORT_MAP },
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

    // Bring the model entry up to date — the declared levels (a new level, or a
    // wire spelling fix, has to reach installs that already have this card) and
    // the advertised capacity — without dropping anything else the entry
    // declares. Ids this plugin retired are dropped so the composer lists what
    // the route actually serves today.
    let nextModels = models
    if (at === -1) nextModels = [...models, ourModel]
    else {
      const declared = isPlainObject(models[at].reasoningEfforts) ? models[at].reasoningEfforts : {}
      const kept = Object.fromEntries(Object.entries(declared).filter(([id]) => !(id in RETIRED_EFFORTS)))
      const merged = { ...kept, ...ourModel.reasoningEfforts }
      const entry = { ...models[at] }
      let changed = false
      if (!sameEntries(declared, merged)) {
        entry.reasoningEfforts = merged
        changed = true
      }
      for (const field of ['contextWindow', 'maxTokens']) {
        if (entry[field] !== ourModel[field]) {
          entry[field] = ourModel[field]
          changed = true
        }
      }
      if (changed) nextModels = models.map((candidate, index) => (index === at ? entry : candidate))
    }

    const addressSame = existing.baseURL === profile.baseURL
    const levelsSame = nextModels === models
    const displaySame = existing.displayName === profile.displayName
    if (addressSame && levelsSame && displaySame) return 'present'
    if (!ours) {
      // A card this plugin did not write is left alone — with one exception. An
      // address on loopback is the footprint of the transport this plugin used
      // to offer, nothing listens there any more, and a card pointing at it pins
      // nothing at all: repair exactly that, and say so.
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
        `the "${cfg.provider}" provider profile is not the one this plugin wrote (api/apiKeyEnv differ), so it is left alone; it points at ${String(existing.baseURL)}, not ${profile.baseURL} — fix it on Settings → Models or requests will bypass the pin`,
      )
      logger.warn?.(
        '[clinepass] the "%s" provider profile is not the one this plugin wrote (api/apiKeyEnv differ), so it is left alone; it points at %s, not %s — fix it on Settings → Models or requests will bypass the pin',
        cfg.provider,
        String(existing.baseURL),
        profile.baseURL,
      )
      return 'mismatch'
    }
    const ops = []
    if (!addressSame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'baseURL'], value: profile.baseURL })
    if (!displaySame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'displayName'], value: profile.displayName })
    if (!levelsSame) ops.push({ op: 'set', path: ['providers', cfg.provider, 'models'], value: nextModels })
    await settings.mutate(PROFILE_NS, ops, revision())
    const repaired = [!addressSame ? `address → ${profile.baseURL}` : null, !displaySame ? 'display name' : null, !levelsSame ? 'model entry' : null].filter(Boolean).join(', ')
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
 * Install the in-process pin hook and provision the provider profile.
 *
 * The settings seam is required: provisioning must finish before the first turn
 * resolves the model, and awaiting it here is what makes the provider card exist
 * by the time dsh starts serving.
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
    // A typo here would otherwise mean "the pin never matches anything" *and* a
    // broken address written into the card, which is exactly the kind of silence
    // this plugin is supposed to avoid. Leave everything alone and say so.
    logger.error?.('[clinepass] upstream "%s" is not a URL; nothing was installed or provisioned', cfg.upstream)
    return
  }
  for (const [model, channels] of Object.entries(cfg.pins ?? {})) {
    if (Array.isArray(channels) && channels.length === 0 && (cfg.pin ?? []).length > 0) {
      const expected = cfg.providerPins?.[model]
      if (Array.isArray(expected) && expected.length > 0) {
        // 有意的直通 + provider 级钉选：请求不动，响应由 wire 顶层的 provider 字段裁决。
        logger.info?.(
          '[clinepass] pins["%s"] is empty on purpose: the model is provider-pinned to %s — requests go out unmodified, responses are verified against the wire provider field',
          model,
          expected.join(', '),
        )
        continue
      }
      logger.warn?.(
        '[clinepass] pins["%s"] is empty, so requests for that model go out unpinned even though pin is %s',
        model,
        JSON.stringify(cfg.pin),
      )
    }
  }

  // Registered only once the address is known to be usable: a misconfigured
  // plugin should change nothing at all, prompt included.
  if (cfg.plainModelId) installPromptDisplay(ctx, cfg)

  const hook = createFetchPin(cfg, logger)
  status = hook.install()
  if (status === 'installed') {
    ctx.effect?.(() => () => {
      hook.uninstall()
    })
  } else {
    logger.error?.(
      '[clinepass] could not hook the global fetch, so requests would go out unpinned. Something replaced globalThis.fetch before this plugin loaded.',
    )
  }

  // 登记结果先落一个 `pending`：状态文件里「还没跑」和「跑失败了」从此长得不一样。
  let provision = 'pending'
  let provisionReason = null
  const publishProvision = () => hook.noteProvision(provision, provisionReason)
  const provisionWith = async (settings) => {
    try {
      provision = await provisionProfile(settings, cfg, logger, (reason) => {
        provisionReason = reason
      })
      if (cfg.alignReasoningEffort) await alignReasoningEffort(settings, cfg, logger)
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
  // has neither. It changes nothing about the pin.
  if (cfg.usage) {
    if (typeof ctx.inject !== 'function') {
      // A context double, or a host that predates `ctx.inject`: the pin is
      // unaffected, so this is a warning rather than a failed activation.
      logger.warn?.('[clinepass] this context cannot inject services; the Settings → Models usage card was not mounted')
    } else {
      ctx.inject(['connection', 'credentials'], (routeCtx) => {
        mounted = installUsageRoute(routeCtx, cfg, logger, { hook })
      })
    }
  }

  const providerPinnedModels = Object.entries(cfg.providerPins ?? {})
    .filter(([, expected]) => Array.isArray(expected) && expected.length > 0)
    .map(([model, expected]) => `${model} → ${expected.join('/')}`)
  logger.info?.(
    '[clinepass] route "%s" served by pi-ai via %s; %s; pin %s (profile %s); prompt shows %s%s',
    cfg.provider,
    hook.profileBaseURL(),
    status === 'installed' ? 'pin injected in-process, no listener' : `hook ${status}`,
    (cfg.pin ?? []).join(', ') || '(nothing)',
    provision,
    cfg.plainModelId ? `${withoutRoutePrefix(cfg.provider, cfg.model)} (no route prefix)` : 'the configured model id',
    providerPinnedModels.length > 0 ? `; provider-pinned: ${providerPinnedModels.join(', ')}` : '',
  )
}
