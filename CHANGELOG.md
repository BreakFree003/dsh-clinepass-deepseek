# Changelog

## 0.12.6

**补记两个模型的 API 行为对照（文档，无代码变更）。**

- README 新增「两个模型的 API 行为对照（2026-10-19 实测）」：普通对话、`reasoning_effort`
  （high/max/low）、OpenAI tools、图片输入、会话中途 system、`max_tokens` 200k/400k 两个模型都
  200（能力面一致）；差异集中在回显 slug、fallback 池（18 vs 14）、`only` 是否执行（别名忽略 /
  1017 执行且有硬钉能力），以及卡片 maxTokens 不参与网关校验。
- 明确记录：落点由网关 affinity 漂移，未钉的 1017 也可能落到 pareto/fireworks；只有
  `provider_metadata.deepseek.systemFingerprint` 能证明上游（两者均为 `e72d3c7f…`）。
- `clinepass-deepseek-audit/README.md` §十四 收录原始矩阵与采样；升级说明 §6.4 加交叉引用。
- `index.js` / `client.js` / 卡片数据与 0.12.5 逐字节相同。

## 0.12.5

**随包卡片与安装器补上 `cline-pass/deepseek-v4.1-flash-1017`：下载即可选，不依赖本机 profile。**

- 0.12.4 的 README 讲了 1017 的钉选，但随包的 `cordis.patch.yml` 与 `install.mjs` 只声明稳定别名 ——
  新装的人在选择器里根本看不到 1017，除非自己去抄 profile 行。
- 现在两处卡片都声明两个模型：别名在前（默认）、1017 在后。1017 条目**不带**
  `compat.vercelGatewayRouting`：门禁未打时写它会抛 `PiAiCatalogError`；不钉也能用。
- README 的「可粘贴」YAML 与「网关路由钉选」同步：说明随包行为不 pin、要硬钉需自己声明
  `llm-pi-ai` 行再跑 `patch-gateway-routing.mjs`。
- `test-package.mjs` 断言随包卡片同时包含两个模型 id。

## 0.12.4

**新增 `patch-gateway-routing.mjs`：把 1017 快照的「硬钉第一方 DeepSeek」做成可巡检的一步。**

- 背景：`cline-pass/deepseek-v4.1-flash-1017` 这条日期快照没有服务端
  `model_properties_override.providerOptions.gateway.order`，网关会执行
  `providerOptions.gateway.only`；稳定别名则相反（`only` 被忽略，落点由服务端 order 决定）。
  要在 1017 上钉 DeepSeek，profile 需写 `compat.vercelGatewayRouting.only: [deepseek]`，
  而 `@deepseek-ai/dsh-llm-pi-ai` 的 `COMPLETIONS_COMPAT_GATE` 默认把
  `vercelGatewayRouting` 标成 `withhold`，不补门禁配置加载会抛 `PiAiCatalogError`。
- 脚本只改 `lib/index.js` 里 `vercelGatewayRouting: "withhold"` 这一行（→ `"offer"`），
  锚点必须恰好出现一次；三种模式与 `patch-inhistory.mjs` 一致：`--check`（0=active /
  1=未生效或不一致 / 2=锚点漂移）、默认幂等应用并自动备份、`--revert`
  （YAML 的 pin 还在用 `vercelGatewayRouting` 时拒绝，`--force` 才还原）。
- 与 in-history 相同有启动依赖：升级/重装把补丁冲掉后，YAML 的 pin 会让配置加载直接失败 ——
  升级后先 `--check` 再起服务。
- README 新增「网关路由钉选（1017 快照专用）」一节；「迁移」与「验证」改成按模型区分的实测结论
  （别名的 `only` 无效、1017 的 `only` 是硬钉；`--negative` 只对别名成立）。
- `package.json` 的 `files` 把脚本包进发布物。

## 0.12.3

**新增 `patch-inhistory.mjs`：把 cline-pass 的 in-history 开关做成可巡检的一步。**

- 背景：`@deepseek-ai/dsh-llm-pi-ai` 的 `COMPLETIONS_COMPAT_GATE` 默认把
  `supportsMidConvoSystemMessages` 标成 `withhold`，profile 里直接声明会抛
  `PiAiCatalogError: not configurable here`。本机要开只能改 `node_modules` 那一行，
  而升级/重装会把它冲掉。
- 脚本三种模式：
  - `--check`：同时检查「门禁补丁 + profile compat 位」。0 = 整套在位；
    1 = 未生效或不一致（门禁 withheld 而 profile 位还开着时明确报 `BROKEN`，提示下次启动会失败）；
    2 = 上游锚点漂移（拒绝写入）。
  - 默认：幂等打补丁，自动备份；profile 位缺失时给出提示但不改 YAML。
  - `--revert`：profile 位还开着时**拒绝**执行（exit 3），避免自己制造启动失败；
    `--force` 才还原。
- 锚点要求 `COMPLETIONS_COMPAT_GATE` 的那对行恰好出现一次，上游改形状时直接报错。
- README 新增「in-history system 快照（配套 profile 补丁）」一节，说明为什么不能做成运行时行为。
- `package.json` 的 `files` 把脚本包进发布物。
- **代码未变**：`index.js` / `client.js` 与 0.12.2 逐字节相同。

## 0.12.2

**恢复 persona 里的裸模型 id 显示** —— 0.12.0 把它连同请求侧的钉选一起删掉了，那是误删：
这段代码与请求改写无关，删掉后上下文里会显示 `cline-pass/deepseek-v4.1-flash`，而每个第一方
路由显示的都是裸 id（随包的 `deepseek` 路由声明 `deepseek-v4-flash`）。现在 persona 又读作
`You are a coding agent powered by the deepseek-v4.1-flash model.`，与官方部署一致；
`plainModelId: false` 可以关掉它（关掉后启动行会说明显示的是配置里的完整 id）。

为什么必须带前缀、又为什么只能改模板：

- **前缀是 wire 要求**：Cline 网关要 `type/model`（裸 id 报
  `invalid model format. Expected format: modelType/model`），而 dsh 把目录 id 原样发给
  wire —— 所以前缀只能留在请求体里，问题是 `{{model}}` 会把它渲染进 persona。
- **不能改目录 id**：老会话的 `model/selection` 与 `request/header` 记的是带前缀的 id，
  `dsh-llm-pi-ai` 用目录解析选择 —— 改名会让它们报 `UNKNOWN_MODEL`，直到每个会话重新选模型。
- **不能重注册 `model` 变量**：`@deepseek-ai/dsh-agent` 的 `installModelSelection` 在每个内层
  listener 返回之后都会用会话的当前选择覆写 `variables.provider` / `variables.model`，什么注册
  都活不过它。
- **不能直接改 `variables.model`**：`@deepseek-ai/dsh-session-reference` 会快照
  `assembly.variables` 来估算引用预算，解析不了的 id 会让预算静默回落到默认值。
- 所以改写落在**还没渲染的 persona 模板**上（`{{…}}` 在 `renderPrompt` 里才解析）：只把
  `{{model}}` 这个 token 换成裸 id，同一段里的其它变量照常，`variables` 一个字节不改。
  listener 用 `{ prepend: true }` 挂在 `installModelSelection` **外层**，才能看到下一个请求
  真正会用的模型（包括本插件挂载前就已存在的 agent）。
- **契约风险**：这条依赖 dsh 的内部形状 —— 事件名 `system-prompt/assemble`、assembly 的
  `{sections:[{name,text,interpolate?}], variables}`、段名
  `deployment:persona-prefix` / `deployment:persona-suffix`。dsh 升级后要复查（README
  「升级 dsh 后要复查的提示词契约」有清单）；形状对不上时**原样返回**，绝不改坏提示词。
- 测试：`test-fetch.mjs` §14（17 条，从 0.11.4 的 §12 原样移植）与时序化的 apply 断言
  （注册 / prepend / 启动行文案 / `plainModelId: false` 不注册）。`withDefaults` 里
  `plainModelId` 不再是「被丢弃的遗留键」，默认 `true`。

## 0.12.1

**随包写下的 provider 卡片补上 `reasoning: high`** —— 就是让模型选择器里不再出现
「Provider default」那一项的那一行。`index.js` 未动。

- 选择器的档位表只在模型目录没有 `defaultEffort` 时才插入「Provider default / 跟随
  Provider」条目，而 `defaultEffort` 只来自 provider profile 的 `reasoning` 字段。随包
  `cordis.patch.yml` 与 `install.mjs` 写下的静态卡片此前没声明它，于是**新装的人**选择器里
  会多出这一项（本机是自己手写的 profile 行，补上后已验证目录变成
  `efforts: [High, Max], defaultEffort: "high"`）。
- 现在两处都带 `reasoning: high`：选择器只剩 **High / Max** 且默认选中 **High**；未显式选档
  的会话也会以 `reasoning_effort=high` 发出。写的档位必须是模型声明过的（下面
  `reasoningEfforts` 里的 `high` / `max`），否则请求报 `UNSUPPORTED_REASONING_EFFORT`。
- **自己写 `llm-pi-ai` 行的人注意**：patch 行是**整行替换 config、不合并**，所以请把
  `reasoning: high` 与 `reasoningEfforts: {high, max}` 一起写进你那行（README 里有可粘贴的
  整段）。
- 已知边界：运行时 `provisionProfile()` **仍然不写也不改档位**（只对齐 `contextWindow` /
  `maxTokens`），所以「没有 patch 行、只靠运行时登记」的 profile 依旧会看到那个
  `Provider default` —— 那种装法本来就要自己写 `llm-pi-ai` 行。

## 0.12.0

**插件只剩两件事：观察真实 Provider、画 Cline Pass 用量卡。** 这是一个删减版本，不是
增量版本：请求侧的钉选/门禁/重试整块拿掉了，因为它们在 2026-10-16 已经无事可做 ——
`cline-pass/deepseek-v4.1-flash` 由订阅路由**第一方**直连 deepseek 提供（
`system_fingerprint` 与官方 `api.deepseek.com` 逐字相同、64 块对齐的 prefix cache 记账、
UUID 形状的 provider id），本地钉选改变不了任何结果；剩下的只是每次请求多一段
`providerOptions.gateway.only` 装饰，和一份需要维护的判定/重试代码。

删了什么（以及为什么不再需要）：

- **请求改写**：`withPin` / `pinnedBody` / `withProviderOrder` / `pinFor` /
  `providerPinFor` / `providerSlug` / `NOTHING_TO_PIN`，以及 `rewrite()` 的整个 pin
  分支。网关自 2026-09-22 起不执行 `providerOptions.gateway.only`；钉真渠道、钉假渠道、
  完全不钉，响应体逐字相同。现在 wrapper 是**纯观察者**：input/init/headers/body 一个
  字节都不改，不重试，不拦，不另发请求。
