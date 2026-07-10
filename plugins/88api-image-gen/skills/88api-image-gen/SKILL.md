---
name: "88api-image-gen"
description: "Generate or edit images with the 88api.ai Token aggregation service's Codex-native 88API-image-gen plugin. Trigger for AI image generation, multi-worker or batch generation, continuous generation, saving images to disk, or editing existing images."
---

# 88API-image-gen

This is the Codex-native image generation plugin from the 88api.ai Token aggregation service. It only calls `gpt-image-2` through `/v1/images/generations` and `/v1/images/edits`; no GPT text model permission is required. A single text-to-image task can opt into native Images API partial-image SSE previews.

## Script

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs"
```

On Windows PowerShell:

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs"
```

## Entry Check

When helping a user install this plugin from its repository, perform this onboarding sequence in order:

1. Check `node --version`. Require Node.js 18 or newer; recommend Node.js 20+. Python is not required.
2. Install the repository marketplace and `88api-image-gen@88api-plugins` using the repository README commands.
3. Check the local resize backend: PowerShell/System.Drawing on Windows, built-in `sips` on macOS, or ImageMagick (`magick`/`convert`) on Linux/Unix.
4. Run the configuration check below.
5. If no key is configured, stop before generation and tell the user to visit `https://88api.ai/`, sign in, and create an **image-generation group key**. Then help the user save it locally with `--set-key`.

Every time this skill is triggered for generation, run:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --get-config
```

The output is JSON with masked worker key previews. Never display a full API key.

- If `密钥状态` is `未配置` or `已配置密钥数` is `0`, do not attempt generation. Explain that an 88API image-generation group key is required, direct the user to `https://88api.ai/`, and save the key locally with:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --set-key "<YOUR_88API_IMAGE_GROUP_KEY>"
```

`<YOUR_88API_IMAGE_GROUP_KEY>` is a placeholder and must be replaced with the real key created by the user at 88api.ai. Never write the real key into repository files, documentation, commits, logs, or the assistant response. Prefer letting the user enter it directly in their local terminal; if the user explicitly supplies it for configuration, do not echo it back.

- If the user wants multiple independent 88API workers, add more keys with:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --add-worker-key "<ANOTHER_88API_IMAGE_GROUP_KEY>" --worker-name "<NAME>"
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --list-workers
```

Do not exceed 10 workers in this plugin. One key/worker is the recommended default. Configure multiple distinct keys only when the user needs several independent images generated concurrently. Warn that parallel image responses, reference-image buffers, and resizing can consume substantial memory. Low-spec computers should not use multiple workers; start with one and increase gradually only when memory allows.

Critical billing and stability warning:

- Low-spec computers must not run batch generation or multiple workers.
- If available memory is unknown, default to one worker and `--concurrency 1`.
- Before `--batch`, `--repeat`, `--batch-edit`, or `--workflow-batch-edit`, warn the user that local memory exhaustion can freeze the computer or crash Codex.
- A local crash, disconnect, or failure to save the returned image does not cancel requests already submitted to 88API. Requests accepted or completed by the cloud may still be billed.
- Do not start a large batch until the user has seen this warning. For workflow batches, run `--dry-run` first and begin with `--limit 1 --concurrency 1`.

## Codex Prompt Compiler and Orchestration

The Codex model running this skill is the prompt planner. Prepare the final Image2 instruction from the current conversation without sending prompt planning to a separate external model.

Before a paid image request, turn the user's request and conversation context into one clear Image2 instruction:

- Preserve the user's intent, named people, brands, exact quoted text, numbers, required objects, and prohibitions.
- For reference images, state the role of each image in argument order: identity, product, composition, style, background, or other user-defined role.
- Add only useful composition, camera, lighting, material, color, background, and aspect details. Do not bloat a simple request.
- Never invent poster copy, logos, claims, prices, names, or product features.
- If the user says to use the prompt verbatim or not optimize it, pass the original prompt unchanged except for the script's required aspect suffix.
- Do not expose the internal compiled prompt unless the user asks to review it.

For an explicitly iterative request, Codex may orchestrate `generate -> inspect saved image -> edit`, using the saved result as the next reference. Each follow-up edit is a new paid request. Default to one generation only; perform at most one automatic corrective edit, and only when the user asked for iterative refinement. Never loop until "perfect" and never create extra variations without counting and disclosing them.

