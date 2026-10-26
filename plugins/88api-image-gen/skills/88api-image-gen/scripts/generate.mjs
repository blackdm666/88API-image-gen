#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  describeEntry,
  findEntry,
  inferEntry,
  loadCatalog,
  loadSnapshotCatalog,
  resolveRequestPlan,
  sanitizeCatalog,
  selectEditVariant,
} from "./catalog.mjs";
import { buildGeminiChatBody, decodeBase64Image, geminiStageError, parseGeminiChatResponse, postJsonOverHttps, safeErrorText } from "./gemini.mjs";

const API_ROOT = "https://88api.ai";
const IMAGES_EDITS_URL = `${API_ROOT}/v1/images/edits`;
const CHAT_COMPLETIONS_URL = `${API_ROOT}/v1/chat/completions`;
const MODELS_URL = `${API_ROOT}/v1/models`;
const PLUGIN_VERSION = "3.0.4";
const DEFAULT_MODEL = "gpt-image-2";
// Model ids from older plugin versions: gpt-image-2-4k became gpt-image-2 + 4K.
const LEGACY_MODEL_ALIASES = { "gpt-image-2-4k": { model: "gpt-image-2", resolution: "4K" } };
// Capability boundaries come from the 88API docs catalog (see catalog.mjs). The
// bundled snapshot is used until main() loads the cached or live copy.
let CATALOG = loadSnapshotCatalog();
// Models the Key lists but the catalog does not document yet (see inferEntry).
const INFERRED_ENTRIES = new Map();
const DEFAULT_TRANSPORT = "images";
const TRANSPORTS = new Set(["auto", "images"]);
// Client-neutral config location. API88_CONFIG_DIR overrides the directory;
// API88_KEY overrides the saved Key for one process without being written.
const CONFIG_DIR_OVERRIDDEN = !!String(process.env.API88_CONFIG_DIR || "").trim();
const CONFIG_DIR = CONFIG_DIR_OVERRIDDEN ? resolve(String(process.env.API88_CONFIG_DIR).trim()) : join(homedir(), ".88api");
const CONFIG_PATH = join(CONFIG_DIR, "image-gen.json");
const JOBS_DIR = join(CONFIG_DIR, "image-gen-jobs");
const ENV_API_KEY = String(process.env.API88_KEY || "").trim();
// Read once and copied to CONFIG_PATH; never deleted. While the Codex-era file
// exists, --set-key and other saves also update it so older installed plugin
// versions keep using the current Key.
const LEGACY_CODEX_CONFIG_PATH = join(homedir(), ".codex", "88api-image-gen-config.json");
const LEGACY_FHL_CONFIG_PATH = join(homedir(), ".codex", "fhl-image-gen-config.json");
// 88API-Nano-Banana (no longer updated) kept its Key here; a Nano-only user is
// migrated on first use. Its saved Gemini model carries over as the default.
const LEGACY_NANO_CONFIG_PATHS = [join(CONFIG_DIR, "nano-banana.json"), join(homedir(), ".codex", "88api-nano-banana-config.json")];
const LEGACY_CONFIG_PATHS = [LEGACY_CODEX_CONFIG_PATH, LEGACY_FHL_CONFIG_PATH, ...LEGACY_NANO_CONFIG_PATHS];
const CATALOG_CACHE_PATH = join(CONFIG_DIR, "image-models.json");
const JOB_LIST_LIMIT = 5;

const MAX_GENERATION_COUNT = 9;
const MAX_REPEAT = 50;
const MAX_CONCURRENCY = 10;
const MAX_EDIT_COUNT = 4;
const MAX_BATCH_PROMPTS = 20;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 600_000;
const RESULT_DOWNLOAD_ATTEMPTS = 3;
const RESULT_DOWNLOAD_BACKOFF_MS = [2_000, 5_000];
// Socket errors that happen before any request byte reaches 88API. Only these
// prove a paid request was never submitted.
const CONNECT_FAILURE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"]);
const NO_AUTO_RETRY_PREFIX = "[NO-AUTO-RETRY]";
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655_360;
const IMAGE_MAX_PIXELS = 8_294_400;
const IMAGE_MAX_EDGE = 3_840;
const IMAGE_MAX_RATIO = 3;
const DEFAULTS = {
  count: 1,
  concurrency: 3,
};
const API_SIZE_LIMIT_NOTICE = "图像请求规格与实际计费以 88api.ai 控制台为准。";
const WORKER_ID_PREFIX = "worker-";
const DEFAULT_WORKER_NAME = "default";
const DEFAULT_WORKER_COOLDOWN_MS = 60_000;
const SCHEDULER_IDLE_MS = 25;
const IMAGE_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const WORKFLOW_DEFAULT_LIMIT = 100;
const WORKFLOW_DEFAULT_REPAIR_PASSES = 2;
const WORKFLOW_REPAIR_CONCURRENCY = 1;
const WORKFLOW_NAIL_PRESET = "nail-tryon";
const NAIL_STRESS_DEFAULT_LIMIT = 100;
const NAIL_STRESS_SCENES = [
  {
    sceneIndex: 1,
    sceneKey: "hands_closeup",
    filename: "01_hands_closeup.png",
    label: "双手前伸特写",
    instruction: "伸出双手做近距离美甲展示，镜头重点聚焦双手和美甲细节，模特脸部可以弱化但仍要保持可识别。",
  },
  {
    sceneIndex: 2,
    sceneKey: "hand_half_face",
    filename: "02_hand_half_face.png",
    label: "手遮半眼面部特写",
    instruction: "一只手自然靠近脸颊或遮住一侧眼周，肩部以上近景，特写镜头同时展示眼镜、发型、脸部识别特征和手部美甲，姿态中性自然，不要性感化。",
  },
  {
    sceneIndex: 3,
    sceneKey: "half_body_pose",
    filename: "03_half_body_pose.png",
    label: "半身像手部姿态",
    instruction: "半身像构图，画面裁切到腰部以上，双手做不同展示姿态，既体现人物气质，也要让手部美甲足够清晰可见，整体像电商 lookbook 或商品试戴参考图，不强调身体曲线，不突出裙摆和腿部。",
  },
  {
    sceneIndex: 4,
    sceneKey: "full_body_scene",
    filename: "04_full_body_scene.png",
    label: "全身场景展示",
    instruction: "全身像构图，人物完整出现在独立场景中，同时仍能清楚看到双手和美甲展示，不要把手藏起来；站姿和镜头语言保持日常、中性、保守的商品展示风格，避免任何性感化姿态或对身体曲线的强调。",
  },
];

const RATIO_ALIASES = {
  square: "1:1",
  landscape: "4:3",
  portrait: "3:4",
};

function previewKey(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 4)}...${key.slice(-2)}`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function nextWorkerId(workers) {
  let maxId = 0;
  for (const worker of workers || []) {
    const match = new RegExp(`^${WORKER_ID_PREFIX}(\\d+)$`).exec(String(worker?.id || "").trim());
    if (!match) continue;
    maxId = Math.max(maxId, Number(match[1]) || 0);
  }
  return `${WORKER_ID_PREFIX}${maxId + 1}`;
}

function workerFallbackName(id, index) {
  if (index === 0 && id === `${WORKER_ID_PREFIX}1`) return DEFAULT_WORKER_NAME;
  return id;
}

function normalizeWorkerRecord(rawWorker, normalizedWorkers, index, now) {
  if (!rawWorker || typeof rawWorker !== "object") return null;
  const apiKey = String(rawWorker.apiKey || "").trim();
  if (!apiKey) return null;

  const existingIds = new Set(normalizedWorkers.map((worker) => worker.id));
  let id = String(rawWorker.id || "").trim();
  if (!id || existingIds.has(id)) id = nextWorkerId(normalizedWorkers);

  return {
    id,
    name: String(rawWorker.name || "").trim() || workerFallbackName(id, index),
    apiKey,
    enabled: rawWorker.enabled !== false,
    createdAt: String(rawWorker.createdAt || "").trim() || now,
  };
}

function createWorkerRecord(apiKey, name, existingWorkers = []) {
  const id = nextWorkerId(existingWorkers);
  return {
    id,
    name: String(name || "").trim() || workerFallbackName(id, existingWorkers.length),
    apiKey: String(apiKey || "").trim(),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

function normalizeConfigShape(config) {
  const source = config && typeof config === "object" ? { ...config } : {};
  const normalized = { ...source };
  let changed = false;
  const now = new Date().toISOString();
  const normalizedWorkers = [];
  const sourceWorkers = Array.isArray(source.workers) ? source.workers : [];

  if (source.apiKey && sourceWorkers.length === 0) {
    normalizedWorkers.push({
      id: `${WORKER_ID_PREFIX}1`,
      name: DEFAULT_WORKER_NAME,
      apiKey: String(source.apiKey).trim(),
      enabled: true,
      createdAt: now,
    });
    changed = true;
  }

  for (const rawWorker of sourceWorkers) {
    const worker = normalizeWorkerRecord(rawWorker, normalizedWorkers, normalizedWorkers.length, now);
    if (!worker) {
      changed = true;
      continue;
    }
    if (
      worker.id !== rawWorker.id
      || worker.name !== rawWorker.name
      || worker.enabled !== (rawWorker.enabled !== false)
      || worker.createdAt !== rawWorker.createdAt
      || worker.apiKey !== rawWorker.apiKey
    ) {
      changed = true;
    }
    normalizedWorkers.push(worker);
  }

  normalized.workers = normalizedWorkers;
  const alias = legacyModelAlias(source.model);
  if (alias) {
    normalized.model = alias.model;
    normalized.resolution = alias.resolution;
  } else {
    // A saved model the current catalog no longer lists falls back to the default.
    normalized.model = modelEntry(source.model) ? source.model : DEFAULT_MODEL;
  }
  if (source.model !== normalized.model) changed = true;
  if (normalized.resolution !== undefined && !["1K", "2K", "4K"].includes(normalized.resolution)) {
    delete normalized.resolution;
    changed = true;
  }
  if ("apiKey" in normalized) {
    delete normalized.apiKey;
    changed = true;
  }
  if (!Array.isArray(source.workers)) changed = true;
  return { config: normalized, changed };
}

let loadedConfigSource = null;

function writeConfigFile(normalized, configPath) {
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, configPath);
    try {
      chmodSync(configPath, 0o600);
    } catch {
      // Windows may not implement POSIX permission bits; the user profile ACL remains authoritative.
    }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function defaultLegacyPaths(configPath) {
  return configPath === CONFIG_PATH && !CONFIG_DIR_OVERRIDDEN ? LEGACY_CONFIG_PATHS : [];
}

// Legacy files that each save also updates during the transition period.
function legacyMirrorPaths(configPath) {
  return configPath === CONFIG_PATH && !CONFIG_DIR_OVERRIDDEN && existsSync(LEGACY_CODEX_CONFIG_PATH) ? [LEGACY_CODEX_CONFIG_PATH] : [];
}

function saveConfig(config, configPath = CONFIG_PATH, mirrorPaths = legacyMirrorPaths(configPath)) {
  const { config: normalized } = normalizeConfigShape(config);
  writeConfigFile(normalized, configPath);
  for (const mirrorPath of mirrorPaths) {
    try {
      writeConfigFile(normalized, mirrorPath);
    } catch (error) {
      console.warn(`WARNING: Saved ${configPath}, but could not update the legacy copy ${mirrorPath}: ${error?.message || String(error)}`);
    }
  }
}

function loadConfig(configPath = CONFIG_PATH, legacyPaths = defaultLegacyPaths(configPath)) {
  const sourcePath = existsSync(configPath) ? configPath : (legacyPaths.find((path) => existsSync(path)) || null);
  loadedConfigSource = sourcePath;
  if (!sourcePath) return normalizeConfigShape({}).config;
  let normalized;
  try {
    normalized = normalizeConfigShape(JSON.parse(readFileSync(sourcePath, "utf8")));
  } catch (error) {
    console.warn(`WARNING: Unable to read 88API configuration at ${sourcePath}: ${error?.message || String(error)}`);
    return normalizeConfigShape({}).config;
  }
  // Migration / normalization write-backs are optional: in a read-only sandbox the
  // configuration that was read is still used for this run.
  try {
    if (sourcePath !== configPath) {
      saveConfig(normalized.config, configPath, legacyMirrorPaths(configPath).filter((path) => path !== sourcePath));
      console.warn(`NOTICE: Copied the 88API configuration from ${sourcePath} to ${configPath}; the old file was kept.`);
    } else if (normalized.changed) {
      saveConfig(normalized.config, configPath);
    }
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    console.warn(`NOTICE: could not update ${configPath} (${error.code}); using the configuration read from ${sourcePath} for this run.`);
  }
  return normalized.config;
}

function getConfiguredWorkers(config, options = {}) {
  const requireEnabled = options.requireEnabled === true;
  const workers = Array.isArray(config?.workers) ? config.workers.filter((worker) => worker?.apiKey) : [];
  return requireEnabled ? workers.filter((worker) => worker.enabled !== false) : workers;
}

function getPrimaryWorker(config, options = {}) {
  const requireEnabled = options.requireEnabled === true;
  const workers = getConfiguredWorkers(config);
  if (requireEnabled) return workers.find((worker) => worker.enabled !== false) || null;
  return workers.find((worker) => worker.enabled !== false) || workers[0] || null;
}

function getEnabledWorkersOrExit(config) {
  if (ENV_API_KEY) return [{ id: "env", name: "API88_KEY", apiKey: ENV_API_KEY, enabled: true }];
  const worker = getPrimaryWorker(config, { requireEnabled: true });
  if (!worker) {
    console.error("ERROR: No 88API Key is configured. Send the Key to the Agent so it can save and verify it for you (you do not need to run any command), or set the API88_KEY environment variable.");
    process.exit(1);
  }
  return [worker];
}

function workerLabel(worker) {
  if (!worker) return "unknown-worker";
  return String(worker.name || "").trim() || String(worker.id || "").trim() || "unknown-worker";
}

function buildConfigSummary(config, { envKey = ENV_API_KEY, source = loadedConfigSource } = {}) {
  const workers = getConfiguredWorkers(config);
  const primaryWorker = getPrimaryWorker(config);
  const legacyExtraCount = Math.max(0, workers.length - (primaryWorker ? 1 : 0));
  const mirrors = legacyMirrorPaths(CONFIG_PATH);
  return {
    插件版本: PLUGIN_VERSION,
    配置文件: CONFIG_PATH,
    Key来源: envKey ? "环境变量 API88_KEY（优先于配置文件，不写入磁盘）" : (primaryWorker ? source || CONFIG_PATH : "未配置"),
    旧版配置同步: mirrors.length > 0 ? `${mirrors.join(", ")}（保存时同步更新，供旧版插件使用）` : "无",
    已配置Key: !!(envKey || primaryWorker),
    Key预览: envKey ? previewKey(envKey) : (primaryWorker ? previewKey(primaryWorker.apiKey) : null),
    Key模式: "单 Key",
    上游分组: "请在 88API 控制台选择 auto；本地无法从 Key 反查分组",
    并发模式: "同一 Key 建立本地请求槽，由 auto 分组在上游自动分配",
    旧版备用Key记录: legacyExtraCount > 0 ? `${legacyExtraCount} 个（仅保留兼容，不参与请求；再次 --set-key 后清理）` : "无",
    协议: "按模型清单选择：OpenAI Images API 或 Chat Completions（Gemini）",
    模型清单: `${CATALOG.source}${CATALOG.fetchedAt ? `（${CATALOG.fetchedAt}）` : ""}`,
    当前保存模型: modelEntry(config?.model) ? config.model : DEFAULT_MODEL,
    保存的默认分辨率: config?.resolution || null,
    出厂默认模型: DEFAULT_MODEL,
    清单内模型: catalogModelIds(),
    快速模式: config?.quickMode || null,
    批量模式: config?.batchMode || null,
  };
}

function replaceWithSingleKey(config, apiKey) {
  const normalizedKey = String(apiKey || "").trim();
  if (!normalizedKey) throw new Error("88API Key cannot be empty.");
  return {
    ...config,
    workers: [createWorkerRecord(normalizedKey, DEFAULT_WORKER_NAME, [])],
  };
}

function normalizeTransport(value) {
  const normalized = String(value || DEFAULT_TRANSPORT).trim().toLowerCase();
  if (normalized === "response") return "responses";
  if (normalized === "image" || normalized === "images-api") return "images";
  return normalized;
}

function resolveRunTransport(value) {
  const requested = normalizeTransport(value);
  if (!TRANSPORTS.has(requested)) {
    if (requested === "responses") {
      throw new Error("Responses transport is disabled: all supported image models use the 88API Images API only.");
    }
    throw new Error(`Invalid transport="${value}". Use auto or images.`);
  }
  return "images";
}

// What the run actually calls, for the progress line. The --transport flag only
// exists for compatibility; the endpoint comes from the model catalog.
function routeLabel(model, imagePaths = null) {
  const entry = modelEntry(model);
  if (entry.protocol === "gemini-chat") return `Chat Completions ${CHAT_COMPLETIONS_URL}`;
  if (imagePaths?.length) {
    try {
      const variant = editVariantFor(model, imagePaths.map((path) => ({ url: /^https?:\/\//i.test(String(path)) ? path : null })));
      return `Images API ${API_ROOT}${variant.endpoint} (${variant.upload})`;
    } catch (error) {
      // Workflow modes validate references per request; the label just says why.
      return `Images API (${error?.message || error})`;
    }
  }
  return `Images API ${API_ROOT}${entry.generate.endpoint}`;
}

function modelEntry(model) {
  const id = String(model || "").trim();
  return findEntry(CATALOG, id) || INFERRED_ENTRIES.get(id) || null;
}

function catalogModelIds() {
  return CATALOG.models.map(({ id }) => id);
}

function validateModel(model) {
  const normalized = String(model || "").trim();
  if (!modelEntry(normalized)) {
    throw new Error(`Unknown model="${normalized}". It is not in the 88API model catalog; run --list-models to see the models your Key can use.`);
  }
  return normalized;
}

function legacyModelAlias(model) {
  return LEGACY_MODEL_ALIASES[String(model || "").trim()] || null;
}

function effectiveModel(flags, config) {
  const requested = flags?.model || config?.model || DEFAULT_MODEL;
  return validateModel(legacyModelAlias(requested)?.model || requested);
}

// A plain "WxH" string is still accepted by the request builders (self-tests and
// older call sites); it behaves like an exact-pixel plan.
function planOf(size) {
  if (size && typeof size === "object") return size;
  const pixels = size ? String(size) : null;
  return { fields: pixels ? { size: pixels } : {}, pixels, resizeTo: pixels, promptSuffix: "", imageConfig: null, label: pixels || "model default", resolution: null };
}

function resizeTarget(size) {
  return planOf(size).resizeTo || null;
}

function normalizeRatio(ratio) {
  const normalized = String(ratio || "").trim().toLowerCase();
  return RATIO_ALIASES[normalized] || normalized;
}

function imageSizeValidationError(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return `Invalid image size "${size}".`;
  const { width, height } = parsed;
  const pixels = width * height;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) {
    return `Image size ${size} must use ${IMAGE_SIZE_STEP}-pixel increments.`;
  }
  if (longEdge > IMAGE_MAX_EDGE) return `Image size ${size} exceeds the ${IMAGE_MAX_EDGE}px maximum edge.`;
  if (longEdge / shortEdge > IMAGE_MAX_RATIO) return `Image size ${size} exceeds the ${IMAGE_MAX_RATIO}:1 maximum aspect ratio.`;
  if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) {
    return `Image size ${size} has ${pixels} pixels; allowed range is ${IMAGE_MIN_PIXELS}-${IMAGE_MAX_PIXELS}.`;
  }
  return null;
}

function clampInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function timestamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
}

// Sandboxed Agent clients (DeepSeek Harness, Codex workspace-write) may only allow
// writes inside the working directory. When a default folder under the home
// directory is not writable, the CLI uses one under the current directory.
const WORKSPACE_OUTPUT_DIR = join(process.cwd(), "88api-images");
const WORKSPACE_JOBS_DIR = join(process.cwd(), ".88api-image-gen-jobs");
const reportedFallbacks = new Set();

function isPermissionError(error) {
  return ["EPERM", "EACCES", "EROFS"].includes(error?.code);
}

// An existing folder can still be read-only in a sandbox, so probe with a write.
function assertWritableDir(dir) {
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, `.write-test-${process.pid}-${Math.random().toString(36).slice(2, 6)}`);
  writeFileSync(probe, "");
  unlinkSync(probe);
}

function writableDir(preferred, fallback, label, assertWritable = assertWritableDir) {
  try {
    assertWritable(preferred);
    return preferred;
  } catch (error) {
    if (!fallback || !isPermissionError(error)) throw error;
    assertWritable(fallback);
    if (!reportedFallbacks.has(label)) {
      reportedFallbacks.add(label);
      console.warn(`NOTICE: the default ${label} ${preferred} is not writable here (${error.code}, usually a sandboxed client); using ${fallback} instead.`);
    }
    return fallback;
  }
}

function resolveOutputDir(userDir) {
  // An explicit --output-dir is the user's choice: report a failure instead of moving it.
  if (userDir) {
    mkdirSync(userDir, { recursive: true });
    return userDir;
  }
  return writableDir(join(homedir(), "Pictures", "88api-image-gen"), WORKSPACE_OUTPUT_DIR, "output folder");
}

function fileStem(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

function sanitizePathSegment(value) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "item";
}

function naturalTokens(value) {
  return String(value || "").match(/\d+|\D+/g) || [];
}

function compareNaturalNames(left, right) {
  const leftTokens = naturalTokens(left);
  const rightTokens = naturalTokens(right);
  const max = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < max; index += 1) {
    const a = leftTokens[index];
    const b = rightTokens[index];
    if (a == null) return -1;
    if (b == null) return 1;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
      if (a.length !== b.length) return a.length - b.length;
      continue;
    }
    const diff = a.localeCompare(b, "zh-Hans-CN", { sensitivity: "base" });
    if (diff !== 0) return diff;
  }
  return 0;
}

function listNaturalSortedImageFiles(dir) {
  if (!existsSync(dir)) {
    throw new Error(`Product directory does not exist: ${dir}`);
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => IMAGE_FILE_EXTENSIONS.has(String(entry.name || "").slice(String(entry.name || "").lastIndexOf(".")).toLowerCase()))
    .map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
      stem: fileStem(entry.name),
    }))
    .sort((left, right) => compareNaturalNames(left.name, right.name));
  return entries;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function writeTextFileAtomic(path, content, encoding = "utf8") {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, encoding);
  if (existsSync(path)) unlinkSync(path);
  renameSync(tmpPath, path);
}

function saveTextArtifact(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeTextFileAtomic(path, String(content || ""), "utf8");
}

function writeCsvFile(path, rows) {
  const content = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  writeTextFileAtomic(path, `${content}\n`, "utf8");
}

function buildNailStressOutputRoot(userDir) {
  return resolveOutputDir(userDir || join(homedir(), "Pictures", "88api-image-gen", `nail-stress-test_${timestamp()}`));
}

function buildWorkflowOutputRoot(userDir) {
  return resolveOutputDir(userDir || join(homedir(), "Pictures", "88api-image-gen", `workflow_${timestamp()}`));
}

function imageMimeTypeFromPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function imageExtensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function normalizeBase64Image(value) {
  if (!value || typeof value !== "string") return "";
  const comma = value.indexOf(",");
  return comma >= 0 ? value.slice(comma + 1) : value;
}

async function parseErrorResponse(res) {
  const body = await res.text().catch(() => "");
  return parseErrorBody(res.status, body);
}

function parseErrorBody(status, body) {
  if (!body) return `HTTP ${status}`;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed?.cloudflare_error || parsed?.error_code || parsed?.error_name) {
    const title = parsed.title || parsed.error_name || "Cloudflare error";
    const retryAfter = parsed.retry_after ? ` retry_after=${parsed.retry_after}s` : "";
    return `HTTP ${status}: ${title}${retryAfter}`;
  }
  const lower = body.toLowerCase();
  if (lower.includes("bad gateway") || lower.includes("error code 502")) return `HTTP ${status}: Cloudflare Bad Gateway`;
  if (lower.includes("gateway time-out") || lower.includes("error code 504")) return `HTTP ${status}: Cloudflare Gateway Timeout`;
  if (lower.includes("a timeout occurred") || lower.includes("error code 524")) return `HTTP ${status}: Cloudflare Timeout`;
  if (parsed) {
    const message = parsed?.error?.message || parsed?.message || body;
    return `HTTP ${status}: ${message}`;
  }
  return `HTTP ${status}: ${body}`;
}

async function requestWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoAutoRetryError(error) {
  const text = String(error || "").toLowerCase();
  return text.includes("[no-auto-retry]") || text.includes("[no-retry]");
}

function isRetryableError(error) {
  const text = String(error || "").toLowerCase();
  // Unknown-state failures must never be requeued by this process. A user may
  // still explicitly authorize a new paid request after seeing the warning.
  if (isNoAutoRetryError(text)) return false;
  return [
    "http 429",
    "http 502",
    "http 503",
    "http 504",
    "http 524",
    "timeout",
    "rate limit",
    "too many requests",
    "no available account",
    "account pool busy",
    "please retry later",
    "temporarily unavailable",
    "overloaded",
    "fetch failed",
    "request was not sent",
    "socket hang up",
    "econnreset",
    "terminated",
    "images api response did not contain",
  ].some((pattern) => text.includes(pattern));
}

function isFatalError(error) {
  const text = String(error || "").toLowerCase();
  if (isRetryableError(text)) return false;
  return [
    "http 400",
    "http 401",
    "http 403",
    "http 404",
    "http 422",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "incorrect api key",
    "missing api key",
    "invalid parameter",
    "invalid_request",
    "unsupported",
    "model not found",
    "content policy",
    "safety policy",
    "moderation",
  ].some((pattern) => text.includes(pattern));
}

function isWorkerFatalError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "http 401",
    "http 403",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "incorrect api key",
    "missing api key",
  ].some((pattern) => text.includes(pattern));
}

function isTaskFatalError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "http 400",
    "http 404",
    "http 422",
    "invalid parameter",
    "invalid_request",
    "unsupported",
    "model not found",
    "content policy",
    "safety policy",
    "moderation",
  ].some((pattern) => text.includes(pattern));
}

function truncateText(text, max = 60) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function buildNailScenePrompt(scene) {
  return [
    "请把第1张参考图中的固定模特，与第2张参考图中的美甲产品组合，生成一张真实自然的模特试戴图。",
    "严格保持同一模特身份与穿着不变：同一张脸、同一发型和刘海、同一副眼镜、粉色针织开衫、碎花裙、斜挎包、凉鞋，年龄感和整体气质保持一致，不要换人，不要改发型，不要改穿搭。",
    "把第1张参考图中的人物明确视为 25 岁左右的成年女性，保留其五官、发型、眼镜和穿搭特征，但不要呈现未成年感。",
    "粉色针织开衫要以保守、完整、日常穿法呈现，覆盖胸口区域；碎花裙作为普通日常裙装处理，不要强调裙长、腿部或身体曲线。",
    "第2张参考图是美甲产品款式参考，请把其中的颜色、材质、装饰、图案准确映射到模特双手的整套可穿戴美甲上，优先保证产品特征保真和手部细节清晰。",
    "整体风格必须是电商商品试戴参考图或品牌 lookbook 风格，人物姿态保持中性、自然、日常、保守，不要性感化，不要强调胸部、腰臀、腿部或身体曲线，不要做成人化呈现。",
    scene.instruction,
    "输出必须是 9:16 竖构图，人物和手部都要真实自然，不要拼图，不要多面板，不要海报文字，不要水印。",
  ].join("\n\n");
}

function saveBase64Image(base64, outputDir, prefix, index = null, targetSize = null) {
  const clean = normalizeBase64Image(base64);
  if (!clean) return null;
  const buffer = Buffer.from(clean, "base64");
  const suffix = Math.random().toString(36).slice(2, 6);
  const numbered = index == null ? "" : `_${index}`;
  const filename = `${prefix}_${timestamp()}${numbered}_${suffix}.${imageExtensionForBuffer(buffer)}`;
  const path = join(outputDir, filename);
  return savePngBuffer(path, buffer, targetSize);
}

// Grok 1K and most Gemini results are JPEG; name files by their real format.
function imageExtensionForBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") return "gif";
  return "png";
}

function savePngBuffer(path, buffer, targetSize = null) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  // The local crop/resize only handles PNG; other formats are kept as returned.
  const resizeInfo = readPngDimensions(buffer) ? ensurePngTargetSize(path, targetSize) : null;
  const finalBuffer = resizeInfo?.resized ? readFileSync(path) : buffer;
  const dimensions = readImageDimensions(finalBuffer);
  return {
    path,
    fileSize: `${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB`,
    width: dimensions?.width || resizeInfo?.width || null,
    height: dimensions?.height || resizeInfo?.height || null,
    dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
    resized: !!resizeInfo?.resized,
    originalDimensions: resizeInfo?.originalWidth ? `${resizeInfo.originalWidth}x${resizeInfo.originalHeight}` : null,
    resizeError: resizeInfo?.error || null,
  };
}

function saveBase64ImageToPath(base64, path, targetSize = null) {
  const clean = normalizeBase64Image(base64);
  if (!clean) return null;
  const buffer = Buffer.from(clean, "base64");
  return savePngBuffer(path, buffer, targetSize);
}

function formatImageResult(result) {
  const parts = [result.fileSize].filter(Boolean);
  if (result.dimensions) parts.push(result.dimensions);
  if (result.resized && result.originalDimensions) parts.push(`resized from ${result.originalDimensions}`);
  if (result.resizeError) parts.push(`resize warning: ${result.resizeError}`);
  if (result.extraImages?.length) parts.push(`+${result.extraImages.length} more from the same request: ${result.extraImages.map((item) => item.path).join(", ")}`);
  return parts.join(", ");
}

function inspectExistingImage(path) {
  if (!existsSync(path)) return null;
  const buffer = readFileSync(path);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const dimensions = readImageDimensions(buffer);
  return {
    ok: true,
    path,
    fileSize: `${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
    width: dimensions?.width || null,
    height: dimensions?.height || null,
    dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
    resized: false,
    originalDimensions: null,
    resizeError: null,
    elapsed: 0,
    attempts: 0,
    retries: 0,
    reusedExisting: true,
  };
}