- **裁决与门禁**：`judgeRouting(s)` / `judgeProviders` / `judgeEvidence` /
  `earlyVerdict` / `offenderOf` / `displayableChannel` / `expectedList` /
  `CHANNEL_SLUG` / `CHANNEL_RISKY`、`enforcement`（strict/warn/off）、自动重试
  （`retries`）、`violations` / `lastViolation` / `lastUnverified` / `lastSkipped` /
  `lastRequestShape`，以及 `blocked`/`retried`/`pinned`/`providerPinned`/`unverified`
  计数器。没有「允许列表」就没有可判的违规，也就没有需要 fail-closed 的东西；订阅路由
  今天返回的渠道名是真实的（`deepseek`）或匿名标签（`openai-compatible-private`），
  两者都只是**要显示的事实**，不是要处置的错误。
- **配置键**：`pin` / `pins` / `providerPins` / `enforcement` / `retries`。观察没有可
  配置的行为。旧行照常加载：这些键被忽略并记录进状态文件的 `ignoredOptions`（不刷警告，
  否则每一行遗留配置都会在每次启动时叫一次）。
- **prompt 改写**：`installPromptDisplay` / `PERSONA_SECTIONS` / `withoutRoutePrefix`
  与 `plainModelId`。persona 里的 `cline-pass/` 前缀显示问题已不再由插件处理。
- **effort 改写**：`EFFORT_LEVELS` / `EFFORT_MAP` / `RETIRED_EFFORTS` /
  `alignReasoningEffort`。插件不再写 `agent-default-model.reasoningEffort`（effort 由
  profile 补丁显式给 `high`），也不再往 provider 卡片上写 `reasoningEfforts` —— 卡片
  上现有的档位声明原样保留，插件不再碰它。
- **客户端门禁文案**：胶囊里 warn/reason/⚠️ 那一套分支与文案。

还剩什么（行为不许退化的部分）：

- `createFetchPin` → **`createFetchObserver(config, logger)`**。计数器收敛为
  `{ seen, verified, anonymized, unknown }`：观察到的 chat 请求 / 读出了真实 provider /
  真实 provider 是匿名标签 / 响应里根本没有 provider 元数据。传输失败与取消的流只计
  `seen` —— 没有观测到结论，也就没有可归因的答案。
- 状态文件（同路径、同 tmp+rename 原子写）：
  `{ service, transport, hook, provision, provisionReason, upstream, profileBaseURL,
  counters, lastVerified, lastAnonymized, ignoredOptions, pid, at }`，
  `lastVerified = { at, url, provider, model, sessionId, anonymized }`，按
  session → model 两级记忆。
- `?status=1` 返回 `{ ok: true, provider, anonymized, model, sessionId, at }`；还没观测到
  任何东西时返回 `{ ok: false, reason: 'no-observation' }`（胶囊显示 `Provider: --`）。
- provider 解析沿用实测有效的那套：routing 元数据（`finalProvider` →
  `resolvedProvider` → `affinity.pinnedProvider` → 成功过的 `providerAttempts[].provider`）
  → wire 顶层 `provider` 字段 → `provider_metadata.<x>` 命名空间键（最后一条线索）。
- 逐帧转发：SSE 响应由 pass-through 流承载，`pull` 按背压逐帧取、逐帧放，读到终止帧就
  收尾（网关不保证关流）。**没有整包缓冲** —— `checks/dsh-clinepass-buffering-repro.mjs`
  就是钉这件事的。
- 用量链（`normalizeUsage` / `fetchUsage` / `createUsageHandler` / `installUsageRoute`）、
  provider 卡片登记（`llm-pi-ai.providers.cline-pass`）与 `__DSH_CLINEPASS__` 注入不变。

行为变化（值得知道的）：

- 胶囊只显示 provider 名，不再有 ⚠️/原因/reason 字段；匿名渠道仍是告警配色 + 说明性
  tooltip。
- 观察者不会因为响应「由别家提供」而拒绝或重试任何东西 —— 它本来也不会。
- 非流式响应现在**原样返回**（证据从 `clone()` 读），不再被「读完再重建」。

## 0.11.4

Strict review of 0.11.3 found that two of its three headline claims did not hold in
production, and that the dock pill was invisible for the whole life of a page. No
behaviour change beyond these fixes.

- **Fixed: the Provider pill only appeared after a page refresh.** The dock pill
  early-returned (`if (!isClinepass) return null`) **before** its twelve later hooks,
  while a brand-new session's `modelSelection` projection is still
  `{lastUsed:null,next:null}` — so the first render called one hook and the render
  after the first `request/header` called thirteen. React throws `Rendered more hooks
  than during the previous render`, the slot's error boundary replaces that cell with
  `<div data-slot-error>` for the rest of the page's life, and the pill only came back
  on refresh (when the projection replays from the durable log and the first render is
  already consistent). All hooks are now called unconditionally, exactly as `UsageCard`
  next to it always did; the three effects no-op for a foreign model, and the
  `return null` moved below every hook. The polling timers also moved to `window.*`
  (matching `useNow`/`UsageCard`) so the test stand-in can intercept them, and a
  `running → false` re-read is now followed by one delayed re-read so the conclusion
  does not depend on the order between the stream's terminator and `recordVerified`.
- **Fixed: a warn-mode violation was shadowed by the model's previous pass.** Both
  warn branches wrote `lastVerifiedBySession` but not `lastVerifiedByModel`, while
  `?status=1` resolves `session → model → global`. `sessionId` is always `null` (dsh
  sends no session header upstream — see the next bullet), so the model index is the
  only level that can match, and a stale pass entry for that model won: the pill showed
  "normal" for every violation after the first one per model per process. Both branches
  now mirror `recordVerified` (model index + `lastAnonymized`).
- **Removed: the 0.11.1/0.11.2 anonymized-channel notice.** `6e0acdc` deleted the call
  site but left `withAnonymousNotice` (61 lines), `ANONYMIZED_NOTICE`, the `notice`
  field `pinnedBody` still computed and returned, and `isConversationStart` feeding it.
  All removed. `lastRequestShape` diagnostics stay (they do not depend on the notice).
- **Corrected claims in the 0.11.3 entry below** (kept verbatim as the historical
  record): "recorded in session state (`lastVerifiedBySession` with `warn: true`)"
  never happened — `sessionId` is always `null`, because dsh's upstream LLM requests
  carry only `user-agent` (`attributionHeaders()` in `dsh-llm`); the per-session index,
  `verifiedBySession`, and the pill's `sessionId` query parameter are therefore dead
  weight on this machine. "anonymized channels display a warning badge (⚠️)" — the ⚠️
  suffix is only appended when `warn` is true, and an anonymized channel that is on the
  allow list reports `warn: false`, so the badge never showed for the case it names.
  "updating dynamically as API responses complete" — see the first bullet.
- **Docs:** README, the bundle patch and the profile patch no longer promise the
  notice; `smoke-test.mjs` asserted that notice was present (a live-network test that
  `npm test` does not run) and now asserts the opposite — pure gateway content.
- **Tests:** the client stand-in now enforces the rules of hooks (`endRender` compares
  the hook count against the previous render), which is what let this ship; the dock
  case renders foreign → cline-pass on one mount (the crashing transition) and now
  passes `useSession`, so the polling path is covered; `test-fetch.mjs` §18 is a
  regression test for the warn shadowing (red before the fix, green after).

## 0.11.3

Dynamic Provider display in bottom composer dock and non-blocking Provider warnings:

- **Non-blocking Provider validation (allow all Providers, warn-only):**
  When configured with `enforcement: warn` (or when gateway routes to rotated providers like Together/InferenceNet), responses are never blocked or aborted. All providers are allowed through. The actual wire provider is captured, recorded in session state (`lastVerifiedBySession` with `warn: true`), and reported in `logger.warn` without throwing errors.
- **Real-time Provider pill & warning indicator in composer dock:**
  Registered `conversation.composer.dock` slot component (`clinepass-provider`, order 2) to display the actual upstream provider returned by the gateway at the bottom status bar, updating dynamically as API responses complete. Unexpected/foreign providers and anonymized channels display a warning badge (`⚠️`) with explanatory tooltips.
- **Clean conversation stream (no context pollution):** Removed synthetic notice
  chunk injection from the SSE stream so assistant replies remain 100% genuine model
  content without prepending notices into conversation history or prompt context.
- **In-memory status query:** Handled `?status=1` on `usageRoute` to serve
  in-memory verification state per session/model (including `warn` and `reason`) without touching credentials or gateway.
- **`max_completion_tokens` compatibility & request diagnostics:** Recognises
  `max_completion_tokens` alongside `max_tokens` for `@deepseek-ai/dsh-llm-pi-ai`
  runtime shapes, and records `lastRequestShape` diagnostics.
- **Fixed `ReferenceError: lastRequestShape is not defined`:** Scoped request shape
  variables cleanly in `pinnedBody` and passed through to `rewrite`.

## 0.11.2

The anonymized-channel notice never fired in a real conversation. Diagnosed
from the live status file the morning after 0.11.1 shipped:

- **`counters.anonymized` incremented; no notice appeared.** The first real
  dsh conversation (Playground, 08:38) verified private-channel responses and
  the reply carried no `⚠️` frame. Root cause: the 0.11.1 trigger counted
  "exactly one non-system message", but dsh's context plugins (time-context)
  inject snapshots as *extra user messages* into the same request — the real
  first wire shape is `[system, user, user(time-context)]`, count 2, so the
  condition never held. The 0.11.1 live check passed because it hand-built a
  single-user-message body: the blind spot was the request shape, not the
  injection.
- **The trigger is now three conjunctive checks** (`isConversationStart`):
  `stream === true`, no `assistant` message in the history (turn-1 step-2
  onwards necessarily has one, so the notice cannot repeat), and
  `max_tokens > 8192`. The budget guard keeps the session-title call out —
  it streams from the same route with no assistant history, and its output
  *becomes* the title, where a notice frame would be fatal. dsh-base
  configures the title call at 4096; agent requests run at 384000 (two
  orders of magnitude apart).
- **Tests**: §17 gains the real first-turn wire shape as a regression case
  and a title-shaped negative; the smoke test's notice request now carries
  the agent budget.

## 0.11.1

The gateway anonymizes the channel; the pin learns the anonymity label. Same
night as 0.11.0, after the response-side gate started refusing every
`cline-pass/deepseek-v4.1-flash` request:

- **What changed upstream.** The `routing` metadata of the fallback-net shape
  (`vmc/deepseek-v4p1-flash-contributor-fallbacks`) no longer names the real
  channel: `finalProvider` / `resolvedProvider` / successful
  `providerAttempts` all read `openai-compatible-private`, and
  `fallbacksAvailable` is empty. With the pin at `[deepseek]` every request was
  therefore a strict-mode refusal — fail closed on the letter of the contract.
