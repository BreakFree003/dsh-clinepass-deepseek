# dsh-clinepass 维护规则

## 发版必须同步 pi 侧

pi 侧是行为镜像插件：`~/Documents/Projects/pi-clinepass-dsh`。**每次 dsh 发版（tag + release）
之后，同一版行为要同步到 pi，并递增 pi 的 patch 版本**；只发一边视为没发完。

步骤见 [`RELEASING.md`](RELEASING.md) §7「同步 pi 侧」，要点：

- 同步对象：模型列表、`compat` 位（`supportsMidConvoSystemMessages` 等）、观察器/命令、
  状态文件字段；`~/.pi/agent/models.json` 的 override 按需。
- 同步完必须：`node ~/Documents/Projects/pi-clinepass-dsh/check.mjs` 全过，再对两个模型各发一次
  真实请求。
- 标记：pi README 顶部 `Synced with dsh-clinepass v<version>` 必须指向最新 tag。
- 只动 dsh 文档/打包的版本也要同步标记，并在 pi README 注明 no behavior change。
- 反向同理：pi 侧先落的行为改动，回填 dsh 后走一次 dsh 发版，再回来更新标记。