function parseSizeForAspect(size) {
  const match = /^(\d+)x(\d+)$/i.exec(String(size || "").trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const hasSignature = buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
  if (!hasSignature || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const ext = imageExtensionForBuffer(buffer);
  if (ext === "jpg") return readJpegDimensions(buffer);
  if (ext === "webp") return readWebpDimensions(buffer);
  return readPngDimensions(buffer);
}

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resizePngWithPowerShell(path, width, height) {
  const command = `
$ErrorActionPreference = 'Stop'
$Path = ${powershellSingleQuoted(path)}
$TargetWidth = ${width}
$TargetHeight = ${height}
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($Path)
$bitmap = $null
$graphics = $null
$tmp = "$Path.tmp.png"
try {
  $sourceWidth = $image.Width
  $sourceHeight = $image.Height
  $targetRatio = $TargetWidth / $TargetHeight
  $sourceRatio = $sourceWidth / $sourceHeight
  if ($sourceRatio -gt $targetRatio) {
    $cropHeight = $sourceHeight
    $cropWidth = [int][Math]::Round($sourceHeight * $targetRatio)
    $cropX = [int][Math]::Floor(($sourceWidth - $cropWidth) / 2)
    $cropY = 0
  } else {
    $cropWidth = $sourceWidth
    $cropHeight = [int][Math]::Round($sourceWidth / $targetRatio)
    $cropX = 0
    $cropY = [int][Math]::Floor(($sourceHeight - $cropHeight) / 2)
  }
  $bitmap = New-Object System.Drawing.Bitmap $TargetWidth, $TargetHeight
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $dest = New-Object System.Drawing.Rectangle 0, 0, $TargetWidth, $TargetHeight
  $source = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropWidth, $cropHeight
  $graphics.DrawImage($image, $dest, $source, [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose(); $graphics = $null
  $image.Dispose(); $image = $null
  $bitmap.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose(); $bitmap = $null
  Move-Item -LiteralPath $tmp -Destination $Path -Force
} finally {
  if ($graphics -ne $null) { $graphics.Dispose() }
  if ($bitmap -ne $null) { $bitmap.Dispose() }
  if ($image -ne $null) { $image.Dispose() }
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
}
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], { encoding: "utf8" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    return { ok: false, error: details || `PowerShell exited with ${result.status}` };
  }
  return { ok: true };
}

function replaceFileFromTemp(tmpPath, path) {
  if (existsSync(path)) unlinkSync(path);
  renameSync(tmpPath, path);
}

function resizePngWithImageMagick(path, width, height) {
  const tmp = `${path}.imagemagick-${process.pid}-${Date.now()}.png`;
  const args = [path, "-auto-orient", "-resize", `${width}x${height}^`, "-gravity", "center", "-extent", `${width}x${height}`, tmp];
  let result = spawnSync("magick", args, { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    result = spawnSync("convert", args, { encoding: "utf8" });
  }
  if (result.error || result.status !== 0 || !existsSync(tmp)) {
    if (existsSync(tmp)) unlinkSync(tmp);
    const details = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    return { ok: false, error: details || "ImageMagick is not installed or failed to resize the image" };
  }
  replaceFileFromTemp(tmp, path);
  return { ok: true };
}

function resizePngWithSips(path, width, height, sourceWidth, sourceHeight) {
  const tmp = `${path}.sips-${process.pid}-${Date.now()}.png`;
  const targetRatio = width / height;
  const sourceRatio = sourceWidth / sourceHeight;
  const cropWidth = sourceRatio > targetRatio ? Math.round(sourceHeight * targetRatio) : sourceWidth;
  const cropHeight = sourceRatio > targetRatio ? sourceHeight : Math.round(sourceWidth / targetRatio);
  copyFileSync(path, tmp);
  const crop = spawnSync("sips", ["--cropToHeightWidth", String(cropHeight), String(cropWidth), tmp], { encoding: "utf8" });
  if (crop.error || crop.status !== 0) {
    if (existsSync(tmp)) unlinkSync(tmp);
    return { ok: false, error: [crop.error?.message, crop.stderr, crop.stdout].filter(Boolean).join("\n").trim() || "sips crop failed" };
  }
  const resize = spawnSync("sips", ["--resampleHeightWidth", String(height), String(width), tmp], { encoding: "utf8" });
  if (resize.error || resize.status !== 0) {
    if (existsSync(tmp)) unlinkSync(tmp);
    return { ok: false, error: [resize.error?.message, resize.stderr, resize.stdout].filter(Boolean).join("\n").trim() || "sips resize failed" };
  }
  replaceFileFromTemp(tmp, path);
  return { ok: true };
}

function resizePngForPlatform(path, width, height, sourceWidth, sourceHeight) {
  if (process.platform === "win32") return resizePngWithPowerShell(path, width, height);
  if (process.platform === "darwin") return resizePngWithSips(path, width, height, sourceWidth, sourceHeight);
  return resizePngWithImageMagick(path, width, height);
}

function ensurePngTargetSize(path, targetSize) {
  const target = parseSizeForAspect(targetSize);
  if (!target) return null;

  const beforeBuffer = readFileSync(path);
  const before = readPngDimensions(beforeBuffer);
  if (!before) return { resized: false, error: "Saved image is not a readable PNG" };
  if (before.width === target.width && before.height === target.height) {
    return { resized: false, width: before.width, height: before.height };
  }
  const resized = resizePngForPlatform(path, target.width, target.height, before.width, before.height);
  if (!resized.ok) {
    return {
      resized: false,
      width: before.width,
      height: before.height,
      error: `Resize to ${targetSize} failed on ${process.platform}: ${resized.error}`,
    };
  }
  const after = readPngDimensions(readFileSync(path));
  return {
    resized: true,
    width: after?.width || target.width,
    height: after?.height || target.height,
    originalWidth: before.width,
    originalHeight: before.height,
  };
}

function gcd(left, right) {
  let a = Math.abs(Math.trunc(Number(left) || 0));
  let b = Math.abs(Math.trunc(Number(right) || 0));
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function aspectPromptSuffixForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return "";
  const divisor = gcd(parsed.width, parsed.height);
  if (!divisor) return "";
  const aspect = `${parsed.width / divisor}:${parsed.height / divisor}`;
  if (parsed.width === parsed.height) {
    return `请严格按照 ${aspect} 正方形画幅生成最终图片，整张图片必须为 ${aspect} 比例。`;
  }
  if (parsed.height > parsed.width) {
    return `请严格按照 ${aspect} 竖版画幅生成最终图片，整张图片必须为 ${aspect} 竖向构图，不要正方形，不要横版。`;
  }
  return `请严格按照 ${aspect} 横版画幅生成最终图片，整张图片必须为 ${aspect} 横向构图，不要正方形，不要竖版。`;
}

// Exact-pixel models also get the aspect reminder appended to the prompt (as
// before v3); Midjourney-style models get their --ar flag.
function imageApiPrompt(prompt, size) {
  const plan = planOf(size);
  const aspectPromptSuffix = plan.resizeTo ? aspectPromptSuffixForSize(plan.pixels) : "";
  const flagged = plan.promptSuffix && !/(^|\s)--ar\s/.test(prompt) ? `${prompt} ${plan.promptSuffix}` : prompt;
  return [flagged, aspectPromptSuffix].filter(Boolean).join("\n\n");
}

function buildImagesGenerationBody(model, prompt, size, options = {}) {
  const body = {
    model: validateModel(model),
    prompt: imageApiPrompt(prompt, size),
    ...planOf(size).fields,
    n: 1,
  };
  if (options.preview === true) {
    body.stream = true;
    body.partial_images = 1;
  }
  return body;
}

// GPT Image edits need an exact pixel size. Without --aspect, follow the first
// local reference (Gemini and Grok already do this upstream) instead of the
// catalog's 1:1 default, which would reframe a 3:2 photo into a square.
function referenceAspect(model, imagePaths = []) {
  const entry = modelEntry(model);
  if (entry?.size.param !== "size") return null;
  const first = imagePaths.find((path) => !/^https?:\/\//i.test(String(path)));
  if (!first || !existsSync(first)) return null;
  const dims = readImageDimensions(readFileSync(first));
  if (!dims?.width || !dims?.height) return null;
  const target = Math.log(dims.width / dims.height);
  let best = null;
  for (const ratio of entry.size.ratios) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
    if (!match) continue;
    const distance = Math.abs(Math.log(Number(match[1]) / Number(match[2])) - target);
    if (!best || distance < best.distance) best = { ratio, distance };
  }
  return best ? { ratio: best.ratio, width: dims.width, height: dims.height } : null;
}

function editVariantFor(model, sources) {
  return selectEditVariant(modelEntry(model), sources.map((source) => ({ kind: source.url ? "url" : "file" })));
}

function buildImagesEditForm(model, prompt, size, sources, options = {}) {
  const variant = options.variant || editVariantFor(model, sources);
  const form = new FormData();
  form.append("model", validateModel(model));
  form.append("prompt", imageApiPrompt(prompt, size));
  for (const [key, value] of Object.entries(planOf(size).fields)) form.append(key, String(value));
  form.append("n", "1");
  for (const source of sources) {
    const sourceBuffer = options.redactImageData ? Buffer.from(`<redacted ${source.sourceBuffer.length} bytes>`) : source.sourceBuffer;
    const blob = new Blob([sourceBuffer], { type: source.mimeType || "image/png" });
    form.append(variant.field, blob, source.sourceName || `reference.${source.ext || "png"}`);
  }
  return form;
}

// JSON edit request: references go as data URIs or public URLs in one field
// (Grok and az use /v1/images/edits; Seedream puts URLs on /v1/images/generations).
function buildImagesEditJson(model, prompt, size, sources, variant, options = {}) {
  const items = sources.map((source) => source.url
    || `data:${source.mimeType || "image/png"};base64,${options.redactImageData ? `<${source.sourceBuffer.length} bytes omitted>` : source.sourceBuffer.toString("base64")}`);
  return {
    model: validateModel(model),
    prompt: imageApiPrompt(prompt, size),
    ...planOf(size).fields,
    n: 1,
    [variant.field]: variant.field.endsWith("s") ? items : items[0],
  };
}

function dryRunReferenceSummary(imagePaths = []) {
  return imagePaths.map((imagePath, index) => {
    const source = loadSourceImage(imagePath);
    if (!source.ok) throw new Error(source.error);
    return source.url
      ? { index: index + 1, url: source.url }
      : { index: index + 1, name: source.sourceName, mimeType: source.mimeType, bytes: source.sourceBuffer.length, content: "<binary omitted>" };
  });
}

function buildDryRunPlan({ mode, model, size, aspect, prompts = [], imagePaths = [], count = 1, concurrency = 1, preview = false }) {
  const entry = modelEntry(model);
  const plan = planOf(size);
  const editing = imagePaths.length > 0;
  const samplePrompt = prompts[0] || "";
  let endpoint;
  let contentType = "application/json";
  let request;
  if (entry.protocol === "gemini-chat") {
    endpoint = CHAT_COMPLETIONS_URL;
    const sources = editing ? imagePaths.map((path) => loadSourceImage(path)) : [];
    if (editing) editVariantFor(model, sources);
    request = buildGeminiChatBody(model, samplePrompt, plan, sources, { redactImageData: true });
  } else if (editing) {
    const sources = imagePaths.map((path) => loadSourceImage(path));
    const variant = editVariantFor(model, sources);
    endpoint = `${API_ROOT}${variant.endpoint}`;
    if (variant.upload === "multipart") {
      contentType = "multipart/form-data";
      request = { model, prompt: imageApiPrompt(samplePrompt, plan), ...plan.fields, n: 1, [variant.field]: dryRunReferenceSummary(imagePaths) };
    } else {
      request = buildImagesEditJson(model, samplePrompt, plan, sources, variant, { redactImageData: true });
    }
  } else {
    endpoint = `${API_ROOT}${entry.generate.endpoint}`;
    request = buildImagesGenerationBody(model, samplePrompt, plan, { preview });
  }
  return {
    dryRun: true,
    paidApiCalled: false,
    protocol: entry.protocol === "gemini-chat" ? "OpenAI Chat Completions (Gemini image)" : "OpenAI Images API",
    method: "POST",
    endpoint,
    mode,
    model,
    documented: !entry.inferred,
    resolution: plan.resolution,
    aspect,
    size: plan.label,
    imagesPerRequest: entry.n.imagesPerRequest || 1,
    taskCount: count,
    concurrency,
    request: {
      headers: { Authorization: "Bearer <redacted>", "Content-Type": contentType },
      body: request,
    },
  };
}

function printDryRunPlan(options) {
  console.log(JSON.stringify(buildDryRunPlan(options), null, 2));
}

function extractImagesFromImageApi(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((item) => item?.b64_json || item?.base64 || item?.image?.b64_json)
    .filter((item) => typeof item === "string" && item.trim());
}

class ImageResultDownloadError extends Error {}

function networkErrorDetail(error) {
  if (error?.name === "AbortError") return `timeout after ${REQUEST_TIMEOUT_MS / 1000}s`;
  // Node fetch reports "fetch failed" and keeps the socket error in cause.
  const cause = error?.cause;
  const code = cause?.code || error?.code || "";
  const message = cause?.message || error?.message || String(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

// Builds the error for a failed Images request from the stage it reached:
// submit (state unknown unless the connection never opened), read-result
// (the response arrived, so the image was generated and billed) or download
// (already formatted with the saved result link).
function imageRequestStageError(label, stage, error) {
  if (error instanceof ImageResultDownloadError) return error.message;
  const detail = networkErrorDetail(error);
  if (stage === "submit" && CONNECT_FAILURE_CODES.has(error?.cause?.code || error?.code)) {
    return `${label} request was not sent: could not connect to 88API (${detail}); no charge was made`;
  }
  if (stage === "submit") return `${NO_AUTO_RETRY_PREFIX} ${label} request state is unknown (stage: submit): ${detail}`;
  return `${NO_AUTO_RETRY_PREFIX} ${label} request completed and was billed, but reading the result failed (stage: read-result): ${detail}`;
}

// Downloads a result link with free retries. HTTP(S) links are written to a
// link file first, so an image that was already generated and billed can be
// fetched later with --retry-download instead of paying for a new one.
async function downloadImageResult(url, linkContext = {}) {
  const linkFile = /^https?:/i.test(url) && linkContext.outputDir
    ? saveResultLink(url, linkContext)
    : null;
  let lastError = null;
  for (let attempt = 1; attempt <= RESULT_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const res = await requestWithTimeout(url, { headers: { "User-Agent": `88api-image-gen/${PLUGIN_VERSION}` } }, REQUEST_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      if (linkFile) unlinkSync(linkFile);
      return base64;
    } catch (error) {
      lastError = error;
      if (attempt < RESULT_DOWNLOAD_ATTEMPTS) {
        const waitMs = RESULT_DOWNLOAD_BACKOFF_MS[attempt - 1];
        console.log(`[download] 结果图下载失败（第 ${attempt} 次），${waitMs / 1000} 秒后免费重试：${networkErrorDetail(error)}`);
        await sleep(waitMs);
      }
    }
  }
  const saved = linkFile
    ? ` Result link saved to ${linkFile}; run --retry-download "${linkFile}" to fetch it again at no cost (the link may expire within about an hour).`
    : "";
  throw new ImageResultDownloadError(`${NO_AUTO_RETRY_PREFIX} Image was generated and billed, but downloading it failed after ${RESULT_DOWNLOAD_ATTEMPTS} attempts (stage: download): ${networkErrorDetail(lastError)}.${saved}`);
}

function saveResultLink(url, { outputDir, prefix = "img", savePath = null, targetSize = null, model = null }) {
  const linkFile = join(resolveOutputDir(outputDir), `${prefix}_${timestamp()}_${Math.random().toString(36).slice(2, 6)}.pending-download.json`);
  writeFileSync(linkFile, JSON.stringify({ url, savePath, outputDir, prefix, targetSize, model, createdAt: new Date().toISOString() }, null, 2));
  return linkFile;
}

async function imageApiResultBase64(data, linkContext = {}) {
  const [base64] = extractImagesFromImageApi(data);
  if (base64) return base64;
  const item = Array.isArray(data?.data) ? data.data.find((entry) => typeof entry?.url === "string" && entry.url) : null;
  if (!item?.url) return "";
  return downloadImageResult(item.url, linkContext);
}

// Every image of an Images response, in order (Midjourney always returns 4).
async function imageApiResultAllBase64(data, linkContext = {}) {
  const items = Array.isArray(data?.data) ? data.data : [];
  const results = [];
  for (const item of items) {
    const base64 = item?.b64_json || item?.base64 || item?.image?.b64_json;
    if (typeof base64 === "string" && base64.trim()) results.push(base64);
    else if (typeof item?.url === "string" && item.url) results.push(await downloadImageResult(item.url, linkContext));
  }
  return results;
}

// Saves all images of one response; the first is the result, the rest are listed
// as extraImages so a 4-image Midjourney request keeps every picture.
function saveImageSet(base64List, saveFirst, outputDir, prefix, targetSize) {
  const [first, ...rest] = base64List;
  const saved = first ? saveFirst(first) : null;
  if (!saved) return null;
  const extraImages = rest.map((base64, index) => saveBase64Image(base64, outputDir, prefix, index + 2, targetSize)).filter(Boolean);
  return extraImages.length ? { ...saved, extraImages } : saved;
}

// Fetches an image whose download failed earlier, from its saved link file.
// No new Images request is sent, so this never costs anything.
async function retrySavedDownload(linkFile) {
  if (!existsSync(linkFile)) throw new Error(`Link file does not exist: ${linkFile}`);
  const link = JSON.parse(readFileSync(linkFile, "utf8"));
  if (!/^https?:/i.test(link?.url || "")) throw new Error(`Link file has no result URL: ${linkFile}`);
  const base64 = await downloadImageResult(link.url, {});
  const saved = link.savePath
    ? saveBase64ImageToPath(base64, link.savePath, link.targetSize)
    : saveBase64Image(base64, resolveOutputDir(link.outputDir), link.prefix || "img", null, link.targetSize);
  if (!saved) throw new Error("Downloaded result is not an image");
  unlinkSync(linkFile);
  return saved;
}

function imageApiLogSummary(data, requestedModel = DEFAULT_MODEL) {
  const items = Array.isArray(data?.data) ? data.data : [];
  return {
    created: data?.created ?? null,
    model: data?.model || requestedModel,
    usage: data?.usage || null,
    images: items.map((item, index) => {
      const base64 = item?.b64_json || item?.base64 || item?.image?.b64_json || "";
      return {
        index: index + 1,
        revised_prompt: item?.revised_prompt || null,
        base64_characters: typeof base64 === "string" ? base64.length : 0,
        has_url: typeof item?.url === "string" && item.url.length > 0,
      };
    }),
  };
}

function walkForImageApiBase64(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkForImageApiBase64(child);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  if (typeof value.b64_json === "string" && value.b64_json.trim()) return value.b64_json;
  if (typeof value.base64 === "string" && value.base64.trim()) return value.base64;
  for (const child of Object.values(value)) {
    const found = walkForImageApiBase64(child);
    if (found) return found;
  }
  return "";
}

function walkForImageApiUrl(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkForImageApiUrl(child);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  if (typeof value.url === "string" && value.url.trim()) return value.url;
  for (const child of Object.values(value)) {
    const found = walkForImageApiUrl(child);
    if (found) return found;
  }
  return "";
}

function createPreviewPath() {
  const previewDir = resolveOutputDir(join(tmpdir(), "88api-image-gen-previews"));
  return join(previewDir, `preview_${timestamp()}_${Math.random().toString(36).slice(2, 6)}.png`);
}

async function consumeImageApiStream(res, options = {}) {
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    const data = await res.json();
    const base64 = walkForImageApiBase64(data) || await imageApiResultBase64(data, options.linkContext);
    return {
      base64,
      partialImageEvents: 0,
      eventCounts: { json: 1 },
      previewPath: null,
    };
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Images API SSE body is not readable");
  const decoder = new TextDecoder();
  const eventCounts = {};
  let buffer = "";
  let finalBase64 = "";
  let latestPartial = "";
  let latestImageUrl = "";
  let partialImageEvents = 0;
  const previewPath = options.preview ? createPreviewPath() : null;

  const handleEvent = (event) => {
    const type = String(event?.type || "unknown");
    eventCounts[type] = (eventCounts[type] || 0) + 1;
    if (type === "error" || type.endsWith(".failed")) {
      throw new Error(event?.error?.message || event?.message || "Images API stream failed");
    }
    const base64 = walkForImageApiBase64(event);
    const imageUrl = walkForImageApiUrl(event);
    if (imageUrl) latestImageUrl = imageUrl;
    if (type.includes("partial_image") && base64) {
      partialImageEvents += 1;
      latestPartial = base64;
      if (previewPath) {
        saveBase64ImageToPath(latestPartial, previewPath);
        console.log(`[stream] 实时预览 ${partialImageEvents}: ${previewPath}`);
      } else {
        console.log(`[stream] 图片进度 ${partialImageEvents}`);
      }
      return;
    }
    if (base64) finalBase64 = base64;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        handleEvent(JSON.parse(payload));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }

  if (!finalBase64 && !latestPartial && latestImageUrl) {
    finalBase64 = await imageApiResultBase64({ data: [{ url: latestImageUrl }] }, options.linkContext);
  }

  return {
    base64: finalBase64 || latestPartial,
    partialImageEvents,
    eventCounts,
    previewPath,
  };
}

function imageStreamLogSummary(result, size, model = DEFAULT_MODEL) {
  return {
    transport: "images-stream",
    model,
    size,
    partialImageEvents: result.partialImageEvents || 0,
    eventCounts: result.eventCounts || {},
    finalBase64Characters: typeof result.base64 === "string" ? result.base64.length : 0,
    previewSaved: !!result.previewPath,
  };
}

// Job record: one JSON file per paid run under JOBS_DIR. Each Images request
// is written as "submitting" before it is sent, so a run that an Agent client
// kills on a tool timeout still leaves evidence that the request may have been
// accepted and billed. --job-status reads these files; it never sends a request.
let activeJobRecord = null;

function newJobId() {
  return `${timestamp()}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
}

function writeJobRecord(record) {
  record.updatedAt = new Date().toISOString();
  try {
    writeTextFileAtomic(record.path, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    if (!record.writeWarned) console.warn(`WARNING: Unable to update the job record ${record.path}: ${error?.message || String(error)}`);
    record.writeWarned = true;
  }
}

function startJobRecord({ mode, model = null, outputDir = null }, preferredJobsDir = JOBS_DIR) {
  const id = newJobId();
  const jobsDir = writableDir(preferredJobsDir, preferredJobsDir === JOBS_DIR ? WORKSPACE_JOBS_DIR : null, "job record folder");
  const record = {
    id,
    path: join(jobsDir, `${id}.json`),
    version: PLUGIN_VERSION,
    pid: process.pid,
    mode,
    model,
    outputDir,
    startedAt: new Date().toISOString(),
    finished: false,
    exitCode: null,
    requests: [],
  };
  writeJobRecord(record);
  return record;
}

function jobRequestStart(fields) {
  const record = activeJobRecord;
  if (!record) return null;
  const entry = {
    index: record.requests.length + 1,
    state: "submitting",
    ...fields,
    prompt: truncateText(fields.prompt || "", 200),
    startedAt: new Date().toISOString(),
  };
  record.requests.push(entry);
  writeJobRecord(record);
  return entry;
}

// Billing state from the request stage: an HTTP error response or a refused
// connection costs nothing; a request that reached 88API and then failed is
// treated as possibly or actually billed.
function jobRequestEnd(entry, result) {
  if (!entry || !activeJobRecord) return;
  const error = result?.ok ? null : String(result?.error || "unknown error");
  if (result?.ok) {
    entry.state = "saved";
    entry.path = result.path || null;
    entry.dimensions = result.dimensions || null;
  } else if (/request was not sent/.test(error)) {
    entry.state = "not-sent";
  } else if (/state is unknown/.test(error) || entry.state === "submitting") {
    entry.state = "unknown";
  } else if (entry.httpStatus >= 400) {
    entry.state = "rejected";
  } else if (isNoAutoRetryError(error)) {
    entry.state = "billed-not-saved";
  } else {
    entry.state = "empty-result";
  }
  entry.error = error;
  entry.noAutoRetry = !!error && isNoAutoRetryError(error);
  entry.endedAt = new Date().toISOString();
  writeJobRecord(activeJobRecord);
}

function jobRequestResponded(entry, status) {
  if (!entry || !activeJobRecord) return;
  entry.state = "responded";
  entry.httpStatus = status;
  writeJobRecord(activeJobRecord);
}

function finishJobRecord(exitCode) {
  const record = activeJobRecord;
  if (!record || record.finished) return;
  record.finished = true;
  record.exitCode = exitCode;
  record.endedAt = new Date().toISOString();
  // A run that stopped before sending anything (for example a rejected ratio)
  // leaves nothing worth checking later.
  if (record.requests.length === 0) {
    try {
      if (existsSync(record.path)) unlinkSync(record.path);
    } catch {
      // Leaving an empty record behind is harmless.
    }
    return;
  }
  writeJobRecord(record);
}

function processIsAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const JOB_STATE_MEANING = {
  saved: "已出图并保存（已计费）",
  "not-sent": "未发出，没有费用",
  rejected: "88API 返回错误，未出图",
  unknown: "[NO-AUTO-RETRY] 已发出、状态未知，可能已计费",
  "billed-not-saved": "[NO-AUTO-RETRY] 已出图并计费，但结果没保存下来",
  "empty-result": "88API 返回成功但没有图片，是否计费以 88API 使用日志为准",
  interrupted: "[NO-AUTO-RETRY] 发出后进程被中断，状态未知，可能已计费",
  running: "仍在进行中，请等待，不要重发",
};

// Interprets a job record. A request still marked "submitting"/"responded" in
// a run that is no longer alive was cut off after it was sent: its cloud state
// is unknown and it must not be resubmitted automatically.
function summarizeJobRecord(record, { alive = processIsAlive(record?.pid) } = {}) {
  const running = !record.finished && alive;
  const requests = (record.requests || []).map((entry) => {
    let state = entry.state;
    if (state === "submitting" || state === "responded") state = running ? "running" : "interrupted";
    return { ...entry, state, meaning: JOB_STATE_MEANING[state] || state, mayBeBilled: ["saved", "unknown", "billed-not-saved", "empty-result", "interrupted", "running"].includes(state) };
  });
  const count = (state) => requests.filter((entry) => entry.state === state).length;
  return {
    type: "88api-image-job",
    id: record.id,
    path: record.path,
    status: running ? "running" : (record.finished ? "finished" : "interrupted"),
    mode: record.mode,
    model: record.model,
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
    exitCode: record.exitCode,
    requestsSent: requests.filter((entry) => entry.state !== "not-sent").length,
    saved: count("saved"),
    notSent: count("not-sent"),
    rejected: count("rejected"),
    emptyResult: count("empty-result"),
    unknown: count("unknown") + count("interrupted"),
    billedNotSaved: count("billed-not-saved"),
    running: count("running"),
    noAutoRetry: requests.some((entry) => ["unknown", "interrupted", "billed-not-saved"].includes(entry.state)),
    images: requests.filter((entry) => entry.state === "saved").map((entry) => ({ path: entry.path, dimensions: entry.dimensions || null })),
    requests,
  };
}

function readJobRecord(path) {
  return { ...JSON.parse(readFileSync(path, "utf8")), path };
}

// Records may live in the default folder or, in a sandboxed client, in the
// fallback folder under the working directory; --job-status checks both.
function jobRecordDirs(jobsDir = JOBS_DIR) {
  return jobsDir === JOBS_DIR ? [JOBS_DIR, WORKSPACE_JOBS_DIR] : [jobsDir];
}

function listJobRecordPaths(jobsDir = JOBS_DIR) {
  const paths = jobRecordDirs(jobsDir)
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({ name, path: join(dir, name) })));
  return paths.sort((a, b) => b.name.localeCompare(a.name)).map(({ path }) => path);
}

function resolveJobRecordPath(value, jobsDir = JOBS_DIR) {
  if (existsSync(value)) return value;
  for (const dir of jobRecordDirs(jobsDir)) {
    const byId = join(dir, `${value.replace(/\.json$/i, "")}.json`);
    if (existsSync(byId)) return byId;
  }
  throw new Error(`Job record not found: ${value}`);
}

async function generateImageViaImagesApiOnce(apiKey, prompt, size, outputDir, options = {}) {
  const job = jobRequestStart({ kind: "generation", model: options.model || DEFAULT_MODEL, size, prompt });
  try {
    const result = await generateImageViaImagesApiAttempt(apiKey, prompt, size, outputDir, { ...options, job });
    jobRequestEnd(job, result);
    return result;
  } catch (error) {
    jobRequestEnd(job, { ok: false, error: String(error?.message || error) });
    throw error;
  }
}

// Gemini image models: one Chat Completions request returns one image, embedded
// in the message content. Shared by generation and editing.
async function geminiImageAttempt(apiKey, prompt, size, sources, outputDir, options = {}) {
  const model = validateModel(options.model || DEFAULT_MODEL);
  const plan = planOf(size);
  const editing = sources.length > 0;
  const label = editing ? "Gemini edit" : "Gemini";
  const prefix = editing ? "edit" : "img";
  const start = Date.now();
  const heartbeat = setInterval(() => {
    console.log(`[wait] 88API is still working on the ${model} request (${Math.round((Date.now() - start) / 1000)}s)...`);
  }, 15_000);
  heartbeat.unref();
  let response;
  try {
    response = await postJsonOverHttps(CHAT_COMPLETIONS_URL, buildGeminiChatBody(model, prompt, plan, sources), apiKey, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      userAgent: `88api-image-gen/${PLUGIN_VERSION}`,
      onResponse: (status) => jobRequestResponded(options.job, status),
    });
  } catch (error) {
    return { ok: false, elapsed: Date.now() - start, error: geminiStageError(label, error), sourceName: summarizeSources(sources) };
  } finally {
    clearInterval(heartbeat);
  }
  const elapsed = Date.now() - start;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, elapsed, error: `HTTP ${response.status}: ${safeErrorText(response.raw) || "unknown error"}`, sourceName: summarizeSources(sources) };
  }
  try {
    const parsed = parseGeminiChatResponse(JSON.parse(response.raw || "{}"));
    if (!parsed.image) {
      const text = parsed.text ? ` Text reply: ${parsed.text.slice(0, 500)}` : "";
      return { ok: false, elapsed, error: `${NO_AUTO_RETRY_PREFIX} ${label} request completed (it may be billed) but returned no image.${text}`, sourceName: summarizeSources(sources) };
    }
    const linkContext = { outputDir: options.savePath ? dirname(options.savePath) : outputDir, prefix, savePath: options.savePath || null, model };
    const base64 = parsed.image.type === "url"
      ? await downloadImageResult(parsed.image.url, linkContext)
      : decodeBase64Image(parsed.image.data).toString("base64");
    const saved = options.savePath
      ? saveBase64ImageToPath(base64, options.savePath, null)
      : saveBase64Image(base64, outputDir, prefix, options.saveIndex ?? null, null);
    if (!saved) return { ok: false, elapsed, error: `${NO_AUTO_RETRY_PREFIX} ${label} returned image data that could not be saved`, sourceName: summarizeSources(sources) };
    return { ok: true, elapsed: Date.now() - start, model, resolution: plan.resolution, transport: "chat-completions", ...saved, sourceName: summarizeSources(sources) };
  } catch (error) {
    if (error instanceof ImageResultDownloadError) return { ok: false, elapsed, error: error.message, sourceName: summarizeSources(sources) };
    return { ok: false, elapsed, error: `${NO_AUTO_RETRY_PREFIX} ${label} request completed and was billed, but reading the result failed (stage: read-result): ${error?.message || error}`, sourceName: summarizeSources(sources) };
  }
}

