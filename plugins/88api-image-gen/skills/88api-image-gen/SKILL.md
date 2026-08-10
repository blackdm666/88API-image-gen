---
name: 88api-image-gen
description: Generate or edit images through 88api.ai with gpt-image-2, gpt-image-2-4k, or gpt-image-2-adobe over the OpenAI Images API. Use for text-to-image, reference-image editing, multi-reference composition, transparent-background PNGs, custom dimensions, unusual ratios such as 21:9, 4K or Adobe-model requests, SSE previews, concurrent batches with one auto-group Key, repeated generation, or workflow batch editing.
---

# 88API-image-gen

Use this skill for image generation and image editing through the installed 88API plugin. It supports three models, OpenAI Images generation/edit endpoints, partial-image SSE for one text-to-image task, one auto-group Key with concurrent request slots, batch tasks, and resumable workflows.

## Resolve the runtime

Resolve the directory containing this `SKILL.md`, then go up two levels to obtain `<PLUGIN_ROOT>`. Run:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" <arguments>
```

Do not assume a fixed marketplace cache path or copy the script elsewhere.

## Model routing

Apply these rules in order:

1. If the user requests transparency, pass `--transparent` (or `--background transparent`). The CLI routes the request to `gpt-image-2-adobe` before any paid call, requests PNG output, injects a green/magenta key-color instruction, and converts the saved result to a validated PNG Alpha channel locally.
2. If the user requests an unusual ratio such as `21:9`, pass that ratio unchanged. If the user gives exact pixel dimensions, pass `--size WIDTHxHEIGHT`. Both capabilities route to Adobe automatically.
3. If the user explicitly names `gpt-image-2`, `gpt-image-2-4k`, or `gpt-image-2-adobe`, pass that value with `--model`. Capability routing may still override Image2 for transparency or custom geometry and will report why.
4. If the user asks for ordinary 4K without another Adobe-only capability, pass `--model gpt-image-2-4k` for this invocation only.
5. Otherwise omit `--model`; the CLI uses the saved model, then the factory default `gpt-image-2`.
6. Never hide an automatic switch. This is pre-request capability selection, not failure fallback. Do not run `--set-model` unless the user explicitly wants to change the long-term default.

Model tiers are fixed:

- `gpt-image-2`: 2K matrix.
- `gpt-image-2-4k`: 4K matrix.
- `gpt-image-2-adobe`: 4K matrix plus transparent PNG, non-native ratios, and custom dimensions.

The legacy `--quality` flag is accepted for compatibility, but cannot override the model tier. `--size` is Adobe-only and automatically triggers capability routing. For transparency, treat a missing key color or missing Alpha as a failed accepted request; never present an opaque RGB file as a transparent result.

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

Never echo, inspect, log, commit, or place a real Key in source files. `--get-config` is the safe masked summary. Do not add multiple Keys: the `auto` group allocates concurrent requests upstream. An explicit `--set-key` also removes legacy extra-Key records.

## Prompt handling

Translate the request into one clear image instruction while preserving all explicit constraints: subject identity, products, text content, composition, lighting, style, aspect ratio, and elements that must not change.

- If the user asks for the original wording to be passed through, do not rewrite it.
- For edits, state which reference controls identity, product, pose, composition, or style.
- Do not invent claims about copyright, licensing, commercial safety, or Adobe-specific rights.

## Generate

Default model or saved model:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "<prompt>" --aspect 16:9
```

One-time 4K routing:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --model gpt-image-2-4k --prompt "<prompt>" --aspect 16:9
```

Explicit Adobe request:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --model gpt-image-2-adobe --prompt "<prompt>" --aspect 16:9
```

Transparent PNG, unusual ratio, or exact custom size:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "isolated product" --aspect 1:1 --transparent
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "cinematic ultrawide key art" --aspect 21:9
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "special banner" --size 3000x777
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

Use the single configured Key for all modes. `--concurrency` creates local request slots under that Key, while the 88API `auto` group performs upstream allocation. Each count, repeat, batch item, or workflow item remains an independent paid request.

## Workflow batch edit

Use workflow mode for fixed references plus a directory of variable item images and one or more scene templates:

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --workflow-batch-edit --fixed-ref "<fixed.png>" --item-dir "<items>" --template-inline "<scene instruction>" --limit 1 --aspect 9:16 --concurrency 1 --dry-run
```

Always dry-run first. The task count is item count multiplied by template count. After explicit confirmation, remove `--dry-run`. Workflow output includes `manifest.json`, `summary.csv`, `failures.json`, and `sessions.json`; the manifest records the actual model and resolution tier.

## No-charge dry-run

`--dry-run` works without a Key and never calls the paid API. It supports generation, edit, multi-reference edit, count/repeat, prompt batches, batch edit, and workflow. It prints the endpoint, actual model, tier, size, task count, concurrency, and a sanitized request; reference image bytes and Authorization are omitted.

```powershell
node "<PLUGIN_ROOT>/scripts/generate.mjs" --model gpt-image-2-4k --prompt "<prompt>" --aspect 16:9 --preview --dry-run
node "<PLUGIN_ROOT>/scripts/generate.mjs" --edit --model gpt-image-2-adobe --image "<reference.png>" --prompt "<instruction>" --aspect 16:9 --dry-run
node "<PLUGIN_ROOT>/scripts/generate.mjs" --prompt "<prompt>" --aspect 21:9 --transparent --dry-run
```

## Ratios and exact sizes

Supported ratios: `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `2:1`, `1:2`, `7:4`, `4:7`.

These are the native Image2 ratios. Any other valid positive-integer `W:H` ratio, including `5:4`, `4:5`, `3:1`, `1:3`, and `21:9`, routes to Adobe. `21:9` resolves to `3808x1632` by default.

For `16:9`, `gpt-image-2` resolves to `2048x1152`; both 4K models resolve to `3840x2160`. Explicit custom sizes accept positive `WIDTHxHEIGHT` values with each edge up to `16384` and total pixels up to `67108864`; if both size and aspect are supplied, they must agree. Use `--resolve-size` and `--dry-run` before paid work. The plugin may locally crop/resize upstream output to the exact target dimensions.

## Retry and cost safety

All models use:

- `POST /v1/images/generations` for generation.
- `POST /v1/images/edits` for edits.

Never route to `/v1/responses`. Never retry an accepted or unknown-state request. Errors prefixed with `[NO-RETRY]` must be treated as final until the user checks 88API usage logs. Only clearly pre-acceptance transient failures are eligible for the bounded key-aware retry policy.

## Completion

After generation or editing:

1. Report the requested model, actual model, any automatic routing reason, background mode, Alpha mode (`native` or `chroma-key`), and 2K/4K/custom size mode.
2. Report the saved absolute path, final dimensions, request slot, and elapsed time.
3. Display each successful image in the conversation when the client supports local image rendering.
4. Report partial failures and `[NO-RETRY]` states clearly; do not conceal them or silently generate replacements.
