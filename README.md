# dsh-clinepass

把 **Cline Pass** 接进 DeepSeek Harness：注册一条 OpenAI 兼容的 pi-ai 路由 `cline-pass`，并做两件事 ——

1. **观察真实 Provider**：只读地看这条路由的聊天响应，读出上游到底是谁（含网关的匿名标签
   `openai-compatible-private`），写进状态文件，供 composer 底部的 **Provider 胶囊**显示；
2. **画用量卡**：设置 → 模型 → Cline Pass 卡片上的 5 小时 / 每周 / 每月用量条。

**它不改写任何请求。** 不碰 body、不碰 headers、不重试、不另发请求；SSE 响应逐帧转发，
不在本地缓冲整包。这是 0.12.0 的形态，也是它和 0.11.x 最大的区别（见「迁移」）。

- 环境要求：**node ≥ 20**，dsh 0.1.7 及以上。宿主半边只用 node 内置模块，浏览器半边只向
  web shell 的静态模块表要 React；**没有任何第三方依赖**，也没有构建步骤。
- **分享性质，非长期维护项目**：按 MIT 原样提供，不承诺持续维护、也不承诺跟进上游 dsh 的接口
  漂移。发版清单见 [RELEASING.md](./RELEASING.md)（**tag 和 GitHub Release 是两件事**）。

---
## 安装

三种方式，**选一种，别混用**。装完都要**重启 dsh**（profile 只在启动时读一次）。

### 方式 A：一条命令（bundle 包，推荐）

```bash
dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseekv4.1
# 钉某个 tag：同上，末尾加 #v0.12.5
```

包自己声明了 `dsh.bundle.patch`，所以 `dsh plugin`（pnpm 的转发器）装上它之后会把这个包追加到
profile 清单的 `dsh.profile.bundles` 里 —— 那两行配置（`- id: clinepass` 的 loader 行，以及声明
Cline Pass 卡片的 `- id: llm-pi-ai` 行）随包生效，**不需要手写任何东西**。卸载同样干净：
`dsh plugin --profile web remove dsh-clinepass`。

### 方式 B：安装器（不需要 pnpm，离线可用）

```bash
node install.mjs                 # 默认装进 $DSH_HOME/profiles/web/plugins/dsh-clinepass
node install.mjs --dry-run       # 只打印会做什么
```

它把插件文件复制进 profile 的 `plugins/dsh-clinepass/`，给 `cordis.patch.yml`（会先备份）追加一行
loader 行（`name: './plugins/dsh-clinepass/index.js'`），并追加 `llm-pi-ai` 的 provider 行；如果你
自己的补丁里已经声明了 `llm-pi-ai`，它**不动你那一行**，只提示你把 `cline-pass:` 段自己写进去
（下面的 YAML 可以直接粘贴）。其它开关：`--dsh-home <path>` / `--profile <name>` /
`--name <dir>` / `--no-patch`。

### 方式 C：手动

把 `index.js` / `client.js` / `package.json` / `cordis.patch.yml` 复制进
`<profile>/plugins/dsh-clinepass/`，再照 [patch.example.yml](./patch.example.yml) 自己写 loader 行。

### 卡片从哪来

「Cline Pass」卡片就是一个普通的 pi-ai provider（`llm-pi-ai.providers.cline-pass`），有两个来源：

- **随包/随安装器声明的静态行**（方式 A / B 都写了这一行）—— 重启即有卡片，不看服务时序；
- **插件运行时的 `provisionProfile()`** —— 它认得出自己写的那张卡，只把模型条目的
  `contextWindow` / `maxTokens` 对齐成配置值，**绝不覆盖别人的卡**，也不改档位声明。
  在 dsh 0.1.7 上这次写入并不可靠（冷启动时 settings 服务还没起来；全新 profile 的写入会等
  清单写锁），所以**别只依赖它**。

> **自己写 `llm-pi-ai` 行的人必读**：静态卡声明了 `reasoningEfforts: {high, max}` **和
> `reasoning: high`**，而运行时的 `provisionProfile()` **只**对齐 `contextWindow` /
> `maxTokens` —— 它既不声明档位、也不写默认档、也不改写你写下的值。而 patch 行是**整行替换
> config、不合并**，所以自己写就必须把这两个字段一起写上：
>
> - 少了 `reasoningEfforts`，这个模型在 composer 里没有任何思考档可选；
> - 少了 `reasoning`，选择器会多出一个 **「Provider default / 跟随 Provider」** 条目（客户端
>   只在模型目录没有 `defaultEffort` 时才插入它），而且未显式选档的会话会落到上游自己的默认
>   档。写上 `reasoning: high` 就只剩 **High / Max**，默认 High。
>
> 可粘贴：