async function generateImageViaImagesApiAttempt(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const preview = options.preview === true;
  const model = validateModel(options.model || DEFAULT_MODEL);
  const entry = modelEntry(model);
  if (entry.protocol === "gemini-chat") return geminiImageAttempt(apiKey, prompt, size, [], outputDir, options);
  const targetSize = resize ? resizeTarget(size) : null;
  const start = Date.now();
  const linkContext = { outputDir, prefix: "img", targetSize, model };
  let stage = "submit";
  try {
    const res = await requestWithTimeout(`${API_ROOT}${entry.generate.endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: preview ? "text/event-stream, application/json" : "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildImagesGenerationBody(model, prompt, size, { preview })),
    }, REQUEST_TIMEOUT_MS);
    stage = "read-result";
    jobRequestResponded(options.job, res.status);
    if (!res.ok) return { ok: false, elapsed: Date.now() - start, error: await parseErrorResponse(res) };

    const streamed = preview ? await consumeImageApiStream(res, { ...options, linkContext }) : null;
    const data = preview ? null : await res.json();
    const images = preview ? [streamed?.base64].filter(Boolean) : await imageApiResultAllBase64(data, linkContext);
    const saved = saveImageSet(images, (base64) => saveBase64Image(base64, outputDir, "img", null, targetSize), outputDir, "img", targetSize);
    const elapsed = Date.now() - start;
    if (!saved) {
      return {
        ok: false,
        elapsed,
        error: preview
          ? `${NO_AUTO_RETRY_PREFIX} Images API stream completed without a final image; server accepted the paid request`
          : "Images API response did not contain an image result",
      };
    }
    if (options.rawLogPath && streamed) {
      saveTextArtifact(options.rawLogPath, JSON.stringify(imageStreamLogSummary(streamed, size, model), null, 2));
    }
    return { ok: true, elapsed, model, resolution: planOf(size).resolution, transport: preview ? "images-stream" : "images", ...saved, previewPath: streamed?.previewPath || null };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: imageRequestStageError("Images", stage, error),
    };
  }
}

async function generateImage(apiKey, prompt, size, outputDir, options = {}) {
  resolveRunTransport(options.transport || DEFAULT_TRANSPORT);
  return generateImageViaImagesApiOnce(apiKey, prompt, size, outputDir, options);
}

function loadSourceImage(imagePath) {
  // Public URLs are passed through for models whose JSON edit accepts them.
  if (/^https?:\/\//i.test(String(imagePath))) {
    return { ok: true, url: String(imagePath), imagePath, sourceName: String(imagePath) };
  }
  if (!existsSync(imagePath)) {
    return { ok: false, elapsed: 0, error: `File does not exist: ${imagePath}`, sourceName: basename(imagePath) };
  }

  const sourceName = basename(imagePath);
  const sourceBuffer = readFileSync(imagePath);
  const mimeType = imageMimeTypeFromPath(imagePath);
  const ext = imageExtensionForMimeType(mimeType);
  return {
    ok: true,
    imagePath,
    sourceName,
    sourceBuffer,
    mimeType,
    ext,
  };
}

function summarizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "unknown source";
  if (sources.length === 1) return sources[0].sourceName;
  return `${sources.length} refs: ${sources.map((item) => item.sourceName).join(", ")}`;
}

function loadSourceImages(imagePaths) {
  const sources = [];
  for (const imagePath of imagePaths) {
    const source = loadSourceImage(imagePath);
    if (!source.ok) return source;
    sources.push(source);
  }
  return {
    ok: true,
    sources,
    sourceName: summarizeSources(sources),
  };
}

async function editImageViaImagesApiOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  const job = jobRequestStart({
    kind: "edit",
    model: options.model || DEFAULT_MODEL,
    size,
    prompt,
    references: (sources || []).map((source) => source.imagePath || source.sourceName),
  });
  try {
    const result = await editImageViaImagesApiAttempt(apiKey, sources, prompt, size, outputDir, { ...options, job });
    jobRequestEnd(job, result);
    return result;
  } catch (error) {
    jobRequestEnd(job, { ok: false, error: String(error?.message || error) });
    throw error;
  }
}

async function editImageViaImagesApiAttempt(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const model = validateModel(options.model || DEFAULT_MODEL);
  if (modelEntry(model).protocol === "gemini-chat") return geminiImageAttempt(apiKey, prompt, size, sources, outputDir, options);
  const targetSize = resize ? resizeTarget(size) : null;
  const variant = editVariantFor(model, sources);
  const start = Date.now();
  const sourceName = summarizeSources(sources);
  const rawLogPath = options.rawLogPath || null;
  const linkContext = options.savePath
    ? { outputDir: dirname(options.savePath), prefix: "edit", savePath: options.savePath, targetSize, model }
    : { outputDir, prefix: "edit", targetSize, model };
  let stage = "submit";
  try {
    const json = variant.upload === "json";
    const res = await requestWithTimeout(`${API_ROOT}${variant.endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json
        ? JSON.stringify(buildImagesEditJson(model, prompt, size, sources, variant))
        : buildImagesEditForm(model, prompt, size, sources, { variant }),
    }, REQUEST_TIMEOUT_MS);
    stage = "read-result";
    jobRequestResponded(options.job, res.status);
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      if (rawLogPath) saveTextArtifact(rawLogPath, raw);
      return { ok: false, elapsed: Date.now() - start, error: parseErrorBody(res.status, raw), sourceName };
    }

    const data = await res.json();
    if (rawLogPath) saveTextArtifact(rawLogPath, JSON.stringify(imageApiLogSummary(data, model), null, 2));
    const images = await imageApiResultAllBase64(data, linkContext);
    const saved = saveImageSet(images, (base64) => (options.savePath
      ? saveBase64ImageToPath(base64, options.savePath, targetSize)
      : saveBase64Image(base64, outputDir, "edit", options.saveIndex ?? null, targetSize)), outputDir, "edit", targetSize);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "Images API response did not contain an edited image", sourceName };
    return { ok: true, elapsed, model, resolution: planOf(size).resolution, ...saved, sourceName };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: imageRequestStageError("Images edit", stage, error),
      sourceName,
    };
  }
}

async function editImageOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  resolveRunTransport(options.transport || DEFAULT_TRANSPORT);
  return editImageViaImagesApiOnce(apiKey, sources, prompt, size, outputDir, options);
}

function createWorkerSession(worker) {
  return {
    ...worker,
    busy: false,
    fatal: false,
    disabledUntil: 0,
    lastError: null,
    used: false,
    stats: {
      assigned: 0,
      success: 0,
      failed: 0,
      retries: 0,
      cooldowns: 0,
      fatalErrors: 0,
    },
  };
}

function activeWorkerCount(sessions) {
  return sessions.filter((worker) => worker.enabled !== false && !worker.fatal).length;
}

function hasPotentialWorkerSessions(sessions) {
  return activeWorkerCount(sessions) > 0;
}

function schedulerCooldownMs(sessions, retryDelayMs, cooldownMs) {
  return activeWorkerCount(sessions) > 1 ? cooldownMs : retryDelayMs;
}

function findAvailableWorker(sessions) {
  const now = Date.now();
  const candidates = sessions.filter((worker) => worker.enabled !== false && !worker.fatal && !worker.busy && worker.disabledUntil <= now);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    if (left.stats.assigned !== right.stats.assigned) return left.stats.assigned - right.stats.assigned;
    if (left.disabledUntil !== right.disabledUntil) return left.disabledUntil - right.disabledUntil;
    return left.id.localeCompare(right.id);
  });
  return candidates[0];
}

function nextAvailableWorkerDelayMs(sessions) {
  const now = Date.now();
  const delays = sessions
    .filter((worker) => worker.enabled !== false && !worker.fatal && !worker.busy && worker.disabledUntil > now)
    .map((worker) => worker.disabledUntil - now);
  if (delays.length === 0) return null;
  return Math.max(1, Math.min(...delays));
}

function createTaskStates(tasks) {
  return tasks.map((task, index) => ({
    index,
    payload: task,
    pending: true,
    running: false,
    done: false,
    notBefore: 0,
    attempts: 0,
    retries: 0,
    finalResult: null,
  }));
}

function takeNextReadyTask(taskStates) {
  const now = Date.now();
  const task = taskStates.find((item) => item.pending && !item.running && !item.done && item.notBefore <= now);
  if (!task) return null;
  task.pending = false;
  task.running = true;
  return task;
}

function taskGroupKey(taskState) {
  const raw = taskState?.payload?.groupKey;
  if (raw == null) return "";
  const key = String(raw).trim();
  return key || "";
}

function hasRemainingGroupTasks(taskStates, groupKey) {
  if (!groupKey) return false;
  return taskStates.some((task) => {
    if (task.done) return false;
    return taskGroupKey(task) === groupKey;
  });
}

function availableWorkerSessions(sessions) {
  const now = Date.now();
  return sessions
    .filter((worker) => worker.enabled !== false && !worker.fatal && !worker.busy && worker.disabledUntil <= now)
    .sort((left, right) => {
      if (left.stats.assigned !== right.stats.assigned) return left.stats.assigned - right.stats.assigned;
      if (left.disabledUntil !== right.disabledUntil) return left.disabledUntil - right.disabledUntil;
      return left.id.localeCompare(right.id);
    });
}

