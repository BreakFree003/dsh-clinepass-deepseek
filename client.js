/**
 * dsh-clinepass —— 浏览器半边：**设置 → 模型 → Cline Pass** 卡片上的用量条。
 *
 * 为什么手写：dsh 的客户端插件通常用 tsdown + 共享 preset 构建，而那需要一份
 * dsh 源码 checkout；本机只有已安装的 profile，所以这里直接产出客户端模块系统
 * 要求的形状（契约见文件末尾）。产物只有 Node 内置模块之外的 **React**，而
 * React 由 web shell 的静态模块表提供，因此不需要写进 `dsh.client.external`。
 *
 * 挂载点：dsh 的 Models 设置页专门给外部插件留了
 * `settings.models.provider-card` 这个 slot（keyed，按 provider 所属的 settings
 * 命名空间派发）。本插件注册到 `llm-pi-ai` 这个 key 上，于是能拿到**每一条**
 * pi-ai 路由的卡片，再自己筛出 `cline-pass` —— 其它 provider 的卡片直接返回
 * null，一个字节都不多渲染。这是官方文档明确支持的扩展点
 * （`@deepseek-ai/dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts`），
 * 不是补丁，所以 dsh 升级不会把它打散。
 *
 * 数据从哪来：**不在浏览器里取**。dsh 的凭据设计是「密钥只能写、不能读」
 * （`credentials/set` 单向，没有任何 read 路径），所以浏览器拿不到 API key，
 * 也就无法直接请求 Cline。宿主半边把 key 从凭据库取出来、请求网关，再把**只有
 * 用量数字**的 JSON 挂在本文件读取的那条同源路径上。这条路径注册在 dsh 自己
 * 已经跑着的 HTTP 服务上（`ctx.connection.fetch.register`），**不是新端口、
 * 不是新监听**，而且走 dsh 自己的 Host/Origin 信任栅栏与浏览器 cookie 认证。
 *
 * 刻意不做的事：不缓存密钥、不把密钥写进 DOM、不引入任何第三方依赖、不改动
 * 卡片本身的结构（只在卡片内部追加一段只读信息）。
 *
 * 另有一个挂载点：composer 底部的 `conversation.composer.dock` 胶囊，显示宿主
 * 观察到**真实**上游 provider（`?status=1`，走同一条同源路径）—— 它同样只读，
 * 不判断、不告警、不改任何请求；匿名渠道（`openai-compatible-private`）只换配色
 * 与 tooltip。
 *
 * @module dsh-clinepass/client
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'dsh-clinepass',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      var React = require('react')
      // 明细面板挂 portal：dock 在页面底部、祖先链上随时可能出现 overflow/transform，
      // 绝对定位会在那里被裁掉。上游 usage 胶囊的弹层也是 portal（见
      // dsh-client-ui-chat 的 DialogPill），这里跟随同一套做法。
      var ReactDOM = require('react-dom')

      // ═══════════════════════════ 常量 ═══════════════════════════

      /** 卡片所属的 settings 命名空间：slot 的 key。 */
      var SETTINGS_NS = 'llm-pi-ai'

      /** 只在这条路由的卡片上渲染。 */
      var PROVIDER = 'cline-pass'

      /** 宿主半边的默认路径；宿主会通过 index 注入把真实值送到这个全局。 */
      var DEFAULT_ROUTE = '/api/clinepass.usage'

      /** 宿主注入的路由表（`webServer/index-inject` 的 global 行）。 */
      var BOOT_GLOBAL = '__DSH_CLINEPASS__'

      /** 三个窗口，按显示顺序；`type` 就是网关返回的那个字符串。 */
      var WINDOWS = ['five_hour', 'weekly', 'monthly']

      /** 倒计时刷新间隔：窗口以小时/天计，30 秒足够准，也不会一直重渲染。 */
      var TICK_MS = 30 * 1000

      /** 浏览器到 dsh 这一段的超时；宿主那一段另有 usageTimeoutMs。 */
      var CLIENT_TIMEOUT_MS = 20 * 1000

      // 主题 token 取自 dsh 自己的设计变量，各带一个回退值：token 改名时
      // 样子会退回中性灰，而不是变成透明或黑块。
      var LABEL_PRIMARY = 'var(--dsw-alias-label-primary, #1f2329)'
      var LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'
      var LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, #9ca3af)'
      var BORDER = 'var(--dsw-alias-border-l2, #e5e7eb)'
      var TRACK = 'var(--dsw-alias-bg-layer-3, #eceef1)'
      var OK = 'var(--dsw-alias-state-success-primary, #12a150)'
      var WARN = 'var(--dsw-alias-state-warn-primary, #d97706)'
      var DANGER = 'var(--dsw-alias-state-error-primary, #dc2626)'
      var LINK = 'var(--dsw-alias-link, #2563eb)'

      // ═══════════════════════════ 文案 ═══════════════════════════
      // 刻意只在文件里放中英两套，而不去 locale 注册表里占一个命名空间：本插件
      // 的文本量是十几个 key，注册一个命名空间会让「重复注册」成为一次热重载
      // 的失败点，而收益只是少两行字典。当前语言仍然读 dsh 自己的 locale 服务，
      // 所以「设置 → 通用 → 语言」切到英文时这里会跟着切。

      var TEXT = {
        zh: {
          // 标题里点明是「剩余」：右边那个百分比是裸数字，不写清楚就只能靠猜
          // 它到底是已用还是剩余 —— 这正是这次改动要消掉的不确定性。
          title: 'ClinePass 剩余用量',
          refresh: '刷新',
          loading: '读取中…',
          updated: '更新于 {time}',
          left: '剩余 {percent}%',
          resetsIn: '{when} 后重置',
          resetsAt: '{time} 重置',
          resetting: '即将重置',
          noKey: '还没填 API 密钥 —— 在下面「API 密钥」里填入后保存。',
          unauthorized: '网关拒绝了这把 API 密钥，请重新填写。',
          rateLimited: '网关正在限流，稍后再试。',
          unavailable: '网关暂时不可用。',
          timeout: '读取用量超时了。',
          network: '连不上网关。',
          parse: '网关返回了读不懂的内容。',
          noCredentials: '这个 dsh 没有可读的凭据库。',
          internal: '读取失败，细节见 dsh 日志。',
          unmounted: '这个 dsh 没有挂载用量路由（`usage: false`？）。',
          empty: '网关没有返回任何窗口。',
          retry: '重试',
          five_hour: '5 小时',
          weekly: '每周',
          monthly: '每月',
          providerTitle: 'ClinePass 提供方',
          providerAwaiting: '等待 API 返回…',
          providerAnonymizedTooltip: 'deepseek 渠道已被网关匿名化为 openai-compatible-private（contributor 档：数据可能用于训练，无 ZDR）',
          spendTitle: '官方定价累计',
          spendSince: '自 {time} 起',
          spendReset: '重置为 0',
          spendResetHint: '以当前累计值为新起点，把显示的数字归零',
          spendConfirm: '确认重置？',
          spendHint: '按 DeepSeek 官方峰谷价累计；旧会话的历史不计入',
          // ── 成本（官方峰谷价）──
          costTitle: 'DeepSeek 官方价（按每次请求发生的时刻判峰谷）',
          costActual: '实际 {cost}',
          costPeak: '若全按高峰价 {cost}',
          costSubagents: '含 {count} 个子代理会话',
          // ── 展开后的明细面板 ──
          panelTitle: '官方价明细',
          panelSelf: '本会话',
          panelSubagents: '子代理（{count} 个）',
          panelPeak: '峰时段 {cost}',
          panelOff: '谷时段 {cost}',
          panelInput: '输入（未命中）',
          panelCacheRead: '缓存命中读取',
          panelCacheWrite: '缓存写入',
          panelOutput: '输出',
          panelCacheHit: '缓存命中 {percent}%',
          panelClinepass: 'ClinePass 计费',
          panelEmpty: '这个对话还没有计费请求',
        },
        en: {
          title: 'ClinePass remaining usage',
          refresh: 'Refresh',
          loading: 'Loading…',
          updated: 'updated {time}',
          left: '{percent}% left',
          resetsIn: 'resets in {when}',
          resetsAt: 'resets {time}',
          resetting: 'resetting now',
          noKey: 'No API key yet — enter one under “API key” below and save.',
          unauthorized: 'The gateway rejected this API key; enter it again.',
          rateLimited: 'The gateway is rate limiting; try again shortly.',
          unavailable: 'The gateway is temporarily unavailable.',
          timeout: 'The usage read timed out.',
          network: 'Could not reach the gateway.',
          parse: 'The gateway answered with something unreadable.',
          noCredentials: 'This dsh has no readable credential store.',
          internal: 'The read failed; see the dsh log.',
          unmounted: 'This dsh is not serving the usage route — is the feature disabled?',
          empty: 'The gateway reported no windows.',
          retry: 'Retry',
          five_hour: '5-hour',
          weekly: 'Weekly',
          monthly: 'Monthly',
          providerTitle: 'ClinePass Provider',
          providerAwaiting: 'Awaiting API response…',
          providerAnonymizedTooltip: 'deepseek channel anonymized by gateway as openai-compatible-private (contributor tier: data may be used for training, no ZDR)',
          spendTitle: 'List-price total',
          spendSince: 'since {time}',
          spendReset: 'Reset to 0',
          spendResetHint: 'Make the current total the new starting point and show 0',
          spendConfirm: 'Confirm reset?',
          spendHint: 'Accumulated at the DeepSeek list price; history of older sessions is excluded',
          // ── cost (official peak/off-peak price) ──
          costTitle: 'DeepSeek list price (peak/off-peak by the time of each request)',
          costActual: 'actual {cost}',
          costPeak: 'all-peak {cost}',
          costSubagents: 'incl. {count} subagent sessions',
          // ── expanded breakdown panel ──
          panelTitle: 'List-price breakdown',
          panelSelf: 'This session',
          panelSubagents: 'Subagents ({count})',
          panelPeak: 'Peak {cost}',
          panelOff: 'Off-peak {cost}',
          panelInput: 'Input (uncached)',
          panelCacheRead: 'Cache reads',
          panelCacheWrite: 'Cache writes',
          panelOutput: 'Output',
          panelCacheHit: 'Cache hit {percent}%',
          panelClinepass: 'ClinePass billing',
          panelEmpty: 'No billable requests in this conversation yet',
        },
      }

      /** 取一套文案并把 `{name}` 占位替换掉。 */
      function fill(template, values) {
        return String(template).replace(/\{(\w+)\}/g, function (whole, name) {
          return values !== undefined && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
        })
      }

      // ═══════════════════════════ 纯函数 ═══════════════════════════

      /** 宿主注入的用量路径，拿不到就用默认值（静态部署等边缘情况）。 */
      function usageRoute() {
        var boot = window[BOOT_GLOBAL]
        if (boot !== null && typeof boot === 'object' && typeof boot.usageRoute === 'string' && boot.usageRoute.length > 0) return boot.usageRoute
        return DEFAULT_ROUTE
      }

      /**
       * 宿主是否挂载了用量路由。
       *
       * `usage: false` 只让宿主不注册路由，**不会**把浏览器半边从页面上拿掉
       * （bundle 是从 package.json 发现并加载的，跟配置无关）。所以宿主会显式
       * 广播 `enabled: false`，让这张卡片干脆不渲染 —— 否则它会去请求一条不存在的
       * 路径、拿到 404 页面，然后一直显示"连不上网关"，而那只刷新按钮永远修不好它。
       * 老宿主没有这个字段时按"挂载了"处理，保持旧行为。
       */
      function usageEnabled() {
        var boot = window[BOOT_GLOBAL]
        if (boot !== null && typeof boot === 'object' && boot.enabled === false) return false
        return true
      }

      /** 累计值路由（宿主注入；缺省同上，读不到就整段不显示）。 */
      function spendRoute() {
        var boot = window[BOOT_GLOBAL]
        if (boot !== null && typeof boot === 'object' && typeof boot.spendRoute === 'string' && boot.spendRoute.length > 0) return boot.spendRoute
        return '/api/clinepass.spend'
      }

      /** 累计值请求路径（同源，不需要 origin）。 */
      function spendUrl() {
        var base = spendRoute()
        try {
          return new URL(base, 'http://127.0.0.1:3080').pathname
        } catch {
          return base
        }
      }

      /**
       * 请求 URL。用 `URL` 而不是字符串拼 `?refresh=1`：`usageRoute` 是可配置的，
       * 一个已经带查询串的路径（`/api/x?token=y`）拼出来就是个坏 URL。
       */
      function usageUrl(force) {
        var route = usageRoute()
        if (force !== true) return route
        try {
          var url = new URL(route, window.location.origin)
          url.searchParams.set('refresh', '1')
          return url.pathname + url.search
        } catch (error) {
          return route
        }
      }

      /**
       * 不是宿主那封信的响应 → 失败原因。
       *
       * 按状态码分，而不是一律 `network`：404 是"宿主没挂这条路由"，5xx 是
       * "dsh 自己出问题了"，两者都不该把用户引去查本机到网关的网络。
       */
      function statusReason(status) {
        if (status === 401 || status === 403) return 'unauthorized'
        if (status === 404) return 'unmounted'
        if (status === 429) return 'rateLimited'
        if (status >= 500) return 'unavailable'
        return 'http'
      }

      /**
       * 把剩余毫秒说成人话。窗口最长一个月，所以「天」一定要有；
       * 超过一天时不再显示分，避免一行数字读不过来。
       *
       * @param ms - 距离重置的毫秒数。
       * @param zh - 是否用中文单位。
       */
      function remainingText(ms, zh) {
        if (!isFinite(ms)) return ''
        if (ms <= 0) return ''
        var minutes = Math.floor(ms / 60000)
        var hours = Math.floor(minutes / 60)
        var days = Math.floor(hours / 24)
        if (days > 0) return days + (zh ? ' 天 ' : 'd ') + (hours % 24) + (zh ? ' 小时' : 'h')
        if (hours > 0) return hours + (zh ? ' 小时 ' : 'h ') + (minutes % 60) + (zh ? ' 分' : 'm')
        return minutes + (zh ? ' 分钟' : 'm')
      }

      /**
       * 网关只给 `percentUsed`（响应里没有绝对额度字段），所以「剩余」只能是
       * `100 - 已用`。先按一位小数收口再取差：直接 `100 - 82.4` 会得到
       * `17.599999999999994` 这种浮点尾巴，而那不是「剩余 17.6%」。
       */
      function remainingPercent(used) {
        var value = Math.round((100 - used) * 10) / 10
        return Math.max(0, Math.min(100, value))
      }

      /**
       * 一条窗口记录，读不懂就返回 null。
       *
       * 这不是多余的谨慎。宿主侧的 `normalizeUsage` 已经筛过一遍，但
       * `usageRoute` 是可配置的 —— 指向别的东西时，`limits` 里一个 `null` 元素
       * 就会在渲染里对 `limit.type` 抛异常，而 slot 的 error boundary 会把它吞成
       * 一个**不可见的空 div**，并且这一格 keyed slot 就此作废：整张卡片在本次
       * 页面会话里再也不会出现，界面上没有任何解释。宁可少画一行。
       *
       * 顺带挡住 `NaN`：`Math.min(100, Math.max(0, NaN))` 还是 `NaN`，那会画成一条
       * 0 宽、**绿色**、写着 `NaN%` 的条 —— 一个看起来完全健康的坏值。
       * `percentUsed: null` 更糟：`100 - null` 是 100，会显示成「剩余 100%」。
       */
      function normalizeLimit(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
        var used = value.percentUsed
        if (typeof used !== 'number' || isFinite(used) !== true) return null
        var at = typeof value.resetsAt === 'string' ? new Date(value.resetsAt) : null
        return {
          remaining: remainingPercent(used),
          resetsAt: at !== null && isNaN(at.getTime()) === false ? at : null,
        }
      }

      /** 剩余量分档：决定进度条的颜色。剩余 ≤10% 是红，≤30% 是黄。 */
      function severityColor(remaining) {
        if (remaining <= 10) return DANGER
        if (remaining <= 30) return WARN
        return OK
      }

      /**
       * 宿主失败原因 → 文案 key。
       *
       * 宿主说的是连字符形式（`no-key`），文案表用的是驼峰，所以这里必须有一张
       * 显式的表：靠字符串变形去猜（连字符转驼峰）会在加一个原因时静默退回
       * 「读取失败」，而那正是最难查的一类 bug。认不出的原因一律 `internal`。
       */
      var REASON_KEY = {
        'no-key': 'noKey',
        unmounted: 'unmounted',
        'no-credentials': 'noCredentials',
        unauthorized: 'unauthorized',
        'rate-limited': 'rateLimited',
        unavailable: 'unavailable',
        timeout: 'timeout',
        network: 'network',
        parse: 'parse',
        http: 'internal',
        internal: 'internal',
      }

      /** 失败原因 → 一句人话；认不出的原因退回「读取失败」。 */
      function reasonText(reason, t) {
        var key = typeof reason === 'string' ? REASON_KEY[reason] : undefined
        return key !== undefined ? t[key] : t.internal
      }

      // ═══════════════════════════ 组件 ═══════════════════════════

      /** 读 dsh 当前语言（'zh' / 'en'），拿不到就按英文。 */
      function useLanguage(ctx) {
        var locale = ctx.locale
        var usable = locale !== undefined && typeof locale.subscribe === 'function' && typeof locale.getSnapshot === 'function'
        // 两个回调的身份必须稳定，否则每次渲染都会退订再订阅一次。三个 hook 都
        // 无条件调用 —— 拿不到 locale 时退化成"永远英文"，而不是少调一个 hook。
        var subscribe = React.useCallback(
          function (notify) {
            return usable ? locale.subscribe(notify) : function () {}
          },
          [locale, usable],
        )
        var snapshot = React.useCallback(
          function () {
            if (!usable) return 'en'
            var current = locale.getSnapshot()
            return current !== null && typeof current === 'object' ? String(current.active) : 'en'
          },
          [locale, usable],
        )
        var active = React.useSyncExternalStore(subscribe, snapshot)
        return active.indexOf('zh') === 0 ? 'zh' : 'en'
      }

      /** 每 TICK_MS 变一次的时钟，只为让倒计时自己走。 */
      /**
       * 倒计时用的「现在」。`ticking` 为假时**不排定时器**。
       *
       * 这个 hook 在每一条 llm-pi-ai 卡片上都会被调用（hook 不能有条件），但
       * 只有本路由那张卡片真的需要它 —— 于是把"要不要跑"作为参数传进来。否则
       * 每多一个 provider 就多一个每 30 秒空转一次、只为了返回 null 的定时器。
       */
      function useNow(ticking) {
        var pair = React.useState(function () {
          return Date.now()
        })
        var now = pair[0]
        var setNow = pair[1]
        React.useEffect(
          function () {
            if (ticking !== true) return undefined
            var timer = window.setInterval(function () {
              setNow(Date.now())
            }, TICK_MS)
            return function () {
              window.clearInterval(timer)
            }
          },
          [ticking],
        )
        return now
      }

      /**
       * 一条窗口：标签 / 进度条 / **剩余**百分比 / 重置时间。
       *
       * 进度条画的是剩余量（油表：越满 = 剩得越多，快见底变红），和右边那个
       * 数字是同一个量 —— 数字说「剩 18%」而条子填了 82% 会自相矛盾。
       * @param props - `{ type, row, now, t, zh, locale }`，`row` 是 `normalizeLimit` 的产物。
       */
      function UsageRow(props) {
        var t = props.t
        var row = props.row
        var remaining = row.remaining
        var label = Object.prototype.hasOwnProperty.call(t, props.type) ? t[props.type] : String(props.type)
        var reset = row.resetsAt
        var resetMs = reset === null ? Number.NaN : reset.getTime() - props.now
        return React.createElement(
          'div',
          { style: { marginTop: 6 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement(
              'span',
              { style: { flex: '0 0 52px', fontSize: 12, color: LABEL_SECONDARY } },
              label,
            ),
            React.createElement(
              'div',
              {
                style: { flex: '1 1 auto', height: 6, borderRadius: 3, background: TRACK, overflow: 'hidden' },
                role: 'progressbar',
                'aria-valuenow': remaining,
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-label': label + ' ' + fill(t.left, { percent: remaining }),
              },
              React.createElement('div', {
                style: {
                  width: remaining + '%',
                  height: '100%',
                  borderRadius: 3,
                  background: severityColor(remaining),
                  transition: 'width .3s ease',
                },
              }),
            ),
            React.createElement(
              'span',
              {
                style: {
                  flex: '0 0 auto',
                  minWidth: 34,
                  textAlign: 'right',
                  fontSize: 12,
                  color: LABEL_PRIMARY,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              remaining + '%',
            ),
          ),
          reset === null
            ? null
            : React.createElement(
                'div',
                { style: { marginLeft: 60, fontSize: 11, color: LABEL_TERTIARY } },
                resetMs <= 0
                  ? t.resetting
                  : fill(t.resetsIn, { when: remainingText(resetMs, props.zh) }) +
                      ' · ' +
                      fill(t.resetsAt, { time: reset.toLocaleString(props.locale) }),
              ),
        )
      }

      /**
       * 卡片上追加的用量区。
       *
       * 收到的 owner props 是 `{ provider, configured, keyConfigured }`；本组件
       * 在**每一条** llm-pi-ai 卡片上都会被调用，所以第一件事就是把非本路由的
       * 卡片原样放过（返回 null）。
       */
      function UsageCard(props) {
        var ctx = props.ctx
        var entry = props.provider
        var isOurs = entry !== null && typeof entry === 'object' && entry.provider === PROVIDER
        var enabled = usageEnabled()
        var keyConfigured = props.keyConfigured
        var language = useLanguage(ctx)
        var zh = language === 'zh'
        var t = TEXT[language]
        var pair = React.useState({ status: 'loading', body: null })
        var state = pair[0]
        var setState = pair[1]
        // 只有本路由、且真的挂载了，才需要这个每 30 秒的定时器。
        var now = useNow(isOurs && enabled)
        // 手动刷新与自动刷新共用一个代次：后发的结果覆盖先发的，卸载后不回写。
        var generation = React.useRef(0)
        // 区分「刚挂载」与「key 变了」：前者走宿主缓存，后者强制绕过。
        var firstRead = React.useRef(true)

        // 官方定价累计：独立于额度卡的数据源（一个来自网关，一个来自本地投影缓存），
        // 读失败就整段不渲染 —— 不让它把额度卡拖成错误态。
        var spendPair = React.useState({ status: 'loading', body: null })
        var spendState = spendPair[0]
        var setSpendState = spendPair[1]
        // 0 = 没在确认；1 = 已点一次，等第二次。
        var armPair = React.useState(0)
        var resetArmed = armPair[0]
        var setResetArmed = armPair[1]
        var spendGeneration = React.useRef(0)
        var armTimer = React.useRef(null)

        var loadSpend = React.useCallback(function () {
          var mine = spendGeneration.current + 1
          spendGeneration.current = mine
          window
            .fetch(spendUrl(), { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (response) {
              return response.json().then(
                function (body) { return { response: response, body: body } },
                function () { return { response: response, body: null } },
              )
            })
            .then(function (result) {
              if (spendGeneration.current !== mine) return
              // 形状要够：`ok` 之外还得有 `cny` 与 `since`，否则整段不渲染 ——
              // 路由没挂上时这条请求可能拿到 usage 的响应或 HTML，不能当成累计值。
              if (
                result.body !== null &&
                typeof result.body === 'object' &&
                result.body.ok === true &&
                typeof result.body.cny === 'number' &&
                typeof result.body.since === 'string'
              ) {
                setSpendState({ status: 'ready', body: result.body })
                return
              }
              setSpendState({ status: 'failed', body: null })
            })
            .catch(function () {
              if (spendGeneration.current !== mine) return
              setSpendState({ status: 'failed', body: null })
            })
        }, [])

        var resetSpend = React.useCallback(function () {
          var mine = spendGeneration.current + 1
          spendGeneration.current = mine
          window
            .fetch(spendUrl(), {
              method: 'POST',
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            })
            .then(function (response) { return response.json() })
            .then(function (body) {
              if (spendGeneration.current !== mine) return
              if (body !== null && typeof body === 'object' && body.ok === true) setSpendState({ status: 'ready', body: body })
            })
            .catch(function () {})
            .then(function () { setResetArmed(0) })
        }, [])

        var load = React.useCallback(
          function (force) {
            var mine = generation.current + 1
            generation.current = mine
            // 函数式 setState：刷新时保留上一次的数（避免整块闪成"读取中"），
            // 而且不需要把 state 放进依赖里 —— 那会让 load 每次渲染都换身份。
            setState(function (previous) {
              return { status: 'loading', body: previous.body }
            })
            // 自己也要有超时：宿主只保证它到网关那一段（默认 15 秒）。没有这个，
            // 一个卡住的 dsh 会让卡片永远停在"读取中"，而刷新按钮在 loading 时是
            // 禁用的 —— 用户没有任何可点的东西。
            var controller = typeof AbortController === 'function' ? new AbortController() : null
            var timer =
              controller === null
                ? null
                : window.setTimeout(function () {
                    controller.abort()
                  }, CLIENT_TIMEOUT_MS)
            window
              .fetch(usageUrl(force), {
                headers: { accept: 'application/json' },
                credentials: 'same-origin',
                signal: controller === null ? undefined : controller.signal,
              })
              .then(function (response) {
                return response.json().then(
                  function (body) {
                    return { response: response, body: body }
                  },
                  function () {
                    return { response: response, body: null }
                  },
                )
              })
              .then(function (result) {
                if (generation.current !== mine) return
                if (result.body !== null && typeof result.body === 'object' && typeof result.body.ok === 'boolean') {
                  setState({ status: 'ready', body: result.body })
                  return
                }
                // 不是宿主那封信（404 页面、HTML 错误页、代理的 502……）。按状态码
                // 说人话，别一律报"连不上网关" —— 那会把用户引去查网络，而网关
                // 根本没被联系过。
                setState({ status: 'ready', body: { ok: false, reason: statusReason(result.response.status) } })
              })
              .catch(function (error) {
                if (generation.current !== mine) return
                var aborted = error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.name === 'TimeoutError')
                setState({ status: 'ready', body: { ok: false, reason: aborted ? 'timeout' : 'network' } })
              })
              .then(
                function () {
                  if (timer !== null) window.clearTimeout(timer)
                },
                function () {
                  if (timer !== null) window.clearTimeout(timer)
                },
              )
          },
          [],
        )

        // 挂载时读一次（走宿主缓存，不白打一次网关）；之后 key 的「已配置」状态
        // 一变（用户在下面保存了新 key）就**强制**再读一次 —— 强制是必要的：宿主
        // 对失败也有一小段短期缓存，不强制的话「填好新 key，下一次看就是新的」会被
        // 那几秒挡掉。首读与"key 变了"要分开，所以用一个 ref 记住是不是第一次。
        React.useEffect(
          function () {
            if (!isOurs || !enabled) return undefined
            var force = firstRead.current !== true
            firstRead.current = false
            load(force)
            loadSpend()
            return function () {
              generation.current += 1
              spendGeneration.current += 1
            }
          },
          [isOurs, enabled, load, loadSpend, keyConfigured],
        )

        // 确认态 4 秒后自动撤回：用户点了「重置」却不想确认时，不该一直悬着。
        React.useEffect(function () {
          if (resetArmed === 0) return undefined
          armTimer.current = window.setTimeout(function () {
            setResetArmed(0)
          }, 4000)
          return function () {
            window.clearTimeout(armTimer.current)
          }
        }, [resetArmed])

        if (!isOurs || !enabled) return null

        var body = state.body
        var failed = body !== null && body.ok !== true
        // 逐条收窄再渲染：一个坏元素不值得让整张卡片（连同 keyed slot 的那一格）
        // 消失。而且这里**按 `WINDOWS` 取值**而不是遍历响应数组：顺序因此固定，
        // 网关的实验性窗口不会被画上来，重复的 type 也只取第一条 —— 和宿主侧
        // `normalizeUsage` 是同一套规则，所以那条响应换个顺序、多几个字段都不会
        // 改变这张卡片的样子。
        var byType = Object.create(null)
        if (body !== null && body.ok === true && Array.isArray(body.limits)) {
          for (var index = 0; index < body.limits.length; index += 1) {
            var candidate = body.limits[index]
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
            if (typeof candidate.type !== 'string' || byType[candidate.type] !== undefined) continue
            byType[candidate.type] = candidate
          }
        }
        var limits = []
        for (var position = 0; position < WINDOWS.length; position += 1) {
          var type = WINDOWS[position]
          if (byType[type] === undefined) continue
          var row = normalizeLimit(byType[type])
          if (row !== null) limits.push({ type: type, row: row })
        }
        var updated = body !== null && typeof body.fetchedAt === 'string' ? new Date(body.fetchedAt) : null
        var localeId = zh ? 'zh-CN' : 'en'

        return React.createElement(
          'div',
          {
            style: {
              marginTop: 10,
              paddingTop: 8,
              borderTop: '1px solid ' + BORDER,
              fontSize: 12,
              lineHeight: 1.5,
              color: LABEL_PRIMARY,
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            React.createElement('span', { style: { fontWeight: 600, color: LABEL_SECONDARY } }, t.title),
            React.createElement('span', { style: { flex: '1 1 auto' } }),
            updated !== null && !Number.isNaN(updated.getTime())
              ? React.createElement('span', { style: { color: LABEL_TERTIARY, fontSize: 11 } }, fill(t.updated, { time: updated.toLocaleTimeString(localeId) }))
              : null,
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  load(true)
                },
                disabled: state.status === 'loading',
                style: {
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  cursor: state.status === 'loading' ? 'default' : 'pointer',
                  color: state.status === 'loading' ? LABEL_TERTIARY : LINK,
                  font: 'inherit',
                  fontSize: 11,
                },
              },
              state.status === 'loading' ? t.loading : t.refresh,
            ),
          ),
          failed
            ? React.createElement(
                'div',
                { style: { marginTop: 6, color: LABEL_SECONDARY } },
                reasonText(body.reason, t),
                body.ok !== true && body.reason !== 'no-key'
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        onClick: function () {
                          load(true)
                        },
                        disabled: state.status === 'loading',
                        style: {
                          border: 'none',
                          background: 'none',
                          padding: '0 0 0 8px',
                          cursor: state.status === 'loading' ? 'default' : 'pointer',
                          color: state.status === 'loading' ? LABEL_TERTIARY : LINK,
                          font: 'inherit',
                        },
                      },
                      t.retry,
                    )
                  : null,
              )
            : null,
          !failed && state.status === 'ready' && limits.length === 0
            ? React.createElement('div', { style: { marginTop: 6, color: LABEL_SECONDARY } }, t.empty)
            : null,
          !failed && limits.length === 0 && state.status === 'loading'
            ? React.createElement('div', { style: { marginTop: 6, color: LABEL_TERTIARY } }, t.loading)
            : null,
          limits.map(function (item) {
            return React.createElement(UsageRow, { key: item.type, type: item.type, row: item.row, now: now, zh: zh, locale: localeId, t: t })
          }),
          spendState.status === 'ready' && spendState.body !== null && spendState.body.ok === true
            ? (function () {
                var spend = spendState.body
                var since = typeof spend.since === 'string' ? new Date(spend.since) : null
                var sinceText = since !== null && !Number.isNaN(since.getTime())
                  ? since.toLocaleString(localeId, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                  : '--'
                var amount = typeof spend.cny === 'number' && isFinite(spend.cny) ? spend.cny : 0
                var amountText = amount <= 0 ? '¥0.00' : '¥' + amount.toFixed(amount < 0.01 ? 4 : 2)
                return React.createElement(
                  'div',
                  {
                    'data-clinepass-spend': '',
                    style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid ' + BORDER },
                  },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
                    React.createElement('span', { style: { fontWeight: 600, color: LABEL_SECONDARY } }, t.spendTitle),
                    React.createElement('span', { style: { flex: '1 1 auto' } }),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        'data-clinepass-spend-reset': '',
                        onClick: function () {
                          if (resetArmed === 0) {
                            setResetArmed(1)
                            return
                          }
                          resetSpend()
                        },
                        title: t.spendResetHint,
                        style: {
                          border: 'none',
                          background: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          color: resetArmed === 0 ? LINK : WARN,
                          font: 'inherit',
                          fontSize: 11,
                        },
                      },
                      resetArmed === 0 ? t.spendReset : t.spendConfirm,
                    ),
                  ),
                  React.createElement('div', { style: { color: LABEL_TERTIARY, fontSize: 11, marginTop: 2 } }, fill(t.spendSince, { time: sinceText })),
                  React.createElement(
                    'div',
                    { style: { fontSize: 18, fontWeight: 600, lineHeight: 1.4, fontVariantNumeric: 'tabular-nums' } },
                    amountText,
                  ),
                    React.createElement('div', { style: { color: LABEL_TERTIARY, fontSize: 11 } }, t.spendHint),
                )
              })()
            : null,
        )
      }

      // ═══════════════════════════ 状态栏提供方胶囊 ═══════════════════════════

      /** 状态查询路径：复用 usageRoute 的 ?status=1 查询。 */
      function statusUrl(sessionId, model) {
        var base = usageRoute()
        try {
          var origin = (typeof window !== 'undefined' && window.location && (window.location.origin || window.location.href)) || 'http://127.0.0.1:3080'
          var u = new URL(base, origin)
          u.searchParams.set('status', '1')
          if (sessionId) u.searchParams.set('sessionId', sessionId)
          if (model) u.searchParams.set('model', model)
          return u.pathname + u.search
        } catch {
          return base + '?status=1'
        }
      }

      function ServerIcon() {
        return React.createElement('svg', {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { flex: 'none' },
        }, [
          React.createElement('rect', { key: 'r1', x: 2, y: 3, width: 12, height: 4, rx: 1 }),
          React.createElement('rect', { key: 'r2', x: 2, y: 9, width: 12, height: 4, rx: 1 }),
          React.createElement('circle', { key: 'c1', cx: 4.5, cy: 5, r: 0.5, fill: 'currentColor' }),
          React.createElement('circle', { key: 'c2', cx: 4.5, cy: 11, r: 0.5, fill: 'currentColor' }),
        ])
      }

      /** 警示三角：匿名渠道与回退池都用它 —— 两种都是「不是你以为的那条直连」。 */
      function WarningIcon() {
        return React.createElement('svg', {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: WARN,
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { flex: 'none' },
        }, [
          React.createElement('path', {
            key: 'p1',
            d: 'M8 2.5L14 13.5H2L8 2.5Z',
          }),
          React.createElement('line', { key: 'l1', x1: 8, y1: 6.5, x2: 8, y2: 9.5 }),
          React.createElement('circle', { key: 'c1', cx: 8, cy: 11.5, r: 0.5, fill: 'currentColor' }),
        ])
      }

      // ═══════════════════════════ 成本（官方峰谷价）═══════════════════════════

      /**
       * 金额格式化：¥ 前缀 + 动态位数。
       *
       * 一次对话常常只有几分钱（本机实测一条 66 次请求的会话 ¥0.39，单轮 ¥0.003），
       * 固定两位会全变成 0.00；这里按量级给 4/3/2 位。四舍五入后归零的极小值写成
       * `¥0.0001`，不写一个骗人的 `¥0.0000`。
       *
       * @param value - 人民币金额。
       * @returns 展示文本；非正数返回 null（不显示）。
       */
      function formatCny(value) {
        if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null
        var digits = value < 0.01 ? 4 : value < 1 ? 3 : 2
        var text = value.toFixed(digits)
        if (Number(text) === 0) return '¥' + (1 / Math.pow(10, digits)).toFixed(digits)
        return '¥' + text
      }

      /**
       * 紧凑数字：明细里 token 是 6~7 位数，写全了会把面板撑爆。
       *
       * @param value - token 数。
       * @returns `1.23M` / `12.3k` / `999` 这样的文本。
       */
      function formatCompact(value) {
        if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '0'
        if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
        if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k'
        return String(Math.round(value))
      }

      /**
       * 缓存命中率（按计费口径）：命中读 /（命中读 + 未命中输入 + 缓存写入）。
       *
       * @param tokens - `{ cacheRead, uncachedInput, cacheWrite }`。
       * @returns 百分比整数，没有可计费输入时为 null。
       */
      function cacheHitPercent(tokens) {
        var billed = tokens.cacheRead + tokens.uncachedInput + tokens.cacheWrite
        if (!(billed > 0)) return null
        // 两位小数：99.87% 和 99% 对「缓存有没有真的命中」是两种结论。
        return Math.round((tokens.cacheRead / billed) * 10000) / 100
      }

      /**
       * 把一个成本投影视图（wire 值）规整成数字。
       *
       * 投影是**插件注册的**：没加载、被禁用、或宿主没挂 sessionProjections 时，
       * `projectionValues.clinepassCost` 就是 undefined —— 那时整段成本不显示，
       * 胶囊退回原来的「只看 Provider」。这是降级，不是错误。
       *
       * @param view - `clinepassCost` 的视图，可能缺席。
       * @returns `{ cny, cnyPeak, requests }`，没有时为 null。
       */
      /** 空成本：所有字段归零，方便聚合时统一相加。 */
      function emptyCost() {
        return {
          cny: 0,
          cnyPeak: 0,
          peakCny: 0,
          offCny: 0,
          requests: 0,
          peakRequests: 0,
          tokens: { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0 },
        }
      }

      /**
       * 把一个成本投影视图（wire 值）规整成数字。
       *
       * 投影是**插件注册的**：没加载、被禁用、或宿主没挂 sessionProjections 时，
       * `projectionValues.clinepassCost` 就是 undefined —— 那时整段成本不显示，
       * 胶囊退回原来的「只看 Provider」。这是降级，不是错误。
       *
       * @param view - `clinepassCost` 的视图，可能缺席。
       * @returns 成本对象（含 `pricing`），没有时为 null。
       */
      function costOfValue(view) {
        if (!view || typeof view !== 'object') return null
        var number = function (raw) {
          return typeof raw === 'number' && isFinite(raw) ? raw : 0
        }
        var tokens = view.tokens && typeof view.tokens === 'object' ? view.tokens : {}
        var cost = emptyCost()
        cost.cny = number(view.cny)
        cost.cnyPeak = number(view.cnyPeak)
        cost.peakCny = number(view.peakCny)
        cost.offCny = number(view.offCny)
        cost.requests = number(view.requests)
        cost.peakRequests = number(view.peakRequests)
        cost.tokens = {
          cacheRead: number(tokens.cacheRead),
          uncachedInput: number(tokens.uncachedInput),
          cacheWrite: number(tokens.cacheWrite),
          output: number(tokens.output),
        }
        cost.pricing = typeof view.pricing === 'string' ? view.pricing : null
        return cost
      }

      /** 把 `part` 累加进 `total`（就地改 `total`，调用方负责只传自己的副本）。 */
      function addCostInto(total, part) {
        total.cny += part.cny
        total.cnyPeak += part.cnyPeak
        total.peakCny += part.peakCny
        total.offCny += part.offCny
        total.requests += part.requests
        total.peakRequests += part.peakRequests
        total.tokens.cacheRead += part.tokens.cacheRead
        total.tokens.uncachedInput += part.tokens.uncachedInput
        total.tokens.cacheWrite += part.tokens.cacheWrite
        total.tokens.output += part.tokens.output
        return total
      }

      /**
       * 从一个会话行里取成本投影的视图。
       *
       * @param summary - sessions 列表的一行。
       * @returns 成本对象，没有时为 null。
       */
      function costOfSession(summary) {
        if (!summary || !summary.projectionValues) return null
        return costOfValue(summary.projectionValues.clinepassCost)
      }

      /**
       * 这个会话是不是当前对话的子代理（任意深度）。
       *
       * 规则与上游 `dsh-client-ui-chat` 的 `isSubagentOf` 一致：沿 `parentId` 向上走，
       * 每一步父会话的 `origin` 都必须是 `subagent`，中途遇到非子代理祖先就停 ——
       * 所以 fork 自己派出的子代理算在 fork 头上，不会重复算回 fork 的来源会话。
       *
       * @param byId - sessions 列表 store。
       * @param summary - 待判定的会话行。
       * @param sessionId - 当前打开的会话。
       */
      function isSubagentOf(byId, summary, sessionId) {
        var seen = new Set([summary.id])
        var parentId = summary.parentId
        while (parentId !== undefined && !seen.has(parentId)) {
          if (parentId === sessionId) return true
          seen.add(parentId)
          var parent = byId[parentId]
          if (parent === undefined || parent.origin !== 'subagent') return false
          parentId = parent.parentId
        }
        return false
      }

      /**
       * 当前对话下所有子代理会话的成本合计（含每个子代理的明细，展开面板用）。
       *
       * 每个子代理行带的是**它自己**的成本（投影跳过 seeded 继承前缀），所以这里直接
       * 相加不会把父会话的历史算第二遍。
       *
       * @param byId - sessions 列表 store。
       * @param sessionId - 当前会话。
       * @returns 合计对象（额外带 `count`），没有子代理时 undefined。
       */
      function subagentCostOf(byId, sessionId) {
        if (sessionId === undefined || byId === undefined) return undefined
        var total
        var subagentCount = 0
        var ids = Object.keys(byId)
        for (var index = 0; index < ids.length; index += 1) {
          var summary = byId[ids[index]]
          if (!summary || summary.origin !== 'subagent') continue
          var cost = costOfSession(summary)
          if (cost === null || !isSubagentOf(byId, summary, sessionId)) continue
          if (total === undefined) total = emptyCost()
          addCostInto(total, cost)
          subagentCount += 1
        }
        // 刚 spawn / 还没结算的子代理成本是 0：当成「没有子代理」，别渲染「含 0 个子代理」。
        if (total === undefined || (total.cny === 0 && total.requests === 0)) return undefined
        total.count = subagentCount
        return total
      }

      /** `useSessions` 的兜底：dock 契约总会给，这里保证缺了也不炸（返回空 store）。 */
      var EMPTY_SESSION_LIST = { byId: {} }
      function selectEmptySessions(selector) {
        return selector(EMPTY_SESSION_LIST)
      }

      /**
       * 成本合计的相等判断：**面板渲染的每个字段**都要比。
       *
       * 只比 4 个字段时，peakCny / offCny / tokens 变了而它们没变，`useSyncExternalStore`
       * 会保留旧选中值 —— 面板停在旧数字上（要求碰巧相等，概率低，但相等函数写错就是错）。
       */
      function sameCostView(left, right) {
        if (left === right) return true
        if (!left || !right) return false
        if (left.cny !== right.cny || left.cnyPeak !== right.cnyPeak) return false
        if (left.peakCny !== right.peakCny || left.offCny !== right.offCny) return false
        if (left.requests !== right.requests || left.peakRequests !== right.peakRequests) return false
        if (left.count !== right.count) return false
        if (left.selfCny !== right.selfCny || left.subagentCny !== right.subagentCny) return false
        var a = left.tokens
        var b = right.tokens
        if (a === undefined || b === undefined) return a === b
        return a.cacheRead === b.cacheRead && a.uncachedInput === b.uncachedInput && a.cacheWrite === b.cacheWrite && a.output === b.output
      }

      /**
       * 底部状态栏（conversation.composer.dock）的 Provider 胶囊。
       * 随 API 响应动态更新，仅对 Clinepass 的模型生效显示。
       *
       * **每一个 hook 都必须在早退之前无条件调用**（和下面的 {@link UsageCard} 一样）。
       * 这不是风格问题：`isClinepass` 会在会话中途由 false 变 true —— 新会话在第一次
       * `request/header` 之前，`modelSelection` 投影是 `{lastUsed:null,next:null}`
       * （init 见 dsh-api-session-controller 的 model-selection-projection），此时
       * `sel` 为 null、`isClinepass` 为 false；请求一落盘，同一个 fiber 就要开始调用
       * 下面那 12 个 hook。把 `return null` 放在 hook 前面 = hook 数量从 1 跳到 13，
       * React 抛 "Rendered more hooks than during the previous render"，slot 错误边界
       * 把这一格永久换成 `<div data-slot-error>` —— 胶囊整页消失，只有刷新页面
       * （投影从持久化日志回放，第一帧就一致）才回来。这个坑真踩过一次（0.11.3）。
       */
      function ClinepassProviderPill(props) {
        var useProjection = props.useProjection
        var sessionId = props.sessionId
        var useSession = props.useSession
        var useSessions = props.useSessions
        var ctx = props.ctx

        var modelSelection = useProjection ? useProjection('modelSelection') : null
        var sel = modelSelection ? (modelSelection.lastUsed || modelSelection.next) : null
        var isClinepass = false
        if (sel) {
          if (sel.provider === PROVIDER) isClinepass = true
          if (typeof sel.model === 'string' && sel.model.indexOf(PROVIDER + '/') === 0) isClinepass = true
        }

        // 成本（DeepSeek 官方峰谷价）。两个订阅同样在早退之前无条件调用：
        // - 本会话：插件注册的 `clinepassCost` 投影（宿主按每条请求的时刻计价）；
        // - 子代理会话：sessions 列表里每一行自带的同名投影值，按上游的
        //   `isSubagentOf` 规则聚合 —— 子代理的投影跳过 seeded 继承前缀，直接相加
        //   不会把父会话的历史算第二遍。
        var costView = useProjection ? useProjection('clinepassCost') : undefined
        var subscribeSessions = typeof useSessions === 'function' ? useSessions : selectEmptySessions
        var subagentCost = subscribeSessions(function (state) {
          return subagentCostOf(state ? state.byId : undefined, sessionId)
        }, sameCostView)

        var currentModel = sel && typeof sel.model === 'string' ? sel.model : ''
        var lang = useLanguage(ctx)
        var t = TEXT[lang] || TEXT.zh

        var statePair = React.useState({ provider: null, anonymized: false, model: null, at: null, loading: false })
        var status = statePair[0]
        var setStatus = statePair[1]

        var running = useSession ? useSession(function (s) { return s.running }) : false
        var prevRunningRef = React.useRef(running)

        var refresh = React.useCallback(function () {
          var url = statusUrl(sessionId, currentModel)
          var fetchFn = window.fetch ? window.fetch.bind(window) : globalThis.fetch
          if (!fetchFn) return
          fetchFn(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (res) {
              if (!res.ok) return null
              return res.json()
            })
            .then(function (data) {
              if (data && data.ok) {
                setStatus({
                  provider: data.provider,
                  anonymized: data.anonymized === true,
                  model: data.model,
                  at: data.at,
                  loading: false,
                })
              }
            })
            .catch(function () {})
        }, [sessionId, currentModel])

        // 三个 effect 都对非 clinepass 模型空转 —— hook 照调，活不干。
        React.useEffect(function () {
          if (!isClinepass) return
          refresh()
        }, [isClinepass, sessionId, currentModel, refresh])

        React.useEffect(function () {
          var wasRunning = prevRunningRef.current
          prevRunningRef.current = running
          if (!isClinepass || !wasRunning || running) return undefined
          refresh()
          // 服务端在放行终止帧之前就写完 lastVerified，所以上面这一次通常已经拿到
          // 新结论；补一次延迟重读是为了不依赖那个顺序（流式收尾与 recordVerified
          // 的先后是实现的巧合，不是契约）。
          // 计时器一律走 `window.` —— 与 useNow / UsageCard 同一套，测试的替身才拦得住
          // （裸 setInterval 在 Node 里是真计时器，会挂在测试进程上）。
          var settle = window.setTimeout(refresh, 1200)
          return function () {
            window.clearTimeout(settle)
          }
        }, [isClinepass, running, refresh])

        React.useEffect(function () {
          if (!isClinepass || !running) return
          var timer = window.setInterval(refresh, 2000)
          return function () {
            window.clearInterval(timer)
          }
        }, [isClinepass, running, refresh])

        var isAnonymized = status.anonymized === true
        var providerName = status.provider

        // 成本合计 = 本会话 + 所有子代理会话。投影缺席时整段不显示（降级）。
        var ownCost = costOfValue(costView)
        var costSummary = null
        if (ownCost !== null || subagentCost !== undefined) {
          costSummary = emptyCost()
          if (ownCost !== null) addCostInto(costSummary, ownCost)
          if (subagentCost !== undefined) addCostInto(costSummary, subagentCost)
          costSummary.pricing = ownCost === null ? null : ownCost.pricing
          costSummary.selfCny = ownCost === null ? 0 : ownCost.cny
          costSummary.subagentCny = subagentCost === undefined ? 0 : subagentCost.cny
          costSummary.subagentCount = subagentCost === undefined ? 0 : subagentCost.count
        }
        var costText = costSummary === null ? null : formatCny(costSummary.cny)

        var displayText = providerName ? ('Provider: ' + providerName) : 'Provider: --'
        if (costText !== null) displayText += ' · ' + costText
        var tooltip = providerName
          ? (isAnonymized ? (providerName + ' — ' + t.providerAnonymizedTooltip) : ('网关返回提供方: ' + providerName))
          : t.providerAwaiting
        if (costText !== null) {
          var costLines = [t.costTitle, fill(t.costActual, { cost: costText })]
          if (costSummary.subagentCount > 0) costLines.push(fill(t.costSubagents, { count: costSummary.subagentCount }))
          tooltip += '\n—\n' + costLines.join('\n')
        }

        var hoverPair = React.useState(false)
        var hovered = hoverPair[0]
        var setHovered = hoverPair[1]

        // 展开面板：开着的时候胶囊就是它的开合开关。
        var openPair = React.useState(false)
        var open = openPair[0]
        var setOpen = openPair[1]
        var posPair = React.useState(null)
        var pos = posPair[0]
        var setPos = posPair[1]
        var rootRef = React.useRef(null)
        var panelRef = React.useRef(null)

        /**
         * 打开/收起明细。
         *
         * 位置在**点击那一刻**按锚点算一次（fixed + bottom）：面板在 dock 上方展开，
         * 内容再长也只会向上长。dock 贴着窗口底边，所以不需要跟随滚动。
         */
        var toggleOpen = React.useCallback(function () {
          if (open) {
            setOpen(false)
            return
          }
          var rect = rootRef.current ? rootRef.current.getBoundingClientRect() : null
          var viewportWidth = typeof window === 'undefined' ? 360 : window.innerWidth
          var width = Math.min(340, viewportWidth - 16)
          var left = rect === null ? 8 : Math.max(8, Math.min(rect.left, viewportWidth - width - 8))
          var bottom = rect === null ? 8 : Math.max(8, window.innerHeight - rect.top + 6)
          setPos({ left: left, bottom: bottom, width: width })
          setOpen(true)
          // 点开时顺手重读一次上游，和点胶囊原来的行为一致。
          refresh()
        }, [open, refresh])

        // 点外面 / Esc 收起。监听挂在 document 上，effect 只在打开期间存在。
        React.useEffect(function () {
          if (!open) return undefined
          var onDown = function (event) {
            var target = event.target
            if (rootRef.current !== null && rootRef.current.contains(target)) return
            if (panelRef.current !== null && panelRef.current.contains(target)) return
            setOpen(false)
          }
          var onKey = function (event) {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', onDown)
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
          }
        }, [open])

        // 全部 hook 到此为止；下面才是「非本路由的卡片原样放过」。
        if (!isClinepass) return null

        var icon = isAnonymized
          ? React.createElement(WarningIcon, null)
          : React.createElement(ServerIcon, null)

        /** 明细里的一行：左标签右数值。 */
        var groupRow = function (label, value, key) {
          return React.createElement('div', {
            key: key,
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
          }, [
            React.createElement('span', { key: 'label', style: { color: LABEL_SECONDARY } }, label),
            value === '' || value === undefined
              ? null
              : React.createElement('span', {
                  key: 'value',
                  style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
                }, value),
          ])
        }

        /** 一条细分隔线。 */
        var separator = function (key) {
          return React.createElement('div', {
            key: key,
            style: { height: 1, background: BORDER, margin: '8px 0', opacity: 0.8 },
          })
        }

        /**
         * 明细里的金额：≥ ¥0.01 固定两位（¥0.20 比 ¥0.200 稳），更小的才给四位
         * （子代理常常只花几厘钱，两位会全变成 ¥0.00）。0 也显示，不留空。
         */
        var money = function (value) {
          if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '¥0.00'
          return '¥' + value.toFixed(value < 0.01 ? 4 : 2)
        }

        var panelChildren = null
        if (open && costSummary !== null && pos !== null) {
          var rows = []
          rows.push(React.createElement('div', {
            key: 'head',
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
          }, [
            React.createElement('span', { key: 'label', style: { color: LABEL_SECONDARY } }, t.panelTitle),
            React.createElement('span', {
              key: 'value',
              style: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
            }, money(costSummary.cny)),
          ]))
          rows.push(separator('sep-1'))

          if (costSummary.requests === 0) {
            rows.push(React.createElement('div', { key: 'empty', style: { color: LABEL_SECONDARY } }, t.panelEmpty))
          } else {
            rows.push(groupRow(t.panelSelf, money(costSummary.selfCny), 'self'))
            if (costSummary.subagentCount > 0) {
              rows.push(groupRow(fill(t.panelSubagents, { count: costSummary.subagentCount }), money(costSummary.subagentCny), 'subs'))
            }
            rows.push(separator('sep-2'))
            // 一次都没有的时段不写：0 次的那行只会挤占版面，不携带信息。
            var offPeakCount = costSummary.requests - costSummary.peakRequests
            if (costSummary.peakRequests > 0) {
              rows.push(groupRow(fill(t.panelPeak, { cost: money(costSummary.peakCny) }), '', 'peak'))
            }
            if (offPeakCount > 0) {
              rows.push(groupRow(fill(t.panelOff, { cost: money(costSummary.offCny) }), '', 'off'))
            }
            // ClinePass 的额度记账恒按高峰价（与请求时刻无关），所以它等于「全部 token
            // 按峰价」；低峰期它比官方实付价高，这正是两个数字要并排的原因。
            rows.push(separator('sep-3'))
            rows.push(groupRow(t.panelClinepass, money(costSummary.cnyPeak), 'clinepass'))
            rows.push(separator('sep-4'))

            var tokens = costSummary.tokens
            rows.push(groupRow(t.panelInput, formatCompact(tokens.uncachedInput), 't-in'))
            if (tokens.cacheWrite > 0) rows.push(groupRow(t.panelCacheWrite, formatCompact(tokens.cacheWrite), 't-cw'))
            rows.push(groupRow(t.panelCacheRead, formatCompact(tokens.cacheRead), 't-cr'))
            rows.push(groupRow(t.panelOutput, formatCompact(tokens.output), 't-out'))
            var hit = cacheHitPercent(tokens)
            if (hit !== null) {
              rows.push(React.createElement('div', {
                key: 't-hit',
                style: { color: LABEL_TERTIARY, fontSize: 11, marginTop: 2 },
              }, fill(t.panelCacheHit, { percent: hit.toFixed(2) })))
            }
          }


          panelChildren = React.createElement('div', {
            ref: panelRef,
            role: 'dialog',
            'aria-label': t.panelTitle,
            'data-clinepass-panel': '',
            style: {
              position: 'fixed',
              left: pos.left + 'px',
              bottom: pos.bottom + 'px',
              width: pos.width + 'px',
              zIndex: 2147483000,
              boxSizing: 'border-box',
              padding: '12px 14px',
              borderRadius: '12px',
              border: '1px solid ' + BORDER,
              background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
              color: LABEL_PRIMARY,
              fontSize: '12px',
              lineHeight: '20px',
              textAlign: 'left',
            },
          }, rows)
        }

        var pillButton = React.createElement('button', {
          type: 'button',
          className: 'bOPqQW_pill',
          title: open ? undefined : tooltip,
          'aria-haspopup': panelChildren === null ? undefined : 'dialog',
          'aria-expanded': open,
          onClick: toggleOpen,
          onMouseEnter: function () { setHovered(true) },
          onMouseLeave: function () { setHovered(false) },
          style: {
            boxSizing: 'border-box',
            maxWidth: '100%',
            color: hovered || open ? LABEL_PRIMARY : isAnonymized ? WARN : LABEL_TERTIARY,
            font: 'inherit',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 'inherit',
            whiteSpace: 'nowrap',
            background: hovered || open ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05))' : 'transparent',
            border: 'none',
            borderRadius: '999px',
            alignItems: 'center',
            gap: '6px',
            padding: '1px 8px',
            display: 'inline-flex',
            cursor: 'pointer',
            transition: 'background-color 0.15s, color 0.15s',
          },
        }, [
          icon,
          React.createElement('span', {
            key: 'label',
            className: 'bOPqQW_label',
            style: {
              textOverflow: 'ellipsis',
              minWidth: 0,
              overflow: 'hidden',
            },
          }, displayText),
        ])

        // 面板挂 portal 到 body：dock 的祖先链随时可能出现 overflow/transform，
        // 绝对定位会被裁掉；portal 也让 fixed 坐标不受祖先影响。portal 只是
        // **元素树**上的一个孩子（真实 DOM 落点是 body），胶囊自身仍是根节点。
        var anchorChildren = [pillButton]
        if (panelChildren !== null) anchorChildren.push(ReactDOM.createPortal(panelChildren, document.body))

        return React.createElement('span', {
          ref: rootRef,
          className: 'bOPqQW_anchor',
          'data-composer-stat': 'clinepass-provider',
          // 给冒烟测试/排查留一个可读的出口：成本就是胶囊上那个数字。
          'data-clinepass-cost': costText === null ? undefined : costText,
          style: {
            minWidth: 0,
            fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
            lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
            display: 'inline-flex',
            alignItems: 'center',
          },
        }, anchorChildren)
      }

      // ═══════════════════════════ 插件本体 ═══════════════════════════

      /**
       * 需要注入的客户端服务。
       *
       * **`locale` 必须写在这里**：cordis 的可追踪代理对未声明的服务属性是**抛错**
       * （`cannot get property "locale" without inject`），而不是返回 undefined ——
       * 所以「不注入、拿不到就退英文」这条路根本走不通，漏声明只会让整个 slot
       * 静默崩成 `<div data-slot-error>`（这个坑真踩过一次）。dsh 自己的 API 目录
       * 也把两种写法分得很清：硬依赖是 `inject: ["locale"]` + `ctx.locale`，
       * 可选访问是 `ctx.get("locale")`。这里选硬依赖 —— web shell 必然提供 locale，
       * 其它客户端插件也都这么写；`useLanguage` 里的 `usable` 兜底只服务于测试的假 ctx。
       */
      var inject = ['slots', 'locale']

      /**
       * 注册卡片扩展与底部状态栏胶囊。
       *
       * @param ctx - 客户端根上下文。
       */
      function apply(ctx) {
        ctx.slots.inject('settings.models.provider-card', function () {
          return ctx.slots.register(
            {
              name: 'settings.models.provider-card',
              key: SETTINGS_NS,
            },
            function Card(props) {
              return React.createElement(UsageCard, Object.assign({ ctx: ctx }, props))
            },
          )
        })

        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'clinepass-provider',
              order: 2,
            },
            function ProviderDockPill(props) {
              return React.createElement(ClinepassProviderPill, Object.assign({ ctx: ctx }, props))
            },
          )
        })
      }

      exports.inject = inject
      exports.apply = apply
      return module.exports
    },
  })
}
