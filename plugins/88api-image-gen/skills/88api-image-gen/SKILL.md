---
name: 88api-image-gen
description: Generate or edit images through 88api.ai with every image model the 88API docs catalog lists — GPT Image (gpt-image-2, gpt-image-2.5-flare/sunburst, az-gpt-image-*), Gemini / Nano Banana (gemini-3.1-flash-image, gemini-nano-banana-2.1, gemini-3-pro-image), Grok Imagine, Seedream and Midjourney. The plugin reads each model's endpoint and parameter limits from the live 88API model catalog and picks the right API (Images API or Chat Completions) itself. Use for text-to-image, reference-image editing, multi-reference composition, 1K/2K/4K output, transparent backgrounds, batches, repeated generation, workflow batch editing, checking interrupted paid runs, or troubleshooting Agent-client sandbox, timeout and network-approval failures before an 88API request starts. Replaces the discontinued 88API-Nano-Banana plugin. Works in Codex, Claude Code, ZCode, DeepSeek Harness and other Agent clients that can run local Node.js commands.
---

# 88API-Image-Gen

Use this skill for image generation and editing through 88API. One plugin covers all 88API image models: the CLI loads the 88API model catalog (published by the 88API docs at `https://88api.ai/helper/image-models.json`, cached for a day, with a bundled snapshot as fallback) and builds each request from it — endpoint, upload format, size field, allowed ratios, resolutions, quality values and reference-image limits. It runs in any Agent client that can execute a local `node` command (Node.js 18+).

## Resolve the runtime

`<SKILL_DIR>` is the directory containing this `SKILL.md`; the CLI is bundled beside it. Run:

```powershell
node "<SKILL_DIR>/scripts/generate.mjs" <arguments>
```

Resolve `<SKILL_DIR>` to an absolute path from where this file was loaded. Do not assume a fixed marketplace or skills cache path, and do not copy the scripts elsewhere.

## Pick the model