Transport policy:

- Default `--transport auto` and explicit `--transport images` both use the direct Images endpoints.
- Responses transport is disabled because image-generation group keys must not require a GPT text model.
- Real preview files are opt-in with `--preview` for one text-to-image task through `/v1/images/generations` SSE. Partial images may add image-output usage or charges, so enable them only when the user explicitly requests a live preview. Never enable preview files across a batch or edit task.
- An accepted or unknown Images request must not be silently retried after timeout, broken SSE, or a missing final image. The cloud task may still be billed.

## Worker Pool Rules

This plugin now supports one plugin with many independent API workers.

- Each worker is one API key with the same 88API base URL, model settings, and fixed 2K ratio matrix
- The worker pool is capped at 10 API workers
- Multiple workers increase memory usage; do not recommend them on low-spec computers
- Single tasks use one worker only
- Multiple independent tasks run in parallel across multiple workers
- The plugin does **not** infer prompt difficulty and does **not** split one image request into many workers
- The plugin only scales out when there are many independent tasks, such as:
  - `--count`
  - `--repeat`
  - `--batch`
  - `--batch-inline`
  - `--batch-edit`
  - `--edit --count N`

Important image-edit rule:

- `--edit --image a --image b --prompt ...` without `--batch-edit` is still one combined multi-reference edit request and must stay on one worker
- `--batch-edit --edit --image a --image b ...` means each source image is its own task and may be distributed across many workers

If a retryable worker error occurs before a task is accepted (`429`, `502`, `503`, `504`, `524`, rate limit, no available account, account pool busy, temporarily unavailable), that worker is cooled temporarily and queued work is retried on another healthy worker when possible. Errors marked `[NO-RETRY]` must never be resubmitted automatically.

If an auth/key error occurs, that worker is disabled for the current run. Other healthy workers continue.

## Codex Display Rule

This plugin must immediately show every successful saved image in the Codex conversation with an absolute-path Markdown image tag such as `![result](C:\absolute\path.png)`.

Apply this to all successful outputs from text-to-image, edit, `--count`, `--repeat`, batch, and batch edit runs. If multiple images succeed, show all successful images in the same reply and separately report any failed items. Include the worker label in the text summary when useful for troubleshooting.

Special case for large workflow batch-edit runs:

- Do not dump hundreds of images into one Codex reply
- Show the summary, failures, and only a small sample such as the first 8 successful images or one sample per scene
- The full result set stays on disk under the generated output folder

## Generate

For clear text-to-image requests, do not ask for confirmation:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>"
```

Generation requests are fixed to the 2K preset matrix. Do not offer 1K or 4K choices. If the user asks for 1K, 4K, or an exact pixel size, map the request to the nearest supported fixed aspect preset and tell them: `图像请求规格与实际计费以 88api.ai 控制台为准。`

Pass only `--ratio` or `--aspect` when the user asks for a shape. Do not use `--size` for normal generation or edit requests.

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9
```

Supported aspects are fixed to `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `2:1`, `1:2`, `7:4`, and `4:7`. Aliases are `square=1:1`, `landscape=4:3`, and `portrait=3:4`.

The ratios `5:4`, `4:5`, `3:1`, and `1:3` are disabled in this plugin because repeated upstream compatibility tests returned upstream `502` for them. Do not request them, and do not re-enable them unless new real tests prove they are stable.

The upstream service may return a near-aspect image with non-exact pixels. The script center-crops/resizes the saved PNG to the requested `WIDTHxHEIGHT` and reports `resized from <original>`. It uses System.Drawing on Windows, the built-in `sips` command on macOS, and ImageMagick (`magick` or `convert`) on Linux/Unix. Use `--no-resize` when testing the true upstream raster.

For same-prompt multi-image requests, use `--count 1..9`. For longer continuous runs, use `--repeat 1..50`. Each image is a separate paid Images API request and can be distributed to different workers:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --prompt "一只钓鱼的小猫" --count 2 --concurrency 1 --aspect 16:9
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --prompt "一只钓鱼的小猫" --repeat 2 --concurrency 1 --adaptive
```