```yaml
- id: llm-pi-ai
  config:
    providers:
      cline-pass:
        displayName: Cline Pass
        api: openai-completions
        apiKeyEnv: CLINE_PASS_API_KEY
        baseURL: https://api.cline.bot/api/v1
        reasoning: high          # 默认思考档；不写就会多出「Provider default」选项
        models:
          - id: cline-pass/deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 921600
            maxTokens: 131072
            input: [text, image]
            reasoningEfforts:
              high: high
              max: max
          # 日期快照。这里不写 compat.vercelGatewayRouting：门禁未打时写它会让
          # 配置加载直接失败（启动失败）。不钉也能用；要硬钉 DeepSeek 见
          # 「网关路由钉选」一节。
          - id: cline-pass/deepseek-v4.1-flash-1017
            name: DeepSeek V4.1 Flash 1017
            contextWindow: 921600
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts:
              high: high
              max: max
```

## 设置 API key

**设置 → 模型 → Cline Pass** 卡片里的 **API key** 字段，填好保存。它写进 dsh 的凭据库，键名就是
`CLINE_PASS_API_KEY`（可用 `apiKeyEnv` 改）。

浏览器侧**读不到**这把 key —— dsh 的凭据缝是单向的（只能写）。所以用量卡不在浏览器里请求网关：
宿主半边用 key 去读，只把**数字**发回同一条同源路径。

## Provider 胶囊

在 composer 底部，显示这条路由**最近一次真实上游**：

- 有结论时是 `Provider: <名字>`（例如 `Provider: deepseek`）；悬停有说明，点一下立即重读；
- 网关返回**匿名标签** `openai-compatible-private`（VMC 回退网形状）时换成警示色 + 专门图标 +
  tooltip（contributor 档：数据可能用于训练，无 ZDR）；
- 还没观察到任何结论时显示 `Provider: --`（tooltip「等待 API 返回…」）；
- 数据来自状态文件，经宿主路由 `?status=1` 暴露；按 session → model 两级记忆；
- **读不到元数据就不给结论**：那种响应只计 `seen`，胶囊保持上一次的结论（或 `--`）。

服务端在放行终止帧之前就写完结论，所以一轮结束通常立刻可见；胶囊在回合结束后还会补读一次，
运行中每 2 秒刷新一次。

## 用量卡

**设置 → 模型 → Cline Pass** 卡片，三个**滚动窗口**：5 小时 / 每周 / 每月。

- 网关只报**已用**百分比（`percentUsed`），卡片显示的是**剩余** = `100 − percentUsed`，
  外加重置倒计时、读取时间，和一个刷新按钮（绕过缓存）。
- 数字来自 `GET https://api.cline.bot/api/v1/users/me/plan/usage-limits`（用你存的那把 key）。
- 上限本身不在这张卡上：它来自订阅的 `entitlements.cline_pass.inferenceCapThreshold`（三个窗口各自
  的美元阈值）。2026-10-16 标定过一次记账单位（1 单位 = 1e-8 USD，于是 5 小时 / 每周 / 每月 ≈
  **$10 / $25 / $50**；Cline 官方并不公布这些数字）—— 仅供理解量级，别当成契约。

## 配置项

`withDefaults()` 里的全部键；不写就是下面的默认值。