function takeNextStickyTaskAssignment(taskStates, sessions, groupAssignments, runningGroups) {
  const now = Date.now();
  const ready = taskStates.filter((item) => item.pending && !item.running && !item.done && item.notBefore <= now);
  if (ready.length === 0) return null;
  const available = availableWorkerSessions(sessions);
  if (available.length === 0) return null;

  for (const task of ready) {
    const groupKey = taskGroupKey(task);
    if (!groupKey || runningGroups.has(groupKey)) continue;
    const assignedWorkerId = groupAssignments.get(groupKey);
    if (!assignedWorkerId) continue;
    const worker = available.find((candidate) => candidate.id === assignedWorkerId);
    if (!worker) continue;
    task.pending = false;
    task.running = true;
    runningGroups.add(groupKey);
    return { taskState: task, worker };
  }

  for (const task of ready) {
    const groupKey = taskGroupKey(task);
    if (!groupKey || runningGroups.has(groupKey) || groupAssignments.has(groupKey)) continue;
    const worker = available[0];
    task.pending = false;
    task.running = true;
    groupAssignments.set(groupKey, worker.id);
    runningGroups.add(groupKey);
    return { taskState: task, worker };
  }

  const plain = ready.find((task) => !taskGroupKey(task));
  if (!plain) return null;
  plain.pending = false;
  plain.running = true;
  return { taskState: plain, worker: available[0] };
}

function nextTaskDelayMs(taskStates) {
  const now = Date.now();
  const delays = taskStates
    .filter((task) => task.pending && !task.running && !task.done && task.notBefore > now)
    .map((task) => task.notBefore - now);
  if (delays.length === 0) return null;
  return Math.max(1, Math.min(...delays));
}

function completeTask(taskState, result) {
  taskState.pending = false;
  taskState.running = false;
  taskState.done = true;
  taskState.notBefore = 0;
  taskState.finalResult = {
    ...result,
    attempts: taskState.attempts,
    retries: taskState.retries,
  };
}

function requeueTask(taskState, delayMs = 0) {
  taskState.pending = true;
  taskState.running = false;
  taskState.notBefore = delayMs > 0 ? Date.now() + delayMs : 0;
}

function printWorkerStats(report) {
  console.log(`Scheduler: configured keys=${report.workerCount}, active keys=${report.enabledWorkerCount}, request slots used=${report.activeWorkerCount}, peak concurrency=${report.peakConcurrency}`);
  for (const worker of report.workerStats) {
    console.log(`- ${worker.name} [${worker.id}] assigned=${worker.assigned} success=${worker.success} failed=${worker.failed} retries=${worker.retries} cooldowns=${worker.cooldowns} fatalErrors=${worker.fatalErrors}${worker.lastError ? ` lastError="${worker.lastError}"` : ""}`);
  }
}

async function runWorkerTaskQueue(workers, tasks, options = {}) {
  const {
    concurrency = DEFAULTS.concurrency,
    adaptive = true,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    cooldownMs = DEFAULT_WORKER_COOLDOWN_MS,
    runTask,
    onTaskStart = () => {},
    onTaskComplete = () => {},
    outputDir = null,
    returnReport = false,
    stickyTaskGroups = false,
  } = options;

  const configuredWorkers = Array.isArray(workers) ? workers.filter((worker) => worker?.apiKey) : [];
  const enabledWorkers = configuredWorkers.filter((worker) => worker.enabled !== false);
  const total = tasks.length;
  if (enabledWorkers.length === 0) {
    const report = {
      total,
      success: 0,
      failed: total,
      retryCount: 0,
      workerCount: configuredWorkers.length,
      enabledWorkerCount: 0,
      activeWorkerCount: 0,
      initialConcurrency: 0,
      peakConcurrency: 0,
      elapsed: 0,
      outputDir,
      paths: [],
      exhaustedReason: "No enabled worker configured.",
      results: tasks.map((task) => ({
        ok: false,
        prompt: task?.prompt || null,
        sourceName: task?.sourceName || null,
        error: "No enabled worker configured.",
        skipped: true,
      })),
      workerStats: [],
      exitCode: 1,
    };
    return returnReport ? report : report.exitCode;
  }

  const taskStates = createTaskStates(tasks);
  const groupAssignments = new Map();
  const runningGroups = new Set();
  const started = Date.now();
  const requestedConcurrency = Math.max(1, Math.min(Number(concurrency) || DEFAULTS.concurrency, total || 1, MAX_CONCURRENCY));
  const sessionSources = enabledWorkers.length === 1 && requestedConcurrency > 1
    ? Array.from({ length: requestedConcurrency }, (_, index) => ({
      ...enabledWorkers[0],
      id: `${enabledWorkers[0].id}-slot-${index + 1}`,
      name: `${workerLabel(enabledWorkers[0])} slot ${index + 1}`,
      sourceWorkerId: enabledWorkers[0].id,
    }))
    : enabledWorkers;
  const sessions = sessionSources.map(createWorkerSession);
  const initialConcurrency = Math.max(1, Math.min(requestedConcurrency, sessions.length));
  let activeRuns = 0;
  let peakConcurrency = 0;
  let retryCount = 0;
  let exhaustedReason = null;

  function allTasksDone() {
    return taskStates.every((task) => task.done);
  }

  async function dispatcher() {
    while (true) {
      if (allTasksDone()) return;
      if (!hasPotentialWorkerSessions(sessions)) {
        exhaustedReason = exhaustedReason || "No enabled worker remained available for this run.";
        return;
      }

      let worker = null;
      let taskState = null;
      if (stickyTaskGroups) {
        const assignment = takeNextStickyTaskAssignment(taskStates, sessions, groupAssignments, runningGroups);
        if (assignment) {
          ({ taskState, worker } = assignment);
        }
      } else {
        worker = findAvailableWorker(sessions);
        if (worker) taskState = takeNextReadyTask(taskStates);
      }

      if (!worker || !taskState) {
        const taskDelay = nextTaskDelayMs(taskStates);
        const workerDelay = nextAvailableWorkerDelayMs(sessions);
        if (taskDelay == null && taskStates.some((task) => task.running)) {
          await sleep(SCHEDULER_IDLE_MS);
          continue;
        }
        const waitValues = [taskDelay, workerDelay, SCHEDULER_IDLE_MS].filter((value) => Number.isFinite(value) && value >= 0);
        await sleep(waitValues.length > 0 ? Math.max(1, Math.min(...waitValues)) : SCHEDULER_IDLE_MS);
        continue;
      }

      worker.busy = true;
      worker.used = true;
      worker.stats.assigned += 1;
      activeRuns += 1;
      peakConcurrency = Math.max(peakConcurrency, activeRuns);
      taskState.attempts += 1;
      onTaskStart(taskState.payload, { index: taskState.index, total, worker, attempt: taskState.attempts });

      let result;
      try {
        result = await runTask(worker, taskState.payload, { index: taskState.index, total, attempt: taskState.attempts });
      } catch (error) {
        result = {
          ok: false,
          elapsed: 0,
          error: error?.message || String(error),
        };
      }

      activeRuns -= 1;
      worker.busy = false;
      const groupKey = taskGroupKey(taskState);
      if (groupKey) runningGroups.delete(groupKey);

      const baseResult = {
        ...result,
        workerId: worker.id,
        workerName: worker.name,
        workerLabel: workerLabel(worker),
      };

      if (result.ok) {
        worker.stats.success += 1;
        worker.lastError = null;
        completeTask(taskState, baseResult);
        if (groupKey && !hasRemainingGroupTasks(taskStates, groupKey)) groupAssignments.delete(groupKey);
        onTaskComplete(taskState.payload, taskState.finalResult, { index: taskState.index, total, worker });
        console.log(`[${taskState.index + 1}/${total}] OK via ${workerLabel(worker)} ${(result.elapsed / 1000).toFixed(1)}s attempts=${taskState.attempts}`);
        continue;
      }

      worker.stats.failed += 1;
      worker.lastError = result.error || "Unknown error";
      const retryable = isRetryableError(result.error);
      const workerFatal = isWorkerFatalError(result.error);
      const taskFatal = isTaskFatalError(result.error);
      const fatal = isFatalError(result.error) || workerFatal || taskFatal;

      if (workerFatal) {
        for (const session of sessions) {
          if (session.apiKey === worker.apiKey) session.fatal = true;
        }
        worker.stats.fatalErrors += 1;
        console.log(`[key:${previewKey(worker.apiKey)}] Disabled for this run: ${result.error}`);
      } else if (retryable && adaptive) {
        const disabledUntil = Date.now() + schedulerCooldownMs(sessions, retryDelayMs, cooldownMs);
        for (const session of sessions) {
          if (session.apiKey === worker.apiKey) session.disabledUntil = disabledUntil;
        }
        worker.stats.cooldowns += 1;
      }

      const canRetry = !taskFatal && (retryable || workerFatal) && taskState.retries < maxRetries && hasPotentialWorkerSessions(sessions);
      if (canRetry) {
        taskState.retries += 1;
        retryCount += 1;
        worker.stats.retries += 1;
        if (groupKey && workerFatal) groupAssignments.delete(groupKey);
        const requeueDelay = !adaptive && retryable ? retryDelayMs : 0;
        requeueTask(taskState, requeueDelay);
        console.log(`[${taskState.index + 1}/${total}] RETRY ${taskState.retries}/${maxRetries} via ${workerLabel(worker)}: ${result.error}`);
        continue;
      }

      completeTask(taskState, {
        ...baseResult,
        retryable,
        fatal,
        workerFatal,
        taskFatal,
      });
      if (groupKey && !hasRemainingGroupTasks(taskStates, groupKey)) groupAssignments.delete(groupKey);
      onTaskComplete(taskState.payload, taskState.finalResult, { index: taskState.index, total, worker });
      console.log(`[${taskState.index + 1}/${total}] FAILED via ${workerLabel(worker)} attempts=${taskState.attempts} ${result.error}`);
    }
  }

  await Promise.all(Array.from({ length: initialConcurrency }, () => dispatcher()));

  for (const taskState of taskStates) {
    if (taskState.done) continue;
    completeTask(taskState, {
      ok: false,
      prompt: taskState.payload?.prompt || null,
      sourceName: taskState.payload?.sourceName || null,
      error: exhaustedReason || "Not started",
      skipped: true,
    });
  }

  const results = taskStates.map((task) => task.finalResult);
  const ok = results.filter((item) => item?.ok);
  const failed = results.filter((item) => item && !item.ok);
  const elapsed = Date.now() - started;

  const report = {
    total,
    success: ok.length,
    failed: failed.length,
    retryCount,
    workerCount: configuredWorkers.length,
    enabledWorkerCount: enabledWorkers.length,
    activeWorkerCount: sessions.filter((worker) => worker.used).length,
    initialConcurrency,
    peakConcurrency,
    elapsed,
    outputDir,
    paths: ok.map((item) => item.path).filter(Boolean),
    exhaustedReason,
    results,
    workerStats: sessions.map((worker) => ({
      id: worker.id,
      name: worker.name,
      assigned: worker.stats.assigned,
      success: worker.stats.success,
      failed: worker.stats.failed,
      retries: worker.stats.retries,
      cooldowns: worker.stats.cooldowns,
      fatalErrors: worker.stats.fatalErrors,
      lastError: worker.lastError,
    })),
    exitCode: failed.length > 0 ? 1 : 0,
  };
  return returnReport ? report : report.exitCode;
}

async function editImage(workers, imagePaths, prompt, size, outputDir, count = 1, silent = false, options = {}) {
  const resize = options.resize !== false;
  const paths = Array.isArray(imagePaths) ? imagePaths : [imagePaths];
  const sourceGroup = loadSourceImages(paths);
  if (!sourceGroup.ok) return sourceGroup;
  const { sources, sourceName } = sourceGroup;

  if (!silent) {
    const sizeOf = (source) => (source.url ? "URL" : `${(source.sourceBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    if (sources.length === 1) {
      console.log(`Loaded ${sources[0].sourceName} (${sizeOf(sources[0])})`);
    } else {
      const totalMb = sources.reduce((sum, item) => sum + (item.sourceBuffer?.length || 0), 0) / 1024 / 1024;
      console.log(`Loaded ${sources.length} source images (${totalMb.toFixed(2)}MB of local files)`);
      for (const source of sources) {
        console.log(`- ${source.sourceName} (${sizeOf(source)})`);
      }
    }
  }

  const tasks = Array.from({ length: count }, (_, index) => ({
    prompt,
    sourceName,
    sources,
    saveIndex: count > 1 ? index + 1 : null,
    startText: count > 1
      ? `Editing variation ${index + 1}/${count} from ${sourceName}`
      : `Editing ${sourceName}`,
  }));

  const requestedConcurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULTS.concurrency, count, MAX_CONCURRENCY));
  const report = await runWorkerTaskQueue(workers, tasks, {
    concurrency: requestedConcurrency,
    adaptive: options.adaptive !== false,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)}`);
    },
    runTask: async (worker, task) => editImageOnce(worker.apiKey, task.sources, prompt, size, outputDir, {
      model: options.model,
      resize,
      saveIndex: task.saveIndex,
      transport: options.transport,
      preview: options.preview === true && count === 1,
    }),
  });

  const results = report.results.filter((item) => item?.ok);
  const failures = report.results.filter((item) => item && !item.ok);
  if (failures.length > 0) {
    return {
      ok: false,
      elapsed: report.elapsed,
      sourceName,
      results,
      failures,
      retries: report.retryCount,
      report,
      error: failures[0]?.error || "Edit failed",
    };
  }
  if (count > 1) return { ok: true, elapsed: report.elapsed, results, sourceName, retries: report.retryCount, report };
  return { ok: true, elapsed: report.elapsed, ...results[0], sourceName, retries: report.retryCount, report };
}

async function runBatch(workers, prompts, size, concurrency, outputDir, options = {}) {
  if (typeof options === "boolean") options = { isVariation: options };
  const {
    isVariation = false,
    adaptive = true,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    resize = true,
    transport = "images",
    preview = false,
    returnReport = false,
    model = DEFAULT_MODEL,
  } = options;

  const tasks = prompts.map((prompt, index) => ({
    prompt,
    startText: isVariation
      ? `Generating variation ${index + 1}/${prompts.length}`
      : `Generating: "${truncateText(prompt)}"`,
  }));

  const report = await runWorkerTaskQueue(workers, tasks, {
    concurrency,
    adaptive,
    maxRetries,
    retryDelayMs,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)}`);
    },
    // The summary below prints each result's prompt, so carry it on the result.
    runTask: async (worker, task) => ({
      ...await generateImage(worker.apiKey, task.prompt, size, outputDir, {
        model,
        resize,
        transport,
        preview: preview && prompts.length === 1,
      }),
      prompt: task.prompt,
    }),
  });

  console.log("");
  if (isVariation) {
    console.log(`Prompt: "${prompts[0]}" x ${prompts.length}`);
    const successes = report.results.filter((item) => item?.ok);
    const failures = report.results.filter((item) => item && !item.ok);
    for (const [index, result] of successes.entries()) {
      console.log(`${index + 1}. ${basename(result.path)} ${formatImageResult(result)} via ${result.workerLabel}`);
    }
    for (const result of failures) console.log(`FAILED via ${result.workerLabel || "n/a"}: ${result.error}`);
  } else {
    for (const result of report.results) {
      console.log(`Prompt: "${result.prompt}"`);
      if (result.ok) {
        console.log(`Path: ${result.path}`);
        console.log(`Worker: ${result.workerLabel}`);
        console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s, ${formatImageResult(result)}`);
      } else {
        console.log(`Worker: ${result.workerLabel || "n/a"}`);
        console.log(`FAILED: ${result.error}`);
      }
      console.log("");
    }
  }
  console.log(`Total: ${report.total}`);
  console.log(`Success: ${report.success}`);
  console.log(`Failed: ${report.failed}`);
  console.log(`Retries: ${report.retryCount}`);
  console.log(`Done: ${report.success}/${report.total} in ${(report.elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  if (report.paths.length > 0) {
    console.log("Successful paths:");
    for (const path of report.paths) console.log(path);
  }
  printWorkerStats(report);
  if (report.exhaustedReason) console.log(`Worker pool stop: ${report.exhaustedReason}`);
  return returnReport ? report : report.exitCode;
}

async function runBatchEdit(workers, imagePaths, prompt, size, concurrency, outputDir, options = {}) {
  const resize = options.resize !== false;
  const tasks = [];
  for (const imagePath of imagePaths) {
    const sourceGroup = loadSourceImages([imagePath]);
    if (!sourceGroup.ok) {
      console.error(`FAILED ${basename(imagePath)}: ${sourceGroup.error}`);
      return 1;
    }
    tasks.push({
      prompt,
      sourceName: sourceGroup.sourceName,
      sources: sourceGroup.sources,
      startText: `Editing ${basename(imagePath)}`,
    });
  }

  const report = await runWorkerTaskQueue(workers, tasks, {
    concurrency,
    adaptive: options.adaptive !== false,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)}`);
    },
    runTask: async (worker, task) => editImageOnce(worker.apiKey, task.sources, prompt, size, outputDir, {
      model: options.model,
      resize,
      transport: options.transport,
    }),
  });

  console.log("");
  console.log(`Edit prompt: "${prompt}"`);
  for (const result of report.results.filter((item) => item?.ok)) {
    console.log(`${basename(result.path)} <- ${result.sourceName} ${formatImageResult(result)} via ${result.workerLabel}`);
  }
  for (const result of report.results.filter((item) => item && !item.ok)) {
    console.log(`FAILED ${result.sourceName}: ${result.error} via ${result.workerLabel || "n/a"}`);
  }
  console.log(`Done: ${report.success}/${report.total} in ${(report.elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  printWorkerStats(report);
  if (report.exhaustedReason) console.log(`Worker pool stop: ${report.exhaustedReason}`);
  return report.exitCode;
}

function buildNailProductDirName(productIndex, productName) {
  return `${String(productIndex).padStart(3, "0")}_${sanitizePathSegment(fileStem(productName))}`;
}

function selectNailStressProducts(productDir, limit) {
  const files = listNaturalSortedImageFiles(productDir);
  if (files.length < limit) {
    throw new Error(`Product directory only has ${files.length} image files, fewer than requested limit ${limit}.`);
  }
  return {
    availableCount: files.length,
    products: files.slice(0, limit).map((file, index) => ({
      ...file,
      productIndex: index + 1,
      dirName: buildNailProductDirName(index + 1, file.name),
    })),
  };
}

function buildNailStressTasks(personaPath, products, outputRoot) {
  const tasks = [];
  for (const product of products) {
    const productOutputDir = join(outputRoot, product.dirName);
    for (const scene of NAIL_STRESS_SCENES) {
      tasks.push({
        personaPath,
        productIndex: product.productIndex,
        productFileName: product.name,
        productPath: product.path,
        productDirName: product.dirName,
        groupKey: product.dirName,
        sceneIndex: scene.sceneIndex,
        sceneKey: scene.sceneKey,
        sceneLabel: scene.label,
        prompt: buildNailScenePrompt(scene),
        outputDir: productOutputDir,
        outputPath: join(productOutputDir, scene.filename),
        rawLogBasePath: join(productOutputDir, `${String(scene.sceneIndex).padStart(2, "0")}_${scene.sceneKey}`),
        startText: `${String(product.productIndex).padStart(3, "0")} ${product.name} -> ${scene.label}`,
      });
    }
  }
  return tasks;
}

function buildNailStressRecords(tasks, resultsOrReport) {
  const resultList = Array.isArray(resultsOrReport)
    ? resultsOrReport
    : (resultsOrReport?.results || []);
  return tasks.map((task, index) => {
    const result = resultList[index] || null;
    const status = !result
      ? "pending"
      : result.ok
        ? "success"
        : "failed";
    return {
      productIndex: task.productIndex,
      productFileName: task.productFileName,
      productPath: task.productPath,
      productDirName: task.productDirName,
      sceneIndex: task.sceneIndex,
      sceneKey: task.sceneKey,
      sceneLabel: task.sceneLabel,
      prompt: task.prompt,
      status,
      workerId: result?.workerId || null,
      workerName: result?.workerName || null,
      workerLabel: result?.workerLabel || null,
      attempts: result?.attempts ?? 0,
      retries: result?.retries ?? 0,
      elapsedMs: result?.elapsed ?? 0,
      outputPath: result?.path || task.outputPath,
      fileSize: result?.fileSize || null,
      width: result?.width || null,
      height: result?.height || null,
      dimensions: result?.dimensions || null,
      resized: !!result?.resized,
      originalDimensions: result?.originalDimensions || null,
      error: status === "failed" ? (result?.error || "Unknown error") : null,
      skipped: !!result?.skipped,
    };
  });
}

function buildNailStressSummary(records, report = null) {
  const success = records.filter((item) => item.status === "success").length;
  const failed = records.filter((item) => item.status === "failed").length;
  const pending = records.filter((item) => item.status === "pending").length;
  return {
    total: records.length,
    success,
    failed,
    pending,
    retries: report?.retryCount ?? records.reduce((sum, item) => sum + (item.retries || 0), 0),
    workerCount: report?.workerCount ?? null,
    enabledWorkerCount: report?.enabledWorkerCount ?? null,
    activeWorkerCount: report?.activeWorkerCount ?? null,
    initialConcurrency: report?.initialConcurrency ?? null,
    peakConcurrency: report?.peakConcurrency ?? null,
    elapsedMs: report?.elapsed ?? null,
    exhaustedReason: report?.exhaustedReason || null,
  };
}

function writeNailStressArtifacts(outputRoot, records, report, metadata, options = {}) {
  const manifestPath = join(outputRoot, "manifest.json");
  const summaryCsvPath = join(outputRoot, "summary.csv");
  const failuresPath = join(outputRoot, "failures.json");
  const failures = records.filter((item) => item.status !== "success");
  const partial = options.partial === true;
  const summary = buildNailStressSummary(records, report);

  writeTextFileAtomic(manifestPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    outputRoot,
    metadata,
    partial,
    summary,
    workerStats: report?.workerStats || [],
    items: records,
  }, null, 2), "utf8");

  writeCsvFile(summaryCsvPath, [
    ["productIndex", "productFileName", "sceneIndex", "sceneKey", "sceneLabel", "status", "worker", "attempts", "retries", "elapsedMs", "dimensions", "outputPath", "error"],
    ...records.map((item) => [
      item.productIndex,
      item.productFileName,
      item.sceneIndex,
      item.sceneKey,
      item.sceneLabel,
      item.status,
      item.workerLabel || "",
      item.attempts,
      item.retries,
      item.elapsedMs,
      item.dimensions || "",
      item.outputPath,
      item.error || "",
    ]),
  ]);

  writeTextFileAtomic(failuresPath, JSON.stringify(failures, null, 2), "utf8");
  return { manifestPath, summaryCsvPath, failuresPath };
}

function printNailStressDryRun(personaPath, productDir, limit, size, outputRoot, selection, tasks, concurrency, model) {
  console.log("Nail stress test dry run");
  console.log(`Endpoint: ${IMAGES_EDITS_URL}`);
  console.log(`Model: ${model} (${size})`);
  console.log("Authorization: Bearer <redacted>");
  console.log("Reference image content: <binary omitted>");
  console.log(`Persona: ${personaPath}`);
  console.log(`Product dir: ${productDir}`);
  console.log(`Available product images: ${selection.availableCount}`);
  console.log(`Selected products: ${selection.products.length}`);
  console.log(`Aspect: 9:16 (${size})`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Output root: ${outputRoot}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Sanitized request: ${JSON.stringify({ model, size, n: 1, prompt: "<task prompt>", "image[]": ["<persona binary omitted>", "<product binary omitted>"] })}`);
  console.log("First products:");
  for (const product of selection.products.slice(0, Math.min(5, limit))) {
    console.log(`- ${String(product.productIndex).padStart(3, "0")} ${product.name}`);
  }
  if (selection.products.length > 5) {
    const tail = selection.products.slice(-Math.min(5, selection.products.length));
    console.log("Last products:");
    for (const product of tail) {
      console.log(`- ${String(product.productIndex).padStart(3, "0")} ${product.name}`);
    }
  }
}

function buildWorkflowItemDirName(itemIndex, itemName) {
  return `${String(itemIndex).padStart(3, "0")}_${sanitizePathSegment(fileStem(itemName))}`;
}