## Batch Generate

Before running batch generation, apply the critical billing and stability warning above. On low-spec hardware, do not run it; process prompts one at a time instead.

Use batch mode for multiple different prompts:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --batch-inline "<PROMPT_1>" "<PROMPT_2>" --concurrency 1
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --batch "<FILE.json>" --concurrency 1
```

If batch config is missing, ask for ratio/aspect and concurrency, then save it:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --set-batch-mode --ratio 4:3 --concurrency 1
```

## 通用批量图生图 Workflow

真实生产任务不要把某个产品类型写死，优先使用通用 `--workflow-batch-edit`：

低配置电脑禁止直接运行此工作流。必须先提示本地崩溃不等于云端取消、已受理请求仍可能计费，并先执行 `--limit 1 --concurrency 1 --dry-run`。
```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<固定参考图.png>" --item-dir "<变量图片目录>" --templates "<templates.json>" --limit 1 --concurrency 1 --aspect 9:16 --dry-run
```

这个 workflow 的模型是：

- `--fixed-ref` 可重复，用于固定人物、品牌、场景、风格或商品基准图。
- `--item-dir` 是批量变量图目录，例如产品、服装、道具、包装或家具等。
- `--templates` 或 `--template-inline` 决定每个变量图需要生成哪些场景。
- 每个变量图是一个任务组，每个模板对应一张独立的付费 Images edit 图片。
- 参考图顺序固定：所有 fixed refs 在前，当前变量图在最后。
- 插件不假设产品类型；产品语义必须来自用户模板和参考图。

模板 JSON 支持数组或 `{ "templates": [...] }`：
```json
{
  "templates": [
    {
      "key": "catalog_scene",
      "label": "Catalog Scene",
      "prompt": "Use the variable item as the main reference and create a clean catalog-style scene. Do not assume product category."
    },
    {
      "key": "lifestyle_scene",
      "label": "Lifestyle Scene",
      "prompt": "Place the variable item naturally into a lifestyle environment based on the fixed references."
    }
  ]
}
```

也可以不使用 JSON，直接传入一个或多个 inline 模板：
```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<固定参考图.png>" --item-dir "<变量图片目录>" --template-inline "<场景提示词>" --limit 1 --concurrency 1 --aspect 9:16 --dry-run
```

生产经验已经固化在 workflow 中：

- 自动断点续跑：同一输出目录里已有的有效 PNG 会被跳过。
- 自动补洞：主批次结束后扫描缺图，默认以较低并发补跑失败项。
- 输出完整报告：`manifest.json`、`summary.csv`、`failures.json`、`sessions.json`。
- 失败分类：`timeout_524`、`no_image_result`、`network`、`content_policy`、`auth`、`retryable`、`fatal`。
- 默认按任务组绑定 worker，优先保证稳定；同一变量图的多个场景尽量保持调度一致。

内置美甲试戴只是一个 preset，不是底层默认策略：

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 1 --concurrency 1 --aspect 9:16 --dry-run
```

使用前先 dry-run，确认图片数量、模板数量和总任务数：
```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<固定参考图.png>" --item-dir "<变量图片目录>" --templates "<templates.json>" --limit 1 --concurrency 1 --aspect 9:16 --dry-run
```

## Edit Existing Images

The image-to-image chain always uses `gpt-image-2` Images API:

- Endpoint: `POST https://88api.ai/v1/images/edits`
- Input method: multipart form data with ordered `image[]` files
- Prompt planning remains in the current Codex conversation
- This is not a collage step; reference roles follow the original CLI argument order

Default single-image edits use Images API:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

For multiple edit variations of one source, each variation is a separate paid request and may be scheduled to different workers:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --count 2 --concurrency 1
```

For multi-reference image-to-image, pass multiple `--image` flags. A single combined task uploads ordered multipart `image[]` files:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

To force per-source batch behavior instead of one combined multi-reference request, opt in explicitly:

```bash
node "$HOME/plugins/88api-image-gen/scripts/generate.mjs" --batch-edit --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --concurrency 1
```

`--transport auto` and `--transport images` are accepted. Legacy Responses edit routes are rejected. Never automatically resend a paid request whose state is accepted or unknown.

## Nail Try-On Preset / Legacy Stress Test

The old `--nail-stress-test` command is kept as a compatibility shortcut for the successful nail try-on production test. For new production tasks, prefer `--workflow-batch-edit` with a custom template or `--preset nail-tryon`.

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --nail-stress-test --persona "<人物参考图.png>" --product-dir "<产品图目录>" --limit 1 --concurrency 1 --dry-run
```