| 键 | 默认 | 作用 |
|---|---|---|
| `upstream` | `https://api.cline.bot` | 网关 **origin**（profile 的 baseURL 是它 + `/api/v1`）。带路径会被截成 origin 并警告；不是 URL 则什么都不装 |
| `provider` | `cline-pass` | 路由 id（卡片与胶囊都认它） |
| `model` | `cline-pass/deepseek-v4.1-flash` | 模型 id（请求体要带 `type/` 前缀） |
| `displayName` | `Cline Pass` | 设置页卡片标题 |
| `contextWindow` | `921600` | 登记/对齐卡片用 |
| `maxTokens` | `131072` | 同上 |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | 凭据库里的键名 |
| `provision` | `true` | `false` = 不登记/不修复 provider 卡片（那卡片就得自己声明） |
| `plainModelId` | `true` | persona 里显示**裸模型 id**（`deepseek-v4.1-flash`）；`false` = 保持完整 id（详见下节） |
| `usage` | `true` | `false` = 不挂载用量路由（卡片会显示「没挂载」而不是一直转圈） |
| `usageRoute` | `/api/clinepass.usage` | 用量路由路径 |
| `usageTimeoutMs` | `15000` | 宿主读网关的超时 |
| `usageCacheMs` | `60000` | 成功读取的缓存时长；`0` = 每次重取（失败只缓存 5 秒） |
| `statusFile` | `<DSH_HOME>/dsh-clinepass-status.json` | 观察结果落盘处；给字符串换路径，`false` 关掉 |

## in-history system 快照（配套 profile 补丁）

DSH 默认把 `openai-completions` 路由当 leading-only：系统提示词一变就改写头部、重开请求序列。
pi-ai 的转录层其实支持会话中途 system 消息（实测网关接受，且前缀缓存仍命中），但
`@deepseek-ai/dsh-llm-pi-ai` 的 `COMPLETIONS_COMPAT_GATE` 把 `supportsMidConvoSystemMessages`
标成 `withhold` —— 配置层直接写会抛 `PiAiCatalogError`。所以本机做法是两件事一起：

1. profile 的 `llm-pi-ai.providers.cline-pass.models[].compat` 写
   `supportsMidConvoSystemMessages: true`；
2. 用本包的 `patch-inhistory.mjs` 把门禁那一行改成 `offer`：

   ```bash
   node <profile>/node_modules/dsh-clinepass/patch-inhistory.mjs --check   # 0=已打，1=未打
   node <profile>/node_modules/dsh-clinepass/patch-inhistory.mjs           # 幂等应用，自动备份
   node <profile>/node_modules/dsh-clinepass/patch-inhistory.mjs --revert  # 还原成 withhold
   ```

3. 改完重启 dsh web。

**为什么不做成运行时行为**：这个标志被消费两处 —— 配置门禁（决定 YAML 能不能写）和
pi-ai 模型对象的 `compat`（决定转录层保留还是折叠中途 system 消息）。插件拿不到模型对象，
`ctx.llm.registerAdapter()` 也不允许接管已注册的 `cline-pass` 路由；唯一入口是 boot 前的源码补丁。
**升级会重装 node_modules**，所以升级后先 `--check`，未打就重跑，再起服务 ——
YAML 那行还在而补丁没了，启动会直接失败。

## 网关路由钉选（1017 快照专用）

`providerOptions.gateway.only` 在两条 cline-pass 路由上行为**不同**，别把结论混用：

- `cline-pass/deepseek-v4.1-flash`（稳定别名）：网关**无视**该字段。它的服务端模型属性带
  `model_properties_override.providerOptions.gateway.order = [deepseek, fireworks]`，
  客户端写 `only: ['__no_such_upstream__']` 也照常 200、仍落 `deepseek`。
- `cline-pass/deepseek-v4.1-flash-1017`（日期快照）：网关**执行**该字段。`only: ['deepseek']`
  时 `finalProvider=deepseek`、`fallbacksAvailable=[]`、`planningReasoning` 带
  `Provider set restricted to: deepseek.`；写一个不存在的渠道直接
  500 `No available providers match the 'only' filter`；`only: ['fireworks']` 就真落 fireworks。
  所以它是**硬钉**：DeepSeek 不可用时请求失败，不回落。

2026-10-19 实测（同一把 key，每项 2 次采样）。上游是否真是 DeepSeek 看
`provider_metadata.deepseek.systemFingerprint`（1017 仍是 `e72d3c7f…`）；顶层
`system_fingerprint` 是网关每次 mint 的 `fp_…`，随请求变，不能当上游指纹用。

在 1017 上钉第一方 DeepSeek，两件事一起：

随包卡片（方式 A / B）和安装器都会声明**两个**模型：稳定别名在前（默认选中），1017 快照在后。
1017 那行**故意不带 pin** —— 门禁没打时写 `compat.vercelGatewayRouting` 会让配置加载直接失败；
不钉也能用（网关按服务端 order 选路）。要硬钉第一方 DeepSeek，按下面做 —— 注意随包的
`llm-pi-ai` 行是整行替换的，改不了它，得复制到自己 profile 的补丁里（上面「可粘贴」那段）。