function sanitizeTemplateKey(value, fallback) {
  const key = sanitizePathSegment(String(value || "").toLowerCase().replace(/\s+/g, "_"));
  return key === "item" ? fallback : key;
}

function workflowTemplateFilename(template) {
  if (template.filename) {
    const filename = sanitizePathSegment(template.filename.replace(/\.png$/i, ""));
    return `${filename}.png`;
  }
  return `${String(template.templateIndex).padStart(2, "0")}_${sanitizeTemplateKey(template.templateKey, `template_${template.templateIndex}`)}.png`;
}

function normalizeWorkflowTemplateEntry(entry, index) {
  const templateIndex = index + 1;
  const fallbackKey = `template_${templateIndex}`;
  if (typeof entry === "string") {
    return {
      templateIndex,
      templateKey: fallbackKey,
      label: fallbackKey,
      prompt: entry,
      filename: null,
    };
  }
  if (!entry || typeof entry !== "object") {
    throw new Error(`Workflow template #${templateIndex} must be a string or object.`);
  }
  const prompt = String(entry.prompt ?? entry.instruction ?? entry.text ?? "").trim();
  if (!prompt) throw new Error(`Workflow template #${templateIndex} is missing prompt/instruction/text.`);
  const rawKey = entry.key ?? entry.name ?? entry.label ?? fallbackKey;
  const templateKey = sanitizeTemplateKey(rawKey, fallbackKey);
  return {
    templateIndex,
    templateKey,
    label: String(entry.label ?? entry.name ?? templateKey).trim() || templateKey,
    prompt,
    filename: entry.filename ? String(entry.filename).trim() : null,
  };
}

function workflowPresetTemplates(preset) {
  const normalized = String(preset || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized !== WORKFLOW_NAIL_PRESET) {
    throw new Error(`Unknown workflow preset "${preset}". Supported preset: ${WORKFLOW_NAIL_PRESET}.`);
  }
  return NAIL_STRESS_SCENES.map((scene, index) => normalizeWorkflowTemplateEntry({
    key: scene.sceneKey,
    label: scene.label,
    filename: scene.filename,
    prompt: buildNailScenePrompt(scene),
  }, index));
}

function parseWorkflowTemplates(flags) {
  const inlineTemplates = Array.isArray(flags.templateInline) ? flags.templateInline : [];
  let rawTemplates = [];
  if (flags.templatesFile) {
    const parsed = JSON.parse(readFileSync(flags.templatesFile, "utf8").replace(/^\uFEFF/, ""));
    rawTemplates = Array.isArray(parsed) ? parsed : parsed?.templates;
    if (!Array.isArray(rawTemplates)) {
      throw new Error("--templates must be a JSON array or an object with a templates array.");
    }
  }
  if (inlineTemplates.length > 0) rawTemplates.push(...inlineTemplates);
  if (rawTemplates.length === 0 && flags.preset) return workflowPresetTemplates(flags.preset);
  if (rawTemplates.length === 0) {
    throw new Error(`--workflow-batch-edit requires --templates <json>, one or more --template-inline, or --preset ${WORKFLOW_NAIL_PRESET}.`);
  }
  return rawTemplates.map(normalizeWorkflowTemplateEntry);
}

function selectWorkflowItems(itemDir, limit, limitExplicit) {
  const files = listNaturalSortedImageFiles(itemDir);
  if (files.length === 0) throw new Error(`Item directory has no image files: ${itemDir}`);
  if (limitExplicit && files.length < limit) {
    throw new Error(`Item directory only has ${files.length} image files, fewer than requested limit ${limit}.`);
  }
  const selectedCount = Math.min(files.length, limit);
  return {
    availableCount: files.length,
    items: files.slice(0, selectedCount).map((file, index) => ({
      itemIndex: index + 1,
      name: file.name,
      path: file.path,
      dirName: buildWorkflowItemDirName(index + 1, file.name),
    })),
  };
}

function buildWorkflowPrompt(template, options = {}) {
  const fixedCount = options.fixedRefCount || 0;
  const variableRefIndex = fixedCount + 1;
  return [
    `Reference order: ${fixedCount > 0 ? `references 1-${fixedCount} are fixed context images; ` : ""}reference ${variableRefIndex} is the current variable item image.`,
    "Follow the user's template exactly. Do not assume a product category unless the template says it. Combine or apply the references according to the template.",
    template.prompt,
  ].join("\n\n");
}

function buildWorkflowTasks(items, templates, outputRoot, options = {}) {
  const tasks = [];
  for (const item of items) {
    const itemOutputDir = join(outputRoot, item.dirName);
    for (const template of templates) {
      const filename = workflowTemplateFilename(template);
      const task = {
        itemIndex: item.itemIndex,
        itemFileName: item.name,
        itemPath: item.path,
        itemDirName: item.dirName,
        groupKey: item.dirName,
        templateIndex: template.templateIndex,
        templateKey: template.templateKey,
        templateLabel: template.label,
        prompt: buildWorkflowPrompt(template, options),
        rawTemplatePrompt: template.prompt,
        outputDir: itemOutputDir,
        outputPath: join(itemOutputDir, filename),
        rawLogBasePath: join(itemOutputDir, `${String(template.templateIndex).padStart(2, "0")}_${template.templateKey}`),
        startText: `${String(item.itemIndex).padStart(3, "0")} ${item.name} -> ${template.label}`,
      };
      tasks.push(task);
    }
  }
  return tasks;
}

function classifyWorkflowError(error) {
  const text = String(error || "").toLowerCase();
  if (!text) return "";
  if (text.includes("http 524") || text.includes("timeout occurred") || text.includes("cloudflare timeout")) return "timeout_524";
  if (text.includes("images api response did not contain")) return "no_image_result";
  if (text.includes("stage: download")) return "download_failed";
  if (text.includes("stage: read-result")) return "read_result_failed";
  if (text.includes("request was not sent")) return "not_sent";
  if (text.includes("fetch failed") || text.includes("terminated") || text.includes("socket hang up") || text.includes("econnreset")) return "network";
  if (text.includes("content policy") || text.includes("safety policy") || text.includes("moderation")) return "content_policy";
  if (text.includes("http 401") || text.includes("http 403") || text.includes("invalid api key") || text.includes("unauthorized") || text.includes("forbidden")) return "auth";
  if (isRetryableError(text)) return "retryable";
  if (isFatalError(text)) return "fatal";
  return "other";
}

function buildWorkflowRecords(tasks, resultsOrReport) {
  const results = Array.isArray(resultsOrReport) ? resultsOrReport : resultsOrReport?.results || [];
  return tasks.map((task, index) => {
    const result = results[index] || {};
    const status = result.ok ? "success" : result.error ? "failed" : "pending";
    return {
      itemIndex: task.itemIndex,
      itemFileName: task.itemFileName,
      itemPath: task.itemPath,
      itemDirName: task.itemDirName,
      templateIndex: task.templateIndex,
      templateKey: task.templateKey,
      templateLabel: task.templateLabel,
      prompt: task.prompt,
      status,
      workerId: result.workerId || null,
      workerName: result.workerName || null,
      workerLabel: result.workerLabel || null,
      attempts: result.attempts || 0,
      retries: result.retries || 0,
      elapsedMs: result.elapsed || 0,
      outputPath: task.outputPath,
      fileSize: result.fileSize || null,
      width: result.width || null,
      height: result.height || null,
      dimensions: result.dimensions || null,
      resized: !!result.resized,
      originalDimensions: result.originalDimensions || null,
      error: result.error || null,
      errorClass: classifyWorkflowError(result.error),
      reusedExisting: !!result.reusedExisting,
    };
  });
}

function buildWorkflowSummary(records, report = null) {
  const success = records.filter((item) => item.status === "success").length;
  const failed = records.filter((item) => item.status === "failed").length;
  const pending = records.length - success - failed;
  const retries = records.reduce((sum, item) => sum + (Number(item.retries) || 0), 0);
  return {
    total: records.length,
    success,
    failed,
    pending,
    retries: report?.retryCount ?? retries,
    workerCount: report?.workerCount ?? null,
    enabledWorkerCount: report?.enabledWorkerCount ?? null,
    activeWorkerCount: report?.activeWorkerCount ?? null,
    initialConcurrency: report?.initialConcurrency ?? null,
    peakConcurrency: report?.peakConcurrency ?? null,
    elapsedMs: report?.elapsed ?? null,
    exhaustedReason: report?.exhaustedReason ?? null,
  };
}

function writeWorkflowArtifacts(outputRoot, records, report, metadata, sessions = [], options = {}) {
  const partial = options.partial === true;
  const summary = buildWorkflowSummary(records, report);
  const manifestPath = join(outputRoot, "manifest.json");
  const summaryCsvPath = join(outputRoot, "summary.csv");
  const failuresPath = join(outputRoot, "failures.json");
  const sessionsPath = join(outputRoot, "sessions.json");
  writeTextFileAtomic(manifestPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    outputRoot,
    metadata,
    partial,
    summary,
    workerStats: report?.workerStats || [],
    sessions,
    items: records,
  }, null, 2)}\n`, "utf8");
  writeCsvFile(summaryCsvPath, [
    ["itemIndex", "itemFileName", "templateIndex", "templateKey", "templateLabel", "status", "errorClass", "worker", "attempts", "retries", "elapsedMs", "dimensions", "outputPath", "error"],
    ...records.map((item) => [
      item.itemIndex,
      item.itemFileName,
      item.templateIndex,
      item.templateKey,
      item.templateLabel,
      item.status,
      item.errorClass,
      item.workerLabel || item.workerName || item.workerId || "",
      item.attempts,
      item.retries,
      item.elapsedMs,
      item.dimensions,
      item.outputPath,
      item.error,
    ]),
  ]);
  writeTextFileAtomic(failuresPath, `${JSON.stringify(records.filter((item) => item.status !== "success"), null, 2)}\n`, "utf8");
  writeTextFileAtomic(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  return { manifestPath, summaryCsvPath, failuresPath, sessionsPath };
}

function buildWorkflowSession(label, report, queuedCount, startedAt, endedAt) {
  return {
    label,
    startedAt,
    endedAt,
    queuedCount,
    total: report.total,
    success: report.success,
    failed: report.failed,
    retries: report.retryCount,
    workerCount: report.workerCount,
    enabledWorkerCount: report.enabledWorkerCount,
    activeWorkerCount: report.activeWorkerCount,
    initialConcurrency: report.initialConcurrency,
    peakConcurrency: report.peakConcurrency,
    elapsedMs: report.elapsed,
    exhaustedReason: report.exhaustedReason,
    workerStats: report.workerStats,
  };
}

function mergeWorkerStats(reports) {
  const merged = new Map();
  for (const report of reports) {
    for (const worker of report.workerStats || []) {
      const current = merged.get(worker.id) || {
        id: worker.id,
        name: worker.name,
        assigned: 0,
        success: 0,
        failed: 0,
        retries: 0,
        cooldowns: 0,
        fatalErrors: 0,
        lastError: null,
      };
      current.assigned += worker.assigned || 0;
      current.success += worker.success || 0;
      current.failed += worker.failed || 0;
      current.retries += worker.retries || 0;
      current.cooldowns += worker.cooldowns || 0;
      current.fatalErrors += worker.fatalErrors || 0;
      current.lastError = worker.lastError || current.lastError;
      merged.set(worker.id, current);
    }
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function noOpQueueReport(workers, outputRoot) {
  const configuredWorkers = Array.isArray(workers) ? workers.filter((worker) => worker?.apiKey) : [];
  const enabledWorkers = configuredWorkers.filter((worker) => worker.enabled !== false);
  return {
    total: 0,
    success: 0,
    failed: 0,
    retryCount: 0,
    workerCount: configuredWorkers.length,
    enabledWorkerCount: enabledWorkers.length,
    activeWorkerCount: 0,
    initialConcurrency: 0,
    peakConcurrency: 0,
    elapsed: 0,
    outputDir: outputRoot,
    paths: [],
    exhaustedReason: null,
    results: [],
    workerStats: [],
    exitCode: 0,
  };
}

async function runWorkflowQueuePass(workers, queuedTasks, passOptions) {
  const {
    label,
    outputRoot,
    concurrency,
    adaptive,
    resize,
    fixedSources,
    size,
    liveResults,
    allTasks,
    metadata,
    sessions,
    repair = false,
    transport = "images",
    model = DEFAULT_MODEL,
  } = passOptions;
  if (queuedTasks.length === 0) return noOpQueueReport(workers, outputRoot);
  const startedAt = new Date().toISOString();
  const report = await runWorkerTaskQueue(workers, queuedTasks, {
    concurrency,
    adaptive,
    maxRetries: MAX_RETRIES,
    retryDelayMs: RETRY_BACKOFF_MS,
    outputDir: outputRoot,
    returnReport: true,
    stickyTaskGroups: true,
    onTaskStart: (task, context) => {
      console.log(`[${label} ${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)}`);
    },
    onTaskComplete: (task, result) => {
      liveResults[task.fullIndex] = result;
      const liveRecords = buildWorkflowRecords(allTasks, liveResults);
      writeWorkflowArtifacts(outputRoot, liveRecords, null, metadata, sessions, { partial: true });
    },
    runTask: async (worker, task, context) => {
      const item = loadSourceImage(task.itemPath);
      if (!item.ok) {
        return {
          ok: false,
          elapsed: 0,
          error: item.error,
          sourceName: basename(task.itemPath),
        };
      }
      return editImageOnce(worker.apiKey, [...fixedSources, item], task.prompt, size, task.outputDir, {
        model,
        resize,
        savePath: task.outputPath,
        rawLogPath: `${task.rawLogBasePath}.${repair ? "repair" : "main"}.attempt${context.attempt}.json`,
        transport,
      });
    },
  });
  const endedAt = new Date().toISOString();
  sessions.push(buildWorkflowSession(label, report, queuedTasks.length, startedAt, endedAt));
  return report;
}

function workflowMissingQueue(tasks, liveResults) {
  const queued = [];
  for (const [index, task] of tasks.entries()) {
    const existing = inspectExistingImage(task.outputPath);
    if (existing) {
      liveResults[index] = {
        ...existing,
        workerId: liveResults[index]?.workerId || "existing",
        workerName: liveResults[index]?.workerName || "existing",
        workerLabel: liveResults[index]?.workerLabel || "existing",
      };
      continue;
    }
    queued.push({ ...task, fullIndex: index });
  }
  return queued;
}

function printWorkflowDryRun(fixedRefPaths, itemDir, limit, size, outputRoot, selection, templates, tasks, concurrency, model) {
  console.log("Workflow batch edit dry run");
  console.log(`Endpoint: ${IMAGES_EDITS_URL}`);
  console.log(`Model: ${model} (${size})`);
  console.log("Authorization: Bearer <redacted>");
  console.log("Reference image content: <binary omitted>");
  console.log(`Fixed refs: ${fixedRefPaths.length}`);
  for (const refPath of fixedRefPaths) console.log(`- ${refPath}`);
  console.log(`Item dir: ${itemDir}`);
  console.log(`Available item images: ${selection.availableCount}`);
  console.log(`Selected items: ${selection.items.length}`);
  console.log(`Templates: ${templates.length}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Sanitized request: ${JSON.stringify({ model, size, n: 1, prompt: "<template prompt>", "image[]": [...fixedRefPaths.map(() => "<fixed reference binary omitted>"), "<item binary omitted>"] })}`);
  console.log(`Aspect/size: ${size}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Output root: ${outputRoot}`);
  console.log("First items:");
  for (const item of selection.items.slice(0, Math.min(5, limit))) {
    console.log(`- ${String(item.itemIndex).padStart(3, "0")} ${item.name}`);
  }
  console.log("Templates:");
  for (const template of templates) {
    console.log(`- ${String(template.templateIndex).padStart(2, "0")} ${template.templateKey}: ${template.label}`);
  }
}

async function runWorkflowBatchEdit(workers, options) {
  const {
    fixedRefPaths = [],
    itemDir,
    limit = WORKFLOW_DEFAULT_LIMIT,
    limitExplicit = false,
    templates,
    preset = null,
    size,
    aspect,
    concurrency = MAX_CONCURRENCY,
    adaptive = true,
    resize = true,
    outputDir,
    dryRun = false,
    repairPasses = WORKFLOW_DEFAULT_REPAIR_PASSES,
    transport = "images",
    model = DEFAULT_MODEL,
  } = options;

  const fixedGroup = loadSourceImages(fixedRefPaths);
  if (!fixedGroup.ok) throw new Error(fixedGroup.error);
  const fixedSources = fixedGroup.sources || [];
  const outputRoot = buildWorkflowOutputRoot(outputDir);
  const selection = selectWorkflowItems(itemDir, limit, limitExplicit);
  for (const item of selection.items) mkdirSync(join(outputRoot, item.dirName), { recursive: true });
  const workflowTemplates = templates;
  const tasks = buildWorkflowTasks(selection.items, workflowTemplates, outputRoot, { fixedRefCount: fixedSources.length });
  const metadata = {
    workflow: "batch-edit",
    preset,
    fixedRefPaths,
    itemDir,
    limit,
    selectedItemCount: selection.items.length,
    availableItemCount: selection.availableCount,
    size,
    aspect,
    templateCount: workflowTemplates.length,
    repairPasses,
    transport,
    model,
    resolution: planOf(size).resolution,
  };

  if (dryRun) {
    printWorkflowDryRun(fixedRefPaths, itemDir, limit, size, outputRoot, selection, workflowTemplates, tasks, concurrency, model);
    return { ok: true, dryRun: true, outputRoot, selection, templates: workflowTemplates, tasks };
  }

  console.log("Workflow batch edit started");
  console.log(`Fixed refs: ${fixedSources.length}`);
  for (const source of fixedSources) console.log(`- ${source.sourceName} (${(source.sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`Item dir: ${itemDir}`);
  console.log(`Items: ${selection.items.length}/${selection.availableCount}`);
  console.log(`Templates per item: ${workflowTemplates.length}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Aspect/size: ${aspect} (${size})`);
  console.log(`Output root: ${outputRoot}`);

  const liveResults = Array.from({ length: tasks.length }, () => null);
  const sessions = [];
  const mainQueue = workflowMissingQueue(tasks, liveResults);
  console.log(`Existing images reused: ${liveResults.filter(Boolean).length}`);
  console.log(`Queued tasks: ${mainQueue.length}`);
  writeWorkflowArtifacts(outputRoot, buildWorkflowRecords(tasks, liveResults), null, metadata, sessions, { partial: true });

  const reports = [];
  const mainReport = await runWorkflowQueuePass(workers, mainQueue, {
    label: "main",
    outputRoot,
    concurrency,
    adaptive,
    resize,
    fixedSources,
    size,
    liveResults,
    allTasks: tasks,
    metadata,
    sessions,
    transport,
    model,
  });
  reports.push(mainReport);

  for (let pass = 1; pass <= repairPasses; pass += 1) {
    const repairQueue = workflowMissingQueue(tasks, liveResults);
    if (repairQueue.length === 0) break;
    console.log(`Repair pass ${pass}: ${repairQueue.length} missing task(s).`);
    const repairReport = await runWorkflowQueuePass(workers, repairQueue, {
      label: `repair-${pass}`,
      outputRoot,
      concurrency: WORKFLOW_REPAIR_CONCURRENCY,
      adaptive,
      resize,
      fixedSources,
      size,
      liveResults,
      allTasks: tasks,
      metadata,
      sessions,
      repair: true,
      transport,
      model,
    });
    reports.push(repairReport);
  }

  workflowMissingQueue(tasks, liveResults);
  const records = buildWorkflowRecords(tasks, liveResults);
  const finalSummary = buildWorkflowSummary(records, null);
  const combinedReport = {
    ...reports[reports.length - 1],
    total: records.length,
    success: finalSummary.success,
    failed: records.length - finalSummary.success,
    retryCount: reports.reduce((sum, report) => sum + (report.retryCount || 0), 0),
    workerCount: workers.length,
    enabledWorkerCount: workers.filter((worker) => worker.enabled !== false).length,
    activeWorkerCount: new Set(reports.flatMap((report) => (report.workerStats || []).filter((worker) => worker.assigned > 0).map((worker) => worker.id))).size,
    initialConcurrency: reports[0]?.initialConcurrency || 0,
    peakConcurrency: Math.max(0, ...reports.map((report) => report.peakConcurrency || 0)),
    elapsed: reports.reduce((sum, report) => sum + (report.elapsed || 0), 0),
    workerStats: mergeWorkerStats(reports),
    exitCode: finalSummary.success === records.length ? 0 : 1,
    exhaustedReason: reports.map((report) => report.exhaustedReason).filter(Boolean).join("; ") || null,
  };
  const artifacts = writeWorkflowArtifacts(outputRoot, records, combinedReport, metadata, sessions, { partial: false });
  const missing = records.filter((record) => record.status !== "success");

  console.log("");
  console.log(`Done: ${finalSummary.success}/${finalSummary.total} in ${(combinedReport.elapsed / 1000).toFixed(1)}s`);
  console.log(`Retries: ${combinedReport.retryCount}`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Manifest: ${artifacts.manifestPath}`);
  console.log(`Summary CSV: ${artifacts.summaryCsvPath}`);
  console.log(`Failures JSON: ${artifacts.failuresPath}`);
  console.log(`Sessions JSON: ${artifacts.sessionsPath}`);
  const samplePaths = records.filter((item) => item.status === "success").map((item) => item.outputPath).slice(0, 8);
  if (samplePaths.length > 0) {
    console.log("Sample successful paths:");
    for (const path of samplePaths) console.log(path);
  }
  if (missing.length > 0) {
    console.log("Missing or failed items:");
    for (const item of missing.slice(0, 20)) {
      console.log(`- ${String(item.itemIndex).padStart(3, "0")} ${item.itemFileName} ${item.templateLabel}: ${item.error || "missing output"}`);
    }
  }
  printWorkerStats(combinedReport);

  return {
    ok: missing.length === 0,
    dryRun: false,
    outputRoot,
    selection,
    templates: workflowTemplates,
    tasks,
    records,
    report: combinedReport,
    artifacts,
  };
}

async function runWorkflowSelfTest() {
  const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
  const outputRoot = join(tmpdir(), `88api-workflow-self-test_${timestamp()}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`);
  const item = {
    itemIndex: 1,
    name: "item.png",
    path: join(outputRoot, "item.png"),
    dirName: "001_item",
  };
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(item.path, onePixelPng);
  const templates = [
    normalizeWorkflowTemplateEntry({ key: "scene_a", prompt: "Place the variable item into a clean scene." }, 0),
    normalizeWorkflowTemplateEntry({ key: "scene_b", prompt: "Create a second independent scene." }, 1),
  ];
  const tasks = buildWorkflowTasks([item], templates, outputRoot, { fixedRefCount: 0 });
  const liveResults = Array.from({ length: tasks.length }, () => null);
  const firstQueue = workflowMissingQueue(tasks, liveResults);
  savePngBuffer(tasks[0].outputPath, onePixelPng, null);
  const repairQueue = workflowMissingQueue(tasks, liveResults);
  liveResults[tasks[1].templateIndex - 1] = {
    ok: false,
    error: "HTTP 524: Error 524: A timeout occurred",
    attempts: 1,
    retries: 1,
    elapsed: 1000,
  };
  const records = buildWorkflowRecords(tasks, liveResults);
  const artifacts = writeWorkflowArtifacts(outputRoot, records, noOpQueueReport([], outputRoot), {
    workflow: "self-test",
    model: "gpt-image-2",
    resolution: "4K",
    size: "3840x2160",
    aspect: "16:9",
  }, [{
    label: "mock-main",
    queuedCount: firstQueue.length,
    retries: 1,
  }], { partial: false });

  const manifest = JSON.parse(readFileSync(artifacts.manifestPath, "utf8"));
  const ok = firstQueue.length === 2
    && repairQueue.length === 1
    && records[0].status === "success"
    && records[1].errorClass === "timeout_524"
    && manifest.metadata?.model === "gpt-image-2"
    && manifest.metadata?.resolution === "4K"
    && manifest.metadata?.size === "3840x2160"
    && existsSync(artifacts.manifestPath)
    && existsSync(artifacts.sessionsPath);
  if (!ok) {
    console.error("Workflow self-test FAILED.");
    console.error(JSON.stringify({ firstQueue: firstQueue.length, repairQueue: repairQueue.length, records, artifacts }, null, 2));
    return 1;
  }
  console.log("Workflow self-test OK.");
  console.log(`Output: ${outputRoot}`);
  return 0;
}

async function runNailStressTest(workers, options) {
  const {
    personaPath,
    productDir,
    limit = NAIL_STRESS_DEFAULT_LIMIT,
    size,
    concurrency = MAX_CONCURRENCY,
    adaptive = true,
    resize = true,
    outputDir,
    dryRun = false,
    resumeExisting = true,
    transport = "images",
    model = DEFAULT_MODEL,
  } = options;

  const persona = loadSourceImage(personaPath);
  if (!persona.ok) throw new Error(persona.error);

  const outputRoot = buildNailStressOutputRoot(outputDir);
  const selection = selectNailStressProducts(productDir, limit);
  for (const product of selection.products) {
    mkdirSync(join(outputRoot, product.dirName), { recursive: true });
  }
  const tasks = buildNailStressTasks(personaPath, selection.products, outputRoot);
  const metadata = {
    personaPath,
    productDir,
    limit,
    size,
    aspect: "9:16",
    sceneCount: NAIL_STRESS_SCENES.length,
    transport,
    model,
    resolution: planOf(size).resolution,
  };

  if (dryRun) {
    printNailStressDryRun(personaPath, productDir, limit, size, outputRoot, selection, tasks, concurrency, model);
    return {
      ok: true,
      dryRun: true,
      outputRoot,
      selection,
      tasks,
    };
  }

  console.log("Nail stress test started");
  console.log(`Persona: ${persona.sourceName}`);
  console.log(`Product dir: ${productDir}`);
  console.log(`Products: ${selection.products.length}/${selection.availableCount}`);
  console.log(`Scenes per product: ${NAIL_STRESS_SCENES.length}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Aspect: 9:16 (${size})`);
  console.log(`Output root: ${outputRoot}`);

  const liveResults = Array.from({ length: tasks.length }, () => null);
  const queuedTasks = [];
  for (const [index, task] of tasks.entries()) {
    const existing = resumeExisting ? inspectExistingImage(task.outputPath) : null;
    if (existing) {
      liveResults[index] = {
        ...existing,
        workerId: "existing",
        workerName: "existing",
        workerLabel: "existing",
      };
      continue;
    }
    queuedTasks.push({ ...task, fullIndex: index });
  }
  console.log(`Existing images reused: ${liveResults.filter(Boolean).length}`);
  console.log(`Queued tasks: ${queuedTasks.length}`);

  const writePartialArtifacts = () => {
    const liveRecords = buildNailStressRecords(tasks, liveResults);
    return writeNailStressArtifacts(outputRoot, liveRecords, null, metadata, { partial: true });
  };
  writePartialArtifacts();

  const report = queuedTasks.length === 0
    ? {
      total: 0,
      success: 0,
      failed: 0,
      retryCount: 0,
      workerCount: workers.length,
      enabledWorkerCount: workers.filter((worker) => worker.enabled !== false).length,
      activeWorkerCount: 0,
      initialConcurrency: 0,
      peakConcurrency: 0,
      elapsed: 0,
      outputDir: outputRoot,
      paths: [],
      exhaustedReason: null,
      results: [],
      workerStats: [],
      exitCode: 0,
    }
    : await runWorkerTaskQueue(workers, queuedTasks, {
    concurrency,
    adaptive,
    maxRetries: MAX_RETRIES,
    retryDelayMs: RETRY_BACKOFF_MS,
    outputDir: outputRoot,
    returnReport: true,
    stickyTaskGroups: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)}`);
    },
    onTaskComplete: (task, result, context) => {
      liveResults[task.fullIndex] = result;
      writePartialArtifacts();
    },
    runTask: async (worker, task, context) => {
      const product = loadSourceImage(task.productPath);
      if (!product.ok) {
        return {
          ok: false,
          elapsed: 0,
          error: product.error,
          sourceName: basename(task.productPath),
        };
      }
      return editImageOnce(worker.apiKey, [persona, product], task.prompt, size, task.outputDir, {
        model,
        resize,
        savePath: task.outputPath,
        rawLogPath: `${task.rawLogBasePath}.attempt${context.attempt}.json`,
        transport,
      });
    },
  });

  const records = buildNailStressRecords(tasks, liveResults);
  const artifacts = writeNailStressArtifacts(outputRoot, records, report, metadata, { partial: false });
  const summary = buildNailStressSummary(records, report);

  console.log("");
  console.log(`Done: ${summary.success}/${summary.total} in ${(report.elapsed / 1000).toFixed(1)}s`);
  console.log(`Retries: ${summary.retries}`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Manifest: ${artifacts.manifestPath}`);
  console.log(`Summary CSV: ${artifacts.summaryCsvPath}`);
  console.log(`Failures JSON: ${artifacts.failuresPath}`);
  const samplePaths = records.filter((item) => item.status === "success").map((item) => item.outputPath).slice(0, 8);
  if (samplePaths.length > 0) {
    console.log("Sample successful paths:");
    for (const path of samplePaths) console.log(path);
  }
  if (summary.failed > 0) {
    console.log("Failed items:");
    for (const item of records.filter((record) => record.status !== "success").slice(0, 20)) {
      console.log(`- ${String(item.productIndex).padStart(3, "0")} ${item.productFileName} ${item.sceneLabel}: ${item.error}`);
    }
  }
  printWorkerStats(report);
  if (report.exhaustedReason) console.log(`Worker pool stop: ${report.exhaustedReason}`);

  return {
    ok: summary.failed === 0,
    dryRun: false,
    outputRoot,
    selection,
    tasks,
    report,
    records,
    artifacts,
  };
}

async function runAdaptiveSelfTest() {
  const mockWorkers = Array.from({ length: 4 }, (_, index) => ({
    id: `${WORKER_ID_PREFIX}${index + 1}`,
    name: `mock-${index + 1}`,
    apiKey: `mock-key-${index + 1}`,
    enabled: true,
    createdAt: "2026-07-08T00:00:00.000Z",
  }));

  console.log("Worker pool self-test: a single task should use only one worker.");
  const singleReport = await runWorkerTaskQueue(mockWorkers, [
    { prompt: "single-task" },
  ], {
    concurrency: 4,
    retryDelayMs: 0,
    returnReport: true,
    runTask: async (worker, task) => {
      await sleep(5);
      return { ok: true, elapsed: 5, path: `mock://${worker.id}-${task.prompt}.png`, fileSize: "1.00KB" };
    },
  });

  const singleOk = singleReport.exitCode === 0
    && singleReport.success === 1
    && singleReport.activeWorkerCount === 1
    && singleReport.peakConcurrency === 1;

  console.log("");
  console.log("Scheduler self-test: one Key should provide concurrent request slots for upstream auto allocation.");
  let singleKeyActive = 0;
  let singleKeyPeak = 0;
  const singleKeyReport = await runWorkerTaskQueue(mockWorkers.slice(0, 1), Array.from({ length: 3 }, (_, index) => ({
    prompt: `single-key-${index + 1}`,
  })), {
    concurrency: 3,
    retryDelayMs: 0,
    returnReport: true,
    runTask: async (worker, task) => {
      singleKeyActive += 1;
      singleKeyPeak = Math.max(singleKeyPeak, singleKeyActive);
      await sleep(5);
      singleKeyActive -= 1;
      return { ok: true, elapsed: 5, path: `mock://${worker.id}-${task.prompt}.png`, fileSize: "1.00KB" };
    },
  });
  const singleKeyOk = singleKeyReport.exitCode === 0
    && singleKeyReport.workerCount === 1
    && singleKeyReport.enabledWorkerCount === 1
    && singleKeyReport.success === 3
    && singleKeyReport.peakConcurrency === 3
    && singleKeyPeak === 3;

  console.log("");
  console.log("Worker pool self-test: retryable worker failure should cool the worker and move the task.");
  const retryCalls = new Map();
  const retryableReport = await runWorkerTaskQueue(mockWorkers, Array.from({ length: 5 }, (_, index) => ({
    prompt: `retryable-${index + 1}`,
  })), {
    concurrency: 4,
    retryDelayMs: 0,
    cooldownMs: 0,
    returnReport: true,
    runTask: async (worker, task, context) => {
      const key = `${worker.id}:${context.index}`;
      const count = (retryCalls.get(key) || 0) + 1;
      retryCalls.set(key, count);
      await sleep(5);
      if (worker.id === "worker-2" && context.index === 1 && count === 1) {
        return { ok: false, elapsed: 5, error: "HTTP 502: Cloudflare Bad Gateway" };
      }
      return { ok: true, elapsed: 5, path: `mock://${worker.id}-${task.prompt}.png`, fileSize: "1.00KB" };
    },
  });

  const retryableOk = retryableReport.exitCode === 0
    && retryableReport.success === 5
    && retryableReport.retryCount === 1
    && retryableReport.workerStats.some((worker) => worker.id === "worker-2" && worker.cooldowns === 1);

  console.log("");
  console.log("Worker pool self-test: one auth-fatal worker should be disabled while others continue.");
  const authFatalReport = await runWorkerTaskQueue(mockWorkers.slice(0, 3), Array.from({ length: 4 }, (_, index) => ({
    prompt: `auth-fatal-${index + 1}`,
  })), {
    concurrency: 3,
    retryDelayMs: 0,
    cooldownMs: 0,
    returnReport: true,
    runTask: async (worker, task) => {
      await sleep(5);
      if (worker.id === "worker-2") {
        return { ok: false, elapsed: 5, error: "HTTP 401: Invalid API key" };
      }
      return { ok: true, elapsed: 5, path: `mock://${worker.id}-${task.prompt}.png`, fileSize: "1.00KB" };
    },
  });

  const authFatalOk = authFatalReport.exitCode === 0
    && authFatalReport.success === 4
    && authFatalReport.workerStats.some((worker) => worker.id === "worker-2" && worker.fatalErrors === 1);

  console.log("");
  console.log("Worker pool self-test: all workers fatal should stop the remaining queue.");
  const allFatalReport = await runWorkerTaskQueue(mockWorkers.slice(0, 2), Array.from({ length: 3 }, (_, index) => ({
    prompt: `all-fatal-${index + 1}`,
  })), {
    concurrency: 2,
    retryDelayMs: 0,
    cooldownMs: 0,
    returnReport: true,
    runTask: async () => {
      await sleep(5);
      return { ok: false, elapsed: 5, error: "HTTP 401: Invalid API key" };
    },
  });

  const allFatalOk = allFatalReport.exitCode === 1
    && allFatalReport.failed === 3
    && !!allFatalReport.exhaustedReason;

  if (!singleOk || !singleKeyOk || !retryableOk || !authFatalOk || !allFatalOk) {
    console.error("Worker pool self-test FAILED.");
    console.error(JSON.stringify({ singleReport, singleKeyReport, singleKeyPeak, retryableReport, authFatalReport, allFatalReport }, null, 2));
    return 1;
  }

  console.log("");
  console.log("Worker pool self-test OK.");
  return 0;
}

