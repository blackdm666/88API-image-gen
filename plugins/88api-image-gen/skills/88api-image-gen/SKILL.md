---
name: 88api-image-gen
description: Generate or edit images through 88api.ai with gpt-image-2 or gpt-image-2-4k over the OpenAI Images API. Use for text-to-image, reference-image editing, multi-reference composition, 4K requests, SSE previews, concurrent batches with one auto-group Key, repeated generation, workflow batch editing, or troubleshooting Codex Auto-mode sandbox and network-approval failures before an 88API request starts.
---

# 88API-Image-Gen

Use this skill for image generation and image editing through the installed 88API plugin. It supports two models, OpenAI Images generation/edit endpoints, partial-image SSE for one text-to-image task, one auto-group Key with concurrent request slots, batch tasks, and resumable workflows.

## Resolve the runtime

Resolve the directory containing this `SKILL.md`, then go up two levels to obtain `<PLUGIN_ROOT>`. Run:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" <arguments>
```

Do not assume a fixed marketplace cache path or copy the script elsewhere.

## Model selection

1. If the user explicitly requests 4K, pass `--model gpt-image-2-4k` for that invocation.
2. If the user explicitly names `gpt-image-2` or `gpt-image-2-4k`, pass that value with `--model`.
3. Otherwise omit `--model`; the CLI uses the saved model, then the factory default `gpt-image-2`.
4. Do not run `--set-model` unless the user explicitly wants to change the long-term default.
5. Never switch models after an accepted or unknown-state request.

Model tiers are fixed:

- `gpt-image-2`: 2K matrix.
- `gpt-image-2-4k`: 4K matrix.

The legacy `--quality` flag is accepted for compatibility but cannot override the model tier. Exact custom pixel dimensions, transparent output, and unsupported aspect ratios are not provided by this plugin. Never invent or pass removed options for those requests; explain the limitation and ask the user to select a supported ratio when necessary.

## First-use checks

Run these read-only or no-charge commands when installation, configuration, model availability, or safety needs verification:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --config-path
node "<PLUGIN_ROOT>/scripts/generate.mjs" --get-config
node "<PLUGIN_ROOT>/scripts/generate.mjs" --list-models
node "<PLUGIN_ROOT>/scripts/generate.mjs" --self-test
```

If no Key is configured, tell the user to create one 88API Key with the `auto` group, then save it locally:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --set-key "<YOUR_88API_KEY>"
```

Never echo, inspect, log, commit, or place a real Key in source files. `--get-config` is the safe masked summary. Do not add multiple Keys: the `auto` group allocates concurrent requests upstream.

## Prompt handling

Translate the request into one clear image instruction while preserving all explicit constraints: subject identity, products, text content, composition, lighting, style, aspect ratio, and elements that must not change.

- If the user asks for the original wording to be passed through, do not rewrite it.
- For edits, state which reference controls identity, product, pose, composition, or style.
- Do not invent claims about copyright, licensing, or commercial safety.

## Generate

Default 2K model or saved model:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "<prompt>" --aspect 16:9
```

One-time 4K model:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --model gpt-image-2-4k --prompt "<prompt>" --aspect 16:9
```

Only add `--preview` when the user explicitly asks for a real intermediate preview. Preview is supported for one text-to-image task, uses SSE partial-image output, and may increase usage or cost.

## Edit and multi-reference edit

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --edit --image "<reference.png>" --prompt "<edit instruction>" --aspect 16:9
```

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --edit --model gpt-image-2-4k --image "<person.png>" --image "<product.png>" --prompt "<composition instruction>" --aspect 16:9
```

All references are uploaded in order as multipart `image[]` fields to one Images edit request. Maximum: 10 references. Do not pre-compose them unless the user asks.

## Multi-image and batch modes

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "<prompt>" --count 2 --concurrency 1
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "<prompt>" --repeat 2 --concurrency 1
node "<PLUGIN_ROOT>/scripts/generate.mjs" --batch-inline "<prompt 1>" "<prompt 2>" --concurrency 1
node "<PLUGIN_ROOT>/scripts/generate.mjs" --batch-edit --edit --image "<one.png>" --image "<two.png>" --prompt "<instruction>" --concurrency 1
```