1. profile 的 1017 模型行写 `compat.vercelGatewayRouting.only: [deepseek]`（pi-ai 从模型的
   `compat` 读，写进请求体）。目前实测生效的只有这个形状；`gateway.order`（只改规划顺序、
   压不过 `clientSessionId` 的会话亲和）/ `allow` / `pinnedProvider` / 顶层 `provider.only` /
   `model_properties_override` 在稳定别名上都被忽略，1017 上只验证了 `only`。
2. 用本包的 `patch-gateway-routing.mjs` 打开门禁：

   ```bash
   node <profile>/node_modules/dsh-clinepass/patch-gateway-routing.mjs --check   # 0=整套在位
   node <profile>/node_modules/dsh-clinepass/patch-gateway-routing.mjs           # 幂等应用，自动备份
   node <profile>/node_modules/dsh-clinepass/patch-gateway-routing.mjs --revert  # YAML 还在用 pin 时拒绝，--force 才还原
   ```

   它只改 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 里
   `vercelGatewayRouting: "withhold"` 这一行（→ `"offer"`），锚点必须恰好出现一次，
   上游改形状就报错、不写入。
3. 改完重启 dsh web。

**为什么不做成运行时行为**：与 in-history 开关同因 —— 这个标志被配置门禁消费，门禁在 boot 前跑；
插件既拿不到 `pi-ai` 的模型对象，也不能接管已注册的 `cline-pass` 路由。**升级/重装会重装
node_modules**：补丁被冲掉后 YAML 的 `vercelGatewayRouting` 会让配置加载直接抛
`PiAiCatalogError`（服务起不来）—— 升级后先 `--check`，未打就重跑，再起服务。
`~/.config/dsh-web/start.sh` 不会自动重打。

## 迁移（0.11.x → 0.12.x）

**0.12.0 是删减版**，请求侧整块没了：

- 删掉的配置键：`pin` / `pins` / `providerPins` / `enforcement` / `retries`，以及
  `alignReasoningEffort`。**旧行照常加载** —— 这些键被忽略并记进状态文件的
  `ignoredOptions`（不刷警告，否则每个没清理的旧行都会在每次启动时叫一次）。更早的端口时代键
  （`transport` / `listen` / `captureDir` / `address` / `baseURL`）同样忽略，但会各警告一次。
  0.12.0 曾把 `plainModelId` 一起归进这份遗留名单，那是误删；0.12.2 起它又是真选项。
- **请求侧钉选**：0.12.0 删掉的是插件自带的请求改写与校验 —— 对稳定别名它确实无效
  （2026-10-19 复测：写 `only: ['__no_such__']` 仍 200、落 `deepseek`；落点由服务端
  `model_properties_override.providerOptions.gateway.order` 决定）。但 1017 日期快照没有这条
  服务端覆盖，网关会执行 `only` —— 要钉它请用上面「网关路由钉选」那套
  （profile compat + `patch-gateway-routing.mjs`），插件本身仍然不碰请求。
  指纹怎么读：审计 §九/§十二 的「与官方逐字相同」比的是
  `provider_metadata.deepseek.systemFingerprint`；顶层 `system_fingerprint` 是网关每请求 mint 的
  `fp_…`（2026-10-19 采样两请求都不同），不要拿它判断上游。证据见
  [`../clinepass-deepseek-audit/README.md`](../clinepass-deepseek-audit/README.md) §九、§十二、§十三。
- **effort**：插件不再写 `agent-default-model.reasoningEffort`，也不再往卡片上写
  `reasoningEfforts` / `reasoning`。想固定思考档就在自己的 profile 补丁里显式给（例：
  `agent-default-model` 写 `reasoningEffort: high`），并在卡片里声明档位与默认档
  （`reasoning: high`）。

## 提示词里的模型 id（0.12.2 起）

网关要求请求体里是 `type/model`（裸 id 报 `invalid model format`），而 dsh 把目录 id 原样发给
wire —— 于是 `{{model}}` 会把这段**传输细节**渲染进 persona，第一方路由都不会这样。插件因此把
persona 模板里的 `{{model}}` 换成裸 id：上下文里读作
`You are a coding agent powered by the deepseek-v4.1-flash model.`，与官方部署一致。
`plainModelId: false` 关掉它（启动行会说明显示的是配置里的完整 id）。