async function runImagesApiSelfTest() {
  console.log("Images API self-test: generation JSON, edit multipart, and result extraction.");
  const sources = [
    {
      sourceName: "mock-a.png",
      sourceBuffer: Buffer.from("mock-source-a"),
      mimeType: "image/png",
      ext: "png",
    },
    {
      sourceName: "mock-b.jpg",
      sourceBuffer: Buffer.from("mock-source-b"),
      mimeType: "image/jpeg",
      ext: "jpg",
    },
  ];
  // Every catalog model: the plan's fields must land in the request it builds.
  const payloads = CATALOG.models.map((entry) => {
    const id = entry.id;
    const plan = resolveRequestPlan(entry, { ratio: entry.size.ratios.includes("16:9") ? "16:9" : undefined });
    if (entry.protocol === "gemini-chat") {
      const body = buildGeminiChatBody(id, "mock generation prompt", plan, sources.slice(0, 1));
      return {
        id,
        size: plan.label,
        ok: body.model === id
          && body.extra_body?.google?.image_config?.aspect_ratio === "16:9"
          && body.messages[0].content[1]?.image_url?.url.startsWith("data:image/png;base64,"),
      };
    }
    const generation = buildImagesGenerationBody(id, "mock generation prompt", plan);
    const fieldsOk = Object.entries(plan.fields).every(([key, value]) => generation[key] === value);
    const multipart = (entry.edit || []).find((variant) => variant.upload === "multipart");
    let editOk = true;
    if (multipart) {
      const refs = sources.slice(0, multipart.maxImages);
      const form = buildImagesEditForm(id, "mock edit prompt", plan, refs, { variant: multipart });
      const imageEntries = [...form.entries()].filter(([key]) => key === multipart.field);
      editOk = form.get("model") === id
        && form.get("n") === "1"
        && Object.entries(plan.fields).every(([key, value]) => form.get(key) === String(value))
        && String(form.get("prompt")).includes("mock edit prompt")
        && imageEntries.length === refs.length
        && imageEntries.every(([, value]) => value instanceof Blob);
    }
    return {
      id,
      size: plan.label,
      ok: generation.model === id
        && generation.n === 1
        && fieldsOk
        && generation.prompt.includes("mock generation prompt")
        && (entry.size.param !== "prompt-ar" || generation.prompt.endsWith("--ar 16:9"))
        && editOk,
    };
  });
  const payloadOk = payloads.every(({ ok }) => ok);

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const [base64] = extractImagesFromImageApi({ data: [{ b64_json: pngB64 }] });
  const logSummary = imageApiLogSummary({ data: [{ b64_json: pngB64, url: "https://signed.example/image.png" }] }, "gpt-image-2");
  const logText = JSON.stringify(logSummary);
  const outputDir = resolveOutputDir(join(tmpdir(), "88api-image-gen-self-test"));
  const saved = saveBase64Image(base64, outputDir, "self_test_edit");
  const savedOk = !!saved?.path && existsSync(saved.path) && saved.width === 1 && saved.height === 1;
  const logOk = logSummary.images?.[0]?.base64_characters === pngB64.length
    && logSummary.images?.[0]?.has_url === true
    && !logText.includes(pngB64)
    && !logText.includes("signed.example");

  if (!payloadOk || !savedOk || !logOk) {
    console.error("Images API self-test FAILED.");
    console.error(JSON.stringify({
      payloadOk,
      payloads,
      savedOk,
      logOk,
      saved,
    }, null, 2));
    return 1;
  }

  console.log("Images API self-test OK.");
  console.log(`Saved: ${saved.path}`);
  return 0;
}

