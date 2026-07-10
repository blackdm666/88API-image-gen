# 88API Image Gen

> 本项目是来源于 [88api.ai Token 聚合站](https://88api.ai/) 的 Codex 专用生图插件。

`88API Image Gen` 面向 Codex 提供文生图、图生图、多参考图、批量任务和多 worker 调度能力。

> [!CAUTION]
> **低配置电脑切勿尝试批量生图或高并发多 worker。** 批量任务会同时占用大量本地内存，可能导致电脑卡死、Codex 客户端崩溃或图片来不及保存。本地卡死、断网或客户端崩溃并不会自动撤销已经提交到 88API 云端的请求；云端已经受理或完成的任务仍可能正常计费，即使本地最终没有收到图片。请先使用单 Key、单 worker、`--concurrency 1` 和少量任务测试。

## 快速开始

把 [GitHub 仓库地址](https://github.com/blackdm666/88API-image-gen) 交给 Codex，并让它安装仓库中的 `88api-image-gen` 插件即可；也可以手动执行下面两条命令：

```bash
codex plugin marketplace add blackdm666/88API-image-gen
codex plugin add 88api-image-gen@88api-plugins
```

如果你已经添加过 marketplace，只需要执行第二条安装命令。

## 项目简介

这是一个 Codex Git marketplace：

- marketplace 名称：`88api-plugins`
- marketplace 展示名：`88API Plugins`
- 当前插件：`88api-image-gen@88api-plugins`

`88api-image-gen` 是 88api.ai 面向 Codex 提供的专用生图插件，底层通过兼容 Responses API 提供以下能力：

- 文生图
- 单图图生图
- 多参考图图生图
- 同提示词多张
- 连续出图
- 最多 10 个独立 worker 的并行调度
- 通用 `workflow-batch-edit` 批量图生图工作流
- `preset nail-tryon` 预设
- 自动续跑、补洞和结果清单输出

## 安装前提

开始前请确认：

- 你已经安装并能正常使用 Codex
- 当前网络可以访问 GitHub 和 88API 服务
- 已安装 Node.js 18 或更高版本，推荐 Node.js 20+
- 你已经在 [88api.ai](https://88api.ai/) 创建至少一个“生图分组 Key”
- API Key 只保存在本机，不写进仓库

### 最基础环境检查

```bash
node --version
```

能够输出 `v18` 或更高版本即可。插件运行不需要 Python、pip、虚拟环境或额外 npm 包。

精确尺寸后处理还需要：

- Windows：PowerShell 和系统图形组件，通常系统已经具备。
- macOS：系统自带 `sips`，通常无需安装。
- Linux/Unix：安装 ImageMagick，并确认 `magick` 或 `convert` 命令可用。

```bash
magick -version
# 较旧发行版也可能使用：convert -version
```

## 添加 Marketplace

命令行方式：

```bash
codex plugin marketplace add blackdm666/88API-image-gen
```

添加成功后，Codex 会识别仓库内的 `.agents/plugins/marketplace.json`，并注册 `88api-plugins`。

## 安装插件

```bash
codex plugin add 88api-image-gen@88api-plugins
```

安装完成后，插件标识就是：

```text
88api-image-gen@88api-plugins
```

如果 marketplace 后续有更新，可以刷新后再升级插件：

```bash
codex plugin marketplace upgrade 88api-plugins
```

## 首次配置 API Key

### 第一步：在 88api.ai 创建生图分组 Key

首次使用前访问 [88api.ai](https://88api.ai/)，登录控制台并创建一个或多个“生图分组 Key”。普通用户和低配置电脑建议只创建、配置一个 Key。

1. 进入 88API 控制台的“API 密钥”页面，点击“创建 API 密钥”。
2. 名称可以自定义，例如“文生图”。
3. 分组选择“生图模型”。
4. 数量可选 `1–10`。第一次使用或电脑配置较低时，请选择 `1`。
5. 按需设置过期时间和额度，然后保存更改。

![在 88API 控制台创建生图分组 Key](docs/assets/88api-create-image-group-keys.png)

创建完成后，在“API 密钥”列表中确认新 Key 的状态为“已启用”、分组为“生图模型”。使用每行 API 密钥右侧的复制按钮复制对应 Key，再按照下一步写入插件配置。

![在 88API 控制台复制生图分组 Key](docs/assets/88api-copy-image-group-keys.png)

> 安全提醒：截图中的 Key 已脱敏。不要公开、截图或提交自己的完整 Key；只将它写入本机插件配置。

- 一个 Key 对应插件中的一个 worker，已经可以完成正常文生图和图生图。
- 只有需要同时生成多张独立图片、批量任务或连续出图时，才考虑配置多个 Key。
- 插件最多支持 10 个 Key/worker，但这只是上限，不是推荐值。
- 多 worker 会同时保存响应、解码图片和处理参考图，明显增加内存占用。
- **低配置电脑切勿配置或启用多个 worker，更不要尝试批量生图。** 建议从 1 个开始，根据内存情况逐步增加。
- 本地客户端崩溃不代表云端任务取消；已经受理的请求仍可能计费。
- 单张图不会因为配置多个 Key 而被拆分加速；多个 Key 只会并行处理多张独立图片。

### 第二步：配置第一个 Key

下面命令中的 `<YOUR_88API_IMAGE_GROUP_KEY>` 必须替换成你在 88api.ai 创建的真实生图分组 Key。不要保留尖括号，也不要把真实 Key 写入 README、Git 提交或任何仓库文件。

Windows PowerShell：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --set-key "<YOUR_88API_IMAGE_GROUP_KEY>"
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --get-config
```

macOS / Linux / Git Bash：

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --set-key "<YOUR_88API_IMAGE_GROUP_KEY>"
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --get-config
```

精确尺寸后处理采用跨平台居中裁剪与缩放：Windows 使用系统图形组件，macOS 使用系统自带 `sips`，Linux/Unix 需要安装 ImageMagick（提供 `magick` 或 `convert` 命令）。如需保留上游原始像素，可传入 `--no-resize`。

如果 `--get-config` 显示 `workerCount` 为 `1` 且 `hasKey` 为 `true`，说明配置成功。若显示 `workerCount: 0` 或 `hasKey: false`，插件不能生图，Codex 必须提醒用户先完成上述配置。

### 第三步（可选）：配置多个 Key / 多 worker

`v0.1.1` 开始支持 worker 池，最多可配置 10 个独立 API worker：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --add-worker-key "<ANOTHER_88API_IMAGE_GROUP_KEY>" --worker-name worker-2
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --add-worker-key "<THIRD_88API_IMAGE_GROUP_KEY>" --worker-name worker-3
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --list-workers
```

这里的两个 Key 占位符分别替换为不同的 88API 生图分组 Key，不能重复使用同一个 Key。低配电脑请跳过这一步。

常用管理命令：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --list-workers
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --set-worker-key worker-2 "<REPLACEMENT_88API_IMAGE_GROUP_KEY>"
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --disable-worker worker-3
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --enable-worker worker-3
```

配置文件保存在本机：

```text
~/.codex/88api-image-gen-config.json
```

`--get-config` 和 `--list-workers` 只显示脱敏后的 key 摘要，不会打印完整密钥。

## 使用方法

插件安装并配置 Key 后，不需要启动常驻服务，也没有额外的“启动命令”。直接在 Codex 对话中提出生图或图片编辑需求，Codex 会调用插件。文档中的 `node .../generate.mjs` 命令只用于配置 Key、环境检查、手动调用和排错。

默认输出目录：

```text
~/Pictures/88api-image-gen
```

### 1. 文生图

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗"
```

指定比例：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --aspect 16:9
```

### 2. 同提示词多张

`--count` 上限是 `9`：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --count 2 --concurrency 1 --aspect 16:9
```

### 3. 连续出图 / 自适应并发

> [!WARNING]
> 连续出图属于批量任务。低配置电脑请勿使用；首次测试请将 `--repeat` 控制在较小数量并使用 `--concurrency 1`。客户端崩溃后，已提交云端的请求仍可能继续执行并计费。

`--repeat` 适合长任务，范围是 `1..50`：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --repeat 2 --concurrency 1 --aspect 16:9
```

说明：

- 默认开启自适应并发
- 遇到 `429 / 502 / 503 / 504 / 524 / rate limit / account busy` 这类可重试错误时，会自动重试并对后续任务降速
- 优先保证整体成功率，而不是硬顶并发

强制关闭自适应：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --repeat 2 --concurrency 1 --aspect 16:9 --no-adaptive
```

### 4. 批量文生图

> [!CAUTION]
> 低配置电脑切勿尝试批量生图。批量响应和图片解码可能卡爆本地内存，导致 Codex 崩溃；本地未保存成功不等于云端未执行，已受理请求仍可能产生费用。

内联多提示词：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --batch-inline "一只钓鱼的小猫" "一只看书的小狗" --concurrency 1
```

或使用 JSON 文件：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --batch prompts.json --concurrency 1
```

### 5. 单图图生图

图生图默认固定走 Responses API：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --edit --image "C:\path\input.png" --prompt "把这张图改成 9:16 竖版海报" --aspect 9:16
```

### 6. 多参考图图生图

多张参考图会按顺序作为多个 `input_image` 一起上传到同一个 Responses 请求中，不会先拼图：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --edit --image "C:\path\one.png" --image "C:\path\two.png" --image "C:\path\three.png" --prompt "将这些参考图组合成一个完整场景，保留主要特征并生成高质量海报" --aspect 16:9
```

当前单次多参考图上传上限为 `10` 张。

### 7. 按源图分别批量图生图

开始前务必确认电脑内存充足。低配置电脑请改为逐张处理，并使用 `--concurrency 1`。

如果你的需求是“每张源图各自出图”，而不是“多图合成一次请求”，显式使用 `--batch-edit`：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --batch-edit --edit --image "C:\path\one.png" --image "C:\path\two.png" --prompt "为每张参考图生成独立海报" --concurrency 1
```

### 8. 通用批量图生图工作流

> [!CAUTION]
> 此工作流可能快速展开为“变量图数量 × 模板数量”个付费请求。低配置电脑切勿直接运行；必须先 `--dry-run` 核对任务总数，再从 `--limit 1 --concurrency 1` 开始。即使 Codex 客户端崩溃，已经提交到云端的请求仍可能执行并计费。

这是 `v0.1.1` 的重点能力。适合“固定参考图 + 一批变量图 + 多个场景模板”的生产任务，比如：

- 人物参考图 + 多个服装图
- 模特图 + 多个产品图
- 品牌参考图 + 多个商品图
- 角色参考图 + 多个道具图
- 家具图 + 多个空间图

用内联模板直接展开任务：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<固定参考图.png>" --item-dir "<变量图目录>" --template-inline "保持固定参考图中的主体特征不变，将变量图内容自然融入场景，输出 9:16 竖构图" --template-inline "生成半身展示构图，突出变量图元素，主体身份不变" --limit 1 --aspect 9:16 --concurrency 1 --dry-run
```

也可以使用模板 JSON：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<固定参考图.png>" --item-dir "<变量图目录>" --templates templates.json --limit 1 --aspect 9:16 --concurrency 1 --dry-run
```

模板 JSON 结构示例：

```json
{
  "templates": [
    { "key": "closeup", "prompt": "保持人物特征不变，生成近景特写，突出变量图元素" },
    { "key": "poster", "prompt": "保持主体一致，生成完整海报构图，突出变量图元素" }
  ]
}
```

工作流特性：

- 每个变量图会展开为一个独立任务组
- 每个模板都是一次独立 Responses edit 请求
- 支持断点续跑
- 支持自动补洞
- 会输出 `manifest.json`、`summary.csv`、`failures.json`、`sessions.json`

### 9. `preset nail-tryon`

美甲试戴只是内置预设，不是插件唯一场景。需要时可以直接调用：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 1 --concurrency 1 --aspect 9:16 --dry-run
```

旧命令 `--nail-stress-test` 仍保留为兼容入口，但新任务更推荐使用通用 `--workflow-batch-edit`。

## 支持的比例与尺寸

插件当前固定为 2K 请求矩阵，只允许使用已验证可用的比例。

支持比例：

- `1:1`
- `3:2`
- `2:3`
- `4:3`
- `3:4`
- `16:9`
- `9:16`
- `2:1`
- `1:2`
- `7:4`
- `4:7`

别名：

- `square = 1:1`
- `landscape = 4:3`
- `portrait = 3:4`

2K 对应尺寸：

| 比例 | 尺寸 |
| --- | --- |
| `1:1` | `2048x2048` |
| `3:2` | `2048x1360` |
| `2:3` | `1360x2048` |
| `4:3` | `2048x1536` |
| `3:4` | `1536x2048` |
| `16:9` | `2048x1152` |
| `9:16` | `1152x2048` |
| `2:1` | `2048x1024` |
| `1:2` | `1024x2048` |
| `7:4` | `2208x1264` |
| `4:7` | `1264x2208` |

已禁用比例：

- `5:4`
- `4:5`
- `3:1`
- `1:3`

这些比例在真实上游兼容性测试中多次返回上游 `502`，因此已经在插件里禁用，不允许再用 `--size` 自定义格式绕过。

## 能力与限制

当前真实行为如下：

- 文生图默认走 `POST https://88api.ai/v1/responses`
- 图生图默认也走 `POST https://88api.ai/v1/responses`
- 文本模型固定为 `gpt-5.5`
- 图像工具模型固定为 `gpt-image-2`
- 图生图使用 `input_text + input_image` 的 Responses 方式
- 多参考图图生图是多图上传，不是拼图
- 不支持任意 `--size` 自定义
- 当前插件固定按 2K 比例矩阵请求
- legacy Images API 编辑链路已禁用，不作为默认能力

插件内保留如下说明，便于理解当前上游限制：

> 由于官方请求限制FHL只能接收1K图像，详细计费以后台为准。

对普通使用者来说，可以直接理解为：当前版本已经把可用的比例、尺寸和请求方式固化好了，按支持列表使用即可。

## Worker 说明

`v0.1.1` 使用“单任务独占、独立任务并行”的 worker 池策略：

- 单次普通文生图：1 个任务，只占用 1 个 worker
- `--count` / `--repeat`：会拆成多个独立任务
- `--batch` / `--batch-inline`：每个提示词是 1 个独立任务
- `--batch-edit`：每张源图是 1 个独立任务
- `--workflow-batch-edit`：每个变量图 × 每个模板，都是 1 个独立任务
- 一个多参考图合成请求本身仍只占 1 个 worker，不会被拆烂

上限规则：

- worker 最多 10 个
- 总并发最多 10
- 只有存在多个独立任务时，多个 API 才会同时参与

## 基础排错

### 1. marketplace 添加失败

先确认仓库地址和命令正确：

```bash
codex plugin marketplace add blackdm666/88API-image-gen
```

如果你在公司网络或代理环境下，先确认 Codex 能访问 GitHub。

### 2. 插件安装失败

确认 marketplace 已成功添加后，再执行：

```bash
codex plugin add 88api-image-gen@88api-plugins
```

### 3. `hasKey` 是 `false`

说明本机还没有写入可用的 88API 生图分组 Key。先访问 [88api.ai](https://88api.ai/) 创建 Key，再将下面的占位符替换为真实 Key：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --set-key "<YOUR_88API_IMAGE_GROUP_KEY>"
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --get-config
```

### 4. 比例不支持

这不是 bug，而是你传入了未开放或已禁用的比例。请只使用 README 中列出的支持比例。

### 5. 出图时报 502 / 503 / 504 / 524

这通常是 88API 上游暂时不稳定。连续任务下插件会自动重试、降速和补洞；单次失败时，稍后再试通常更稳。

### 6. 图生图失败

先确认：

- 图片路径存在且可读取
- 图片格式正常
- 你使用的是 `--edit`
- 你没有尝试切回 legacy Images API

## 仓库与插件信息

- GitHub 仓库：[blackdm666/88API-image-gen](https://github.com/blackdm666/88API-image-gen)
- marketplace 名称：`88api-plugins`
- marketplace 展示名：`88API Plugins`
- 插件标识：`88api-image-gen@88api-plugins`
- 插件目录：`./plugins/88api-image-gen`
- 当前版本：`0.2.0`

如果你只想记住两条命令，就记这两行：

```bash
codex plugin marketplace add blackdm666/88API-image-gen
codex plugin add 88api-image-gen@88api-plugins
```