只能改**模板**，因为三条看似更省事的路都走不通：改目录 id（老会话的 `model/selection` 与
`request/header` 记的是带前缀的 id，`dsh-llm-pi-ai` 按目录解析选择 → 报 `UNKNOWN_MODEL`）；重注册
`model` 变量（`dsh-agent` 的 `installModelSelection` 在每个内层 listener 之后用会话当前选择覆写
`variables.provider`/`model`）；直接改 `variables.model`（`dsh-session-reference` 靠快照
`assembly.variables` 估算引用预算，解析不了的 id 会让预算静默回落）。所以 listener 用
`{ prepend: true }` 挂在 `installModelSelection` **外层**，只替换模板里的 `{{model}}` token，
`variables` 一字不改，段名对不上就原样返回。

**升级 dsh 后要复查的提示词契约**（形状变了不会报错，只会静默不生效）：

- 事件名仍是 `system-prompt/assemble`，且 listener 能拿到 `next()` 之后的 assembly；
- assembly 形状仍是 `{ sections: [{ name, text, interpolate? }], variables }`，`{{…}}` 在
  `renderPrompt` 里才解析（模板在 assemble 时仍是未渲染的原文）；
- 段名仍是 `deployment:persona-prefix` / `deployment:persona-suffix`；
- `@deepseek-ai/dsh-agent` 仍在 assemble 内层用会话 selection 覆写 `variables.model`
  —— 这决定 `{ prepend: true }` 是否还必要；
- 生效确认：新会话日志里搜 `coding agent powered by`（应是裸 id），或
  `node test-fetch.mjs`（§14 就是这份契约，不需要 dsh、不需要外网）。

## 验证

```bash
npm test          # test-package → test-fetch → test-settings → test-usage → test-install，都不需要外网
node checks/dsh-clinepass-buffering-repro.mjs
node checks/dsh-clinepass-streaming-gate-check.mjs
node smoke-test.mjs [--negative]     # 活体：检查状态文件 + 真实网关往返
```

- 两个 `checks/` 脚本与 `smoke-test.mjs` 用的都是**安装副本**
  （`<profile>/node_modules/dsh-clinepass/index.js`；手工安装路线是 `plugins/dsh-clinepass/`）——
  所以**部署之后**才能跑，在源码仓里直接跑会红。
- `checks/dsh-clinepass-buffering-repro.mjs` 钉「逐帧转发」：观察者一旦退化成整包缓冲，分片节奏
  就变了（dsh 的 TPS 测量正是从它来的）。
- `checks/dsh-clinepass-streaming-gate-check.mjs` 用**真实 OpenAI SDK** 走一遍安装后的观察者：
  请求原样到达、流仍能装配出完整消息、同一个响应里的上游仍被读出来。
- `smoke-test.mjs --negative` 会故意要一个不存在的渠道。默认打稳定别名：网关无视该字段
  （200、仍落 `deepseek`），所以断言 PASS —— 这正是 0.12.0 删掉请求改写器的理由。
  用 `MODEL_ID=cline-pass/deepseek-v4.1-flash-1017` 跑同一条会 **FAIL**
  （500 `No available providers match the 'only' filter`）：那不是回归，是 1017 快照真的执行
  `only`。这条负控制只对稳定别名成立。

### 状态文件

```bash
cat ~/.dsh/dsh-clinepass-status.json
```

| 字段 | 含义 |
|---|---|
| `hook` | `installed` / `absent` / `replaced-by-us` —— 观察者是否真的挂在 `globalThis.fetch` 上 |
| `counters.seen` | 观察到的聊天请求数 |
| `counters.verified` | 读出了真实 provider 的数量 |
| `counters.anonymized` | 结论是匿名标签 `openai-compatible-private` 的数量 |
| `counters.unknown` | 响应里根本没有 provider 元数据的数量 |
| `lastVerified` / `lastAnonymized` | 最近一条结论：`{at, url, provider, model, sessionId, anonymized}` |
| `provision` / `provisionReason` | provider 卡片的登记结果与原因（`created` / `present` / `repaired` / `mismatch` / `off` / `pending` / `failed` / `unavailable`） |
| `ignoredOptions` | 被忽略的遗留配置键 |
| `pid` / `at` | 进程号 / 落盘时间 |