async function runImageStreamSelfTest() {
  console.log("Images API stream self-test: payload shape, partial-image SSE, and final extraction.");
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const testModel = "gpt-image-2";
  const body = buildImagesGenerationBody(testModel, "mock generation", "3840x2160", { preview: true });
  const sse = [
    `data: ${JSON.stringify({ type: "image_generation.partial_image", partial_image_index: 0, b64_json: pngB64 })}`,
    `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: pngB64 })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  const parsed = await consumeImageApiStream(new Response(sse, {
    headers: { "Content-Type": "text/event-stream" },
  }), { preview: false });
  const urlSse = [
    `data: ${JSON.stringify({ type: "image_generation.completed", data: [{ url: `data:image/png;base64,${pngB64}` }] })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  const urlParsed = await consumeImageApiStream(new Response(urlSse, {
    headers: { "Content-Type": "text/event-stream" },
  }), { preview: false });
  const payloadOk = body.model === testModel
    && body.stream === true
    && body.partial_images === 1
    && body.n === 1
    && body.prompt.includes("mock generation");
  const streamOk = parsed.base64 === pngB64
    && parsed.partialImageEvents === 1
    && parsed.eventCounts?.["image_generation.completed"] === 1
    && urlParsed.base64 === pngB64
    && urlParsed.eventCounts?.["image_generation.completed"] === 1;
  let responsesRejected = false;
  try {
    resolveRunTransport("responses");
  } catch {
    responsesRejected = true;
  }
  const safetyOk = resolveRunTransport("auto") === "images"
    && resolveRunTransport("images") === "images"
    && responsesRejected
    && isNoAutoRetryError("[NO-AUTO-RETRY] Current unknown-state error") === true
    && isNoAutoRetryError("[NO-RETRY] Legacy unknown-state error") === true
    && isRetryableError("[NO-AUTO-RETRY] Images API stream timed out") === false
    && isRetryableError("[NO-RETRY] Legacy unknown-state error") === false
    && parseArgs(["--prompt", "mock", "--transport", "images", "--preview"]).flags.transport === "images"
    && parseArgs(["--prompt", "mock", "--transport", "images", "--preview"]).flags.preview === true;
  if (!payloadOk || !streamOk || !safetyOk) {
    console.error("Images API stream self-test FAILED.");
    console.error(JSON.stringify({ payloadOk, streamOk, safetyOk, parsed: imageStreamLogSummary(parsed, "3840x2160", testModel), urlParsed: imageStreamLogSummary(urlParsed, "3840x2160", testModel) }, null, 2));
    return 1;
  }
  console.log("Images API stream self-test OK.");
  return 0;
}

async function runModelConfigSelfTest() {
  console.log("Model/config self-test: catalog, migration, precedence, sizes, atomic save, and dry-run redaction.");
  const configPath = join(tmpdir(), `88api-image-gen-config-self-test-${process.pid}-${Date.now()}.json`);
  const legacy = {
    workers: [
      { id: "worker-1", name: "disabled-old", apiKey: "sk-test-disabled", enabled: false },
      { id: "worker-2", name: "active", apiKey: "sk-test-active", enabled: true },
      { id: "worker-3", name: "legacy-extra", apiKey: "sk-test-extra", enabled: true },
    ],
    quickMode: { quality: "2K", ratio: "16:9", count: 2 },
    batchMode: { quality: "2K", ratio: "4:3", concurrency: 2 },
  };
  writeFileSync(configPath, JSON.stringify(legacy, null, 2), "utf8");
  const migrated = loadConfig(configPath);
  const migratedDefaultModel = migrated.model;
  // v2 saved "gpt-image-2-4k"; v3 keeps gpt-image-2 and remembers 4K.
  migrated.model = "gpt-image-2-4k";
  saveConfig(migrated, configPath);
  const persisted = loadConfig(configPath);
  const removedModelFallback = normalizeConfigShape({ ...legacy, model: "removed-image-model" }).config.model;
  const nanoConfig = normalizeConfigShape({ apiKey: "sk-test-nano", model: "gemini-3.1-flash-image" }).config;
  const selectedWorker = getPrimaryWorker(persisted, { requireEnabled: true });
  const configSummary = buildConfigSummary(persisted, { envKey: "", source: configPath });
  const replacedConfig = replaceWithSingleKey(persisted, "sk-test-replacement");

  // Every documented exact-pixel preset must pass the local size rules.
  const presetChecks = CATALOG.models.filter((entry) => entry.size.param === "size").flatMap((entry) => entry.size.resolutions.flatMap((resolution) => entry.size.ratios.map((ratio) => {
    const plan = resolveRequestPlan(entry, { ratio, resolution });
    return { model: entry.id, ratio, resolution, size: plan.pixels, error: imageSizeValidationError(plan.pixels) };
  })));
  const presetSizesOk = presetChecks.length > 0 && presetChecks.every((item) => item.size && item.error === null);
  const legacyPlan = resolveGenerationParams({ model: "gpt-image-2-4k", aspect: "16:9" }, {}, {});
  const dryRun = buildDryRunPlan({
    mode: "generation",
    model: legacyPlan.model,
    size: legacyPlan.size,
    aspect: "16:9",
    prompts: ["mock prompt"],
    count: 2,
    concurrency: 1,
    preview: true,
  });
  const dryText = JSON.stringify(dryRun);
  const rejects = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  // The catalog can never point requests at another host or path.
  const hostile = { schemaVersion: 1, models: [{ ...CATALOG.models[0], id: "evil-image", generate: { endpoint: "https://attacker.example/v1/images" } }, CATALOG.models[0]] };
  const sanitized = sanitizeCatalog(JSON.parse(JSON.stringify(hostile)), "self-test");
  const hostileDropped = sanitized.models.length === 1 && sanitized.skipped === 1 && rejects(() => sanitizeCatalog({ schemaVersion: 2, models: [] }, "self-test"));

  const grok = modelEntry("grok-imagine-image");
  const seedream = modelEntry("doubao-seedream-5-0-pro");
  const editRulesOk = !!grok && !!seedream
    && editVariantFor("grok-imagine-image", [{}, {}, {}]).upload === "json"
    && rejects(() => editVariantFor("grok-imagine-image", [{}, {}, {}, {}]))
    && editVariantFor("doubao-seedream-5-0-pro", [{}]).upload === "multipart"
    && editVariantFor("doubao-seedream-5-0-pro", [{ url: "https://example.com/a.png" }, { url: "https://example.com/b.png" }]).endpoint === "/v1/images/generations"
    && rejects(() => editVariantFor("doubao-seedream-5-0-pro", [{}, {}]))
    && rejects(() => editVariantFor("midjourney-v8.2", [{}]));
  const planRulesOk = rejects(() => resolveRequestPlan(grok, { resolution: "4K" }))
    && rejects(() => resolveRequestPlan(modelEntry("gemini-3-pro-image"), { ratio: "1:4" }))
    && rejects(() => resolveRequestPlan(modelEntry("gpt-image-2"), { background: "transparent" }))
    && rejects(() => resolveRequestPlan(modelEntry("az-gpt-image-2"), { background: "transparent", outputFormat: "jpeg" }))
    && resolveRequestPlan(grok, { ratio: "16:9", resolution: "2K" }).fields.resolution === "2k"
    && resolveRequestPlan(seedream, { resolution: "2K" }).fields.quality === "2K"
    && imageApiPrompt("cat", resolveRequestPlan(modelEntry("midjourney-v8.2"), { ratio: "16:9" })) === "cat --ar 16:9";

  // Some upstreams append their own image link after the embedded Base64 image.
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const parsed = parseGeminiChatResponse({ choices: [{ message: { content: `![image](data:image/png;base64,${pngB64})\n![src](https://upstream.example/x.jpg)` } }] });
  const geminiParseOk = parsed.image?.type === "base64" && parsed.image.data === pngB64
    && parseGeminiChatResponse({ choices: [{ message: { content: "only text" } }] }).image === null;

  const ok = CATALOG.models.length > 0
    && presetSizesOk
    && hostileDropped
    && editRulesOk
    && planRulesOk
    && geminiParseOk
    && migratedDefaultModel === DEFAULT_MODEL
    && removedModelFallback === DEFAULT_MODEL
    && nanoConfig.model === "gemini-3.1-flash-image"
    && nanoConfig.workers[0]?.apiKey === "sk-test-nano"
    && migrated.workers.length === 3
    && migrated.workers[0].enabled === false
    && persisted.model === "gpt-image-2"
    && persisted.resolution === "4K"
    && persisted.workers[0].apiKey === legacy.workers[0].apiKey
    && selectedWorker?.apiKey === legacy.workers[1].apiKey
    && configSummary.已配置Key === true
    && configSummary.Key预览 === previewKey(legacy.workers[1].apiKey)
    && configSummary.旧版备用Key记录.startsWith("2 个")
    && replacedConfig.workers.length === 1
    && replacedConfig.workers[0].apiKey === "sk-test-replacement"
    && effectiveModel({ model: "gpt-image-2-4k" }, persisted) === "gpt-image-2"
    && effectiveModel({}, persisted) === "gpt-image-2"
    && effectiveModel({}, {}) === DEFAULT_MODEL
    && legacyPlan.size.pixels === "3840x2160"
    && rejects(() => validateModel("not-a-model"))
    && dryRun.paidApiCalled === false
    && dryRun.request.body.model === "gpt-image-2"
    && dryRun.request.body.size === "3840x2160"
    && !("background" in dryRun.request.body)
    && dryRun.taskCount === 2
    && legacy.workers.every((worker) => !dryText.includes(worker.apiKey))
    && !dryText.includes("base64");
  if (existsSync(configPath)) unlinkSync(configPath);
  if (!ok) {
    console.error("Model/config self-test FAILED.");
    console.error(JSON.stringify({ migrated, persisted, removedModelFallback, nanoConfig, presetChecks: presetChecks.filter((item) => item.error), presetSizesOk, hostileDropped, editRulesOk, planRulesOk, geminiParseOk, dryRun }, null, 2));
    return 1;
  }
  console.log("Model/config self-test OK.");
  return 0;
}

// Covers the three failure stages against a local HTTP server: a refused
// connection is reported as not sent (auto-retry allowed), a failed read as
// billed, and a failed result download retries for free, keeps its link file
// and can be fetched later with --retry-download.
async function runResultDownloadSelfTest() {
  console.log("Result download self-test: stage errors, free download retries, and --retry-download.");
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const png = Buffer.from(pngB64, "base64");
  let failuresLeft = 0;
  const server = createServer((req, res) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png" }).end(png);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/result.png`;
  const backoff = [...RESULT_DOWNLOAD_BACKOFF_MS];
  RESULT_DOWNLOAD_BACKOFF_MS.fill(0);
  const outputDir = resolveOutputDir(join(tmpdir(), `88api-image-gen-download-test-${Date.now()}`));
  const pendingFiles = () => readdirSync(outputDir).filter((name) => name.endsWith(".pending-download.json"));
  const checks = {};
  try {
    failuresLeft = RESULT_DOWNLOAD_ATTEMPTS - 1;
    const recovered = await imageApiResultBase64({ data: [{ url }] }, { outputDir, prefix: "img" });
    checks.retriesUntilSuccess = recovered === pngB64 && pendingFiles().length === 0;

    failuresLeft = RESULT_DOWNLOAD_ATTEMPTS;
    let downloadError = "";
    try {
      await imageApiResultBase64({ data: [{ url }] }, { outputDir, prefix: "img" });
    } catch (error) {
      downloadError = imageRequestStageError("Images", "read-result", error);
    }
    const [linkName] = pendingFiles();
    checks.downloadFailureKeepsLink = !!linkName
      && downloadError.includes("stage: download")
      && downloadError.includes(linkName)
      && isNoAutoRetryError(downloadError)
      && classifyWorkflowError(downloadError) === "download_failed";

    const saved = linkName ? await retrySavedDownload(join(outputDir, linkName)) : null;
    checks.retryDownloadSavesImage = !!saved?.path && existsSync(saved.path) && saved.width === 1 && pendingFiles().length === 0;

    // A port that was just bound and released refuses connections.
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    let refused = null;
    try {
      await requestWithTimeout(`http://127.0.0.1:${closedPort}/v1/images/generations`, { method: "POST" }, 5_000);
    } catch (error) {
      refused = error;
    }
    const notSent = imageRequestStageError("Images", "submit", refused);
    const unknown = imageRequestStageError("Images", "submit", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET", message: "read ECONNRESET" } }));
    const billed = imageRequestStageError("Images edit", "read-result", Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } }));
    checks.stageMessages = notSent.includes("was not sent") && !isNoAutoRetryError(notSent) && isRetryableError(notSent)
      && unknown.includes("state is unknown (stage: submit)") && unknown.includes("ECONNRESET") && isNoAutoRetryError(unknown)
      && billed.includes("was billed") && billed.includes("stage: read-result") && isNoAutoRetryError(billed)
      && classifyWorkflowError(billed) === "read_result_failed";
  } finally {
    RESULT_DOWNLOAD_BACKOFF_MS.splice(0, RESULT_DOWNLOAD_BACKOFF_MS.length, ...backoff);
    server.close();
  }
  if (!Object.values(checks).every(Boolean) || Object.keys(checks).length !== 4) {
    console.error("Result download self-test FAILED.");
    console.error(JSON.stringify(checks, null, 2));
    return 1;
  }
  console.log("Result download self-test OK.");
  return 0;
}

// Covers the client-neutral config move (legacy copy kept and mirrored) and
// the job record: requests cut off by a killed process read back as
// interrupted and never retryable, and nothing here touches the real home dir.
async function runConfigJobSelfTest() {
  console.log("Config/job self-test: legacy config migration, legacy mirror, job record states, interrupted runs.");
  const root = resolveOutputDir(join(tmpdir(), `88api-image-gen-config-job-test-${process.pid}-${Date.now()}`));
  const newPath = join(root, "new", "image-gen.json");
  const legacyPath = join(root, "legacy", "88api-image-gen-config.json");
  const jobsDir = join(root, "jobs");
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({ apiKey: "sk-test-legacy", model: "gpt-image-2-4k" }), "utf8");
  const checks = {};
  const previousRecord = activeJobRecord;
  try {
    const migrated = loadConfig(newPath, [legacyPath]);
    checks.migratedFromLegacy = existsSync(newPath) && existsSync(legacyPath)
      && migrated.model === "gpt-image-2" && migrated.resolution === "4K"
      && getPrimaryWorker(migrated)?.apiKey === "sk-test-legacy"
      && loadedConfigSource === legacyPath;
    saveConfig(replaceWithSingleKey(migrated, "sk-test-new"), newPath, [legacyPath]);
    const mirrored = JSON.parse(readFileSync(legacyPath, "utf8"));
    checks.legacyMirrored = getPrimaryWorker(loadConfig(newPath, [legacyPath]))?.apiKey === "sk-test-new"
      && getPrimaryWorker(mirrored)?.apiKey === "sk-test-new"
      && loadedConfigSource === newPath;
    const envSummary = buildConfigSummary(migrated, { envKey: "sk-test-environment-key", source: newPath });
    checks.envKeySummary = envSummary.Key预览 === previewKey("sk-test-environment-key")
      && envSummary.Key来源.includes("API88_KEY")
      && !JSON.stringify(envSummary).includes("sk-test-environment-key");

    activeJobRecord = startJobRecord({ mode: "self-test", model: DEFAULT_MODEL }, jobsDir);
    const saved = jobRequestStart({ kind: "generation", model: DEFAULT_MODEL, size: "2048x2048", prompt: "a" });
    jobRequestResponded(saved, 200);
    jobRequestEnd(saved, { ok: true, path: join(root, "a.png"), dimensions: "2048x2048" });
    const notSent = jobRequestStart({ kind: "generation", prompt: "b" });
    jobRequestEnd(notSent, { ok: false, error: "Images request was not sent: could not connect to 88API (ECONNREFUSED); no charge was made" });
    const rejected = jobRequestStart({ kind: "generation", prompt: "c" });
    jobRequestResponded(rejected, 400);
    jobRequestEnd(rejected, { ok: false, error: "HTTP 400: bad prompt" });
    const unknown = jobRequestStart({ kind: "edit", prompt: "d" });
    jobRequestEnd(unknown, { ok: false, error: `${NO_AUTO_RETRY_PREFIX} Images edit request state is unknown (stage: submit): ECONNRESET` });
    const billed = jobRequestStart({ kind: "generation", prompt: "e" });
    jobRequestResponded(billed, 200);
    jobRequestEnd(billed, { ok: false, error: `${NO_AUTO_RETRY_PREFIX} Images request completed and was billed, but reading the result failed (stage: read-result): terminated` });
    jobRequestStart({ kind: "generation", prompt: "f" });
    const recordPath = activeJobRecord.path;

    // The run was "killed": still unfinished on disk and its process is gone.
    const killed = summarizeJobRecord(readJobRecord(recordPath), { alive: false });
    const states = killed.requests.map((entry) => entry.state).join(",");
    checks.interruptedStates = killed.status === "interrupted"
      && states === "saved,not-sent,rejected,unknown,billed-not-saved,interrupted"
      && killed.saved === 1 && killed.notSent === 1 && killed.rejected === 1
      && killed.unknown === 2 && killed.billedNotSaved === 1
      && killed.requestsSent === 5
      && killed.noAutoRetry === true
      && killed.requests[5].mayBeBilled === true
      && killed.requests[1].mayBeBilled === false
      && killed.images.length === 1;
    const live = summarizeJobRecord(readJobRecord(recordPath), { alive: true });
    checks.runningWhileAlive = live.status === "running" && live.requests[5].state === "running";
    checks.resolveById = resolveJobRecordPath(activeJobRecord.id, jobsDir) === recordPath
      && listJobRecordPaths(jobsDir)[0] === recordPath;

    finishJobRecord(0);
    checks.finishedRecord = readJobRecord(recordPath).finished === true;
    activeJobRecord = startJobRecord({ mode: "self-test-empty" }, jobsDir);
    const emptyPath = activeJobRecord.path;
    finishJobRecord(1);
    checks.emptyRecordRemoved = !existsSync(emptyPath);
  } finally {
    activeJobRecord = previousRecord;
  }
  if (!Object.values(checks).every(Boolean) || Object.keys(checks).length !== 8) {
    console.error("Config/job self-test FAILED.");
    console.error(JSON.stringify(checks, null, 2));
    return 1;
  }
  console.log("Config/job self-test OK.");
  return 0;
}

// Sandboxed clients: unwritable default folders fall back to the working
// directory, other errors still surface; GPT Image edits follow the reference.
async function runSandboxSelfTest() {
  console.log("Sandbox self-test: writable-folder fallback and reference-image aspect.");
  const root = join(tmpdir(), `88api-image-gen-sandbox-self-test-${process.pid}-${Date.now()}`);
  const preferred = join(root, "home-default");
  const fallback = join(root, "workspace");
  const denied = (dir) => {
    if (dir === preferred) {
      const error = new Error(`EPERM: operation not permitted, mkdir '${dir}'`);
      error.code = "EPERM";
      throw error;
    }
    assertWritableDir(dir);
  };
  const rejects = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const fellBack = writableDir(preferred, fallback, "self-test folder", denied) === fallback && existsSync(fallback);
  const keptPreferred = writableDir(join(root, "ok"), fallback, "self-test folder") === join(root, "ok");
  const noFallbackRejects = rejects(() => writableDir(preferred, null, "self-test folder", denied));
  const otherErrorRejects = rejects(() => writableDir(join(root, "x"), fallback, "self-test folder", () => {
    const error = new Error("disk full");
    error.code = "ENOSPC";
    throw error;
  }));

  // A PNG header is enough for the dimension reader.
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1536, 16);
  png.writeUInt32BE(1024, 20);
  const refPath = join(root, "ref-3x2.png");
  writeFileSync(refPath, png);
  const gptAspect = referenceAspect("gpt-image-2", [refPath])?.ratio;
  const geminiAspect = referenceAspect("gemini-3.1-flash-image", [refPath]);
  const urlOnly = referenceAspect("gpt-image-2", ["https://example.com/a.png"]);

  const ok = fellBack && keptPreferred && noFallbackRejects && otherErrorRejects && gptAspect === "3:2" && geminiAspect === null && urlOnly === null;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // leftover temp files are harmless
  }
  if (!ok) {
    console.error("Sandbox self-test FAILED.");
    console.error(JSON.stringify({ fellBack, keptPreferred, noFallbackRejects, otherErrorRejects, gptAspect, geminiAspect, urlOnly }, null, 2));
    return 1;
  }
  console.log("Sandbox self-test OK.");
  return 0;
}

async function runUnifiedSelfTest() {
  const tests = [
    ["adaptive", runAdaptiveSelfTest],
    ["images-api", runImagesApiSelfTest],
    ["result-download", runResultDownloadSelfTest],
    ["image-stream", runImageStreamSelfTest],
    ["workflow", runWorkflowSelfTest],
    ["model-config", runModelConfigSelfTest],
    ["config-job", runConfigJobSelfTest],
    ["sandbox", runSandboxSelfTest],
  ];
  const results = [];
  for (const [name, test] of tests) {
    const exitCode = await test();
    results.push({ name, ok: exitCode === 0 });
    if (exitCode !== 0) break;
  }
  const ok = results.length === tests.length && results.every((result) => result.ok);
  console.log(JSON.stringify({ selfTest: ok ? "OK" : "FAILED", results }, null, 2));
  return ok ? 0 : 1;
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const value = argv[i];
    if (value === "--get-config") args.flags.getConfig = true;
    else if (value === "--version" || value === "-v") args.flags.version = true;
    else if (value === "--config-path") args.flags.configPath = true;
    else if (value === "--list-models") args.flags.listModels = true;
    else if (value === "--list-workers") args.flags.listWorkers = true;
    else if (value === "--set-model" && argv[i + 1]) args.flags.setModel = argv[++i];
    else if (value === "--model" && argv[i + 1]) args.flags.model = argv[++i];
    else if (value === "--set-key" && argv[i + 1]) args.flags.setKey = argv[++i];
    else if (value === "--add-worker-key" && argv[i + 1]) args.flags.addWorkerKey = argv[++i];
    else if (value === "--worker-name" && argv[i + 1]) args.flags.workerName = argv[++i];
    else if (value === "--set-worker-key" && argv[i + 2]) {
      args.flags.setWorkerKey = { worker: argv[++i], key: argv[++i] };
    } else if (value === "--remove-worker" && argv[i + 1]) args.flags.removeWorker = argv[++i];
    else if (value === "--enable-worker" && argv[i + 1]) args.flags.enableWorker = argv[++i];
    else if (value === "--disable-worker" && argv[i + 1]) args.flags.disableWorker = argv[++i];
    else if (value === "--set-quick-mode") args.flags.setQuickMode = true;
    else if (value === "--set-batch-mode") args.flags.setBatchMode = true;
    else if (value === "--prompt" && argv[i + 1]) args.prompts.push(argv[++i]);
    else if (value === "--quality" && argv[i + 1]) args.flags.quality = argv[++i];
    else if (value === "--resolution" && argv[i + 1]) args.flags.resolution = argv[++i];
    else if (value === "--background" && argv[i + 1]) args.flags.background = argv[++i];
    else if (value === "--output-format" && argv[i + 1]) args.flags.outputFormat = argv[++i];
    else if (value === "--refresh-models") args.flags.refreshModels = true;
    else if (value === "--ratio" && argv[i + 1]) args.flags.ratio = argv[++i];
    else if (value === "--aspect" && argv[i + 1]) args.flags.aspect = argv[++i];
    else if (value === "--count" && argv[i + 1]) args.flags.count = Number.parseInt(argv[++i], 10);
    else if (value === "--repeat" && argv[i + 1]) args.flags.repeat = Number.parseInt(argv[++i], 10);
    else if (value === "--limit" && argv[i + 1]) args.flags.limit = Number.parseInt(argv[++i], 10);
    else if (value === "--output-dir" && argv[i + 1]) args.flags.outputDir = argv[++i];
    else if (value === "--retry-download" && argv[i + 1]) args.flags.retryDownload = argv[++i];
    else if (value === "--job-status") {
      args.flags.jobStatus = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else if (value === "--json") args.flags.json = true;
    else if (value === "--concurrency" && argv[i + 1]) args.flags.concurrency = Number.parseInt(argv[++i], 10);
    else if (value === "--transport" && argv[i + 1]) args.flags.transport = argv[++i];
    else if (value === "--responses") args.flags.transport = "responses";
    else if (value === "--images-api") args.flags.transport = "images";
    else if (value === "--preview") args.flags.preview = true;
    else if (value === "--no-preview") args.flags.preview = false;
    else if (value === "--adaptive") args.flags.adaptive = true;
    else if (value === "--no-adaptive") args.flags.adaptive = false;
    else if (value === "--dry-run") args.flags.dryRun = true;
    else if (value === "--resize") args.flags.resize = true;
    else if (value === "--no-resize" || value === "--raw-output") args.flags.resize = false;
    else if (value === "--batch" && argv[i + 1]) args.flags.batchFile = argv[++i];
    else if (value === "--batch-inline") {
      args.flags.batchInline = true;
      i++;
      while (i < argv.length && !argv[i].startsWith("--")) {
        args.prompts.push(argv[i++]);
      }
      continue;
    } else if (value === "--edit") args.flags.edit = true;
    else if (value === "--batch-edit") args.flags.batchEdit = true;
    else if (value === "--legacy-edit") {
      args.flags.edit = true;
      args.flags.unsupportedEditRoute = "legacy-edit";
    } else if (value === "--edit-api" && argv[i + 1]) {
      const route = String(argv[++i]).trim().toLowerCase();
      if (route === "responses" || route === "response") args.flags.transport = "responses";
      else if (route === "images" || route === "image") args.flags.transport = "images";
      else args.flags.unsupportedEditRoute = `edit-api:${route}`;
    }
    else if (value === "--image" && argv[i + 1]) {
      if (!args.flags.images) args.flags.images = [];
      args.flags.images.push(argv[++i]);
    } else if (value === "--workflow-batch-edit") args.flags.workflowBatchEdit = true;
    else if (value === "--fixed-ref" && argv[i + 1]) {
      if (!args.flags.fixedRefs) args.flags.fixedRefs = [];
      args.flags.fixedRefs.push(argv[++i]);
    } else if (value === "--item-dir" && argv[i + 1]) args.flags.itemDir = argv[++i];
    else if (value === "--templates" && argv[i + 1]) args.flags.templatesFile = argv[++i];
    else if (value === "--template-inline" && argv[i + 1]) {
      if (!args.flags.templateInline) args.flags.templateInline = [];
      args.flags.templateInline.push(argv[++i]);
    } else if (value === "--preset" && argv[i + 1]) args.flags.preset = argv[++i];
    else if (value === "--repair-passes" && argv[i + 1]) args.flags.repairPasses = Number.parseInt(argv[++i], 10);
    else if (value === "--no-repair") args.flags.repairPasses = 0;
    else if (value === "--nail-stress-test") args.flags.nailStressTest = true;
    else if (value === "--persona" && argv[i + 1]) args.flags.personaPath = argv[++i];
    else if (value === "--product-dir" && argv[i + 1]) args.flags.productDir = argv[++i];
    else if (value === "--resolve-size") args.flags.resolveSize = true;
    else if (value === "--self-test-adaptive") args.flags.selfTestAdaptive = true;
    else if (value === "--self-test-workers") args.flags.selfTestAdaptive = true;
    else if (value === "--self-test-images-api") args.flags.selfTestImagesApi = true;
    else if (value === "--self-test-download") args.flags.selfTestDownload = true;
    else if (value === "--self-test-image-stream" || value === "--self-test-responses" || value === "--self-test-edit-responses") args.flags.selfTestImageStream = true;
    else if (value === "--self-test-workflow") args.flags.selfTestWorkflow = true;
    else if (value === "--self-test") args.flags.selfTest = true;
    else if (value === "--help" || value === "-h") args.flags.help = true;
    else if (value.startsWith("--")) args.flags.unknownOption = value;
    i++;
  }
  return args;
}

function printUsage() {
  console.log(`88API-Image-Gen ${PLUGIN_VERSION}

CONFIG
  --version                     print the plugin version
  --get-config
  --config-path
  --list-models                 models in the 88API catalog, marked available/unavailable for the saved Key
  --refresh-models              reload the model catalog from ${"https://88api.ai/helper/image-models.json"} now
  --set-model <MODEL>           change the long-term default model (factory default ${DEFAULT_MODEL})
  --set-key <YOUR_88API_KEY>
  --set-quick-mode --aspect R --resolution 1K|2K|4K --count 1..${MAX_GENERATION_COUNT}
  --set-batch-mode --aspect R --resolution 1K|2K|4K --concurrency 1..${MAX_CONCURRENCY}

FIRST USE
  runtime: Node.js 18+ (Python is not required)
  create one API Key at https://88api.ai/ and select the auto group
  one Key is sufficient; 88API automatically allocates concurrent requests upstream

GENERATE
  --prompt "..." [--model MODEL] [--aspect R] [--resolution 1K|2K|4K] [--quality Q] [--background B] [--output-format F] [--count 1..${MAX_GENERATION_COUNT}] [--preview] [--no-resize] [--dry-run]
  --prompt "..." --repeat 1..${MAX_REPEAT} [--concurrency 1..${MAX_CONCURRENCY}] [--adaptive|--no-adaptive]
  --batch prompts.json [--aspect R] [--resolution 1K|2K|4K] [--concurrency N]
  --batch-inline "prompt 1" "prompt 2" ... [--aspect R] [--resolution 1K|2K|4K] [--concurrency N]

EDIT
  --edit --image path.png --prompt "..." [--aspect R] [--resolution 1K|2K|4K] [--count 1..${MAX_EDIT_COUNT}]
  --edit --image one.png --image https://example.com/two.jpg --prompt "..."   all references go in one edit request
  --batch-edit --edit --image one.png --image two.png --prompt "..." [--concurrency N]
  the endpoint, upload format and reference limit come from the model catalog

PARAMETERS (validated per model against the catalog before any paid request)
  --aspect / --ratio R          aspect ratio, e.g. 1:1, 16:9, 9:16 (aliases: square, landscape, portrait)
  --resolution 1K|2K|4K         converted to the model's own size field (pixels, tier, aspect_ratio+resolution or image_config)
  --quality Q                   model quality level (e.g. low|medium|high); 1K/2K/4K is read as --resolution for older commands
  --background B                transparent|opaque|auto where the model supports it
  --output-format F             png|webp|jpeg where the model supports it
  --preview                     partial-image SSE preview for one text-to-image task (exact-pixel OpenAI models only)

WORKFLOW BATCH EDIT
  --workflow-batch-edit --fixed-ref ref.png --item-dir dir --templates templates.json [--limit ${WORKFLOW_DEFAULT_LIMIT}] [--aspect R] [--concurrency 1..${MAX_CONCURRENCY}] [--repair-passes 0..5|--no-repair] [--dry-run]
  --workflow-batch-edit --fixed-ref ref.png --item-dir dir --template-inline "scene prompt" [--template-inline "..."] [--limit N]
  --workflow-batch-edit --fixed-ref persona.png --item-dir dir --preset ${WORKFLOW_NAIL_PRESET} [--limit N] [--aspect 9:16]
  templates JSON: array of strings/objects or { "templates": [{ "key": "scene", "prompt": "..." }] }

NAIL STRESS TEST
  --nail-stress-test --persona path.png --product-dir dir [--limit ${NAIL_STRESS_DEFAULT_LIMIT}] [--aspect 9:16] [--concurrency 1..${MAX_CONCURRENCY}] [--dry-run]

TOOLS
  --retry-download path.pending-download.json    fetch an already generated and billed image from its saved result link; sends no new paid request
  --job-status [job-id|record.json]               show what a paid run actually did (recent runs when omitted); sends no request
  --json                                          print one machine-readable result line at the end of a paid run
  --resolve-size --model MODEL --aspect 16:9 --resolution 4K
  --self-test
  --self-test-adaptive
  --self-test-images-api
  --self-test-download
  --self-test-image-stream
  --self-test-workflow

DEFAULTS
  API root: ${API_ROOT}
  factory model: ${DEFAULT_MODEL}
  model catalog: ${CATALOG.source}${CATALOG.fetchedAt ? ` (${CATALOG.fetchedAt})` : ""}; cached at ${CATALOG_CACHE_PATH} for 24h
  catalog models: ${catalogModelIds().join(", ")}
  output: ~/Pictures/88api-image-gen
  config: ${CONFIG_PATH} (API88_CONFIG_DIR overrides the directory; API88_KEY overrides the saved Key)
  job records: ${JOBS_DIR}
  scheduler: one configured Key with up to ${MAX_CONCURRENCY} local request slots; upstream allocation uses the auto group
  adaptive: on, concurrency ${DEFAULTS.concurrency}, retries ${MAX_RETRIES}, key cooldown ${DEFAULT_WORKER_COOLDOWN_MS / 1000}s
  notice: ${API_SIZE_LIMIT_NOTICE}`);
}

