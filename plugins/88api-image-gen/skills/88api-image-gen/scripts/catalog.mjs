// Image model catalog and request planning.
//
// The 88API docs publish every image model's capability boundary at
// https://88api.ai/helper/image-models.json (generated from the docs pages). The
// plugin ships a snapshot of it, caches the live copy for a day, and turns a
// catalog entry plus the user's ratio / resolution choices into request fields.
// Nothing in the catalog can change where requests go: endpoints must be one of
// ALLOWED_ENDPOINTS on the fixed 88API host.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CATALOG_URL = "https://88api.ai/helper/image-models.json";
export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_FETCH_TIMEOUT_MS = 8_000;
export const PROTOCOLS = ["openai-images", "gemini-chat"];
export const ALLOWED_ENDPOINTS = [
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/chat/completions",
];
const SIZE_PARAMS = ["size", "aspect_ratio+resolution", "size-tier", "prompt-ar", "image_config", "none"];
const RESOLUTIONS = ["1K", "2K", "4K"];
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RATIO = /^(auto|\d+(\.\d+)?:\d+(\.\d+)?)$/;
const PIXELS = /^\d{2,5}x\d{2,5}$/;

const SNAPSHOT_URL = new URL("./image-models.snapshot.json", import.meta.url);

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Returns a cleaned entry, or null when the entry cannot be used safely.
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object" || !MODEL_ID.test(String(raw.id || ""))) return null;
  if (!PROTOCOLS.includes(raw.protocol)) return null;
  if (!ALLOWED_ENDPOINTS.includes(raw.generate?.endpoint)) return null;
  const edit = Array.isArray(raw.edit) ? raw.edit : [];
  const editVariants = edit.filter((variant) => ALLOWED_ENDPOINTS.includes(variant?.endpoint)
    && ["multipart", "json"].includes(variant.upload)
    && typeof variant.field === "string" && /^[a-z_]+(\[\])?$/i.test(variant.field)
    && Number.isInteger(variant.maxImages) && variant.maxImages >= 1
    && isStringList(variant.sources));
  if (editVariants.length !== edit.length) return null;
  const size = raw.size || {};
  if (!SIZE_PARAMS.includes(size.param) || !isStringList(size.ratios) || !size.ratios.every((ratio) => RATIO.test(ratio))) return null;
  if (size.resolutions !== undefined && !(isStringList(size.resolutions) && size.resolutions.every((item) => RESOLUTIONS.includes(item)))) return null;
  for (const table of Object.values(size.pixels || {})) {
    if (!Object.values(table || {}).every((value) => PIXELS.test(String(value)))) return null;
  }
  if (!Number.isInteger(raw.n?.max) || raw.n.max < 1) return null;
  return {
    id: raw.id,
    aliasOf: typeof raw.aliasOf === "string" ? raw.aliasOf : undefined,
    protocol: raw.protocol,
    billing: raw.billing,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    generate: { endpoint: raw.generate.endpoint },
    edit: editVariants.map(({ endpoint, upload, field, maxImages, sources }) => ({ endpoint, upload, field, maxImages, sources })),
    size: {
      param: size.param,
      ratios: size.ratios,
      resolutions: size.resolutions || [],
      defaultRatio: size.defaultRatio,
      defaultResolution: size.defaultResolution,
      resolutionValues: size.resolutionValues || {},
      pixels: size.pixels || {},
    },
    n: { max: raw.n.max, imagesPerRequest: raw.n.imagesPerRequest },
    options: raw.options && typeof raw.options === "object" ? raw.options : {},
    docs: typeof raw.docs === "string" ? raw.docs : "",
  };
}

export function sanitizeCatalog(raw, source) {
  if (!raw || raw.schemaVersion !== CATALOG_SCHEMA_VERSION || !Array.isArray(raw.models)) {
    throw new Error(`model catalog from ${source} has an unsupported format`);
  }
  const models = raw.models.map(sanitizeEntry).filter(Boolean);
  if (models.length === 0) throw new Error(`model catalog from ${source} contains no usable models`);
  return { source, models, skipped: raw.models.length - models.length };
}