读法：`seen` 在涨而 `verified` 不涨 = 响应里没有 provider 元数据（网关形状变了）；
`hook` 不是 `installed` = 有别的插件先占了 `globalThis.fetch`。

## 卸载

- **方式 A（bundle）**：从安装目录跑 `node <profile>/node_modules/dsh-clinepass/uninstall.mjs`
  （连同它写的 provider 卡片一起撤），再 `dsh plugin --profile web remove dsh-clinepass`。
- **方式 B（安装器）**：`node uninstall.mjs`（`--keep-provider` 保留卡片）。

两种都要**重启 dsh**，卡片才会从设置页消失。

## 安全与边界

- **不开任何端口**。用量功能是 dsh **已经在跑**的 HTTP 服务上的一条*路径*
  （`/api/clinepass.usage`），走 dsh 自己的 Host/Origin 信任栅栏与浏览器 cookie 认证。
- 观察者只匹配配置的 `upstream` origin 下的聊天请求；其它请求原样透传。
- 状态文件里只有结论与计数，**没有密钥**；插件也不记录请求头。
- 一个内部依赖：pi-ai 每次请求新建 client 且不传 `options.fetch`，所以真实传输就是全局 `fetch`。
  这条要是变了，观察会**静默失效** —— 状态文件的 `hook` 字段就是为暴露这件事存在的（用 `console`
  打印的其它插件会进宿主日志，而插件的 `ctx.logger` 行不一定落盘）。

## English

**dsh-clinepass** brings Cline Pass into DeepSeek Harness: it registers an OpenAI-compatible pi-ai
route (`cline-pass`) and does exactly two things — it **observes** the real upstream provider in the
gateway's chat responses (shown in a composer pill, persisted to a status file), and it **draws the
Cline Pass usage card** on Settings → Models.

**It never rewrites a request.** No body, no headers, no retries, no extra calls; SSE bodies are
forwarded frame by frame, never buffered. 0.12.0 removed the request-side channel pin, enforcement,
retries and violation bookkeeping: the stable alias's `deepseek` landing is decided server-side
(`model_properties_override.providerOptions.gateway.order`) and client fields are ignored there.
The dated `…-1017` snapshot is different — the gateway enforces
`providerOptions.gateway.only` on it, so pinning is a profile-side `compat` plus a boot-time gate
patch (`patch-gateway-routing.mjs`); see 「网关路由钉选」.
Legacy keys (`pin`, `pins`, `providerPins`, `enforcement`, `retries`, `alignReasoningEffort`) still
load — they are ignored and listed in the status file's `ignoredOptions`.

It does rewrite the **prompt template**: the wire needs the `type/model` prefix, so the persona
sections are patched to the bare id (`You are a coding agent powered by the deepseek-v4.1-flash
model.`), `variables` untouched; `plainModelId: false` turns that off (see 「提示词里的模型 id」).

**Install** with `dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseekv4.1` (the
package declares `dsh.bundle.patch`, so its two config rows come along automatically), with
`node install.mjs` where pnpm is not available, or by hand (`patch.example.yml`). Restart dsh, then
paste your key into the card on Settings → Models (stored as `CLINE_PASS_API_KEY` in the credential
store; the browser cannot read it by design, which is why the host half fetches the usage numbers).

**Configuration**: `upstream`, `provider`, `model`, `displayName`, `contextWindow`, `maxTokens`,
`apiKeyEnv`, `provision`, `plainModelId`, `usage`, `usageRoute`, `usageTimeoutMs`, `usageCacheMs`,
`statusFile`. If
you declare the `llm-pi-ai` row yourself, include `reasoningEfforts` **and** `reasoning: high` —
the runtime provisioner only aligns `contextWindow`/`maxTokens`, and a row without `reasoning`
leaves the picker showing a "Provider default" entry.

**Verify**: `npm test`, the two `checks/` scripts (they import the *installed* copy, so deploy
first), `smoke-test.mjs`, and `cat ~/.dsh/dsh-clinepass-status.json` (`hook`, `counters.seen` /
`verified` / `anonymized` / `unknown`, `lastVerified`, `provision`, `ignoredOptions`).

**Status**: shared as-is, not a maintained project — no support promise, and no commitment to track
upstream dsh changes. MIT.

## License

MIT — see [LICENSE](./LICENSE).
