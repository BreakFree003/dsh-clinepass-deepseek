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

**pi 版本**：[pi-clinepass-deepseek](https://github.com/BreakFree003/pi-clinepass-deepseek) 把同一套模型定义、
Provider 观察与用量报告搬进 pi；两边按发布版本互相同步，这个插件是它的行为基准（见
[RELEASING.md](./RELEASING.md) §7）。

---
## 安装

三种方式，**选一种，别混用**。装完都要**重启 dsh**（profile 只在启动时读一次）。

### 方式 A：一条命令（bundle 包，推荐）

```bash
dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseek
# 钉某个 tag：同上，末尾加 #v0.17.0
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
          - id: cline-pass/deepseek-v4.1-flash-1017
            name: DeepSeek V4.1 Flash
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
- 网关把请求放进**回退池**（帧里回显 `vmc/…-contributor-fallbacks` 这类模型名）时显示
  `Provider: deepseek · 降级池`，同样换警示图标 + tooltip。**回退池是模型档位的决策，不是
  provider 的**：`finalProvider=deepseek` 的请求照样可能落进去，`only`/`has` 钉住挡不住它；
- 还没观察到任何结论时显示 `Provider: --`（tooltip「等待 API 返回…」）；
- 数据来自状态文件，经宿主路由 `?status=1` 暴露；按 session → model 两级记忆；
- **读不到元数据就不给结论**：那种响应只计 `seen`，胶囊保持上一次的结论（或 `--`）。

判定只认回显模型名的**后缀**（`contributor-fallbacks?` / `/fallbacks?` / `-fallbacks?`），
不拿它和请求的 model 做等值比较 —— 主池回显 canonical slug（`deepseek/…`），请求 id 是
`cline-pass/…`，两者从来就不相等。已知边界：网关不再回显 `model` 时 `servedModel` 是 null、
`degraded` 是 false（读不到就不猜）；`?status=1` 里 `servedModel: null` 就是形状变了的口子。

服务端在放行终止帧之前就写完结论，所以一轮结束通常立刻可见；胶囊在回合结束后还会补读一次，
运行中每 2 秒刷新一次。

## 用量卡

**设置 → 模型 → Cline Pass** 卡片，三个窗口：5 小时 / 每周 / 每月。

- 网关只报**已用**百分比（`percentUsed`），卡片显示的是**剩余** = `100 − percentUsed`，
  外加重置倒计时、读取时间，和一个刷新按钮（绕过缓存）。
- 数字来自 `GET https://api.cline.bot/api/v1/users/me/plan/usage-limits`（用你存的那把 key）。
- 上限本身不在这张卡上：它来自订阅的 `entitlements.cline_pass.inferenceCapThreshold`（三个窗口各自
  的美元阈值，1 单位 = 1e-8 USD）。**2026-10-30 实测**（账本花费 × `percentUsed` 反推，见审计 §二十五）：
  5 小时 **$10**、每月 **$50**、每周 **$25**；额度按账号共享，不按模型切。Cline 官方不公布这些数字，
  别当成契约。
- **窗口语义**（实测，和文档口径不同）：月 = **周期起点起 30 天**（不是日历月）；周**不是滚动 7 天** —— 本次读数
  只含周桶重置之后的花费，桶刚重置时周条偏低是预期行为。

## 配置项

`withDefaults()` 里的全部键；不写就是下面的默认值。

| 键 | 默认 | 作用 |
|---|---|---|
| `upstream` | `https://api.cline.bot` | 网关 **origin**（profile 的 baseURL 是它 + `/api/v1`）。带路径会被截成 origin 并警告；不是 URL 则什么都不装 |
| `provider` | `cline-pass` | 路由 id（卡片与胶囊都认它） |
| `model` | `cline-pass/deepseek-v4.1-flash-1017` | 模型 id（请求体要带 `type/` 前缀） |
| `displayName` | `Cline Pass` | 设置页卡片标题 |
| `contextWindow` | `921600` | 登记/对齐卡片用 |
| `maxTokens` | `384000` | 同上 |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | 凭据库里的键名 |
| `provision` | `true` | `false` = 不登记/不修复 provider 卡片（那卡片就得自己声明） |
| `plainModelId` | `true` | persona 里显示**裸模型 id**（`deepseek-v4.1-flash-1017`）；`false` = 保持完整 id（详见下节） |
| `usage` | `true` | `false` = 不挂载用量路由（卡片会显示「没挂载」而不是一直转圈） |
| `usageRoute` | `/api/clinepass.usage` | 用量路由路径 |
| `usageTimeoutMs` | `15000` | 宿主读网关的超时 |
| `usageCacheMs` | `60000` | 成功读取的缓存时长；`0` = 每次重取（失败只缓存 5 秒） |
| `statusFile` | `<DSH_HOME>/dsh-clinepass-status.json` | 观察结果落盘处；给字符串换路径，`false` 关掉 |

## in-history system 快照（配套 profile 补丁）

> ⛔ **2026-10-28（DSH 0.2.2-alpha.2）退役 —— 不要再跑 `patch-inhistory.mjs`。**
> 上游 pi-ai 已改为：不支持中途 system 消息的模型，后续 system 消息在**原位置**包成
> `<system-reminder>` 提供，不再移到最初提示词里（changelog 原话，代码在
> `appendSharedHistory` 的 else 分支）。本机 YAML 的
> `compat.supportsMidConvoSystemMessages` 已删、门禁已 `--revert` 回 `withhold`。
> 下面保留的是退役前的做法与理由（历史）；`--check` 在退役态会报
> `verdict: inactive`（exit 1），属预期，不再作为巡检项。

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

## 关于上游钉选（2026-10-30 修正：`has` 才是开关）

**插件仍然不改写请求。** 钉选入口只有 pi-ai 模型 `compat.vercelGatewayRouting.{only, has}`；本包
提供的是把这两个字段真正送进请求体的 boot 期补丁脚本，不是运行时行为。

网关行为按 id 分裂、也随日期变，所以按日期记：

- 2026-10-22：`cline-pass/*` 全被改指 VMC contributor 路由（`openai-compatible-private`），
  `only` 被忽略（审计 §十五）。
- 2026-10-23 02:1x：1017 落 deepseek 且带原生 fingerprint —— 当时被解读成「`only` 又生效了」。
  **2026-10-30 复测推翻了它**：那天网关默认就走公开路由，不带任何 pin 也落 deepseek。
- 2026-10-23 22:16 之后：默认改回私有通道（VMC）。
- 2026-10-30 矩阵复测（同一把 key，`…-1017`，每项 2~3 次；流式/非流式、带 tools + system
  prompt 都试过，结论一致）：

  | 请求里的 `providerOptions.gateway` | 落点 |
  |---|---|
  | 无 | `openai-compatible-private`（VMC） |
  | `only: [deepseek]`（**旧配置的形态**） | 同上 —— `only` 被完全忽略 |
  | `has: [vision, implicit-caching]` | `fireworks` |
  | `only` + `has` | **`deepseek`**，带原生 `provider_metadata.deepseek.systemFingerprint=bc19ba97…` |
  | `order` + `has` | `deepseek` |
  | 顶层 `provider.only`（ClinePassBridge 的另一半形态） | VMC |

  机制：`gateway.has` 是**路由开关** —— 没有它，网关把请求直接丢进私有/VMC 通道，`only` 不参与
  决策；有 `has` 才进公开候选路由，再由 `only`/`order` 收敛。这也解释了 10-23 与 10-30 结论的
  矛盾，以及为什么 0.15.0 那套「只写 `only`」在本机实测中一直是空转。

要钉死第一方 DeepSeek（本机 profile 的做法），三件事一起：

1. profile 的 `llm-pi-ai.providers.cline-pass.models[].compat` 里写两个字段：

   ```yaml
   vercelGatewayRouting:
     only: [deepseek]            # 公开候选里只留第一方
     has: [vision, implicit-caching]  # 开公开路由的开关（少它就是 VMC）
   ```

2. 用本包的 `patch-gateway-routing.mjs` 补 pi-ai 的三处锚点（都幂等、自动备份）：
   `@deepseek-ai/dsh-llm-pi-ai` 的 `COMPLETIONS_COMPAT_GATE` 把 `vercelGatewayRouting`
   从 `withhold` 改成 `offer`（否则 YAML 那行在启动时被拒），
   `@earendil-works/pi-ai` 的 `VercelGatewayRoutingSchema` 补 `has` 声明，以及
   `api/openai-completions.js` 把 `has` 抄进 `providerOptions.gateway`（不补就发不出去）：

   ```bash
   node <profile>/node_modules/dsh-clinepass/patch-gateway-routing.mjs --check  # 0=三锚点已补 且 YAML 两字段都在
   node <profile>/node_modules/dsh-clinepass/patch-gateway-routing.mjs           # 幂等应用
   node <profile>/node_modules/dsh-clinepass/patch-gateway-routing.mjs --revert   # 还原上游形态（先删 YAML 那两行）
   ```

3. **重启** dsh web —— 全是 boot 期补丁，不热重载。

**依赖是有方向的**：YAML 写了 `vercelGatewayRouting` 而门禁还是 `withhold`，启动直接抛
`PiAiCatalogError: model "…" sets compat "vercelGatewayRouting", but its api is "openai-completions",
which does not take it`。升级/重装 `node_modules` 会冲掉补丁，**先跑脚本再起服务**。

被补丁的是这三个文件（升级 dsh / 重装 pi-ai 后会回到上游形态，`--check` 因此返回 1）：

| 文件 | 补什么 |
|---|---|
| `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` | `COMPLETIONS_COMPAT_GATE.vercelGatewayRouting`：`withhold` → `offer` |
| `@earendil-works/pi-ai/dist/providers/compat-schema.js` | `VercelGatewayRoutingSchema` 增 `has`（本机这份 dist 无人 import，属防御性声明） |
| `@earendil-works/pi-ai/dist/api/openai-completions.js` | routing 分支把 `has` 抄进 `providerOptions.gateway` |

恢复方式只有一条：`node <profile>/node_modules/dsh-clinepass/patch-gateway-routing.mjs`
（幂等，逐文件备份为 `*.bak-gateway-routing-<stamp>`），然后重启。**别手工改回来** ——
`--revert` 也是同一套锚点。

不花额度的行为验证（库级，假 fetch 截请求体，只证明线上形态）：

```bash
node ../clinepass-deepseek-audit/evidence/scripts/verify-pi-ai-has.mjs  # 期望 gateway 里 only + has 都在
```

**偏移了怎么办**：先跑 `--check`。补丁还在（exit 0）而落点变了 = 网关行为变了，按审计
[§二十二](../clinepass-deepseek-audit/README.md) 的排查手册来：先翻 Vercel AI Gateway 的
[Model Filtering](https://vercel.com/docs/ai-gateway/models-and-providers/model-filtering)（`has` 的
合法值会加新标签）与 [Provider Options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
（`only`/`order`/`sort`/`models`），再用 `clinepass-deepseek-audit/evidence/scripts/route-probe.mjs`
跑矩阵（基线 / 只 `only` / 只 `has` / 组合），**不要只试一个字段**。`has` 是 model 层条件、`only` 是
provider 层条件——私有池是另一条 model entry，provider 层字段永远碰不到它。

边界：`--check` 与上面这个脚本只能证明「补丁在 + YAML 有值 + 请求体里有 `has`」，证明不了网关
此刻的调度决策；要确认落点看 composer 的上游胶囊或 `~/.dsh/dsh-clinepass-status.json` 的
`lastVerified.provider`（应为 `deepseek`）。钉住只限制候选集合，不改变计费（仍走 Cline Pass
订阅；规范 `deepseek/…` 命名空间是 usage-billing，需要额外 credits，不在订阅内）。证据与复现见审计
[`../clinepass-deepseek-audit/README.md`](../clinepass-deepseek-audit/README.md) §十三、§十五、§十九、§二十。

## 模型的 API 行为（2026-10-22 实测）

随包只声明 `cline-pass/deepseek-v4.1-flash-1017` 一个模型（显示名 `DeepSeek V4.1 Flash`）。同一把 key、`stream: true/false`、
`POST /api/v1/chat/completions` 实测：

| 维度 | 结果 |
|---|---|
| 普通对话 / 流式 / 非流式 | 200 |
| `reasoning_effort`（high / max / low） | 全 200；usage 带 `reasoning_tokens` |
| 工具调用（OpenAI `tools`） | 200，`finish_reason=tool_calls` |
| 图片输入（data URL） | 200 |
| 会话中途 system 消息 | 200，遵从后一条 system |
| `response_format: json_object` | 200，返回合法 JSON |
| `providerOptions.gateway.only` | **忽略**（假渠道也 200），落 `openai-compatible-private` |
| `max_tokens: 200000` | 200（网关不按卡片值校验） |

补充说明：

- 落点：当前 `cline-pass/*` → VMC contributor 路由
  （`vmc/deepseek-v4p1-flash-1017-contributor-fallbacks` → `private/deepseek-v4p1-flash-1017-contributor`），
  匿名、无 ZDR；观察者会如实报 `openai-compatible-private`，**这不是插件故障**。
- 只有 `provider_metadata.deepseek.systemFingerprint` 能证明上游落在 DeepSeek（当前匿名路由没有
  这个命名空间）；顶层 `system_fingerprint` 是网关每请求 mint 的 `fp_…`，不能当上游指纹。
- 卡片 `maxTokens` / `contextWindow` 是客户端预算，不是网关上限；921600 上下文与 TPS 没有实测。
- 计费：`cline-pass/*` 在 Cline Pass 订阅内；规范命名空间 `deepseek/*` 是 usage-billing、
  需要额外 credits（订阅不覆盖）。
- **非流式响应形状（2026-10-31）**：网关默认把非流式结果包成 `{success, data}`；要标准 OpenAI
  顶层 `choices` 需请求头 `X-Response-Format: openai`。插件与 dsh 都只走流式，不受影响、也不需要
  加头；完整对照与对旧脚本的影响见审计
  [`../clinepass-deepseek-audit/README.md`](../clinepass-deepseek-audit/README.md) §二十六。

## 迁移（0.11.x → 0.12.x）

**0.12.0 是删减版**，请求侧整块没了：

- 删掉的配置键：`pin` / `pins` / `providerPins` / `enforcement` / `retries`，以及
  `alignReasoningEffort`。**旧行照常加载** —— 这些键被忽略并记进状态文件的
  `ignoredOptions`（不刷警告，否则每个没清理的旧行都会在每次启动时叫一次）。更早的端口时代键
  （`transport` / `listen` / `captureDir` / `address` / `baseURL`）同样忽略，但会各警告一次。
  0.12.0 曾把 `plainModelId` 一起归进这份遗留名单，那是误删；0.12.2 起它又是真选项。
- **请求侧钉选**：0.12.0 删掉的是插件自带的请求改写与校验；客户端唯一入口是 pi-ai 的模型
  `compat`，而 2026-10-22 起网关把 `cline-pass/*` 改指 VMC、`only` 被忽略（见「关于上游钉选」）。
  指纹怎么读：审计 §九/§十二 的「与官方逐字相同」比的是
  `provider_metadata.deepseek.systemFingerprint`；顶层 `system_fingerprint` 是网关每请求 mint 的
  `fp_…`（2026-10-19 采样两请求都不同），不要拿它判断上游。证据见
  [`../clinepass-deepseek-audit/README.md`](../clinepass-deepseek-audit/README.md) §九、§十二、§十三、§十五。
- **effort**：插件不再写 `agent-default-model.reasoningEffort`，也不再往卡片上写
  `reasoningEfforts` / `reasoning`。想固定思考档就在自己的 profile 补丁里显式给（例：
  `agent-default-model` 写 `reasoningEffort: high`），并在卡片里声明档位与默认档
  （`reasoning: high`）。

## 提示词里的模型 id（0.12.2 起）

网关要求请求体里是 `type/model`（裸 id 报 `invalid model format`），而 dsh 把目录 id 原样发给
wire —— 于是 `{{model}}` 会把这段**传输细节**渲染进 persona，第一方路由都不会这样。插件因此把
persona 模板里的 `{{model}}` 换成裸 id：上下文里读作
`You are a coding agent powered by the deepseek-v4.1-flash-1017 model.`，与官方部署一致。
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
- `smoke-test.mjs --negative` 会故意要一个不存在的渠道。当前 `cline-pass/*` 路由忽略该字段
  （200、落匿名），所以断言 PASS —— 这正是 0.12.0 删掉请求改写器的理由。这条的预期值跟着网关走：
  2026-10-19 曾在 1017 上返回 500，10-22 起改为 200 + 流内 `stream_initialization_failed`；
  跑之前可以先用审计 §十五 的 curl 复核。

> pi 侧有一个行为镜像插件：[pi-clinepass-deepseek](https://github.com/BreakFree003/pi-clinepass-deepseek)。
> **每个版本发完后必须同步过去**（模型/compat/观察器 + `check.mjs`），并更新 pi README 的
> `Synced with` 标记 —— 步骤与规则见 [`RELEASING.md`](RELEASING.md) §7。

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
| `lastVerified` / `lastAnonymized` | 最近一条结论：`{at, url, provider, model, servedModel, degraded, sessionId, anonymized}`；`model` 是**请求**的 wire id，`servedModel` 是网关**回显**的实际服务模型（`degraded` 按它的后缀判定） |
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
retries and violation bookkeeping. Pinning is config-level only: pi-ai's
`compat.vercelGatewayRouting.{only, has}` on the model entry, plus `patch-gateway-routing.mjs`
(0.16.0) to flip pi-ai's boot gate from `withhold` to `offer`, declare
`has` in `VercelGatewayRoutingSchema`, and copy `has` into `providerOptions.gateway`.

Corrected 2026-10-30: **`has` is the routing switch, `only` is just the filter.**
`providerOptions.gateway.has` moves a request onto the public candidate route; without it the gateway
serves `openai-compatible-private` (VMC) and ignores `only` outright — which is why the 0.15.0 recipe
(only `only`) never actually pinned anything. With `has: [vision, implicit-caching]`,
`only: [deepseek]` lands first-party DeepSeek (`provider_metadata.deepseek.systemFingerprint`), `has`
alone lands fireworks, and `order` acts as a tie-break hint. The 2026-10-23 "only works again" reading
was a false positive: the gateway was routing public by default that day, so an unpinned request
landed on DeepSeek too. The stable alias and — per audit §15 — the whole `cline-pass/*` family were
re-pointed to a VMC contributor route on 2026-10-22, which is why the package registers only the 1017
id (display name `DeepSeek V4.1 Flash`). The canonical `deepseek/…` ids enforce `only` but are
usage-billing (extra credits, outside the Cline Pass subscription). See audit §13/§15/§19/§20.
An ordering hazard comes with the gate: with `vercelGatewayRouting` in the YAML and the gate left at
`withhold`, startup fails with `PiAiCatalogError`; a `node_modules` reinstall wipes the patches, so
run `patch-gateway-routing.mjs --check` (then the script, if nonzero) **before** starting the
service. `evidence/scripts/verify-pi-ai-has.mjs` proves the field reaches the wire without spending
quota.
**When the landing provider drifts,** run `--check` first: green means the gateway changed, not the
patch. Then follow audit §22 — re-read Vercel AI Gateway's
[model-filtering](https://vercel.com/docs/ai-gateway/models-and-providers/model-filtering) and
[provider-options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options) docs (new
`has` capabilities get added there) and run `evidence/scripts/route-probe.mjs` over
baseline / only / has / combined before touching anything. `has` filters model entries, `only` filters
providers inside an entry; the private pool is a separate model entry, so provider-level fields can
never reach it.
Legacy keys (`pin`, `pins`, `providerPins`, `enforcement`, `retries`, `alignReasoningEffort`) still
load — they are ignored and listed in the status file's `ignoredOptions`.

It does rewrite the **prompt template**: the wire needs the `type/model` prefix, so the persona
sections are patched to the bare id (`You are a coding agent powered by the deepseek-v4.1-flash-1017
model.`), `variables` untouched; `plainModelId: false` turns that off (see 「提示词里的模型 id」).

**Install** with `dsh plugin --profile web add github:BreakFree003/dsh-clinepass-deepseek` (the
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
`verified` / `anonymized` / `unknown`, `lastVerified` including `servedModel` / `degraded`,
`provision`, `ignoredOptions`).

A companion [pi extension](https://github.com/BreakFree003/pi-clinepass-deepseek) mirrors the same models,
provider observer and usage report; the two are kept in sync release by release.

**Status**: shared as-is, not a maintained project — no support promise, and no commitment to track
upstream dsh changes. MIT.

## License

MIT — see [LICENSE](./LICENSE).