Use the single configured Key for all modes. Each count, repeat, batch item, or workflow item remains an independent paid request.

For two or more outputs, prepare the complete task list first and invoke `generate.mjs` exactly once. Use `--count` or `--repeat` for one repeated prompt and `--batch-inline` or `--batch` for different prompts. Keep `--concurrency 1` when the user asks for sequential execution. Never launch one Node process per image: repeated shell launches can trigger repeated Codex Auto-mode network approvals and prevent the remaining tasks from starting.

## Workflow batch edit

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --workflow-batch-edit --fixed-ref "<fixed.png>" --item-dir "<items>" --template-inline "<scene instruction>" --limit 1 --aspect 9:16 --concurrency 1 --dry-run
```

Always dry-run first. The task count is item count multiplied by template count. After explicit confirmation, remove `--dry-run`. Workflow output includes `manifest.json`, `summary.csv`, `failures.json`, and `sessions.json`.

## No-charge dry-run

`--dry-run` works without a Key and never calls the paid API. It prints the endpoint, model, tier, resolved preset size, task count, concurrency, and a sanitized request; reference bytes and Authorization are omitted.

A dry-run does not grant network access to the later paid command. For workflow tasks, run at most one local dry-run, obtain the required confirmation, then start the entire paid batch with one `generate.mjs` invocation. Do not dry-run each image separately.

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --model gpt-image-2-4k --prompt "<prompt>" --aspect 16:9 --preview --dry-run
node "<PLUGIN_ROOT>/scripts/generate.mjs" --edit --model gpt-image-2-4k --image "<reference.png>" --prompt "<instruction>" --aspect 16:9 --dry-run
```

## Ratios and sizes

Supported ratios: `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `2:1`, `1:2`, `7:4`, `4:7`.

Unsupported ratios are rejected before any paid request. Use `--resolve-size` and `--dry-run` before paid work. Important mappings:

- `gpt-image-2` 16:9 → `2048x1152`.
- `gpt-image-2-4k` 16:9 → `3840x2160`.
- `gpt-image-2-4k` 4:3 → `3264x2448`.
- `gpt-image-2-4k` 3:4 → `2448x3264`.

The CLI validates every resolved preset for 16-pixel alignment, maximum edge, aspect ratio, and total pixels before a paid request. The plugin may locally crop or resize an upstream result to its resolved preset dimensions.

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

All models use:

- `POST /v1/images/generations` for generation.
- `POST /v1/images/edits` for edits.

Never route to `/v1/responses`. Errors prefixed with `[NO-AUTO-RETRY]` mean the current process must stop because the paid request was accepted or its cloud state is unknown. Do not automatically requeue it, switch models, fall back, or silently submit a replacement.

This marker is not a permanent ban on future user requests. After reporting that the previous request may still be billed, let the user choose what to do next:

- If the user explicitly says to retry, regenerate, resubmit, or try once more, treat that message as authorization for exactly one new paid request and run it. Do not require the user to inspect 88API logs first.
- If the user has not explicitly authorized another paid request, stop and ask whether they want to check the 88API usage log or submit one new request.
- Never infer authorization from the original request alone. A retry issued by the CLI scheduler is still automatic and remains forbidden for `[NO-AUTO-RETRY]` failures.
- Treat legacy `[NO-RETRY]` output from an older installed version with the same rules.

Only clearly pre-acceptance transient failures are eligible for the bounded key-aware automatic retry policy.

## Completion

After generation or editing:

1. Report the actual model and 2K/4K tier.
2. Report the saved absolute path, final dimensions, request slot, and elapsed time.
3. Display each successful image when the client supports local image rendering.
4. Report partial failures and `[NO-AUTO-RETRY]` states clearly; do not conceal them or silently generate replacements. If the user explicitly requests another attempt, submit exactly one new request.