- **A weight-identity audit before trusting the label.** Rather than blindly
  allowing the new name, the serving channel was audited against the official
  API: single-token distribution fingerprint at N=200 with permutation tests
  (JSD 0.017, p=0.557 — indistinguishable; a GLM impostor cleanly separates at
  p=0.002), near-tie tie-breaker probes (the divergence resolves to the
  official API's own production noise floor — sub is *sharper*, the opposite
  of the quantization signature), temp-0 determinism, and a prefix-cache
  accounting comparison (token-exact vs 64-block). Verdict: a low-noise
  redeployment of genuine DeepSeek V4.1 Flash weights, contributor data tier,
  no ZDR. Full evidence: `clinepass-deepseek-audit/` in the dsh workspace.
- **`ANONYMIZED_CHANNEL` (new) and the allowlist.** The channel pin default is
  now `[deepseek, openai-compatible-private]` — the real name stays listed so
  verification resumes automatically if the gateway ever un-anonymizes;
  everything else about the gate (resolvedProvider, successful provider
  attempts, fail-closed on missing evidence) is unchanged. A channel not in
  the list is still refused.
- **`withAnonymousNotice` (new): one warning per conversation.** On the first
  message of a conversation (`messages` minus `system` — exactly one) served
  via the anonymized channel, a synthetic OpenAI chunk frame carrying a short
  warning is prepended to the response stream: the channel is anonymized,
  contributor-tier (data may train future models), no ZDR. Later messages are
  untouched; the notice frame carries no routing/provider fields, so the gate
  scans it like any content frame. Status file gains `counters.anonymized`
  and `lastAnonymized`.
- **Why prepend rather than append:** the request side already knows the shape
  (`pinnedBody` sees the allowlist); the routing evidence only arrives in the
  last frame, when the content has long been delivered.
- **The smoke test follows the wire.** §2 now asserts "served by an allowed
  channel" (the pin list) instead of naming `deepseek`, and expects the notice
  on its first-message request; §4 drops the `fallbacksAvailable > 1` check —
  the anonymized shape offers an empty list.

## 0.11.0

The provider pin moves onto the wire. Third measurement round on
`api.cline.bot` the same day the rotation was diagnosed, 5 requests per
variant, on the direct shape (`cline-pass/glm-5.3-flash`, top-level `provider`
field on every frame, no routing metadata):

- **The gateway honors the OpenRouter top-level `provider` field.** With
  `provider: { order: ["z-ai"], allow_fallbacks: false }` the response came
  back 5/5 `Z.AI`; `only: ["z-ai"]` also 5/5; with no `provider` field at all
  2/5 `Z.AI` (3/5 `Friendli`). The Vercel-style `providerOptions.gateway.only`
  remains ignored for this shape too (morning measurement: 3/9 landed on
  `Together` while carrying it) — the two routing dialects are not treated
  alike, and only the OpenRouter one works.
- **The display name is not a wire slug.** `provider: { only: ["z.ai"] }` —
  the exact spelling `providerPins` configures — gets the connection dropped
  or returns frames without a provider field. The request line speaks slugs:
  `z-ai`.
- **`providerSlug` / `withProviderOrder` (new).** A provider pin now rewrites
  the request body as well: display names are slug-rendered (lower-case,
  punctuation runs folded to `-`, edges trimmed) and written into top-level
  `provider.order` with `allow_fallbacks: false` — unless the request already
  carries a non-empty `order`, which is respected, matching the pi-side guard.
  The channel pin (deepseek, fallback-net shape) is unaffected: the extra
  field provably changes nothing there (measured, routing byte-identical), so
  a model with both lists gets both fields.
- **The response gate stays.** Rotation should now be pinned away at the
  request, but every response is still verified — a stale slug fails closed
  (whole round fails), it can never let a foreign provider through.
- **Auto-retry fix (0.10.0 follow-up).** The retry budget never engaged for
  streams that carry no evidence until the terminator — the exact fallback-net
  shape: the peek condition included `attempt < retries`, so the last attempt
  fell through to the old stream-interrupt path and `retried` stayed 0, while
  test-fetch §15 documented "retry twice, then a 400". `sendVerified` now
  always peeks under strict + provider pin; an exhausted budget ends in a
  buffered 400 for the no-evidence shape (nothing was ever delivered) and
  hands off to streaming for the early-verdict shape (content flows, verdict
  interrupts at the end) — the exact semantics §15 already asserted.
- `lastProviderPin` gains `order` (the slugs actually written); `counters`
  prose/docs updated accordingly.

## 0.10.0

One new capability: **provider-level pinning** (`providerPins`) — a second
evidence surface for models the gateway serves *directly*, without routing
metadata. Plus the measurement that forced it.

- **What the wire actually looks like now (2026-10-14).** `api.cline.bot`
  rotates `cline-pass/glm-5.3-flash` across several upstream providers: same
  model, same echo (`z-ai/glm-5.3-flash`), measured 3/3 `Z.AI` at 17:59,
  5/5 `InferenceNet` at 18:03, and 9/9 `Together` at 18:25 — including 3
  requests that *carried* `gateway.only:["z-ai"]` and were still served by
  Together. Direct-route responses carry a top-level `provider` field on every
  frame and **no** `gateway.routing` metadata; the contributor-fallback shape
  (`model: vmc/…-contributor-fallbacks`) is the exact inverse. The config
  comment claiming "only the Z.AI official route serves this id (3/3)" was a
  sampling-window illusion and has been rewritten.
- **`providerPins` (new config).** For a pass-through model (`pins` configured
  as `[]`) the response must now prove itself through the wire's top-level
  `provider` field: every frame's value is compared case-insensitively against
  the configured allow-list (`judgeProviders` over `providersOfText`, which
  deliberately reads *top-level* keys only — nested
  `providerAttempts[].provider` / `delta.provider` are not direct-route
  evidence). Missing evidence fails closed, exactly like routing metadata
  does: the fallback shape has no provider field, and when it carries routing
  metadata the violation names that channel. Enforcement semantics are shared
  with the channel pin (`strict` refuses — 400 buffered / stream error; `warn`
  records and passes; `off` skips), and a model configured with *both* `pins`
  and `providerPins` must satisfy both (`judgeEvidence`).
- **Request side unchanged, counted separately.** A provider-pinned request is
  sent byte-for-byte as it arrived (nothing to inject), so it is neither
  `pinned` nor `skipped`: new counter `providerPinned`, new status-file fields
  `providerPins` (the resolved config) and `lastProviderPin`
  (`{at, url, model, expect}`). The startup note for an intentionally empty
  per-model channel pin now says so ("provider-pinned to …") instead of
  warning.
- **Not a weights guarantee.** `providerPins` holds the gateway to what *it*
  reports per frame — the only verifiable signal on this wire. With the
  profile pinned to `[z.ai]` alone, turns served by Together/InferenceNet fail
  (that is the point; the deployed cordis.patch.yml documents the accepted
  cost and how to widen the list).
- **Tests.** `test-fetch.mjs` gains §15 (the provider pin: config parsing,
  buffered/streamed verdicts, the risky-name copy gate, fallback-shape
  fail-closed, provider-evidence overflow, warn/off, both-pins coexistence) —
  322 checks. The SSE event-assembly parser is now shared (`sseDocuments`) by
  `routingsOfText` and `providersOfText` with identical behavior. The smoke
  test's live turn is config-aware: it reads the clinepass row's own
  `pins`/`providerPins` and asserts whichever evidence shape the profile
  actually uses (a strict refusal of a foreign provider is asserted as the
  legitimate outcome); §3's "who served it" check accepts the
  no-routing-metadata shape. The `--negative` section still assumes the
  deepseek routing shape and remains an expected-FAIL for the glm profile.

## 0.9.1

One compatibility fix, forced by dsh 0.2.1-alpha.2. The pin itself is unchanged;
what changed is *when* the profile gets provisioned.

- **Provisioning moved out of `apply()`.** `settings.mutate` now goes through
  `dsh-config-editor`'s `edit()`: it takes the profile's `package.json` write
  lock and then calls `reconcileProfilePatches()` — and *that* waits for the
  loader to **settle**. Awaiting it from inside `apply()` is a self-lock: this
  fiber stays `LOADING`, the tree never settles, `appReady` never commits, and
  the Web client's `/api/remote.mux` upgrade route is never registered. The
  visible damage is silent and comes in five parts: a page stuck on
  "Reconnecting" (client console: `[connection] connection lost, retry #N`; the
  upgrade gets an *empty reply*, not a 401), no `dsh web: …?token=` banner in
  the log, a `package.json.lock` held forever by the server (so every
  `dsh plugin` command dies with `atomic-write: timed out waiting for the
  writer lock`), and **no** activation warning anywhere — `--dump-config`, the
  boot graph and every smoke test stay green. Provisioning now runs after
  `ctx.root.loader.await()`; a host with no loader service still gets the old
  inline behavior. `test-fetch.mjs` §10 pins both halves: while the tree is
  still loading `apply()` must have returned and written nothing, and once it
  settles the card is written (the same test fails on 0.9.0).
- Why it bit *here*: `settings.describe()` only lists entries whose fiber is
  already active, so the early read looked like "the card is missing" and forced
  a write on every start. After the tree settles the existing card is seen and
  nothing is written (`provision: "present"`). Note also that `settings.get()`
  no longer exists — it was removed in dsh 0.1.7 — so the `settings.get?.(ns)`
  fallback in `readNamespace()` is dead code on any current host.

## 0.9.0

Two changes to the diagnostics, both driven by one real question that the status
file could not answer: *"the calls that got blocked today — which channel was
each one actually routed to?"* Four of them landed inside two minutes
(2026-09-30 19:33–19:36), the visible error named no channel, and only the last
one survived in `lastViolation`. Every earlier one was unattributable.

- **The refusal message names the filtered channel** — `cline-pass 渠道校验未通过：
  本次响应由 baseten 提供，允许列表是 deepseek。…`. This reverses the old
  "message must contain no dynamic content" rule, but not the reason behind it:
  dsh runs several regex classifiers over error text (retry classification,
  quota, and context overflow — **which triggers compaction**), so a gateway-supplied
  string is attacker-chosen input to a judge. The interpolation therefore goes
  through `displayableChannel()`: only names with a slug shape **and** no
  classifier-triggering word root (`context` / `limit` / `rate` / `timeout` /
  `5xx` / …) reach the message; everything else falls back to a fixed sentence.
  All 16 real channel names pass, so the user sees the channel in practice. The
  test now pins both sides: a normal name *must* appear, hostile names
  (`context_length_exceeded`, `rate_limit`, `channel-500`, …) must not appear
  and must yield byte-identical messages. The raw name still reaches the three
  diagnostic channels that are never classified: `detail`, the status file, and
  the plugin log.
- **`violations`: a bounded (20) history of blocked calls** in the status file,
  each entry `{at, url, allowed, reason, finalProvider, fallbacksAvailable}`.
  `lastViolation` keeps its old single-slot shape. `at` is the field that lines a
  violation up with the `turn/end` error in dsh's own session log, which is how
  the later analysis of the four 19:33–19:36 blocks was done — retrofitting the
  history is what makes that analysis possible next time without a live
  reproduction.

