# 88API-Image-Gen

来自 [88api.ai](https://88api.ai/) Token 聚合站的生图插件。**一个插件调用 88API 全部生图模型**：GPT Image、Gemini（Nano Banana）、Grok、Seedream、Midjourney，支持文生图、参考图编辑、多参考图、透明背景、1K/2K/4K、批量任务、workflow 和本地保存。

支持 **Codex、Claude Code、ZCode、DeepSeek Harness**，以及 Cursor、Cline、Windsurf、VS Code Copilot、Gemini CLI 等能读取 `SKILL.md` 技能、能运行本机 Node.js 命令的 Agent 客户端。

| 模型系列 | 模型 | 说明 |
| --- | --- | --- |
| GPT Image | `gpt-image-2`（默认）、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | 按像素出图，1K/2K/4K，按张计费 |
| GPT Image（原生参数） | `az-gpt-image-2`、`az-gpt-image-2.5-flare`、`az-gpt-image-2.5-sunburst` | 透明背景、输出格式、更多质量档位，按 token 计费 |
| Gemini（Nano Banana） | `gemini-3.1-flash-image`、`gemini-nano-banana-2.1`、`gemini-3-pro-image` | 1K/2K/4K，文字渲染和人物一致性好 |
| Grok Imagine | `grok-imagine-image`、`grok-imagine-image-2.0`、`grok-imagine-image-quality`、`grok-imagine-edit` | 1K/2K，15 种比例，出图快 |
| Seedream | `doubao-seedream-5-0-pro` | 1K/2K，支持公网参考图 |
| Midjourney | `midjourney-v8.2`、`-fast`、`-turbo` | 每次返回 4 张，仅文生图 |

**v3.0.0：模型能力不再写死在插件里。** 插件读取 88API 文档站发布的模型清单（`https://88api.ai/helper/image-models.json`，本机缓存一天，并内置一份快照），自动决定每个模型走 Images API 还是 Chat Completions、尺寸和参考图怎么传，并在付费前校验比例、分辨率、质量档位和参考图张数。88API 上新模型或调整参数后，插件不用升级就能用。`--list-models` 会按你的 Key 标出哪些模型可用。原 **88API-Nano-Banana 插件已停止更新**，Gemini 生图并入本插件，Nano 的 Key 会自动迁移。

## 环境与 Key

- 上述任一 Agent 客户端
- Node.js 18 或更高版本
- 一个可调用上述模型的 88api.ai Key

登录 [88api.ai](https://88api.ai/)，在“API 密钥”中创建一个 Key，并选择 `auto` 分组。插件只需保存一个 Key；并发请求由同一个 Key 建立本地请求槽，再由 88API 上游分配。

![创建 API Key](docs/assets/88api-create-image-key.png)

![复制 API Key](docs/assets/88api-copy-key.png)

安装插件后，直接向 **88API-Image-Gen** 描述生图或改图需求。Agent 会先自动检查 Key；如果尚未配置，它会主动请你提供完整 Key。你只需把 Key 发给 Agent，Agent 会自动保存、脱敏核验并继续原任务，不需要打开 PowerShell。

配置保存在 `~/.88api/image-gen.json`，本机所有 Agent 客户端共用。旧版保存在 `~/.codex/88api-image-gen-config.json` 的 Key，以及 88API-Nano-Banana 保存在 `~/.88api/nano-banana.json` 的 Key，会在第一次使用时自动复制过来，旧文件保留。Agent 不会在回复中显示完整 Key，验证过程也不会发起付费生图请求。

只在自己信任的 Agent 对话中提供 Key，不要发布到 GitHub Issue、公开聊天、仓库文件或截图中。发给 Agent 的 Key 可能留在客户端的对话记录里；不想发送时，可以改为设置环境变量 `API88_KEY`（优先于配置文件，不写入磁盘）。

<details>
<summary>高级用户：手动配置命令</summary>

```powershell
node plugins/88api-image-gen/skills/88api-image-gen/scripts/generate.mjs --set-key "<YOUR_88API_KEY>"
node plugins/88api-image-gen/skills/88api-image-gen/scripts/generate.mjs --get-config
node plugins/88api-image-gen/skills/88api-image-gen/scripts/generate.mjs --list-models
node plugins/88api-image-gen/skills/88api-image-gen/scripts/generate.mjs --self-test
```

</details>

## 安装

### Codex

```powershell
codex plugin marketplace add blackdm666/88API-image-gen
```

然后在 Codex 插件列表中安装 **88API-Image-Gen** 并新建任务。已安装旧版的用户运行 `codex plugin marketplace upgrade 88api-plugins` 升级。

### Claude Code

```text
/plugin marketplace add blackdm666/88API-image-gen
/plugin install 88api-image-gen@88api-plugins
```

也可以在终端运行 `claude plugin marketplace add blackdm666/88API-image-gen` 和 `claude plugin install 88api-image-gen@88api-plugins`。安装后直接描述需求即可，Claude 会按技能说明调用插件。

### ZCode

ZCode 兼容 Claude Code 插件格式：打开 **设置 → Plugins → Create → Add marketplace**，填入 `blackdm666/88API-image-gen`，然后安装 **88api-image-gen**。

### DeepSeek Harness、Cursor、Cline 等其它客户端

整个技能文件夹 `plugins/88api-image-gen/skills/88api-image-gen/`（含 `SKILL.md` 和 `scripts/` 目录）就是完整的安装包，复制到客户端的技能目录即可，例如：

| 客户端 | 用户级技能目录 |
| --- | --- |
| DeepSeek Harness | `~/.dsh/skills/` 或 `~/.agents/skills/` |
| Cursor、Codex、Gemini CLI 等认公共目录的客户端 | `~/.agents/skills/` |
| Cline | `~/.cline/skills/` |
| ZCode（不用插件时） | `~/.zcode/skills/` |

复制后保持文件夹名为 `88api-image-gen`，新开对话让客户端重新加载技能。DeepSeek Harness 也可以继续使用原生插件 [dsh-plugin-88api-image](https://github.com/blackdm666/dsh-plugin-88api-image)。

## 长任务与中断

一张图最长可能要 10 分钟，批量更久，而不少客户端会更早结束命令（例如 Claude Code 的命令默认 2 分钟超时）。命令被结束时，请求可能已经被 88API 受理并扣费。

- 技能已要求 Agent 在 Claude Code 中把付费命令放到后台运行，其它客户端也优先用后台 / 长命令。
- 每次付费运行开头会打印 `Job record` 和任务号，提交记录保存在 `~/.88api/image-gen-jobs/`。
- 命令中断、超时或看不清结果时，运行 `--job-status <任务号>`（不带参数列出最近几次）查看每个请求的实际状态：已保存、未发出、88API 拒绝、仍在运行，或 `[NO-AUTO-RETRY]` 状态未知 / 被中断（可能已扣费）。这个命令不发请求、不收费。
- `--json` 会在付费运行结束时多输出一行机器可读的结果，格式和 `--job-status` 相同。

## 在 Codex 中使用

在新任务中输入 `@`，选择 **88API-Image-Gen**，然后直接描述需求：

```text
@88API-Image-Gen 生成一张 16:9 的雨夜城市海报。
@88API-Image-Gen 用 4K 生成一张产品主视觉。
@88API-Image-Gen 用 Nano Banana Pro 把这张截图改成英文版。
@88API-Image-Gen 用 az-gpt-image-2 做一张透明背景的贴纸。
@88API-Image-Gen 使用我附加的人物图和产品图，生成一张 16:9 的展示图。
@88API-Image-Gen 用 Midjourney 生成 4 张概念图。
```

没指定模型时使用默认 `gpt-image-2`；点名模型或模型系列时使用对应模型，只在单次请求里传 `--model`；只有用户明确要求改变长期默认模型时才执行 `--set-model`。需要 4K 时传 `--resolution 4K`（旧的 `gpt-image-2-4k` 会自动转成 `gpt-image-2` + 4K）。

一次需要生成两张或更多图片时，Codex 应先整理完整任务清单，再通过一条 `--count`、`--repeat`、`--batch-inline` 或 `--batch` 命令提交。不要每张图片分别启动一次插件进程，否则 Auto 模式可能反复触发外网审批，导致后续任务尚未到达 88API 就被拦截。

## 比例、分辨率与参数

每个模型能用的比例、分辨率、质量档位、背景和输出格式都来自模型清单，运行 `--list-models` 可以看到。常用参数：

- `--aspect 16:9`：画面比例。GPT Image 支持 10 种，Gemini 10 种，Grok 15 种（含 `auto`），Seedream 不指定比例。
- `--resolution 1K|2K|4K`：插件换算成各模型自己的写法（GPT Image 填像素，Grok 填 `resolution`，Gemini 填 `image_config.image_size`，Seedream 填档位）。Grok 最高 2K。
- `--quality`、`--background transparent`、`--output-format png`：只在清单列出的模型上可用，例如透明背景只有 `az-gpt-image-*`。

GPT Image 的像素对照（所有 GPT Image 模型相同）：

| 比例 | 1K | 2K | 4K |
| --- | ---: | ---: | ---: |
| 1:1 | 1024×1024 | 2048×2048 | 2880×2880 |
| 3:2 | 1536×1024 | 2400×1600 | 3504×2336 |
| 2:3 | 1024×1536 | 1600×2400 | 2336×3504 |
| 4:3 | 1152×864 | 2048×1536 | 3264×2448 |
| 3:4 | 864×1152 | 1536×2048 | 2448×3264 |
| 16:9 | 1280×720 | 2560×1440 | 3840×2160 |
| 9:16 | 720×1280 | 1440×2560 | 2160×3840 |
| 21:9 | 1344×576 | 3024×1296 | 3840×1648 |
| 2:1 | 1408×704 | 2880×1440 | 3840×1920 |
| 1:2 | 704×1408 | 1440×2880 | 1920×3840 |

其他模型的像素见 88API 文档站各模型页面。不支持的比例、分辨率或参数会在付费请求前直接报错。

## API 与安全

- 端点由模型清单决定：GPT Image、Grok、Seedream、Midjourney 用 `POST https://88api.ai/v1/images/generations` 和 `/v1/images/edits`；Gemini 用 `POST https://88api.ai/v1/chat/completions`。不使用 `/v1/responses`
- 清单只能写这几个固定路径，域名固定为 88api.ai；清单格式不对或被篡改时插件改用缓存或内置快照
- `--dry-run` 和 `--self-test` 不调用付费生图接口，也不输出 Key 或参考图 Base64；`--list-models` 只调用免费的 `/v1/models`
- 单张文生图显式使用 `--preview` 时启用 Images API SSE（仅按像素出图的 GPT Image 模型）；默认等待最终结果
- 已受理或状态未知的请求标记为 `[NO-AUTO-RETRY]`，不会自动重发或跨模型、跨端点回退；用户明确说“重试/重新生成”后可提交 1 次新请求

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

- **没有 Key：**创建一个 `auto` 分组 Key并把完整 Key 发给 Agent，由 Agent 一键保存和脱敏验证，不需要自己运行命令。
- **`@` 菜单没有插件（Codex）或技能没生效：**更新或重新安装插件，然后新建任务 / 新开对话。
- **旧配置保存了已移除模型：**读取配置时会自动回退到 `gpt-image-2`；旧的 `gpt-image-2-4k` 会转成 `gpt-image-2` + 4K。
- **比例、分辨率或参数不支持：**报错里会列出该模型支持的取值；插件不会自动改成其他值。
- **点名的模型 Key 用不了：**`--list-models` 里 `available` 为 `false`。请求照样会发出，88API 会提示哪些分组提供这个模型，这类拒绝不扣费。
- **新上的模型插件不认识：**插件每天更新一次模型清单，也可以运行 `--refresh-models` 立即更新。文档站还没收录、但 Key 能用的生图模型，插件会只发提示词和参考图试用。
- **报错写着 `request was not sent`：**连不上 88API，请求没有发出、没有扣费，插件会自动重试。
- **报错写着 `stage: read-result`：**图已生成并扣费，只是读取结果时连接断了。
- **报错写着 `stage: download`：**图已生成并扣费，下载结果图时失败（已自动免费重试 3 次）。报错里有一个 `.pending-download.json` 链接文件，运行 `--retry-download <链接文件>` 可免费再下载一次；链接约 1 小时后可能失效。
- **请求超时（10 分钟）或出现 `[NO-AUTO-RETRY]`：**旧请求可能仍会计费，插件不会自行重发。用户了解风险后明确说“重试/重新生成”，Agent 应直接提交 1 次新请求，不强制先查使用日志。
- **客户端把命令中断了，不知道有没有出图：**运行 `--job-status`，按其中每个请求的状态处理；状态是 `interrupted` / `unknown` 的不要自动重发。
- **Auto 模式提示外网审批 429，但 88API 没有日志：**请求在到达插件 API 之前就被 Codex 审批层拦截。不要排查 88API Key 或渠道；按上方步骤启用 Full access（完全访问），或把剩余任务合并为一条批量命令并完成一次审批。

## 项目信息

- 版本：`3.0.0`
- GitHub：[blackdm666/88API-image-gen](https://github.com/blackdm666/88API-image-gen)
- 插件：`88api-image-gen@88api-plugins`（Codex、Claude Code、ZCode 同名）
- 更新说明：[docs/更新说明-v3.0.0.md](docs/更新说明-v3.0.0.md)；[v2.3.0](docs/更新说明-v2.3.0.md)；[v2.2.0](docs/更新说明-v2.2.0.md)；[v2.1.0](docs/更新说明-v2.1.0.md)；[v2.0.0 破坏性变更](docs/更新说明-v2.0.0.md)