Compatibility rules for this command:

- Fixed to `9:16` only
- Uses exactly two reference images per task, in this order:
  - reference 1: persona image
  - reference 2: one nail product image
- Selects the first `N` product images by natural numeric sort
- Generates 4 independent scene prompts per product:
  - hands closeup
  - hand half face
  - half body pose
  - full body scene
- Each scene is one independent paid Images edit request and may go to a different healthy worker
- The persona image is loaded once; product images are loaded on demand task by task
- Output root defaults to:
  - `~/Pictures/88api-image-gen/nail-stress-test_<timestamp>`
- Per-product output files are fixed to:
  - `01_hands_closeup.png`
  - `02_hand_half_face.png`
  - `03_half_body_pose.png`
  - `04_full_body_scene.png`
- The root output folder also includes:
  - `manifest.json`
  - `summary.csv`
  - `failures.json`
  - `sessions.json` in the generic workflow path

Equivalent generic workflow form:

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 1 --concurrency 1 --aspect 9:16 --dry-run
```

Use `--dry-run` first to verify product selection and total task count without calling 88API:

```powershell
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --nail-stress-test --persona "<人物参考图.png>" --product-dir "<产品图目录>" --limit 1 --concurrency 1 --dry-run
```

## API Contract

- Text-to-image: `POST https://88api.ai/v1/images/generations`
- Image edit: `POST https://88api.ai/v1/images/edits`
- Model: always `gpt-image-2`; GPT text-model permission is not required
- Request size policy: always use the fixed 2K preset matrix and the supported aspect list above; do not request 1K, 4K, disabled ratios, or arbitrary `--size`
- Auth: `Authorization: Bearer <88API Key>`
- Images generation body: JSON with `model`, `prompt`, `size`, and `n:1`
- Preview generation adds `stream:true` and `partial_images:1`, consumes `image_generation.partial_image` SSE incrementally, and saves the final image
- Images edit body: multipart form data with `model`, `prompt`, `size`, `n`, and ordered `image[]` files
- Images result parsing: read `data[].b64_json`, with URL download fallback when the gateway returns `data[].url`
- Safety: never cross-fallback or automatically retry after an accepted/unknown paid request marked `[NO-RETRY]`
- Worker routing rule: single task = single worker; multiple independent tasks = many workers when available
- Workflow batch edit: generic fixed refs + variable item ref + user templates. Do not assume product type.
- Workflow reliability: resume existing PNG outputs, auto repair missing outputs, and write `manifest.json`, `summary.csv`, `failures.json`, and `sessions.json`.

## Verification

After changing the script or 88API contract, run:

```powershell
node --check "$HOME\plugins\88api-image-gen\scripts\generate.mjs"
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --help
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --get-config
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --list-workers
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --resolve-size --aspect 9:16
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --self-test-adaptive
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --self-test-images-api
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --self-test-image-stream
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --self-test-workflow
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 1 --concurrency 1 --aspect 9:16 --dry-run
node "$HOME\plugins\88api-image-gen\scripts\generate.mjs" --nail-stress-test --persona "<人物参考图.png>" --product-dir "<产品图目录>" --limit 1 --concurrency 1 --dry-run
```

When real generation or edit requests succeed, always show the successful saved images in Codex immediately with absolute-path Markdown image tags.

## Limits

- Quick same-prompt generation: 1 to 9 images
- Continuous generation: `--repeat 1..50`
- Request quality: fixed 2K
- Edit variations: 1 to 4 images
- Batch prompts: up to 20
- Batch edit source images: up to 10
- Workflow batch edit default limit: first 100 item images unless `--limit` is provided
- Workflow repair passes: default 2, configurable with `--repair-passes 0..5` or disabled with `--no-repair`
- Worker count: 1 to 10
- Worker pool concurrency: 1 to 10
- Generation timeout: 180 seconds
- Edit timeout: 180 seconds
