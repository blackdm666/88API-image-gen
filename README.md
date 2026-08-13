# 88API-Image-Gen

来自 [88api.ai](https://88api.ai/) Token 聚合站的 Codex 专用生图插件。通过 OpenAI Images API 支持文生图、参考图编辑、多参考图、SSE 预览、批量任务、workflow 和本地保存。

| 模型 | 固定档位 | 适合场景 |
| --- | --- | --- |
| `gpt-image-2`（默认） | 2K | 日常生成、常规编辑和批量生产 |
| `gpt-image-2-4k` | 4K | 用户明确要求 4K、高分辨率展示或印刷素材 |

v2.0.0 只保留以上两个模型，不再提供透明背景、自定义像素尺寸、非支持比例自动路由或第三个模型。

## 环境与 Key

- Codex 插件功能
- Node.js 18 或更高版本
- 一个可调用上述模型的 88api.ai Key

登录 [88api.ai](https://88api.ai/)，在“API 密钥”中创建一个 Key，并选择 `auto` 分组。插件只需保存一个 Key；并发请求由同一个 Key 建立本地请求槽，再由 88API 上游分配。

![创建 API Key](docs/assets/88api-create-image-key.png)

![复制 API Key](docs/assets/88api-copy-key.png)

配置命令：

```powershell
node plugins/88api-image-gen/scripts/generate.mjs --set-key "<YOUR_88API_KEY>"
node plugins/88api-image-gen/scripts/generate.mjs --get-config
node plugins/88api-image-gen/scripts/generate.mjs --list-models
node plugins/88api-image-gen/scripts/generate.mjs --self-test
```

真实 Key 只应保存在自己的 Codex 配置中，不要发布到 Issue、公开聊天、仓库或截图里。

## 在 Codex 中使用

在新任务中输入 `@`，选择 **88API-Image-Gen**，然后直接描述需求：

```text
@88API-Image-Gen 生成一张 16:9 的雨夜城市海报。
@88API-Image-Gen 用 4K 生成一张产品主视觉。
@88API-Image-Gen 使用我附加的人物图和产品图，生成一张 16:9 的 4K 展示图。
@88API-Image-Gen 根据这个要求生成 3 张不同方案。
```

普通任务使用 `gpt-image-2`。用户明确要求 4K 时，单次使用 `gpt-image-2-4k`；只有用户明确要求改变长期默认模型时才执行 `--set-model`。

一次需要生成两张或更多图片时，Codex 应先整理完整任务清单，再通过一条 `--count`、`--repeat`、`--batch-inline` 或 `--batch` 命令提交。不要每张图片分别启动一次插件进程，否则 Auto 模式可能反复触发外网审批，导致后续任务尚未到达 88API 就被拦截。

## 支持的比例与尺寸

仅支持：`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`2:1`、`1:2`、`7:4`、`4:7`。

| 比例 | 2K | 4K |
| --- | ---: | ---: |
| 1:1 | 2048×2048 | 2880×2880 |
| 3:2 | 2048×1360 | 3520×2352 |
| 2:3 | 1360×2048 | 2352×3520 |
| 4:3 | 2048×1536 | 3264×2448 |
| 3:4 | 1536×2048 | 2448×3264 |
| 16:9 | 2048×1152 | 3840×2160 |
| 9:16 | 1152×2048 | 2160×3840 |
| 2:1 | 2048×1024 | 3840×1920 |
| 1:2 | 1024×2048 | 1920×3840 |
| 7:4 | 2208×1264 | 3808×2176 |
| 4:7 | 1264×2208 | 2176×3808 |

所有预设都会在付费请求前检查 16 像素对齐、最大边、宽高比和总像素范围。不支持的比例或旧参数会直接报错，不会调用付费 API。

## API 与安全

- 文生图：`POST https://88api.ai/v1/images/generations`
- 图片编辑：`POST https://88api.ai/v1/images/edits`
- 不使用 Chat Completions 或 `/v1/responses`
- `--dry-run` 和 `--self-test` 不调用付费生图接口，也不输出 Key 或参考图 Base64
- 单张文生图显式使用 `--preview` 时启用 Images API SSE；默认等待最终 JSON
- 已受理或状态未知的请求标记为 `[NO-AUTO-RETRY]`，不会自动重发或跨模型回退；用户明确说“重试/重新生成”后可提交 1 次新请求

## Auto 模式与外网审批

Codex 的 Auto 模式可能在插件脚本访问网络前发起外网执行审批。若错误明确包含“外部网络执行授权”“沙箱网络权限”“审批服务”或审批服务的 `429 Too Many Requests`，它不是 88API、Key、渠道或模型返回的限流。

被审批层拦截且尚未启动请求的任务不会发送到 88API，因此 88API 没有对应日志，也不会产生这部分费用；在此之前已经被 88API 受理的任务仍按实际结果计费。遇到这种情况，Codex 应把两类任务分别说明，不能把审批服务 429 写成 88API 429。

需要避免重复审批时，用户可以在 Codex 桌面端执行：

1. Windows 按 `Ctrl+,` 打开设置。
2. 进入 **General（通用）→ Permissions（权限）** 并启用 **Full access（完全访问）**。
3. 回到任务，在输入框下方的权限菜单中选择 **Full access（完全访问）**。
4. 将剩余图片作为一条批量命令重新提交。

**安全提示：**Full access（完全访问）会取消当前任务的本地沙箱与审批边界。插件只能向用户解释并提供步骤，不会自动修改全局 Codex 权限。如果该选项不可用或呈灰色，可能是组织策略限制；此时继续使用单条批量命令，并只审批一次正式外网执行。

## 常见问题

- **没有 Key：**创建一个 `auto` 分组 Key，然后执行 `--set-key`。
- **`@` 菜单没有插件：**更新或重新安装插件，然后新建任务。
- **旧配置保存了已移除模型：**v2.0.0 读取配置时会自动回退到 `gpt-image-2`。
- **比例不支持：**从上方 11 个比例中选择；插件不会自动改成其他比例。
- **请求超时或出现 `[NO-AUTO-RETRY]`：**旧请求可能仍会计费，插件不会自行重发。用户了解风险后明确说“重试/重新生成”，Codex 应直接提交 1 次新请求，不强制先查使用日志。
- **Auto 模式提示外网审批 429，但 88API 没有日志：**请求在到达插件 API 之前就被 Codex 审批层拦截。不要排查 88API Key 或渠道；按上方步骤启用 Full access（完全访问），或把剩余任务合并为一条批量命令并完成一次审批。

## 项目信息

- 版本：`2.0.4`
- GitHub：[blackdm666/88API-image-gen](https://github.com/blackdm666/88API-image-gen)
- 插件：`88api-image-gen@88api-plugins`
- 更新说明：[docs/更新说明-v2.0.4.md](docs/更新说明-v2.0.4.md)；[v2.0.0 破坏性变更](docs/更新说明-v2.0.0.md)