Also re-verified the gateway itself (2026-09-30, live): `providerOptions.gateway.only`
is **still** not honoured — pinning `['baseten']` is still served by `deepseek`,
with routing metadata byte-identical to pinning `['deepseek']` or nothing. The
response metadata did grow new fields (`affinity: {outcome, pinnedProvider}`,
nested `modelAttempts[].providerAttempts[]`, `totalProviderAttemptCount`,
`originalModelId`, `clientSessionId`), and `affinity.pinnedProvider` is the
gateway's own preference (always `deepseek`, the first system channel) rather
than an echo of our request — pinning via an `affinity` request field was tried
and is ignored too. The fields the local gate reads are all still present, so no
verification change was needed. One debugging note worth keeping: a `max_tokens`
that is too small (24) makes the gateway answer HTTP 500
`{"error":"empty response content","success":false}` — that is a token-budget
artifact, not a routing problem.

`test-fetch.mjs` grew both contracts (7 checks that fail on the 0.8.0 code:
no channel named, no history, no bound).

One stale assertion was fixed while testing this against the live gateway:
`smoke-test.mjs --negative` asserted that an impossible pin is *refused* with
`No available providers match the 'only' filter`. That stopped being true on
2026-09-22 (when the gateway began ignoring provider routing options), so the
check had been quietly red for eight days — worse than no check, because a suite
nobody can get green stops being read. It now asserts the documented reality:
the gateway answers 200 and serves the request anyway (`finalProvider: deepseek`,
16 fallbacks offered), which is exactly why enforcement lives in this plugin.
Section 3 of the same run is the positive proof: a stream deliberately allowed
only `alibaba` but served by `deepseek` is refused with the new message naming
`deepseek`, and no completion reaches the caller.

## 0.8.0

The Cline Pass card is now **declared by the package** instead of being written by
the plugin at start-up: install it (either route), restart dsh, and Settings →
Models has the card. No hand-written patch row, no run-time write.

Why it had to change — a clean room showed both halves of the problem on 0.1.7:

- A cold start reaches `apply()` before the settings service is registered. The
  plugin used to read `ctx.settings` right there, which cordis refuses
  (`cannot get property "settings" without inject`), so provisioning — and the
  reasoning-effort migration behind it — never ran and `provision` stayed `null`,
  which read the same as "not yet". Provisioning now publishes `pending` first,
  waits for the service through `ctx.inject(['settings'], …)` instead of reading
  it, and records `failed` plus a `provisionReason` when the call itself throws.
  `test-fetch.mjs` gained a host double that refuses the property read and a
  cold-boot case that fails on the previous code at that exact line
  (`index.js:2091`, the line the error named in production).
- The write is not dependable either: on a fresh profile it waits on the profile
  manifest's writer lock rather than failing — the holder is dsh's own idle
  process — so `provision` sat at `pending` and the patch file never changed. The
  card therefore ships as data: `cordis.patch.yml` carries
  `- id: llm-pi-ai / config.providers.cline-pass`, so a plain
  `dsh plugin --profile web add …` is enough, and `install.mjs` appends the same
  block for the offline routes. A fresh `DSH_HOME` installed that way composes the
  card (`dsh web --dump-config`), boots with `provision: "present"`, leaves the
  profile's own patch at `[]`, and creates no `.lock`.
- A patch row replaces the whole `config` of the row it targets, so the installer
  appends the block **only when the profile has no `llm-pi-ai` row of its own**;
  it says why and points at the README instead of replacing a user's row (that row
  is where their other providers live). `uninstall.mjs` removes only the block it
  wrote, byte for byte.

Docs: the install steps no longer ask for a hand-written provider row, and the
README explains how the card is declared, why it rides on `llm-pi-ai` rather than
a plugin-owned namespace (the Models page picks its layout by settings namespace),
and what to do if you declare `llm-pi-ai` yourself. `npm test`: 582 assertions,
five suites, all offline.

Not a docs-only release: `index.js`, `install.mjs`, `uninstall.mjs` and
`cordis.patch.yml` all changed.

## 0.7.8

Documentation only — `index.js` is byte-for-byte the file 0.7.7 shipped.

- 0.7.7 said the automatic registration cannot work on dsh 0.1.7 and that the
  installer should write the provider row by hand. This adds the other half of
  that answer for whoever wants to fix the plugin instead: provisioning has to
  happen inside `ctx.inject(['settings'], …)` so it waits for the service, with
  the hook still installed immediately — the shape a probe verified. It also notes
  that `provision: null` currently means both "not yet" and "never ran", which a
  real fix would separate.

## 0.7.7

Documentation only — `index.js` is byte-for-byte the file 0.7.6 shipped (compared
against the previous tag, per RELEASING.md step 6).

0.7.5 claimed dsh 0.1.7 had broken provider registration and that fixing the
`settings.get()` call fixed it. The second half was wrong, and a clean room said
so within the hour: **on a cold start the plugin never gets as far as registering
anything.**

A fresh `DSH_HOME` — profile auto-created from the shipped web template, plugin
installed with the documented `dsh plugin … add` command — booted with
`hook: installed` and `provision: null`, the null being the signature of a step
that never ran. A probe plugin wrote the reason to a file, because `ctx.logger`
lines land nowhere:

    {"step":"ctx.settings-threw","message":"cannot get property \"settings\" without inject"}
    {"step":"ctx.get-loose","found":false}

The plugin reads `ctx.settings` while the settings service is not registered yet.
cordis waits for a dependency only when the plugin declares one with `inject`, and
this plugin declares none, so `apply()` throws on that line — registration, the
stored-effort migration, and everything after it never execute. A hot reload never
shows it (the service came up long ago), which is why the development machine
looked fine, and why the「0.1.7 上它没写成功」note in that machine's profile patch
was in fact this.

**This release does not fix it.** A standalone plugin whose install is already one
command plus one manual provider row does not get to grow a service-timing
workaround; the honest move is to write the requirement where the installer will
read it:

- The install section now has the provider row as **step 2 of 4**, not as a
  fallback, with the complete `llm-pi-ai` block to paste, the probe evidence, and
  the two signatures that tell the cases apart — `provision: null` means the
  registration never ran, `failed` plus `provisionReason` means it ran and failed.
- The stale half of the old advice is gone: on 0.1.7 the default model is a profile
  patch row (`- id: agent-default-model`), not a `~/.dsh/settings.yaml` section,
  which no longer exists; the uninstall steps say what to delete by hand.
- `patch.example.yml` points at the second entry, so 方式 A / B / C all reach it.
- A second, **dsh-side** observation is recorded rather than hidden: in the same
  clean room a settings write died with `atomic-write: timed out waiting for the
  writer lock at <profile>/package.json.lock` (the lock naming the dsh's own pid,
  with the process idle) and later attempts hung instead of failing. Not diagnosed
  — it could be 0.1.7-rc.2, a startup-window race with the profile manager, or that
  throwaway profile. The development machine's profile has no such file. Recorded
  because on such a profile saving in Settings → Models fails too, and that is not
  this plugin's doing.

## 0.7.6

Documentation only — `index.js` is byte-for-byte the file 0.7.5 shipped (compared
against the previous tag, per the check added below).

- **The README now names the actual reason plugin log lines land nowhere.** It
  said "where the log ends up is the host's decision", which reads like a
  configuration problem the reader could fix; there is no logger exporter in this
  composition at all, so `ctx.logger` output never leaves the process, while a
  plugin that prints through `console.log` (the neighbouring one does) reaches
  `~/Library/Logs/dsh-web.log`. That asymmetry is exactly what made this look like
  a silent plugin. Reading the status file is not a workaround here — it is the
  only surface there is.
- Two places that sent the reader to the log first now lead with the status file:
  the interception record (`lastViolation.finalProvider`) and the case where the
  card is not ours (`provision: "mismatch"` plus `provisionReason`).
- **`RELEASING.md` gained the check this session needed**: a docs-only release has
  to prove the runtime did not change by comparing `index.js` against the
  *previous tag*. Comparing against HEAD only proves the working tree is clean,
  which is true of every release, docs-only or not.

## 0.7.5

**dsh 0.1.7 removed `settings.get()`, and provisioning died on it.** The write
that puts the Cline Pass card on Settings → Models reads the current card first;
it did so with `settings.get(PROFILE_NS)`. On dsh 0.1.7-rc.2 the settings service
is `SettingsForms`, which exposes `describe()` / `update()` / `replace()` /
`mutate()` and **no `get()`** — so the call threw `settings.get is not a
function`, the retry threw the same way, and `provision` settled at `failed`. A
fresh install on the current dsh therefore got **no provider card at all**: the
route could not be picked, and the pin had nothing to attach to.

Found within minutes of 0.7.4 going live, by the field 0.7.4 added. 0.7.4 records
the verdict; this release records the sentence beside it, so the status file said
`provision: "failed"` and `provisionReason: 'could not provision the "cline-pass"
profile: settings.get is not a function'` on the first reload. 0.7.4 had called
this a 0.1.7-era anecdote that could not be reproduced — it reproduced
immediately, and this is why.