// GET /v1/models with the saved Key: the models this Key's group can call, with
// each model's declared endpoint types. Free; never a paid request.
async function fetchKeyModels(apiKey) {
  const res = await requestWithTimeout(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }, 15_000);
  if (!res.ok) throw new Error(`GET /v1/models returned HTTP ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data?.data) ? data.data : []).map((item) => ({ id: String(item.id || ""), endpointTypes: Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types : [] }));
}

function savedApiKey(config) {
  return ENV_API_KEY || getPrimaryWorker(config, { requireEnabled: true })?.apiKey || "";
}

// A model the catalog does not document can still be tried when the Key lists
// it as an image model: it gets a conservative inferred entry (see inferEntry).
async function registerUndocumentedModel(id, config) {
  const apiKey = savedApiKey(config);
  if (!apiKey) throw new Error(`Unknown model="${id}". It is not in the 88API model catalog, and no Key is configured to look it up.`);
  const listed = (await fetchKeyModels(apiKey)).find((item) => item.id === id);
  if (!listed) throw new Error(`Model "${id}" is not in the 88API model catalog and your Key's group does not list it. Run --list-models to see what this Key can use.`);
  const entry = inferEntry(id, listed.endpointTypes);
  if (!entry) throw new Error(`Model "${id}" is not an image model (declared endpoints: ${listed.endpointTypes.join(", ") || "none"}).`);
  INFERRED_ENTRIES.set(id, entry);
}

async function buildModelList(config) {
  const apiKey = savedApiKey(config);
  let keyModels = null;
  let keyError = null;
  if (apiKey) {
    try {
      keyModels = await fetchKeyModels(apiKey);
    } catch (error) {
      keyError = error?.message || String(error);
    }
  }
  const listed = keyModels ? new Set(keyModels.map((item) => item.id)) : null;
  const undocumented = keyModels
    ? keyModels.filter((item) => !findEntry(CATALOG, item.id) && inferEntry(item.id, item.endpointTypes) && /image|banana|imagine|seedream|midjourney|flux/i.test(item.id))
      .map((item) => describeEntry(inferEntry(item.id, item.endpointTypes), true))
    : [];
  return {
    defaultModel: DEFAULT_MODEL,
    configuredModel: config.model,
    catalog: { source: CATALOG.source, fetchedAt: CATALOG.fetchedAt, models: CATALOG.models.length },
    keyCheck: listed ? "available = listed by GET /v1/models for the saved Key" : (keyError ? `could not query the Key's models: ${keyError}` : "no Key configured; availability unknown"),
    models: CATALOG.models.map((entry) => describeEntry(entry, listed ? listed.has(entry.id) : null)),
    undocumented,
  };
}

function runModeName(flags) {
  if (flags.workflowBatchEdit) return "workflow-batch-edit";
  if (flags.nailStressTest) return "nail-stress-test";
  if (flags.edit) return flags.batchEdit ? "batch-edit" : ((flags.images || []).length > 1 ? "multi-reference-edit" : "edit");
  if (flags.batchFile || flags.batchInline) return "batch";
  if (flags.repeat != null || (flags.count ?? 1) > 1) return "repeat";
  return "generation";
}

// Resolves the model and turns --aspect / --resolution / --quality / --background /
// --output-format into a request plan checked against the model catalog.
function resolveGenerationParams(flags, modeConfig, config = {}) {
  const model = effectiveModel(flags, config);
  const entry = modelEntry(model);
  const explicitRatio = flags.aspect ?? flags.ratio ?? null;
  const ratio = explicitRatio ? normalizeRatio(explicitRatio) : null;
  // --quality 2K/4K came from v2, where it named the size tier.
  const legacyTier = /^[124]k$/i.test(String(flags.quality || "")) ? String(flags.quality).toUpperCase() : null;
  const aliasResolution = legacyModelAlias(flags.model)?.resolution || null;
  try {
    const plan = resolveRequestPlan(entry, {
      ratio,
      resolution: flags.resolution || legacyTier || aliasResolution || null,
      quality: legacyTier ? null : flags.quality,
      background: flags.background,
      outputFormat: flags.outputFormat,
      savedRatio: modeConfig?.ratio,
      savedResolution: modeConfig?.resolution || config.resolution || modeConfig?.quality,
    });
    if (plan.pixels && entry.size.param === "size") {
      const sizeError = imageSizeValidationError(plan.pixels);
      if (sizeError) throw new Error(`invalid ${model} preset: ${sizeError}`);
    }
    if (entry.inferred) console.warn(`NOTICE: ${model} is not documented in the 88API model catalog yet; only the prompt and reference images are sent, without size or quality fields.`);
    return { model, ratio: plan.ratio, resolution: plan.resolution, quality: plan.resolution, size: plan };
  } catch (error) {
    console.error(`ERROR: ${error?.message || String(error)} No paid request was made.`);
    process.exit(1);
  }
}

async function main() {
  const { prompts, flags } = parseArgs(process.argv.slice(2));
  if (flags.unknownOption) {
    console.error(`ERROR: Unsupported option "${flags.unknownOption}". Run --help for the v${PLUGIN_VERSION} command list.`);
    process.exit(1);
  }
  if (flags.version) {
    console.log(`88API-Image-Gen ${PLUGIN_VERSION}`);
    return;
  }
  // Only runs that go online anyway refresh the catalog; offline commands
  // (dry-run, config, job status, self-test) use the cache or bundled snapshot.
  const paidRun = !flags.dryRun && (prompts.length > 0 || flags.batchFile || flags.edit || flags.workflowBatchEdit || flags.nailStressTest);
  CATALOG = await loadCatalog({
    cachePath: CATALOG_CACHE_PATH,
    allowNetwork: !!(paidRun || flags.listModels || flags.refreshModels || flags.setModel),
    force: !!flags.refreshModels,
  });
  if (CATALOG.warning && (paidRun || flags.listModels || flags.refreshModels)) console.warn(`NOTICE: ${CATALOG.warning}; using the ${CATALOG.source}.`);
  if (flags.refreshModels) {
    console.log(`Model catalog: ${CATALOG.source}, ${CATALOG.models.length} models${CATALOG.fetchedAt ? `, fetched ${CATALOG.fetchedAt}` : ""}.`);
    if (!flags.listModels && prompts.length === 0) return;
  }
  const config = loadConfig();
  try {
    // --model may name a model the Key lists but the catalog does not document
    // yet; --set-model only accepts documented models.
    if (flags.model) {
      const id = legacyModelAlias(flags.model)?.model || flags.model;
      if (!modelEntry(id) && !flags.dryRun) await registerUndocumentedModel(id, config);
      validateModel(id);
    }
    if (flags.setModel) validateModel(legacyModelAlias(flags.setModel)?.model || flags.setModel);
  } catch (error) {
    console.error(`ERROR: ${error?.message || String(error)}`);
    process.exit(1);
  }
  let requestedTransport;
  try {
    requestedTransport = normalizeTransport(flags.transport || DEFAULT_TRANSPORT);
    resolveRunTransport(requestedTransport);
  } catch (error) {
    console.error(`ERROR: ${error?.message || String(error)}`);
    process.exit(1);
  }

  if (flags.getConfig) {
    console.log(JSON.stringify(buildConfigSummary(config), null, 2));
    return;
  }

  if (flags.retryDownload) {
    try {
      const saved = await retrySavedDownload(flags.retryDownload);
      console.log(`[OK] ${saved.path} (${formatImageResult(saved)})`);
    } catch (error) {
      console.error(`ERROR: ${error?.message || String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (flags.jobStatus) {
    try {
      if (flags.jobStatus === true) {
        const recent = listJobRecordPaths().slice(0, JOB_LIST_LIMIT).map((path) => {
          const { requests, ...summary } = summarizeJobRecord(readJobRecord(path));
          return summary;
        });
        console.log(JSON.stringify({ jobsDir: JOBS_DIR, recent }, null, 2));
      } else {
        console.log(JSON.stringify(summarizeJobRecord(readJobRecord(resolveJobRecordPath(flags.jobStatus))), null, 2));
      }
    } catch (error) {
      console.error(`ERROR: ${error?.message || String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (flags.configPath) {
    console.log(CONFIG_PATH);
    return;
  }

  if (flags.listModels) {
    console.log(JSON.stringify(await buildModelList(config), null, 2));
    return;
  }

  if (flags.setModel) {
    const alias = legacyModelAlias(flags.setModel);
    config.model = alias?.model || flags.setModel;
    if (alias) config.resolution = alias.resolution;
    saveConfig(config);
    console.log(`Default model saved: ${config.model}`);
    return;
  }

  if (flags.listWorkers) {
    console.warn("NOTICE: --list-workers is deprecated because v1.0 uses one Key. Showing the single-Key configuration summary instead.");
    console.log(JSON.stringify(buildConfigSummary(config), null, 2));
    return;
  }

  if (flags.setKey) {
    const singleKeyConfig = replaceWithSingleKey(config, flags.setKey);
    try {
      saveConfig(singleKeyConfig);
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      // Never fall back to the working directory for the Key: project files may be shared or committed.
      console.error(`ERROR: The Key was not saved: ${CONFIG_PATH} is not writable here (${error.code}, usually a sandboxed client). Run this same --set-key command once with the client's approval to write outside the workspace, or set API88_KEY in the client's environment. The Key is never saved anywhere else.`);
      process.exitCode = 1;
      return;
    }
    console.log(`88API Key saved: ${previewKey(flags.setKey)} (single-Key auto allocation)`);
    return;
  }

  if (flags.addWorkerKey || flags.setWorkerKey || flags.removeWorker || flags.enableWorker || flags.disableWorker || flags.workerName) {
    console.error("ERROR: Multi-Key worker commands were removed in v1.0. Configure one auto-group Key with --set-key <YOUR_88API_KEY>.");
    process.exit(1);
  }

  if (flags.setQuickMode) {
    const previous = config.quickMode || {};
    const resolved = resolveGenerationParams(flags, previous, config);
    const { model, resolution, ratio, size } = resolved;
    const count = clampInteger(flags.count ?? previous.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
    config.quickMode = { resolution, ratio, count };
    saveConfig(config);
    console.log(`Quick mode saved: ${size}, count ${count}; current model ${model}`);
    return;
  }

  if (flags.setBatchMode) {
    const previous = config.batchMode || {};
    const resolved = resolveGenerationParams(flags, previous, config);
    const { model, resolution, ratio, size } = resolved;
    const concurrency = clampInteger(flags.concurrency ?? previous.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    config.batchMode = { resolution, ratio, concurrency };
    saveConfig(config);
    console.log(`Batch mode saved: ${size}, concurrency ${concurrency}; current model ${model}`);
    return;
  }

  if (flags.resolveSize) {
    const { model, size } = resolveGenerationParams(flags, config.quickMode, config);
    const entry = modelEntry(model);
    console.log(JSON.stringify({
      model,
      protocol: entry.protocol,
      ratio: size.ratio,
      resolution: size.resolution,
      pixels: size.pixels,
      requestFields: entry.protocol === "gemini-chat" ? { extra_body: { google: { image_config: size.imageConfig } } } : size.fields,
      promptSuffix: size.promptSuffix || null,
    }, null, 2));
    return;
  }

  if (flags.selfTestAdaptive) {
    process.exitCode = await runAdaptiveSelfTest();
    return;
  }

  if (flags.selfTestImagesApi) {
    process.exitCode = await runImagesApiSelfTest();
    return;
  }

  if (flags.selfTestDownload) {
    process.exitCode = await runResultDownloadSelfTest();
    return;
  }

  if (flags.selfTestImageStream) {
    process.exitCode = await runImageStreamSelfTest();
    return;
  }

  if (flags.selfTestWorkflow) {
    process.exitCode = await runWorkflowSelfTest();
    return;
  }

  if (flags.selfTest) {
    process.exitCode = await runUnifiedSelfTest();
    return;
  }

  if (flags.help || (prompts.length === 0 && !flags.batchFile && !flags.edit && !flags.nailStressTest && !flags.workflowBatchEdit)) {
    printUsage();
    return;
  }

  const configuredWorkers = flags.dryRun ? [] : getEnabledWorkersOrExit(config);
  if (!flags.dryRun) {
    activeJobRecord = startJobRecord({ mode: runModeName(flags), model: effectiveModel(flags, config), outputDir: flags.outputDir || null });
    console.log(`Job record: ${activeJobRecord.path} (if this run is interrupted, check it with --job-status ${activeJobRecord.id}; never resubmit blindly)`);
    process.on("exit", (code) => {
      finishJobRecord(code);
      if (flags.json) {
        try {
          writeSync(1, `${JSON.stringify(summarizeJobRecord(activeJobRecord, { alive: false }))}\n`);
        } catch {
          // stdout already closed; the job record on disk still has the result.
        }
      }
    });
  }

  if (flags.workflowBatchEdit) {
    if (!flags.itemDir) {
      console.error("ERROR: --workflow-batch-edit requires --item-dir <dir>.");
      process.exit(1);
    }
    let templates;
    try {
      templates = parseWorkflowTemplates(flags);
    } catch (error) {
      console.error(`ERROR: ${error?.message || String(error)}`);
      process.exit(1);
    }
    const workflowAspect = flags.aspect ?? flags.ratio ?? "9:16";
    const workflowParams = resolveGenerationParams({ ...flags, aspect: workflowAspect }, { ratio: workflowAspect }, config);
    const { model, ratio, size } = workflowParams;
    const limitExplicit = flags.limit != null;
    const limit = clampInteger(flags.limit, 1, 1000, WORKFLOW_DEFAULT_LIMIT);
    const concurrency = clampInteger(flags.concurrency ?? MAX_CONCURRENCY, 1, MAX_CONCURRENCY, Math.min(MAX_CONCURRENCY, DEFAULTS.concurrency));
    const repairPasses = clampInteger(flags.repairPasses, 0, 5, WORKFLOW_DEFAULT_REPAIR_PASSES);
    const transport = resolveRunTransport(requestedTransport, true);
    console.log(`Route: ${routeLabel(model, [...(flags.fixedRefs || []), "item.png"])} (workflow batch); model: ${model} (${size})`);
    const result = await runWorkflowBatchEdit(configuredWorkers, {
      fixedRefPaths: flags.fixedRefs || [],
      itemDir: flags.itemDir,
      limit,
      limitExplicit,
      templates,
      preset: flags.preset || null,
      size,
      aspect: ratio,
      concurrency,
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
      outputDir: flags.outputDir,
      dryRun: !!flags.dryRun,
      repairPasses,
      transport,
      model,
    });
    process.exitCode = result.report?.exitCode || 0;
    return;
  }

  if (flags.nailStressTest) {
    if (!flags.personaPath) {
      console.error("ERROR: --nail-stress-test requires --persona <path>.");
      process.exit(1);
    }
    if (!flags.productDir) {
      console.error("ERROR: --nail-stress-test requires --product-dir <dir>.");
      process.exit(1);
    }
    const requestedAspect = flags.aspect ?? flags.ratio ?? "9:16";
    const normalizedAspect = normalizeRatio(requestedAspect);
    if (normalizedAspect !== "9:16") {
      console.error(`ERROR: --nail-stress-test is fixed to 9:16. Received "${requestedAspect}".`);
      process.exit(1);
    }
    const limit = clampInteger(flags.limit, 1, 1000, NAIL_STRESS_DEFAULT_LIMIT);
    const concurrency = clampInteger(flags.concurrency ?? MAX_CONCURRENCY, 1, MAX_CONCURRENCY, Math.min(MAX_CONCURRENCY, DEFAULTS.concurrency));
    const nailParams = resolveGenerationParams({ ...flags, aspect: "9:16" }, { ratio: "9:16" }, config);
    const { model, size } = nailParams;
    const transport = resolveRunTransport(requestedTransport, true);
    console.log(`Route: ${routeLabel(model, [flags.personaPath, "product.png"])} (batch preset); model: ${model} (${size})`);
    const result = await runNailStressTest(configuredWorkers, {
      personaPath: flags.personaPath,
      productDir: flags.productDir,
      limit,
      size,
      concurrency,
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
      outputDir: flags.outputDir,
      dryRun: !!flags.dryRun,
      transport,
      model,
    });
    process.exitCode = result.report?.exitCode || 0;
    return;
  }

  const outputDir = resolveOutputDir(flags.outputDir);

  if (flags.edit) {
    const images = flags.images || [];
    if (images.length === 0) {
      console.error("ERROR: --edit requires at least one --image <path>.");
      process.exit(1);
    }
    if (prompts.length === 0) {
      console.error("ERROR: --edit requires --prompt <text>.");
      process.exit(1);
    }
    if (flags.unsupportedEditRoute) {
      console.error("ERROR: Image-to-image uses the edit request the model catalog documents; legacy Responses edit routes are disabled.");
      process.exit(1);
    }
    const followed = !flags.aspect && !flags.ratio ? referenceAspect(effectiveModel(flags, config), images) : null;
    if (followed) console.warn(`NOTICE: aspect following the first reference image (${followed.width}x${followed.height}) -> ${followed.ratio}; pass --aspect to choose another.`);
    const editParams = resolveGenerationParams(followed ? { ...flags, aspect: followed.ratio } : flags, config.quickMode, config);
    const { model, ratio, size } = editParams;
    try {
      // Batch edit sends one reference per request; a normal edit sends them all at once.
      const perRequest = images.length > 1 && flags.batchEdit ? [images[0]] : images;
      editVariantFor(model, perRequest.map((path) => ({ url: /^https?:\/\//i.test(path) ? path : null })));
    } catch (error) {
      console.error(`ERROR: ${error?.message || String(error)} No paid request was made.`);
      process.exit(1);
    }
    if (images.length > 1 && flags.batchEdit) {
      const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
      const transport = resolveRunTransport(requestedTransport, true);
      if (flags.dryRun) {
        printDryRunPlan({ mode: "batch-edit", model, size, aspect: ratio, prompts: [prompts[0]], imagePaths: images.slice(0, 1), count: images.length, concurrency });
        return;
      }
      console.log(`Route: ${routeLabel(model, images.slice(0, 1))} (batch edit); model: ${model} (${size})`);
      process.exitCode = await runBatchEdit(configuredWorkers, images, prompts[0], size, concurrency, outputDir, {
        model,
        adaptive: flags.adaptive !== false,
        resize: flags.resize !== false,
        transport,
      });
      return;
    }
    const count = clampInteger(flags.count, 1, MAX_EDIT_COUNT, 1);
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency ?? count, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const transport = resolveRunTransport(requestedTransport);
    const preview = false;
    if (flags.preview === true) console.warn("NOTICE: --preview is supported for text-to-image generation only; edits use /v1/images/edits.");
    if (flags.dryRun) {
      printDryRunPlan({ mode: images.length > 1 ? "multi-reference-edit" : "edit", model, size, aspect: ratio, prompts: [prompts[0]], imagePaths: images, count, concurrency, preview });
      return;
    }
    console.log(`Route: ${routeLabel(model, images)}; model: ${model} (${size})`);
    const result = await editImage(configuredWorkers, images, prompts[0], size, outputDir, count, false, {
      adaptive: flags.adaptive !== false,
      concurrency,
      resize: flags.resize !== false,
      transport,
      preview,
      model,
    });
    if (!result.ok) {
      if (result.results?.length > 0) {
        console.error("Partial edit successes:");
        for (const [index, item] of result.results.entries()) {
          console.error(`${index + 1}. ${item.path} ${formatImageResult(item)} via ${item.workerLabel}`);
        }
      }
      console.error(`Edit failed: ${result.error}`);
      if (result.report) printWorkerStats(result.report);
      process.exitCode = 1;
      return;
    }
    console.log(`Edit prompt: "${prompts[0]}"`);
    if (count > 1) {
      for (const [index, item] of result.results.entries()) {
        console.log(`${index + 1}. ${item.path} ${formatImageResult(item)} via ${item.workerLabel}`);
      }
    } else {
      console.log(`Path: ${result.path}`);
      console.log(`Size: ${formatImageResult(result)}`);
      console.log(`Worker: ${result.workerLabel}`);
    }
    console.log(`Source: ${result.sourceName}`);
    console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
    if (result.report) printWorkerStats(result.report);
    return;
  }

  const isBatch = !!flags.batchFile || !!flags.batchInline;
  const modeConfig = isBatch ? config.batchMode : config.quickMode;
  const generationParams = resolveGenerationParams(flags, modeConfig, config);
  const { model, ratio, size } = generationParams;

  if (flags.batchFile) {
    const raw = readFileSync(flags.batchFile, "utf8");
    const parsed = JSON.parse(raw);
    const batchPrompts = Array.isArray(parsed) ? parsed : parsed?.prompts;
    if (!Array.isArray(batchPrompts) || batchPrompts.length === 0) {
      console.error("ERROR: Batch file must be a JSON array of prompt strings or { \"prompts\": [...] }.");
      process.exit(1);
    }
    if (batchPrompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const transport = resolveRunTransport(requestedTransport, true);
    if (flags.dryRun) {
      printDryRunPlan({ mode: "batch", model, size, aspect: ratio, prompts: batchPrompts.map(String), count: batchPrompts.length, concurrency });
      return;
    }
    console.log(`Route: ${routeLabel(model)} (batch prompts); model: ${model} (${size})`);
    // Let the event loop drain: process.exit() right after fetch aborts on Windows
    // (libuv UV_HANDLE_CLOSING assertion, exit code 127) and hides the real result.
    process.exitCode = await runBatch(configuredWorkers, batchPrompts.map(String), size, concurrency, outputDir, {
      model,
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
      transport,
    });
    return;
  }

  if (flags.batchInline) {
    if (prompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const transport = resolveRunTransport(requestedTransport, true);
    if (flags.dryRun) {
      printDryRunPlan({ mode: "batch-inline", model, size, aspect: ratio, prompts, count: prompts.length, concurrency });
      return;
    }
    console.log(`Route: ${routeLabel(model)} (batch prompts); model: ${model} (${size})`);
    process.exitCode = await runBatch(configuredWorkers, prompts, size, concurrency, outputDir, {
      model,
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
      transport,
    });
    return;
  }

  const prompt = prompts[0];
  const total = flags.repeat != null
    ? clampInteger(flags.repeat, 1, MAX_REPEAT, DEFAULTS.count)
    : clampInteger(flags.count ?? config.quickMode?.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
  if (total > 1) {
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const transport = resolveRunTransport(requestedTransport, true);
    if (flags.dryRun) {
      printDryRunPlan({ mode: "repeat", model, size, aspect: ratio, prompts: Array(total).fill(prompt), count: total, concurrency });
      return;
    }
    console.log(`Route: ${routeLabel(model)} (${total} independent images); model: ${model} (${size})`);
    process.exitCode = await runBatch(configuredWorkers, Array(total).fill(prompt), size, concurrency, outputDir, {
      model,
      adaptive: flags.adaptive !== false,
      isVariation: true,
      resize: flags.resize !== false,
      transport,
    });
    return;
  }

  const transport = resolveRunTransport(requestedTransport, false);
  const previewEntry = modelEntry(model);
  // Partial-image SSE only exists on the exact-pixel OpenAI Images models.
  const preview = flags.preview === true && previewEntry.protocol === "openai-images" && previewEntry.size.param === "size";
  if (flags.preview === true && !preview) console.warn(`NOTICE: ${model} does not support --preview; waiting for the final image instead.`);
  if (flags.dryRun) {
    printDryRunPlan({ mode: "generation", model, size, aspect: ratio, prompts: [prompt], count: 1, concurrency: 1, preview });
    return;
  }
  console.log(`Route: ${routeLabel(model)}${preview ? " (partial-image preview enabled)" : ""}; model: ${model} (${size})`);
  process.exitCode = await runBatch(configuredWorkers, [prompt], size, 1, outputDir, {
    model,
    adaptive: flags.adaptive !== false,
    resize: flags.resize !== false,
    transport,
    preview,
  });
  return;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
