# dsh-clinepass/checks

clinepass 自己的回归检查。**本机跑，不随包发布** —— `package.json` 的 `files` 里没有
`checks/`，所以不会进 npm / GitHub 包。

| 脚本 | 查什么 |
|---|---|
| `dsh-clinepass-streaming-gate-check.mjs` | 用**真实 OpenAI SDK** 走一遍安装后的观察者：请求原样到达网关（没有注入的渠道字段、模型 id 不变、只发一次）、SSE 仍能装配出完整消息、同一个响应里的真实上游（含匿名标签）仍被读出来 |
| `dsh-clinepass-buffering-repro.mjs` | 分片节奏回归：40 帧 / 25 ms 的假上游必须被**逐帧**转发（退化成「先读完再放行」会毁掉 dsh 的 TPS 测量） |

```bash
node ~/Documents/Projects/dsh/dsh-clinepass/checks/dsh-clinepass-streaming-gate-check.mjs
node ~/Documents/Projects/dsh/dsh-clinepass/checks/dsh-clinepass-buffering-repro.mjs
```

**前提**：两个脚本 import 的都是**安装副本**
`~/.dsh/profiles/web/node_modules/dsh-clinepass/index.js`（手工安装路线是
`plugins/dsh-clinepass/`）—— 所以在源码仓里直接跑会找不到模块，**部署之后**才能跑。

改观察者或分片逻辑后必跑；清单见 [project-map.md](../../project-map.md) §2.2 与 §4。