- **The live value is read from `describe()`**, whose entries carry `value` (the
  service's own type calls it "One Loader entry's live Config fields"), with
  `settings.get?.()` kept as the fallback for hosts that predate the change. Both
  shapes have tests, and the suite's settings doubles now model the *current* host
  by default: putting `settings.get()` back fails five assertions.
- **`alignReasoningEffort` was silently dead on the same API change.** It called
  `settings.get?.(ns)` — optional chaining, so on 0.1.7 it read `undefined` and
  returned `'absent'`, skipping the stored-effort migration without a word. It
  goes through the same reader now.
- **`provisionReason`** joins the status file and `state()`: the sentence behind
  `failed` / `mismatch` / `repaired`, produced by `provisionProfile()` through a
  callback so it can never exist only as a log line. `'present'` / `'created'`
  carry `null`.
- Also corrects `alignReasoningEffort`'s documented return union, which omitted
  `'other-model'` — a value the code has always been able to return.

Verified on the machine that found it: with this release mounted, the same status
file flips to `provision: "present"` / `provisionReason: null`, and
`settings.yaml` is left untouched, because that deployment declares the card
itself.

**Correction (0.7.7):** this release fixed a real bug and then drew too broad a
conclusion from it. `settings.get()` was indeed gone — but a cold start never
reaches that call at all (`ctx.settings` throws without `inject` first), so "a
fresh install got no card" was never this one cause. See 0.7.7 for what a new
install actually needs.

## 0.7.4

**The two questions the README answered with "look at the log" are now answered
by the status file.** Those diagnostics only ever existed as `ctx.logger` lines,
and whether such a line reaches a file is the host's decision — on the machine
this plugin is developed on they do not (the neighbouring plugin that *does*
appear in the launchd log prints through `console`, not through `ctx.logger`).
"`seen` is climbing but `pinned` is not" and "did the provider card get
provisioned?" were exactly the two questions the status file could not answer.

Added:

- **`lastSkipped` in the status file and in `state()`** — `{ at, url, reason }`
  for the most recent request that went out unpinned. The reason is produced in
  one place now: `rewrite()` returns `{ kind: 'skip', reason }` instead of
  `null`, and the counter, the record and the log line all happen at the single
  call site that consumes it, so they cannot drift apart.
- **`provision` in the status file and in `state()`** — the provider-profile
  result (`created` / `present` / `repaired` / `mismatch` / `failed` / `off` /
  `unavailable`), published by a new `hook.noteProvision()` as soon as `apply`
  has run it. It used to exist only in the startup log line.
- Tests for both, **proven to fail under mutation**: removing either field from
  the published payload fails four assertions, and removing the skip record
  fails the two that read it.

Documentation, from reading the docs against a live install:

- **「方式 C」copied four files while the manifest references six.** `client.js`
  (the browser half since 0.7.0) and `cordis.patch.yml` were missing from the
  list, yet `package.json` — which declares both — was copied. The list now
  includes `client.js` and says what it is for and what is deliberately left
  out.
- **A missing provider card has a remedy now, not only a cause.** The
  development machine hit exactly that on dsh 0.1.7: the plugin reported a
  successful create, `settings.yaml` never showed `llm-pi-ai`, and the model
  picker kept a dead entry. It is deployed with `llm-pi-ai.providers` written by
  hand in the profile patch. Documented as a fallback rather than a version
  verdict — it was not reproduced on the current release.
- **`provision` was described as a status-file field** in 0.7.0-0.7.3, which it
  was not until this release; and wherever the log and the status file overlap,
  the README now leads with the status file and notes that plugin log lines may
  land nowhere at all.

## 0.7.3

**Documentation only — `index.js` is byte-identical to 0.7.2.** Corrects places
where the docs contradicted each other or the code, and adds the release
checklist whose step 5 was missed when 0.7.2 went out.

- **The pin-spelling count.** The README claimed "一共试过 15 种写法" while 0.7.1's
  own changelog said "Nine spellings". Neither count survives an audit, and a
  number that contradicts another file is worse than no number at all: both now
  state that every spelling tried was ignored, and name them.
- **`fallbacksAvailable: []` is not what a strict pin looks like** — that has not
  been true since 2026-09-22, when the gateway stopped honouring `only` and began
  listing the same 15 other channels for every request. The FAQ row read a
  non-empty list as the pin having failed; it now says the list is expected, and
  that the no-fallback promise is delivered by the local gate.
- **The English smoke-test description** still promised an assertion of "no
  fallbacks", which 0.7.1 removed on purpose.
- **Pin-a-tag examples** named `#v0.6.2` and `#v0.7.0`; they name `#v0.7.3` now.
  0.7.0's release notes tell readers not to reference `v0.6.2` — the README was
  recommending exactly that.
- **The tested dsh version** was still "`0.1.6-alpha.1`（唯一实测过的版本）" while
  the field record added for 0.7.2 documents a live `0.1.7-rc.2` install. Both are
  named now, with what each one is evidence of.
- **`RELEASING.md` is new** — the checklist this release exists because of.
  `git push origin v1.2.3` creates a *tag*, not a Release, and the Releases page
  stays empty until `gh release create` runs with the tarball. It carries the
  rules this repository has already paid for: never re-point a published tag, tag
  only versions a `package.json` actually shipped, and count assertions from the
  output instead of memory.

This release exists for the same reason 0.6.1 did: an install pinned to a tag
should get documentation that is correct rather than a tarball that contradicts
itself. The published v0.7.2 tag and its tarball are left exactly as built.

## 0.7.2

**`strict` streams again: the gate withholds only the SSE terminator, so a
response is displayed as it is generated and the chunk arrival times behind the
TPS figure survive — while a response from a disallowed channel is still
discarded before it can reach the model.**

0.7.1 read the whole body to get `gateway.routing`, which only appears in the
last frame (measured: frame 41 of 41). That was right about the information the
gate needs and wrong about what it has to withhold: buffering kept non-official
content out of the context, but it also destroyed the chunk timestamps dsh
measures decode speed from, so `sessionStats` folded the local drain time as if
it were generation time. The Token-usage dialog read ~16,000 tok/s where the real
figure was ~150.

Changed:

- **`strict` forwards content immediately and holds back only `data: [DONE]`.**
  Frames are passed through byte-for-byte as they arrive; the terminator is
  released once `gateway.routing` has been judged, and on a violation the
  response body is errored instead of completed. dsh's pi-ai adapter turns that
  into an `error` event, so the agent loop appends only an `assistant/attempt` —
  no `assistant/message` is assembled and no tool call is executed. What changes
  for the user: a refused answer is now visible before the step fails, where
  0.7.1 never showed it at all. What does not change: on a stream that ends on
  its own, it never reaches the model context and no tool acts on it.
- **`warn` streams too.** It judged the same way but buffered as well; with the
  terminator held only in `strict`, `warn` is now a usable "diagnose without
  blocking" mode instead of a second way to lose streaming.
- **Every frame the gate keeps is also scanned for `routing`, not just the ones
  it forwards.** Found by an independent adversarial review: a held frame is
  bytes the gate *retains and later releases*, and a legal two-line SSE frame can
  carry both `data: [DONE]` and a routing object. Not scanning it meant a foreign
  routing could be shadowed by an earlier allowed one — the gate released the
  terminator, pi-ai assembled a message, and a tool call ran (`blocked: 0`). The
  review reproduced that end to end through the real adapter; the regression test
  in §14 fails against the pre-fix code.
- **A cancel is never a verdict.** When the consumer stops reading (user presses
  stop, or dsh aborts the round), `routing` has usually not arrived yet, so the
  old code could reach `conclude` on a cancelled stream and record a *false*
  violation. `cancel()` now records `unverified`, marks the stream concluded so
  nothing judges afterwards, and the read loop stops; a cancelled body can no
  longer be written to (the `cancelled` flag is belt-and-braces on top of that,
  since `concluded` alone already covers the paths a test can drive).

A third review re-attacked the result and found three more, all fixed here:

- **The status file could name the attacker as the culprit.** The violation
  record was built from the *last* routing object while the verdict may have
  rejected an earlier one, so a forged "deepseek" object after a real "alibaba"
  one made `lastViolation.finalProvider` read `deepseek` — the exact field the
  README tells operators to check. `judgeRoutings` now returns the routing it
  rejected, and that is what gets recorded.
- **A routing whose JSON is split across two `data:` lines of one event was not
  judged.** The consumer joins an event's data lines with `\n` before parsing
  (`openai/core/streaming.js`), the plugin parsed each line on its own, so both
  halves failed and the object was invisible — reproduced end to end through the
  real pi-ai adapter, foreign content assembled with `blocked: 0`. Routing
  extraction now assembles events the way the consumer does, and still scans each
  data line separately as well, because a frame carrying both `[DONE]` and a
  routing object is one the consumer stops at but the gate keeps and forwards.
- **The retained-routing set was unbounded.** Deduplication only removes exact
  repeats, so a channel could emit many distinct routing objects (~1 KB each) and
  grow memory linearly. Capped at 64 distinct objects; past that the response
  counts as unprovable.

The terminator predicate also treats a bare `data` line as an empty data field
(it joins to `\n[DONE]` and is therefore *not* a terminator), matching the
consumer exactly.
- The wrapper works on **bytes**: frames are split on the SSE blank line
  (`\n\n`, `\r\n\r\n` and `\r\r`, matching the SDK's own
  `findDoubleNewlineIndex`) and decoded only to read `routing`, so the forwarded
  body is byte-identical — verified against streams chopped mid-`data:`,
  mid-`[DONE]` and between the `\r` and `\n` of a blank line. `isTerminatorFrame`
  also follows the consumer's rule exactly (`data:` plus at most one space),
  instead of a looser one that would hold a frame the SDK then fails to parse.
- The refusal is delivered with `controller.error()` rather than by throwing
  inside a `TransformStream`'s `flush`: that path errors the stream through its
  internal close algorithm and surfaces as an *uncaught exception* when nobody is
  reading concurrently, which took the host process down (found by
  `smoke-test.mjs`).
- **The refusal message is a constant with no gateway-supplied text in it.** A
  second review found that the first attempt at this only mirrored
  `classifyPiAiError`: `mapStopReason` runs pi-ai's context-overflow patterns and
  the harness's `isContextWindowExceededError`/`isQuotaExceededError` *before* it,
  and `CONTEXT_WINDOW_EXCEEDED` makes dsh-compaction **prune and compact the
  session** and retry. A channel slug like `context_length_exceeded` or
  `insufficient-balance` therefore still steered the harness. Mirroring several
  sets of patterns is exactly the kind of thing that drifts (the first mirror was
  already wrong in two places), so the message now contains nothing dynamic at
  all: the culprit goes to the plugin log, `lastViolation`, and a `detail`
  property on the error instead. Pinned by a test that runs five adversarial
  slugs and asserts the message is byte-identical every time.
- **Every `routing` object in the response is judged, not just the last one.**
  Also from the second review: a channel controls the frames it emits, so it can
  append a routing claiming to be an allowed provider and, under last-wins, be
  believed — a forged `deepseek` object after a real `alibaba` one produced a
  clean foreign completion through the real client. The rule is now "any routing
  that names a foreign provider rejects the response"; the regression test fails
  against the previous revision.
- **The verdict no longer waits for upstream EOF.** If upstream sends
  `[DONE]` and keeps the connection open, the held terminator used to stay held
  until the stream idle timeout (the client waited 1.5 s in a probe; production
  would wait 300 s). A terminator now ends the response — which is what the
  consumer does with it too — and the upstream body is cancelled.
- CR is treated as a line terminator everywhere (`\r`, `\n`, `\r\n`, matching
  the SDK), including the terminator predicate and routing extraction. A
  `[DONE]` preceded by a CR was previously forwarded instead of held, so the
  "terminator is never released on a violation" guarantee did not actually hold
  for that framing.
- `verifyPinned` passes the caller's abort signal into the streaming path, and
  the upstream body is locked into a reader lazily (only once bytes are actually
  wanted) rather than eagerly.

Added:

- **`counters.unverified` and `lastUnverified` in the status file**, recording
  streams that never reached a verdict (`aborted`, `cancelled`, `stream failed`).
  Before this, a habitually interrupted session could ride a foreign channel with
  nothing in the status file to show for it.
- A §13 section in `test-fetch.mjs` for the streamed gate (content arriving
  before the verdict, the terminator released on success and withheld on a
  violation, missing routing metadata, `warn`, an upstream failure that is not
  counted as a violation, the frame splitter) and a §14 section for the cases an
  adversarial review attacked: routing hidden inside the held terminator frame,
  cancellation accounting, split frames, no trailing blank line before EOF, two
  terminator frames, `response.body === null`, and an adversarial channel name
  against the retry classifier.

Known limits (measured, not hypothetical — these are documented in the README):

- **A stream that is aborted mid-flight is not protected.** `routing` never
  arrives, no verdict is rendered, and dsh commits the content it already
  displayed as an interrupted `assistant/message` — which *is* in the next
  request's context (text and reasoning only; no tool call runs). 0.7.1's
  buffering did not have this hole because the abort happened before any content
  was released. This is the one place where streaming costs a safety property;
  the abort is recorded as `unverified` so it is at least visible.
- The gate trusts the `routing` the gateway reports about itself. A lying
  gateway defeats it.
- Only foreign attempts marked `success: true` are rejected. Whether the gateway
  marks an attempt that streamed bytes and then failed is unknown (not
  reproducible offline); if it does, the rule must be tightened.

Observed in the field, not in a test (README: 实战记录): a live 0.7.2 install
(dsh 0.1.7-rc.2, `pin: [deepseek]`, `enforcement: strict`) recorded
`blocked: 1` against `seen: 696` / `pinned: 696` / `unverified: 0`, with
`lastViolation.finalProvider: "alibaba"` and 15 fallbacks listed — a real
intermittent fallback, since the next call 10m17s later verified as
`deepseek` again. The round that hit it is the first production sample of the
cost this release documents: its only product was an `assistant/attempt` whose
stream already carried 517 characters of reasoning and two complete `bash` tool
calls, and it failed 14 ms after the verdict was written — no
`assistant/message`, no `tool/result`, neither tool executed. `unverified`
staying 0 is the other half of the claim: the block was a verdict rather than a
stream that was never judged.

## 0.7.1

**The gateway stopped honouring `providerOptions.gateway.only`, so the pin is now
enforced locally: a response that was not served by an allowed channel is
discarded instead of being handed to the model.**

Measured on 2026-09-22 against `api.cline.bot`: pinning the real channel, pinning
a channel that cannot exist (`__no_such_upstream__`) and not pinning at all
produce **byte-identical** `routing` metadata — same `finalProvider: "deepseek"`,
same `fallbacksAvailable` listing all 15 other channels, same
`planningReasoning` ("System credentials planned for: deepseek, alibaba, …
Total execution order: deepseek(system) → alibaba(system) → …"). Every spelling
of the pin we tried (`order`, `models`, `sort`, a top-level `only`,
`providerOptions.only`, snake_case, …) was ignored. The request field is still
sent — it costs nothing and works again the day the gateway restores it — but it
no longer decides anything.

Added:

- **`enforcement`: `strict` (default) / `warn` / `off`.** In `strict`, a
  `chat/completions` response is read to the end, the channel that actually
  served it is taken from `gateway.routing`, and the response is handed on only
  if `finalProvider` **and every `providerAttempt` that succeeded** are in the
  allowed list for that model — as is the `resolvedProvider` the gateway reports
  next to it, so two fields that ever start disagreeing stop the request instead
  of letting the nicer one be believed. Otherwise the response is dropped and the call
  fails with HTTP 400 `PROVIDER_PIN_VIOLATION` — no content from an unlisted
  channel ever reaches the model context. `warn` judges the same way but only
  logs and counts; `off` skips the check and the buffering entirely. The status
  code is deliberately a 4xx: dsh's default retry set is
  `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`, so a 5xx would be
  retried eight times for a request that will be refused every time. Non-2xx
  upstream responses pass through untouched — a failed call has no content to
  "use", and rewriting it would hide quota and rate-limit signals.
- **`counters.blocked`, `lastVerified`, `lastViolation` and `enforcement` in the
  status file.** `lastVerified` records who the gateway said served the last
  accepted request; `lastViolation` records the refusal (including the
  `finalProvider` that did not match and the fallback list), so "did it quietly
  switch channels?" is answerable from one file.
- A `state()` accessor on the hook, and a 4b section in `test-fetch.mjs` covering
  refusal, `warn`, `off`, missing routing metadata and upstream errors — the gate
  is now tested offline, without touching the gateway.

Changed:

- **`strict` costs streaming.** The routing metadata arrives only in the last SSE
  frame (measured: frame 41 of 41), so "never use an unlisted channel" requires
  buffering the whole response and releasing it afterwards: answers appear at the
  end instead of token by token. That is the tradeoff `strict`-by-default buys;
  `enforcement: warn` is the way to keep the diagnosis without the blocking, and
  it buffers too. `off` is the only mode that still streams.
- The accepted response is **rebuilt** from the buffered body (`content-encoding`
  and `content-length` removed) instead of being passed through by identity, and
  a caller abort (`AbortSignal`) propagates as an abort rather than being counted
  as a channel violation.
- `smoke-test.mjs` no longer asserts `fallbacksAvailable` is empty — that
  asserted the gateway behaviour that no longer exists, so it could only ever
  fail. It now reports the fallback list as a notice and asserts that the local
  gate accepted the live response; a new section proves the gate refuses a
  deliberately mismatched allow-list. `--negative` still fails on purpose (the
  impossible-channel pin proves nothing now).
- A disposed plugin instance no longer rewrites the status file with
  `hook: "uninstalled"` while requests still flow through its layer after a
  reload: the record belongs to the instance that owns `globalThis.fetch`.

## 0.7.0

**The plugin grows a browser half: a usage card on Settings → Models. The pin,
the profile provisioning, the prompt rewrite and the wire body are untouched.**

Added:

- **Usage on the Cline Pass card.** The three ClinePass windows — 5-hour, weekly,
  monthly — render as progress bars of what is **left**, with the remaining
  percent, the reset countdown, a refresh button and the read time, inside the
  provider card on Settings → Models. `usage: false` turns the whole thing off.
  The gateway only reports `percentUsed` — the live response carries no `limit`,
  `used` or `remaining` field — so remaining is `100 − percentUsed`, rounded to
  one decimal in the browser half (`100 − 82.4` must not print
  `17.599999999999994`) and clamped so an exhausted window reads `0%`. The host
  keeps the wire field exactly as the gateway named it: the flip is presentation,
  and the bar width, the bar colour and the number are one quantity, never a
  "18% left" label over an 82%-filled bar. The title spells out "remaining"
  because the number itself is bare.
- **`client.js`**, the browser half. It registers into dsh's documented
  `settings.models.provider-card` slot (keyed by the `llm-pi-ai` settings
  namespace) and returns `null` on every card that is not `cline-pass`, so other
  pi-ai routes are unaffected. No build step and no new dependency: it is a
  hand-written bundle in the same style as `dsh-notify-ping`, and the only module
  it asks for is React, which the web shell's static table already provides.
- **The host-side read.** `GET https://api.cline.bot/api/v1/users/me/plan/usage-limits`
  with `Authorization: Bearer <key>` and `Accept: application/json` — the same
  endpoint CodexBar (MIT) uses. Live-verified against the real gateway on
  2026-09-16: `{"success":true,"data":{"limits":[{"type":"five_hour",
  "percentUsed":1,"resetsAt":"2026-09-16T11:38:00.490486029Z"}, …]}}`.
  - `normalizeUsage` refuses anything it does not understand rather than drawing
    a wrong bar: `success` must be exactly `true`, `percentUsed` must be a finite
    number (clamped to 0–100), an unknown window `type` is skipped, and
    `resetsAt` is normalised host-side to millisecond ISO because the gateway
    sends **nanosecond** precision that the `Date` spec does not promise a
    browser will accept.
  - The key is read from the credential store on the host and used for exactly
    one header. It is never logged, cached, or returned; the response carries
    numbers only.
- **`/api/clinepass.usage`** — one exact Fetch route, registered through
  `ctx.connection.fetch.register` on the HTTP server dsh **already runs**.
  This is a new *path*, not a new listener, port or socket: the plugin still
  opens nothing. The route sits behind dsh's own Host/Origin trust fence and
  browser-cookie authentication. One successful read is cached for
  `usageCacheMs` (default 60 s) and concurrent reads are deduplicated. A *failed*
  read is remembered for 5 s — long enough that flipping between settings panes
  while the gateway is down does not re-hit it, short enough that a fixed key
  takes effect immediately, and the card forces a refresh when the stored key
  changes so it never waits that window out. The whole read (credential lookup
  included) is bounded by `usageTimeoutMs`, not just the gateway call.
- **Options**: `usage` (default `true`), `usageRoute`
  (default `/api/clinepass.usage`), `usageTimeoutMs` (default 15000),
  `usageCacheMs` (default 60000; `0` means always refetch).
- `test-usage.mjs`, a zero-network suite over the normaliser, the gateway read,
  the route handler (caching, dedupe, failure classification, key containment)
  and the `apply` wiring. It also **renders `client.js`** against a ~60-line
  stand-in React runtime (React is not a dependency of this package and must not
  become one), asserting the card's real output in both languages, its failure
  copy, its timer discipline and its unmount path. The runtime runs effect
  cleanups, so deleting one is a test failure rather than a silent leak. `test-package.mjs` now also pins the client-half declaration,
  because a wrong `exports["./client"]` or `dsh.client.platform` would leave the
  host working while the card silently never appears.

Fixed:

- **`ctx.locale` needs to be declared in `inject`.** The first cut declared only
  `slots`, on the assumption that an unavailable locale would come back
  `undefined` and the card would fall back to English. Cordis does not work that
  way: an *undeclared* service property **throws**
  (`cannot get property "locale" without inject`), the throw landed inside the
  slot's error boundary, and the card rendered as an empty
  `<div data-slot-error="settings.models.provider-card">` — installed,
  activated, no visible error, nothing on screen. The declaration is now
  `['slots', 'locale']`, `test-usage.mjs` statically asserts that every service
  the bundle touches is declared (the render test cannot catch this class of bug,
  because the guard lives in the real context proxy), and the live-shell check
  that found it was a headless browser reading the actual DOM.
- **The rest of the round, found by three independent reviews of this change.**
  The pin, the provisioning, the prompt rewrite and the wire body are still
  untouched; everything below is inside the usage feature.
  - **`usage: false` did not turn the card off.** The browser half is discovered
    from `package.json`, so it loads whatever the config says; disabling only
    stopped the host registering the route, and the card then fetched a path
    nobody served, got a 404 page, and reported "could not reach the gateway"
    forever — with a Retry button that could never fix it. The README even
    recommended this as a diagnostic. The host now always announces, with
    `enabled: false` when the route is not mounted, and the card renders nothing.
    It also refuses to advertise a route whose registration *failed*.
  - **One malformed `limits` entry could retire the card permanently.** The slot
    wraps an entry in an error boundary that renders an invisible empty `div`;
    for a keyed slot the cell is then spent, so a `null` element (or a
    non-numeric, `null` or `NaN` `percentUsed`, which rendered a green 0-width
    bar reading `NaN%`) removed the card for the rest of the page session with
    no explanation. Limits are now narrowed per entry, and rows are selected by
    `WINDOWS` rather than by whatever the response happened to contain.
  - **Every browser-side failure said "could not reach the gateway".** `fetch`
    resolving is not success: a non-JSON body, a 404 or a proxied 502 all fell
    into one catch. Failures are now classified by status, so a missing route
    says so instead of blaming the network.
  - **The card could wedge on "Loading…" forever.** The host bounds only its own
    leg to the gateway, and the refresh button is disabled while loading, so a
    hung dsh left no clickable control at all. There is now a 20 s client-side
    abort mapped to the timeout copy.
  - **A stalled response body was reported as malformed JSON.** An abort during
    `response.json()` was classified `parse`; it is now `timeout`.
  - **The dedupe slot could wedge.** `credentials.resolve` sat outside the
    gateway timeout, so a provider that never settled held the slot open and the
    refresh button — which joins the same promise — could not escape it. The
    whole read is now bounded.
  - **A 30 s timer on every pi-ai provider card.** The countdown ticker started
    before the `isOurs` early return, so each unrelated provider row (and every
    row that had nothing to count down) ran an idle interval. It is now created
    only for this card. Host side the feature adds **no** timer: the only
    recurring one in the plugin is the pre-existing 30 s fetch-ownership check.
  - **The installer omitted `cordis.patch.yml`**, which the copied
    `package.json` references via `dsh.bundle.patch` and `exports` — a manual
    install produced a manifest pointing at a missing file. Pre-existing, fixed
    here, and `test-package.mjs` now asserts that every referenced file exists
    and is copied.
  - **`npm test` could not run in an installed copy.** Its `test` script names
    `test-package.mjs` and `test-install.mjs`, neither of which the installer
    copies (both need the source checkout — one reads `CHANGELOG.md`, the other
    tests the installer). Pre-existing, and the copy is still byte-identical to
    the repo, so the fix is a `test:installed` script naming the three suites
    that do run anywhere.
  - **Three tests could not fail.** Cache expiry had no test at all (pinning the
    window to 60× passed), effect cleanups were never run (deleting both
    `client.js` cleanups passed), and the suite was locale-dependent — it failed
    under `sv_SE` and `de_DE` because an assertion scanned the browser-formatted
    date. All three are now covered by tests proven to fail under mutation.

Notes:

- The browser cannot read the key by design (dsh's credential seam is
  write-only: "no read path returns it"), which is *why* the card needs a host
  half. Do not "simplify" this into a browser-side fetch — it cannot work, and
  the fallback would be putting the key in the DOM.
- Only web profiles mount the card: it is registered through a child fiber that
  stays pending when `connection` / `credentials` are absent, so a headless
  profile is unaffected.
- `usageRoute` and the client's path cannot drift: the host announces the
  configured path through the web server's own `webserver/index-inject` table,
  and the client only falls back to the default when no page render carried it.
- The card speaks the shell's language; the strings are written into `client.js`
  rather than registered as a locale namespace, so a missing dictionary can never
  blank the card.

## 0.6.2

**One new behavior, one new option — the pin hook, the profile provisioning and
the wire body are untouched.**

Added:

- **The prompt shows the route-relative model id.** The `type/` prefix is a
  gateway requirement on the *wire* (`type/model`, a bare id is rejected), and
  dsh sends a catalog id to the wire verbatim — so the persona used to read
  "powered by the cline-pass/deepseek-v4.1-flash model", where every first-party
  route shows a bare id. `index.js` now prepends a `system-prompt/assemble`
  listener that rewrites the `{{model}}` reference inside the two persona
  sections (`deployment:persona-prefix` / `-suffix`, the
  `PERSONA_*_SECTION` ids of `@deepseek-ai/dsh-system-prompt`) to
  `deepseek-v4.1-flash`.
  - It only touches this route's own ids while the session is actually on this
    route; a bare `deepseek-v4-flash`, another provider, a bare id on this route
    and an `interpolate: false` section are all left alone.
  - It rewrites the *template*, not `assembly.variables`: the session layer
    (`installModelSelection` in `@deepseek-ai/dsh-agent`) applies the live
    selection to those variables after every inner listener, and
    `@deepseek-ai/dsh-session-reference` snapshots them to size its reference
    budget.
  - The listener is prepended, which is what puts it *outside* that selection
    listener and makes it see the model the next request will use — including
    for agents that already existed when the plugin mounted.
  - Not done by renaming the catalog id: every stored session's
    `model/selection` / `request/header` carries the prefixed id, so a rename
    would fail as `UNKNOWN_MODEL` until each session re-picks its model.
- **`plainModelId`** (default `true`) turns the rewrite off; the boot line then
  says `prompt shows the configured model id`.

The boot line now ends with what the prompt will show, e.g.
`… ; prompt shows deepseek-v4.1-flash (no route prefix)`.

Verified live, not only in the suite: a subagent spawned in the running web host
rendered `You are a coding agent powered by the deepseek-v4.1-flash model.`, and
its committed `system/message` contained no `cline-pass/` at all — while
`request/header` and `request/context` kept the wire id, as they must.

## 0.6.1

**Documentation only — `index.js` is byte-identical to 0.6.0.** Corrects claims
an independent review showed to be wrong, two of them introduced while preparing
0.6.0.

- **`test-fetch.mjs` needs no network.** The README said it "really hits the
  gateway at the end, needs network". It does not: the suite stands local HTTP
  servers in for the gateway and speaks real undici to `127.0.0.1` only — its own
  file header says exactly that. The suite is hermetic, so it can be run offline
  and in CI without egress.
- **The plugin never logs request headers.** The README described `authorization`
  being redacted to an example value; `index.js` logs the method, URL, model and
  pin channel, plus the reason a request went out unpinned — and never a header.
  The true statement is stronger: there is nothing to redact. The example is now
  removed outright rather than reworded, because the old example value was not
  synthetic.
- **The status file** also carries `upstream`, `profileBaseURL`, `pid` and `at`
  (and is 2-space pretty-printed); the README listed only counters/time/model/
  channels, and its sample omitted those fields.
- **Required dsh version.** There is no `0.1.5` on npm — only `0.1.5-alpha.*` /
  `0.1.5-rc.*`. The README now names `0.1.6-alpha.1` as the tested version, and
  notes that the `dsh plugin` / `dsh.bundle` modules exist back to
  `0.1.2-alpha.3`, untested.
- **Manual install (方式 C)** copies a minimal file set and now says so, because
  the verification section advertises `test-package.mjs` / `test-install.mjs`,
  which belong to the repo/installer layout and cannot run there.
- **`install.mjs --dry-run`** still requires an existing profile: it exits 1 with
  a pointer to start dsh once. The README presented it as a plain preview.

Not changed: the pin hook, every option and default, the status-file format, the
bundle declaration, and both install routes. `v0.6.0` is left in place and is
still resolvable.

## 0.6.0

**Distribution only — no runtime change.** The pin hook, its options and its
defaults are identical to 0.5.1; what changed is how the plugin gets mounted, so
that it can be installed straight from the repository in one command.

Added:

- **`cordis.patch.yml`, plus `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  in the manifest.** The package is now a dsh *bundle*:
  `dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseekv4.1`
  installs it with pnpm, which then notices the declaration and appends
  `dsh-clinepass` to `dsh.profile.bundles` by itself — no clone, no hand-written
  loader row, and `dsh plugin remove dsh-clinepass` takes it back out. The row
  inside the bundle patch is the same canonical config `install.mjs` writes
  (`upstream` + `pin`), so the two install routes cannot drift.
- Repository, homepage and bugs metadata; `dsh-plugin` / `dsh-bundle` keywords.

Removed:

- **The `install` lifecycle script** (`"install": "node install.mjs"`). It was
  wrong twice over. As a dependency it would silently rewrite the *installer's*
  `$DSH_HOME` on any plain `pnpm install`, and pnpm's build gate refuses a
  git-hosted package that declares one — `ERR_PNPM_IGNORED_BUILDS`, reproduced
  here, which broke exactly the one-command install above. The installer is still
  run explicitly as `node install.mjs`.

Unchanged: `index.js`, every option and default, the status-file format, and the
`install.mjs` / `uninstall.mjs` route (still supported, and still what to use
where there is no pnpm).

## 0.5.1

**Fixes and dead-code removal from an independent adversarial review** (two
reviewers: an instrumented branch-count run plus a 28-site mutation sweep, and a
separate read of the whole file; 273 checks now, all green).

Fixed — each was reproduced before the fix:

- **A stale `content-length` could hang a request.** The `init.body` branch
  dropped it only when the caller supplied headers, while the `Request` branch
  already fell back to the input's — so a `Request` plus `init.body` forwarded
  the old length while the body grew. Both branches now fall back, and a
  three-way control (no plugin / before / after) goes from a 3 s timeout to a
  200 in ~10 ms.
- **The ownership watcher warned and rewrote the status file every 30 s
  forever**, and could never report recovery: it now acts on the state
  *transition* only — one warning per replacement, one write per change, and a
  restored native fetch is reported as `uninstalled` instead of a false
  `foreign` alarm.
- **The status file was written non-atomically**, while the README tells users to
  `cat` it and `smoke-test.mjs` `JSON.parse`s it — a read inside the truncate
  window could redden a healthy install. Now written via `.tmp` + `rename`.
- **An invalid `upstream` installed a hook and wrote a broken card**
  (`baseURL: "api.cline.bot/api/v1"`) past an error log. It is now refused
  before anything is installed or provisioned.
- **A card stranded on a loopback address stopped pinning silently**: the repair
  was gated on `api`/`apiKeyEnv` matching, so a card whose keys the user had
  renamed was never moved off the removed transport and the hook (origin
  matched) pinned nothing. The address is now repaired in that case too, and the
  log says why.
- **`displayName`, `contextWindow` and `maxTokens` were write-once**: changing
  them in the loader row did nothing to an existing card. They are repaired like
  the address is.
- **`upstream` carrying a path** produced `…/api/v1/api/v1` while the hook still
  matched by origin; the origin is now used, with a warning.
- **A stored reasoning effort was realigned for a different model** on the same
  route; the model is now part of the check (`other-model`).

Deleted — provably unreachable or write-only, verified by branch counters and by
mutating them out (no check changes behaviour):

- the redundant `Buffer.isBuffer` branch (`Buffer` is an `ArrayBuffer` view);
- the `[name, value][]` header branch (no caller, 0 hits in every suite);
- `install()`'s `current === wrapper` branch and its `original === null` guard
  (unreachable, and the only path that could ever set `globalThis.fetch = null`);
- the third `status` bag parameter and its three `Object.assign`s, plus the
  write-only `status.transport` / `profile` / `effort` fields;
- the hand-written `EFFORT_MAP` literal (derived from `EFFORT_LEVELS` now, so the
  two cannot drift).

Kept deliberately, after reviewing the reviewers' suggestions: the `calling`
re-entrancy guard (removing it turns the gateway path into a hang rather than an
error), `FETCH_MARK` unwrapping, `withoutBodyLength`, the `ignoredOptions` warn
loop, the level merge with `RETIRED_EFFORTS`, and the status file itself. The
"`apply` opens no listener" check was vacuous — it patched `http.createServer`,
which this module never imports — and is now a real process-resource probe with
its own positive control.

## 0.5.0

**The loopback proxy is gone: the plugin now opens no listener at all.** 0.3.0
stopped *using* the port by default; 0.5.0 removes the code, so a `dsh-clinepass`
install has no port to allocate, no port to free, and no second process holding
the traffic.

- **Removed**: `createPinProxy` (a reverse proxy plus its helpers), and the
  `transport`, `listen`, `captureDir`, `address` and `baseURL` options — ~330
  lines of `index.js` (1172 → 852).
- **A legacy config still boots.** Those options are read, reported once at
  boot ("`\"listen\"` is no longer used: …") and recorded as `ignoredOptions` in
  the status file, so the upgrade is visible even where plugin `warn` lines are
  not; a card left over from an older install is repaired to the gateway in the
  same write. A silently ignored option would look like it took effect, which is
  the failure mode this plugin exists to avoid, so the report is deliberate.
- **The installer refuses `--transport` / `--port`** instead of dropping them,
  with the status-file path as the replacement for the old `curl /health`.
- **`test-proxy.mjs` → `test-settings.mjs`.** The transport-independent coverage
  (option surface, provisioning, repair, the reasoning-effort migration) moved
  to its own suite; the proxy-transport tests are gone with the code. Suites:
  `node test-fetch.mjs && node test-settings.mjs && node test-install.mjs`.
- **Why it stayed this long**: it was kept as an escape hatch for the case where
  something else replaces `globalThis.fetch` (the in-process hook cannot install
  itself then). The status file now names that case (`hook: unavailable`), and
  the trade is stated in the README rather than carried as code.

## 0.4.0

**Two reasoning levels, no alias: `high` and `max`.**

- **`xhigh` is retired.** The route now declares exactly `{ high: 'high',
  max: 'max' }`, so the composer and the model card list two levels instead of
  three. `max` never needed an alias: it is a pi-ai level id a profile may
  declare, and the declared spelling is what goes on the wire
  (`thinkingLevelMap[level] ?? level`).
- **Existing cards are migrated by the provisioning repair.** A declared
  `xhigh` is dropped from the model entry while any level the user added
  themselves (e.g. `medium`) is kept, so a card written by 0.3.0 becomes the
  two-level card in one write.
- **A stored `xhigh` is not silently downgraded.** `alignReasoningEffort` now
  maps a retired id to the level it used to dispatch (`xhigh` → `max`) and only
  falls back to `high` for a value this model has never served (a typo, another
  model's level). A session saved with `xhigh` is still fixed by re-picking a
  level in the composer.
- Docs (`README.md`) updated: two levels, and what the boot repair does to an
  old card and to an old `agent-default-model.reasoningEffort`.

## 0.3.0

**The listener is gone by default: the pin is injected in-process.** The old
reverse proxy remains as an opt-in escape hatch (`transport: proxy`).

- **New default `transport: fetch`**: the plugin wraps `globalThis.fetch` and
  rewrites the body of this gateway's `chat/completions` calls on the way out.
  No socket, no port, no second copy of the traffic. Justification, verified
  against the installed bundles: pi-ai builds a **new OpenAI client per request**
  (`api/openai-completions.js` → `createClient`, `fetch: options?.fetch`), the
  SDK then resolves `options.fetch ?? globalThis.fetch`, and `dsh-llm-pi-ai`
  never passes `fetch` — so the global is what actually carries the request, and
  a wrapper installed at boot is what carries every request after it.
- **Scoped to the gateway origin.** A global hook sees *every* provider's
  traffic, and `providerOptions` is not a field every OpenAI-compatible API
  accepts, so only URLs whose origin matches `upstream` and whose path is
  `/chat/completions` are considered; everything else is handed to the original
  fetch with the original arguments, synchronously and unmodified.
- **A silent bypass is made visible**: the running process writes
  `<DSH_HOME>/dsh-clinepass-status.json` with `hook` (`installed` /
  `unavailable` / `uninstalled` / `foreign`), `seen` / `pinned` / `skipped`
  counters and the last pin. Plugin `info` lines are not shown by every dsh
  front end, so without this a hook that stopped firing would look healthy. An
  installed hook re-checks `globalThis.fetch` every 30 seconds, so a post-install
  replacement by another plugin turns into `hook: "foreign"` instead of a frozen
  `installed`; only the instance that currently owns the global publishes, so a
  reload's older instance cannot overwrite the live record.
  `statusFile: false` (or a custom path) is supported; the file holds no
  credentials.
- **The profile migrates itself**: `provisionProfile` now takes the base URL from
  `apply()` (the gateway origin on `fetch`, the bound listener on `proxy`), so an
  install coming from 0.2.0 has its card repaired from
  `http://127.0.0.1:8791/api/v1` to `https://api.cline.bot/api/v1` at the next
  start — verified end to end through a real dsh run.
- **Hook lifecycle**: installing twice cannot grow a chain of wrappers (a marked
  wrapper is unwrapped back to the real fetch, so a reload restores the original
  in one step), re-installing an installed hook is a no-op, a fetch replaced by
  someone else after us is left alone on uninstall, a missing global fetch is
  reported instead of guessed at, and any error inside the hook degrades to an
  ordinary unpinned request. A synchronous throw from a wrapped function is
  turned into a rejected promise, because that is what `fetch` does; a wrapped
  function that calls `globalThis.fetch` synchronously (which would otherwise
  re-enter the hook forever and starve the event loop) is refused with a clear
  error.
- **A `listen` value that only the proxy transport uses is no longer parsed
  eagerly**: a malformed leftover in a loader row used to abort `apply()` on the
  `fetch` transport, and is now reported through the provisioning outcome
  instead. An `upstream` that is not a URL, and a per-model `pins` entry of `[]`
  that silently disables pinning while `pin` is set, are both reported at boot.
- `install.mjs` writes the canonical portless row by default; `--port` now
  implies `--transport proxy`, and `--transport` selects it explicitly.
  `test-install.mjs` covers the round trip between both row shapes.
- `smoke-test.mjs` verifies the live process through the status file (with a pid
  liveness check, so a record left by a finished run cannot be mistaken for a
  live hook), asserts nothing is listening on the old proxy port, and runs its
  own pinned turn through the real gateway.
- **`reasoningEffort: max` is a first-class level.** `max` is part of pi-ai's own
  escalation order (`off/minimal/low/medium/high/xhigh/max`) and a profile may
  declare it, so the declared levels are `{ high: high, xhigh: max, max: max }` —
  `xhigh` kept as the older alias, both dispatching `reasoning_effort: "max"`.
  Every value any generation of this plugin wrote is therefore valid and nothing
  is rewritten; a level the model does not declare is realigned to `high`, instead
  of the previous special-cased `max → xhigh`.
- **The repair reaches profiles that already exist.** `provisionProfile` used to
  maintain only `baseURL`, so a newly declared level (or a model entry that went
  missing) never reached an install that already had the card. It now reconciles
  the model entry's declared levels as well — merging rather than replacing, so a
  level the user added themselves survives — in the same single write as the
  address repair, and reports `repaired`.
- Added `test-fetch.mjs`: URL scoping, pass-through fidelity (argument identity),
  install/uninstall/reload/foreign-replacement semantics, per-model and empty
  pins, body shapes (string, Buffer, typed array, ArrayBuffer, stream, `Request`),
  robustness (throwing getters, upstream rejections, synchronous throws), the
  status file, and an integration pass through the real `fetch` against local
  servers with a negative control.

## 0.2.0

The route now lives where dsh can render it, so **the API key is entered on
Settings → Models**.

- **Architecture change**: the Cline Pass route is a plain pi-ai provider
  profile (`llm-pi-ai.providers.cline-pass`) instead of a custom `LlmAdapter`.
  The Models page renders a native key field only for the `llm-pi-ai` /
  `llm-deepseek` namespaces (`layoutOf`), and disables Save for anything else —
  a custom settings namespace could only ever show "edit settings.yaml".
  Streaming, tool calls, reasoning, usage and images now ride pi-ai's own,
  already-verified path.
- **The plugin is now a pin-injecting reverse proxy** (`127.0.0.1:8791` by
  default): it adds `providerOptions.gateway.only` to chat bodies and forwards
  everything else byte-for-byte, including streaming responses.
- **Zero dependencies**: only Node built-ins, so the proxy is one auditable file
  and the tests run without dsh's `node_modules`.
- **Self-provisioning**: on start the plugin creates the provider profile when it
  is absent and repairs a stale `baseURL` when the profile is recognisably ours;
  a profile that is not ours is left alone and reported through `/health`.
- **Hardened request path**: a client that dies mid-upload can no longer surface
  an unhandled rejection into dsh's fatal handler; chunked request bodies are
  accepted; a junk `providerOptions` value can no longer be spread into an
  object; a mid-stream upstream failure closes the connection instead of
  appending prose to the SSE body; response writes honour backpressure
  (measured: 64 KB buffered for a 6 MB body, against 5.6 MB before the fix).
- **Migrates a stored reasoning effort** the new route cannot serve: the adapter
  generation offered a level literally named `max`, which pi-ai rejects, so a
  leftover `agent-default-model.reasoningEffort: max` is realigned to `xhigh`
  (the same value on the wire) at boot. Disable with
  `alignReasoningEffort: false`.
- **`/health`** endpoint reporting the pin, the reachable address, the
  provisioning outcome and the effort alignment.
- Optional **`captureDir`** to dump request/response pairs for wire debugging.
- **Installer/uninstaller** are idempotent, back up before writing, and restore
  `cordis.patch.yml` byte-for-byte across the awkward shapes it can (an `[]`
  literal, entries with their own comment headers, CRLF line endings); two
  normalizations are documented — a file with no array at all gains `[]` and a
  file with no final line ending gains one. The settings
  surgery drops `providers.cline-pass` without touching a comment that documents
  the next provider or a sibling key.
- Added `test-proxy.mjs` (13 sections), `test-install.mjs`, `smoke-test.mjs`,
  `patch.example.yml`, README (中文 / English), LICENSE.

## 0.1.0

First cut: a self-contained `LlmAdapter` for provider `cline-pass`, pinned with
`providerOptions.gateway.only = ["deepseek"]`, key from the credential store.
Worked, but its configuration surface was inert (the `installSection`
`setSource` hook hands over a getter, which was fed to the defaults helper as a
value), and the Models page could not offer a key field for a custom settings
namespace. Superseded by 0.2.0; the adapter generation is kept in the
verification workspace under `legacy-adapter-plugin/`.