Run `node "<SKILL_DIR>/scripts/generate.mjs" --list-models` when you need to know what is available. It is free. It prints every catalog model with `available` (whether the saved Key's group lists it), its summary, resolutions, ratios, reference-image limit, quality / background / output-format values and billing, plus `undocumented` image models the Key lists but the catalog does not describe yet.

1. If the user names a model, pass its exact ID with `--model`. Do not substitute another model. If it is not available for their Key, still let the request go: 88API answers with a clear message listing the groups that offer it, and that answer is not billed.
2. If the user names a family without an ID, map it: GPT Image / Image2 → `gpt-image-2`; Image 2.5 → `gpt-image-2.5-flare` (fast) or `gpt-image-2.5-sunburst` (quality); Nano Banana / Gemini → `gemini-3.1-flash-image`; Nano Banana 2.1 → `gemini-nano-banana-2.1`; Nano Banana Pro → `gemini-3-pro-image`; Grok → `grok-imagine-image` (for both generation and editing); Seedream → `doubao-seedream-5-0-pro`; Midjourney → `midjourney-v8.2`.
3. Otherwise omit `--model`; the CLI uses the saved default, then the factory default `gpt-image-2`.
4. The catalog lists each model's billing unit (per image, per request or per token), not its price. Ask first before using one of these more expensive or slower choices the user did not ask for: `gemini-3-pro-image` instead of Flash; an `az-gpt-image-*` model at `high`, `xhigh` or `max` quality or at 2K/4K (billed per token, so cost rises with size and quality); Midjourney (one request is 4 images, billed per request). Do not quote prices from memory; point the user to https://88api.ai/pricing for current prices.
5. Pick by need, using the catalog summaries: transparent background → an `az-gpt-image-*` model; exact pixel sizes and up to 4K → `gpt-image-*` / `az-gpt-image-*`; Gemini models for strong text and identity edits; Grok for fast drafts (1K/2K only). Within Grok: `grok-imagine-image` is the default; use `grok-imagine-image-quality` when the user asks for higher quality or more realistic detail, and `grok-imagine-image-2.0` for the most careful layout and typography (slowest). `grok-imagine-edit` is the same model as `grok-imagine-image-quality`; there is no need to pick it for edits.
6. Do not run `--set-model` unless the user explicitly wants to change the long-term default. Never switch models after an accepted or unknown-state request.

## Parameters

Pass only what the user asked for; every flag is checked against the chosen model's catalog entry before any paid request, and an unsupported value stops with an error that names the supported ones.

- `--aspect R` (alias `--ratio`): e.g. `1:1`, `16:9`, `9:16`. The allowed list differs per model (Grok has 15 incl. `auto`, Gemini has 10, Seedream has none).
- `--resolution 1K|2K|4K`: converted to the model's own size field — exact pixels for GPT Image, `aspect_ratio` + `resolution` for Grok, `image_config.image_size` for Gemini, a size tier for Seedream. Not every model has 4K (Grok tops out at 2K). Without `--resolution` the CLI uses the resolution saved with `--set-quick-mode` / `--set-batch-mode`, else the model's catalog default, which is 1K for every current model that has a resolution setting (Midjourney has none). The same tier and ratio give different pixels on different models (1K 16:9 is 1280×720 on GPT Image and Grok, 1376×768 on Gemini); `--dry-run` or `--resolve-size` prints the exact pixels before a paid run.
- `--quality Q`: the model's quality levels (e.g. `low|medium|high`, `xhigh|max` on `az-gpt-image-2.5-*`, `low|medium|auto` on `grok-imagine-image-2.0`). For older commands `--quality 2K/4K` is read as `--resolution`.
- `--background transparent|opaque|auto` and `--output-format png|webp|jpeg`: only where the catalog lists them (the `az-gpt-image-*` models). Transparency needs png or webp.
- Masks, custom pixel sizes outside the catalog presets, and parameters the catalog does not list are not available. Explain the limitation instead of inventing options.

## First-use checks

Run these read-only or no-charge commands when installation, configuration, model availability, or safety needs verification:

```powershell
node "<SKILL_DIR>/scripts/generate.mjs" --config-path
node "<SKILL_DIR>/scripts/generate.mjs" --get-config
node "<SKILL_DIR>/scripts/generate.mjs" --list-models
node "<SKILL_DIR>/scripts/generate.mjs" --self-test
```

If no Key is configured, stop before any paid request, but **do not tell the user to run PowerShell or copy a setup command**. Say: `还差一个 88API Key，我可以帮你一键配置。请到 https://88api.ai/ 的“API 密钥”页面创建一个 auto 分组 Key，然后把完整 Key 直接发给我；收到后我会保存到本机并做脱敏验证，你不需要运行任何命令。`

Wait for the user to supply the Key. Then run `node "<SKILL_DIR>/scripts/generate.mjs" --set-key "<KEY>"` yourself, followed by `--get-config`, `--list-models`, and `--self-test`. These checks do not submit a paid image request. After successful setup, automatically continue the user's original generation or editing request; do not ask them to restate it.

Treat the Key as sensitive. Never repeat it in replies, progress updates, or command-result summaries; never write it to source, project files, or logs. Report only the masked configuration state and config path. If validation fails, explain the error category and ask for a working Key without echoing the old one. The user should supply it only in a trusted Agent conversation, never in a GitHub Issue, public chat, repository file, or screenshot. A Key sent in chat can remain in the client's conversation history; users who prefer not to send it can set the `API88_KEY` environment variable instead. Do not add multiple Keys: the `auto` group allocates concurrent requests upstream.

The Key is saved to `~/.88api/image-gen.json`, shared by every Agent client on the machine. A Key saved by an older version (`~/.codex/88api-image-gen-config.json`) or by the discontinued 88API-Nano-Banana plugin (`~/.88api/nano-banana.json`) is copied there automatically on first use. `API88_KEY`, when set, takes precedence and is never written to disk; `--get-config` shows which source is active.

## Prompt handling

Translate the request into one clear image instruction while preserving all explicit constraints: subject identity, products, text content, composition, lighting, style, aspect ratio, and elements that must not change.

- If the user asks for the original wording to be passed through, do not rewrite it.
- For edits, state which reference controls identity, product, pose, composition, or style.
- For Midjourney, flags such as `--s 250` or `--no text` belong in the prompt; the CLI adds `--ar` from `--aspect` when the prompt has none.
- Do not invent claims about copyright, licensing, or commercial safety.

## Generate

```powershell
node "<SKILL_DIR>/scripts/generate.mjs" --prompt "<prompt>" --aspect 16:9 --resolution 2K
node "<SKILL_DIR>/scripts/generate.mjs" --model gemini-3-pro-image --prompt "<prompt>" --aspect 3:4 --resolution 4K
node "<SKILL_DIR>/scripts/generate.mjs" --model az-gpt-image-2 --prompt "<sticker prompt>" --background transparent --output-format png
```

Only add `--preview` when the user explicitly asks for a real intermediate preview. It works for one text-to-image task on exact-pixel GPT Image models, uses SSE partial-image output, and may increase usage or cost; other models ignore it with a notice.

Images are saved to `~/Pictures/88api-image-gen` unless `--output-dir "<absolute directory>"` is given; every saved path is printed. Each paid run also prints a `Route:` line with the protocol and endpoint it actually calls (Images API or Chat Completions).

A Midjourney request returns 4 images; all four are saved and listed.

## Edit and multi-reference edit

```powershell
node "<SKILL_DIR>/scripts/generate.mjs" --edit --image "<reference.png>" --prompt "<edit instruction>" --aspect 16:9
node "<SKILL_DIR>/scripts/generate.mjs" --edit --model grok-imagine-image --image "<person.png>" --image "https://example.com/scene.jpg" --prompt "<composition instruction>"
```

`--image` takes local files or public `http(s)` URLs. All references go to one edit request in order; the prompt can refer to them as first, second, and so on. The CLI picks the edit request the catalog documents for that model (multipart upload, JSON with data URIs/URLs, or Chat Completions image parts) and enforces its reference limit before sending (for example 4 for `gpt-image-2`, 3 for Grok, 6 for `gemini-nano-banana-2.1`; Seedream takes 1 local file or up to 14 URLs; Midjourney cannot edit). Do not pre-compose references unless the user asks.

## Multi-image and batch modes

```powershell
node "<SKILL_DIR>/scripts/generate.mjs" --prompt "<prompt>" --count 2 --concurrency 1
node "<SKILL_DIR>/scripts/generate.mjs" --prompt "<prompt>" --repeat 2 --concurrency 1
node "<SKILL_DIR>/scripts/generate.mjs" --batch-inline "<prompt 1>" "<prompt 2>" --concurrency 1
node "<SKILL_DIR>/scripts/generate.mjs" --batch-edit --edit --image "<one.png>" --image "<two.png>" --prompt "<instruction>" --concurrency 1
```

Use the single configured Key for all modes. Each count, repeat, batch item, or workflow item remains an independent paid request (one image per request, except Midjourney's 4).

For two or more outputs, prepare the complete task list first and invoke `generate.mjs` exactly once. Use `--count` or `--repeat` for one repeated prompt and `--batch-inline` or `--batch` for different prompts. Keep `--concurrency 1` when the user asks for sequential execution. Never launch one Node process per image: repeated shell launches can trigger repeated client command or network approvals (for example Codex Auto mode) and prevent the remaining tasks from starting.

## Workflow batch edit

```powershell
node "<SKILL_DIR>/scripts/generate.mjs" --workflow-batch-edit --fixed-ref "<fixed.png>" --item-dir "<items>" --template-inline "<scene instruction>" --limit 1 --aspect 9:16 --concurrency 1 --dry-run
```

Always dry-run first. The task count is item count multiplied by template count. After explicit confirmation, remove `--dry-run`. Workflow output includes `manifest.json`, `summary.csv`, `failures.json`, and `sessions.json`.

## No-charge dry-run

`--dry-run` works without a Key and never calls the paid API. It prints the endpoint, protocol, model, resolved size, task count, concurrency, and a sanitized request; reference bytes and Authorization are omitted. It uses the cached or bundled catalog and does not go online.

A dry-run does not grant network access to the later paid command. For workflow tasks, run at most one local dry-run, obtain the required confirmation, then start the entire paid batch with one `generate.mjs` invocation. Do not dry-run each image separately.

```powershell
node "<SKILL_DIR>/scripts/generate.mjs" --model gpt-image-2 --prompt "<prompt>" --aspect 16:9 --resolution 4K --dry-run
node "<SKILL_DIR>/scripts/generate.mjs" --edit --model gemini-3.1-flash-image --image "<reference.png>" --prompt "<instruction>" --dry-run
```

## Long runs and client command timeouts

One paid request can legitimately take up to 10 minutes (high quality, 4K and Gemini Pro are slower), and a batch longer. Many Agent clients stop a shell command much sooner, and a stopped process may already have had its request accepted and billed by 88API without printing `[NO-AUTO-RETRY]`. Therefore:

- **Claude Code:** the Bash tool stops commands after 2 minutes by default and 10 minutes at most. Run every paid `generate.mjs` command with `run_in_background: true` and wait for its completion notification before reporting. Never run a paid command in the foreground with the default timeout. No-charge commands (`--get-config`, `--list-models`, `--dry-run`, `--self-test`, `--job-status`) may run in the foreground.
- **DeepSeek Harness:** its bash tool moves a command to the background after its timeout (120 seconds by default) instead of killing it. Wait for that background task to finish; do not start the same request again.
- **ZCode, Cursor, Cline, Windsurf, VS Code, Gemini CLI, and other clients:** if the client offers background or long-running commands, use them for paid commands. Otherwise run the paid command once and wait.
- **Any client:** each paid run prints `Job record: <path>` and a job id first. If the command was cut off, timed out, lost its output, or its result is unclear, do not resubmit. Run `node "<SKILL_DIR>/scripts/generate.mjs" --job-status <job id>` (or `--job-status` alone for recent runs). It sends no request and costs nothing, and reports each request as saved, not sent, rejected by 88API, running, or `[NO-AUTO-RETRY]` unknown / interrupted (may be billed). Report the saved images it lists and follow the retry rules below for the rest.
- `--json` prints one machine-readable summary line at the end of a paid run (the same shape as `--job-status`). Use it when the client makes long text output hard to read.

## Codex Auto-mode network approval

Codex Auto mode can require approval before a shell command reaches the network. This approval happens outside the plugin and may fail before Node or the 88API request starts.

When the tool layer explicitly reports an external-network execution authorization error, sandbox network denial, approval-service failure, or approval-service `429 Too Many Requests`:

1. Do not call it an 88API, Key, channel, or model rate limit. An 88API response is reported by the plugin as `HTTP <status>`, not as a Codex authorization-service error.
2. Check whether this invocation produced any plugin task-start or request output. Treat tasks blocked before the process/request started as not submitted to 88API; they have no corresponding 88API usage log or charge. Report any earlier accepted or completed tasks separately because those may be billed.
3. Explain the cause instead of only repeating the raw 429. Use this wording, adapted to the actual task counts:

   > 这不是 88API 返回的 429，而是 Codex Auto 模式的外部网络执行审批在请求发出前被限流。本次被拦截的任务尚未发送到 88API，因此 88API 没有对应日志，也不会产生这部分费用；此前已经受理的任务仍按实际结果计费。

4. Tell the user how to continue without repeated approval calls:
   - Open Codex desktop settings with `Ctrl+,` on Windows.
   - Go to **General（通用）→ Permissions（权限）** and enable **Full access（完全访问）**.
   - Return to the task, open the permission control below the composer, and select **Full access（完全访问）**.
   - Resubmit all remaining images in one batch invocation.
5. Warn that Full access（完全访问） removes the local sandbox and approval boundary for that task. Let the user choose it; never edit their global Codex permission configuration silently. If Full access is unavailable or disabled, explain that an organization policy may control it and fall back to one batch command with a single approval.

Do not use `[NO-AUTO-RETRY]` for a command that was clearly blocked before any request reached 88API. It is safe to resubmit only the confirmed-unstarted tasks after the user changes permissions. If submission state is unclear, preserve the unknown-state cost warning.

## Retry and cost safety

The endpoint comes from the model catalog: GPT Image, Grok, Seedream and Midjourney use `/v1/images/generations` and `/v1/images/edits` (Seedream URL references go on `/v1/images/generations`); Gemini models use `/v1/chat/completions`. Never route an image request to `/v1/responses`, and never switch to another endpoint after a failure.

Errors prefixed with `[NO-AUTO-RETRY]` mean the current process must stop because the paid request was accepted or its cloud state is unknown. Do not automatically requeue it, switch models, fall back, or silently submit a replacement.

This marker is not a permanent ban on future user requests. After reporting that the previous request may still be billed, let the user choose what to do next:

- If the user explicitly says to retry, regenerate, resubmit, or try once more, treat that message as authorization for exactly one new paid request and run it. Do not require the user to inspect 88API logs first.
- If the user has not explicitly authorized another paid request, stop and ask whether they want to check the 88API usage log or submit one new request.
- Never infer authorization from the original request alone. A retry issued by the CLI scheduler is still automatic and remains forbidden for `[NO-AUTO-RETRY]` failures.
- Treat legacy `[NO-RETRY]` output from an older installed version with the same rules.

Only clearly pre-acceptance transient failures are eligible for the bounded key-aware automatic retry policy.

Failures name the stage they reached. Report them to the user in these terms:

- `request was not sent`: the connection to 88API never opened. Nothing was submitted or billed, and the CLI may retry it automatically.
- `[NO-AUTO-RETRY] ... state is unknown (stage: submit)`: the request may have reached 88API. Keep the unknown-state cost warning.
- `[NO-AUTO-RETRY] ... completed and was billed, but reading the result failed (stage: read-result)`: the image was generated and billed; only the response transfer failed.
- `[NO-AUTO-RETRY] ... returned no image`: a Gemini request finished with only a text reply; it may be billed. Show the text summary and let the user decide.
- `[NO-AUTO-RETRY] Image was generated and billed, but downloading it failed ... (stage: download)`: the CLI already retried the download for free and saved the result link to a `*.pending-download.json` file named in the error. Offer to run `node <script> --retry-download "<that file>"` first; it sends no paid request and costs nothing. Suggest a new paid request only if that download also fails (result links can expire within about an hour).
- `--job-status` state `interrupted` or `unknown`: the process stopped after the request was sent. Treat it exactly like `[NO-AUTO-RETRY] ... state is unknown`.
- `HTTP 4xx` with a message such as model not in this group, unsupported parameter or content moderation: 88API rejected the request before generating; it is not billed. Explain the message and adjust the request.

Requests time out after 10 minutes, so slow channels that take several minutes are normal; do not describe a wait under 10 minutes as a failure.

## Completion

After generation or editing:

1. Report the actual model and the resolved size (resolution, ratio and pixels when known).
2. Report the saved absolute path(s), final dimensions and elapsed time. Midjourney results list all 4 files.
3. Display each successful image when the client supports local image rendering.
4. Report partial failures and `[NO-AUTO-RETRY]` states clearly; do not conceal them or silently generate replacements. If the user explicitly requests another attempt, submit exactly one new request.