export function loadSnapshotCatalog() {
  return sanitizeCatalog(JSON.parse(readFileSync(SNAPSHOT_URL, "utf8")), "bundled snapshot");
}

function readCache(cachePath) {
  if (!existsSync(cachePath)) return null;
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    return { catalog: sanitizeCatalog(cached.manifest, "local cache"), fetchedAt: Date.parse(cached.fetchedAt) || 0 };
  } catch {
    return null;
  }
}

function writeCache(cachePath, manifest) {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ fetchedAt: new Date().toISOString(), url: CATALOG_URL, manifest })}\n`, "utf8");
  renameSync(tempPath, cachePath);
}

// Loads the catalog: a fresh local cache, else the live docs copy (when network
// is allowed), else a stale cache, else the bundled snapshot. Never throws.
export async function loadCatalog({ cachePath, allowNetwork = true, force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const cached = cachePath ? readCache(cachePath) : null;
  if (cached && !force && now - cached.fetchedAt < CATALOG_TTL_MS) {
    return { ...cached.catalog, fetchedAt: new Date(cached.fetchedAt).toISOString() };
  }
  let warning = null;
  if (allowNetwork) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
      let manifest;
      try {
        const res = await fetchImpl(CATALOG_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        manifest = await res.json();
      } finally {
        clearTimeout(timer);
      }
      const catalog = sanitizeCatalog(manifest, "88API docs");
      if (cachePath) {
        try {
          writeCache(cachePath, manifest);
        } catch {
          // A read-only profile only loses the cache; the fresh catalog is still used.
        }
      }
      return { ...catalog, fetchedAt: new Date(now).toISOString() };
    } catch (error) {
      warning = `could not refresh the model catalog from ${CATALOG_URL} (${error?.name === "AbortError" ? "timeout" : error?.message || error})`;
    }
  }
  if (cached) return { ...cached.catalog, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: true, warning };
  return { ...loadSnapshotCatalog(), fetchedAt: null, warning };
}

export function findEntry(catalog, id) {
  return catalog?.models.find((entry) => entry.id === id) || null;
}

// Builds a conservative entry for a model the Key lists but the catalog does not
// document yet. Only prompt and reference images are sent; no size fields.
export function inferEntry(id, endpointTypes = []) {
  const types = new Set(endpointTypes);
  const base = {
    id,
    inferred: true,
    billing: "unknown",
    summary: "Not documented in the 88API model catalog yet; parameters are not validated.",
    size: { param: "none", ratios: [], resolutions: [], resolutionValues: {}, pixels: {} },
    n: { max: 1 },
    options: {},
    docs: "",
  };
  if (types.has("gemini")) {
    return {
      ...base,
      protocol: "gemini-chat",
      generate: { endpoint: "/v1/chat/completions" },
      edit: [{ endpoint: "/v1/chat/completions", upload: "json", field: "image_url", maxImages: 6, sources: ["data-uri", "url"] }],
    };
  }
  if (types.has("image-generation")) {
    return {
      ...base,
      protocol: "openai-images",
      generate: { endpoint: "/v1/images/generations" },
      edit: [{ endpoint: "/v1/images/edits", upload: "multipart", field: "image[]", maxImages: 4, sources: ["file"] }],
    };
  }
  return null;
}

function canonicalRatio(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "auto") return text;
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text);
  return match ? `${Number(match[1])}:${Number(match[2])}` : text;
}

function pickRatio(entry, requested, saved) {
  const ratios = entry.size.ratios;
  const explicit = canonicalRatio(requested);
  if (explicit) {
    if (!ratios.includes(explicit)) {
      throw new Error(ratios.length
        ? `${entry.id} does not support aspect ratio "${requested}". Supported: ${ratios.join(", ")}.`
        : `${entry.id} does not accept an aspect ratio in this plugin.`);
    }
    return explicit;
  }
  const remembered = canonicalRatio(saved);
  if (remembered && ratios.includes(remembered)) return remembered;
  if (entry.size.defaultRatio) return entry.size.defaultRatio;
  return null;
}

function pickResolution(entry, requested, saved) {
  const resolutions = entry.size.resolutions;
  const explicit = String(requested || "").trim().toUpperCase();
  if (explicit) {
    if (!resolutions.includes(explicit)) {
      throw new Error(resolutions.length
        ? `${entry.id} does not support resolution "${requested}". Supported: ${resolutions.join(", ")}.`
        : `${entry.id} has no resolution setting.`);
    }
    return explicit;
  }
  const remembered = String(saved || "").trim().toUpperCase();
  if (remembered && resolutions.includes(remembered)) return remembered;
  return entry.size.defaultResolution || resolutions[0] || null;
}

function checkOption(entry, name, label, value) {
  if (value === undefined || value === null || value === "") return undefined;
  const allowed = entry.options?.[name];
  if (!Array.isArray(allowed)) throw new Error(`${entry.id} does not support ${label}.`);
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`${entry.id} does not support ${label}="${value}". Supported: ${allowed.join(", ")}.`);
  return normalized;
}

// Turns a catalog entry and the user's choices into the request plan used by
// both the dry-run and the paid request. Throws before any request is sent.
export function resolveRequestPlan(entry, { ratio, resolution, quality, background, outputFormat, savedRatio, savedResolution } = {}) {
  if (entry.inferred && (ratio || resolution || quality || background || outputFormat)) {
    throw new Error(`${entry.id} is not documented in the model catalog yet, so --aspect, --resolution, --quality, --background and --output-format cannot be validated. Omit them or pick a documented model.`);
  }
  const chosenRatio = pickRatio(entry, ratio, savedRatio);
  const chosenResolution = pickResolution(entry, resolution, savedResolution);
  const fields = {};
  let pixels = null;
  let promptSuffix = "";
  let imageConfig = null;

  switch (entry.size.param) {
    case "size": {
      pixels = entry.size.pixels?.[chosenResolution]?.[chosenRatio || "1:1"] || null;
      if (!pixels) throw new Error(`${entry.id} has no documented ${chosenResolution} size for ${chosenRatio || "1:1"}.`);
      fields.size = pixels;
      break;
    }
    case "aspect_ratio+resolution":
      if (chosenRatio && chosenRatio !== "auto") fields.aspect_ratio = chosenRatio;
      if (chosenResolution) fields.resolution = entry.size.resolutionValues[chosenResolution] || chosenResolution.toLowerCase();
      pixels = chosenRatio && chosenRatio !== "auto" ? entry.size.pixels?.[chosenResolution]?.[chosenRatio] || null : null;
      break;
    case "size-tier":
      if (chosenResolution) {
        const tier = entry.size.resolutionValues[chosenResolution] || chosenResolution;
        fields.size = tier;
        fields.quality = tier;
      }
      break;
    case "prompt-ar":
      if (chosenRatio && chosenRatio !== "auto") promptSuffix = `--ar ${chosenRatio}`;
      break;
    case "image_config":
      imageConfig = {};
      if (chosenRatio && chosenRatio !== "auto") imageConfig.aspect_ratio = chosenRatio;
      if (chosenResolution) imageConfig.image_size = entry.size.resolutionValues[chosenResolution] || chosenResolution;
      pixels = chosenRatio && chosenRatio !== "auto" ? entry.size.pixels?.[chosenResolution]?.[chosenRatio] || null : null;
      break;
    default:
      break;
  }

  const q = checkOption(entry, "quality", "quality", quality);
  if (q) {
    if (entry.size.param === "size-tier") throw new Error(`${entry.id} sets quality through --resolution; do not pass --quality.`);
    fields.quality = q;
  }
  const bg = checkOption(entry, "background", "background", background);
  const format = checkOption(entry, "outputFormat", "output format", outputFormat);
  if (bg === "transparent" && format === "jpeg") throw new Error("A transparent background needs --output-format png or webp; jpeg has no transparency.");
  if (bg) fields.background = bg;
  if (format) fields.output_format = format;

  const parts = [chosenResolution, chosenRatio].filter(Boolean);
  const label = `${parts.join(" ") || "model default"}${pixels ? ` (${pixels})` : ""}`;
  return {
    model: entry.id,
    protocol: entry.protocol,
    ratio: chosenRatio,
    resolution: chosenResolution,
    pixels,
    // Only exact-pixel models get the local crop/resize to the requested size.
    resizeTo: entry.size.param === "size" ? pixels : null,
    fields,
    imageConfig,
    promptSuffix,
    label,
    toString() {
      return label;
    },
    toJSON() {
      return label;
    },
  };
}

// Picks the edit request variant that can carry these references. Each source
// is { kind: "file" | "url" }; local files can also be sent as data URIs.
export function selectEditVariant(entry, sources) {
  const variants = entry.edit || [];
  if (variants.length === 0) throw new Error(`${entry.id} does not support image editing in this plugin.`);
  const count = sources.length;
  const hasUrl = sources.some((source) => source.kind === "url");
  const hasFile = sources.some((source) => source.kind === "file");
  const fits = (variant) => count <= variant.maxImages
    && (!hasUrl || variant.sources.includes("url"))
    && (!hasFile || variant.sources.includes("file") || variant.sources.includes("data-uri"));
  const preferred = [...variants].sort((a, b) => {
    // Local files go multipart when possible; URLs need a JSON variant.
    const score = (variant) => (hasUrl ? (variant.upload === "json" ? 0 : 1) : (variant.upload === "multipart" ? 0 : 1));
    return score(a) - score(b);
  });
  const variant = preferred.find(fits);
  if (variant) return variant;
  const takesFiles = (item) => item.sources.includes("file") || item.sources.includes("data-uri");
  if (hasUrl && !variants.some((item) => item.sources.includes("url"))) throw new Error(`${entry.id} does not accept reference image URLs; pass local files instead.`);
  if (hasFile && !variants.some(takesFiles)) throw new Error(`${entry.id} only accepts public reference image URLs, not local files.`);
  const usable = variants.filter((item) => (!hasUrl || item.sources.includes("url")) && (!hasFile || takesFiles(item)));
  const maxCount = Math.max(0, ...usable.map((item) => item.maxImages));
  const kind = hasFile && hasUrl ? "with this mix of local files and URLs" : (hasFile ? "as local files" : "as URLs");
  const urlMax = Math.max(0, ...variants.filter((item) => item.sources.includes("url")).map((item) => item.maxImages));
  const hint = hasFile && urlMax > maxCount ? ` Up to ${urlMax} are accepted as public image URLs.` : "";
  if (maxCount === 0) throw new Error(`${entry.id} cannot take reference images ${kind}.${hint}`);
  throw new Error(`${entry.id} accepts at most ${maxCount} reference image(s) per request ${kind}; got ${count}.${hint}`);
}

// Summary used by --list-models: what each model accepts, without internals.
export function describeEntry(entry, available = null) {
  const maxRefs = Math.max(0, ...(entry.edit || []).map((variant) => variant.maxImages));
  return {
    id: entry.id,
    available,
    documented: !entry.inferred,
    aliasOf: entry.aliasOf,
    protocol: entry.protocol,
    summary: entry.summary,
    edit: maxRefs ? { maxReferenceImages: maxRefs, sources: [...new Set(entry.edit.flatMap((variant) => variant.sources))] } : false,
    resolutions: entry.size.resolutions,
    ratios: entry.size.ratios,
    imagesPerRequest: entry.n.imagesPerRequest || 1,
    quality: entry.options?.quality,
    background: entry.options?.background,
    outputFormat: entry.options?.outputFormat,
    billing: entry.billing,
    docs: entry.docs ? `https://88api.ai${entry.docs}` : null,
  };
}
