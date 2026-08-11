---
name: 88api-image-gen
description: Generate or edit images through 88api.ai with gpt-image-2 or gpt-image-2-4k over the OpenAI Images API. Use for text-to-image, reference-image editing, multi-reference composition, 4K requests, SSE previews, concurrent batches with one auto-group Key, repeated generation, or workflow batch editing.
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

## Workflow batch edit

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --workflow-batch-edit --fixed-ref "<fixed.png>" --item-dir "<items>" --template-inline "<scene instruction>" --limit 1 --aspect 9:16 --concurrency 1 --dry-run
```

Always dry-run first. The task count is item count multiplied by template count. After explicit confirmation, remove `--dry-run`. Workflow output includes `manifest.json`, `summary.csv`, `failures.json`, and `sessions.json`.

## No-charge dry-run

`--dry-run` works without a Key and never calls the paid API. It prints the endpoint, model, tier, resolved preset size, task count, concurrency, and a sanitized request; reference bytes and Authorization are omitted.

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

## Retry and cost safety

All models use:

- `POST /v1/images/generations` for generation.
- `POST /v1/images/edits` for edits.

Never route to `/v1/responses`. Never retry an accepted or unknown-state request. Errors prefixed with `[NO-RETRY]` are final until the user checks 88API usage logs. Only clearly pre-acceptance transient failures are eligible for the bounded key-aware retry policy.

## Completion

After generation or editing:

1. Report the actual model and 2K/4K tier.
2. Report the saved absolute path, final dimensions, request slot, and elapsed time.
3. Display each successful image when the client supports local image rendering.
4. Report partial failures and `[NO-RETRY]` states clearly; do not conceal them or silently generate replacements.
