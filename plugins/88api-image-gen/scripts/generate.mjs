#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const API_ROOT = "https://88api.ai";
const RESPONSES_URL = `${API_ROOT}/v1/responses`;
const TEXT_MODEL = "gpt-5.5";
const IMAGE_MODEL = "gpt-image-2";
const CONFIG_PATH = join(homedir(), ".codex", "88api-image-gen-config.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".codex", "fhl-image-gen-config.json");
const NO_PROMPT_REVISION_INSTRUCTIONS = "You are a tool runner. Pass the user prompt to image_generation VERBATIM. DO NOT rewrite, expand, polish, or revise it in any way. Use the exact text the user gave.";

const MAX_GENERATION_COUNT = 9;
const MAX_REPEAT = 50;
const MAX_CONCURRENCY = 10;
const MAX_WORKERS = 10;
const MAX_EDIT_COUNT = 4;
const MAX_BATCH_PROMPTS = 20;
const MAX_EDIT_SOURCES = 10;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 180_000;
const SUPPORTED_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "7:4",
  "4:7",
];
const DISABLED_RATIOS = new Set(["5:4", "4:5", "3:1", "1:3"]);

const SIZE_MATRIX = {
  "1K": {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1536x1152",
    "3:4": "1152x1536",
    "5:4": "1520x1216",
    "4:5": "1216x1520",
    "16:9": "1536x864",
    "9:16": "864x1536",
    "2:1": "1536x768",
    "1:2": "768x1536",
    "3:1": "1536x512",
    "1:3": "512x1536",
    "7:4": "1664x944",
    "4:7": "944x1664",
  },
  "2K": {
    "1:1": "2048x2048",
    "3:2": "2048x1360",
    "2:3": "1360x2048",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "5:4": "2040x1632",
    "4:5": "1632x2040",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "2:1": "2048x1024",
    "1:2": "1024x2048",
    "3:1": "2040x680",
    "1:3": "680x2040",
    "7:4": "2208x1264",
    "4:7": "1264x2208",
  },
  "4K": {
    "1:1": "2880x2880",
    "3:2": "3520x2352",
    "2:3": "2352x3520",
    "4:3": "3840x2880",
    "3:4": "2880x3840",
    "5:4": "3840x3072",
    "4:5": "3072x3840",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "2:1": "3840x1920",
    "1:2": "1920x3840",
    "3:1": "3840x1280",
    "1:3": "1280x3840",
    "7:4": "3808x2176",
    "4:7": "2176x3808",
  },
};

const DEFAULTS = {
  quality: "2K",
  ratio: "1:1",
  count: 1,
  concurrency: 3,
};
const FIXED_REQUEST_QUALITY = "2K";
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
  if ("apiKey" in normalized) {
    delete normalized.apiKey;
    changed = true;
  }
  if (!Array.isArray(source.workers)) changed = true;
  return { config: normalized, changed };
}

function saveConfig(config) {
  const { config: normalized } = normalizeConfigShape(config);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows may not implement POSIX permission bits; the user profile ACL remains authoritative.
  }
}

function loadConfig() {
  const sourcePath = existsSync(CONFIG_PATH)
    ? CONFIG_PATH
    : (existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH : null);
  if (!sourcePath) return normalizeConfigShape({}).config;
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
    const normalized = normalizeConfigShape(parsed);
    if (normalized.changed || sourcePath === LEGACY_CONFIG_PATH) saveConfig(normalized.config);
    return normalized.config;
  } catch (error) {
    console.warn(`WARNING: Unable to read 88API configuration at ${sourcePath}: ${error?.message || String(error)}`);
    return normalizeConfigShape({}).config;
  }
}

function getConfiguredWorkers(config, options = {}) {
  const requireEnabled = options.requireEnabled === true;
  const workers = Array.isArray(config?.workers) ? config.workers.filter((worker) => worker?.apiKey) : [];
  return requireEnabled ? workers.filter((worker) => worker.enabled !== false) : workers;
}

function getEnabledWorkersOrExit(config) {
  const workers = getConfiguredWorkers(config, { requireEnabled: true });
  if (workers.length === 0) {
    console.error("ERROR: No enabled 88API worker is configured. Create an image-generation group key at https://88api.ai/ and run --set-key <YOUR_88API_IMAGE_GROUP_KEY>. Start with one worker; multiple workers use more memory.");
    process.exit(1);
  }
  return workers;
}

function findDuplicateWorkerKey(workers, apiKey, ignoreId = null) {
  const normalizedKey = String(apiKey || "").trim();
  return workers.find((worker) => worker.apiKey === normalizedKey && worker.id !== ignoreId) || null;
}

function resolveWorkerReference(config, reference) {
  const workers = getConfiguredWorkers(config);
  const ref = String(reference || "").trim();
  if (!ref) return null;

  const byIndex = Number.parseInt(ref, 10);
  if (Number.isFinite(byIndex) && String(byIndex) === ref && byIndex >= 1 && byIndex <= workers.length) {
    return { worker: workers[byIndex - 1], index: byIndex - 1 };
  }

  const index = workers.findIndex((worker) => worker.id === ref || worker.name === ref);
  if (index >= 0) return { worker: workers[index], index };
  return null;
}

function workerLabel(worker) {
  if (!worker) return "unknown-worker";
  return String(worker.name || "").trim() || String(worker.id || "").trim() || "unknown-worker";
}

function summarizeWorker(worker, index) {
  return {
    index: index + 1,
    id: worker.id,
    name: worker.name,
    enabled: worker.enabled !== false,
    keyPreview: previewKey(worker.apiKey),
    createdAt: worker.createdAt || null,
  };
}

function workerLimitErrorMessage(count) {
  return `ERROR: Worker pool supports up to ${MAX_WORKERS} API workers. Current configured workers: ${count}. Remove extra workers before continuing.`;
}

function isWorkerLimitExceeded(config) {
  return getConfiguredWorkers(config).length > MAX_WORKERS;
}

function buildConfigSummary(config) {
  const workers = getConfiguredWorkers(config);
  const enabledWorkers = workers.filter((worker) => worker.enabled !== false);
  return {
    hasKey: workers.length > 0,
    keyPreview: workers.length === 1 ? previewKey(workers[0].apiKey) : null,
    workerCount: workers.length,
    workerLimit: MAX_WORKERS,
    workerLimitExceeded: workers.length > MAX_WORKERS,
    enabledWorkerCount: enabledWorkers.length,
    workers: workers.map(summarizeWorker),
    quickMode: config?.quickMode || null,
    batchMode: config?.batchMode || null,
  };
}

function printWorkerList(config) {
  const workers = getConfiguredWorkers(config);
  if (workers.length === 0) {
    console.log(`Workers: none configured (limit ${MAX_WORKERS})`);
    return;
  }
  const enabled = workers.filter((worker) => worker.enabled !== false).length;
  console.log(`Workers: ${workers.length} total, ${enabled} enabled, limit ${MAX_WORKERS}`);
  workers.forEach((worker, index) => {
    console.log(`${index + 1}. ${worker.name} [${worker.id}] ${worker.enabled !== false ? "enabled" : "disabled"} key=${previewKey(worker.apiKey)}`);
  });
  if (workers.length > MAX_WORKERS) console.log(workerLimitErrorMessage(workers.length));
}

function normalizeQuality(quality) {
  return FIXED_REQUEST_QUALITY;
}

function shouldWarnFixedQuality(quality) {
  const normalized = String(quality || "").trim().toUpperCase();
  return normalized && normalized !== FIXED_REQUEST_QUALITY;
}

function normalizeRatio(ratio) {
  const normalized = String(ratio || "").trim().toLowerCase();
  return RATIO_ALIASES[normalized] || normalized;
}

function ratioLabel(ratio) {
  const canonical = normalizeRatio(ratio);
  const alias = Object.entries(RATIO_ALIASES).find(([, value]) => value === canonical)?.[0];
  return alias ? `${canonical} (${alias})` : canonical;
}

function supportedRatioText() {
  return SUPPORTED_RATIOS.join(", ");
}

function normalizeSizeString(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return null;
  return `${parsed.width}x${parsed.height}`;
}

function aspectRatioForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return null;
  const divisor = gcd(parsed.width, parsed.height);
  if (!divisor) return null;
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}

function supportedAspectFromSize(size) {
  const aspect = aspectRatioForSize(size);
  return SUPPORTED_RATIOS.includes(aspect) ? aspect : null;
}

function isDisabledRatio(ratio) {
  return DISABLED_RATIOS.has(normalizeRatio(ratio));
}

function resolveSize(quality, ratio, explicitSize = null) {
  if (explicitSize) return normalizeSizeString(explicitSize);
  const normalizedQuality = normalizeQuality(quality);
  const normalizedRatio = normalizeRatio(ratio);
  if (!normalizedQuality) return null;
  return SIZE_MATRIX[normalizedQuality]?.[normalizedRatio] || null;
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

function resolveOutputDir(userDir) {
  const dir = userDir || join(homedir(), "Pictures", "88api-image-gen");
  mkdirSync(dir, { recursive: true });
  return dir;
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

function imageDataURLFromBuffer(buffer, mimeType) {
  return `data:${mimeType || "image/png"};base64,${buffer.toString("base64")}`;
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

function isRetryableError(error) {
  const text = String(error || "").toLowerCase();
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
    "socket hang up",
    "econnreset",
    "terminated",
    "no image_generation_call result",
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
  const filename = `${prefix}_${timestamp()}${numbered}_${suffix}.png`;
  const path = join(outputDir, filename);
  return savePngBuffer(path, buffer, targetSize);
}

function savePngBuffer(path, buffer, targetSize = null) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  const resizeInfo = ensurePngTargetSize(path, targetSize);
  const finalBuffer = resizeInfo?.resized ? readFileSync(path) : buffer;
  const dimensions = readPngDimensions(finalBuffer);
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
  return parts.join(", ");
}

function inspectExistingImage(path) {
  if (!existsSync(path)) return null;
  const buffer = readFileSync(path);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const dimensions = readPngDimensions(buffer);
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

function extractImagesFromResponse(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((item) => item?.b64_json || item?.image?.b64_json || item?.base64)
    .filter((item) => typeof item === "string" && item.trim());
}

function parseSSEEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return null;
  const payload = trimmed.slice(6).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function walkForImageGenerationCall(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkForImageGenerationCall(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (value.type === "image_generation_call" && value.result) return value;
    for (const child of Object.values(value)) {
      const found = walkForImageGenerationCall(child);
      if (found) return found;
    }
  }
  return null;
}

function walkForBase64Image(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkForBase64Image(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (typeof value.b64_json === "string" && value.b64_json.trim()) return value.b64_json;
    if (typeof value.partial_image_b64 === "string" && value.partial_image_b64.trim()) return value.partial_image_b64;
    if (typeof value.base64 === "string" && value.base64.trim()) return value.base64;
    for (const child of Object.values(value)) {
      const found = walkForBase64Image(child);
      if (found) return found;
    }
  }
  return null;
}

function extractImagesFromResponses(raw) {
  const images = [];
  const partialImages = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const event = parseSSEEventLine(line);
    if (!event) continue;
    if (event?.type === "response.image_generation_call.partial_image" && typeof event.partial_image_b64 === "string" && event.partial_image_b64.trim()) {
      partialImages.push(event.partial_image_b64);
      continue;
    }
    if (event?.type === "image_generation.partial_image" && typeof event.b64_json === "string" && event.b64_json.trim()) {
      partialImages.push(event.b64_json);
      continue;
    }
    if (event?.type === "image_generation.completed" && typeof event.b64_json === "string" && event.b64_json.trim()) {
      images.push(event.b64_json);
      continue;
    }
    if (event?.type === "response.output_item.done" && event?.item?.type === "image_generation_call" && event.item.result) {
      images.push(event.item.result);
      continue;
    }
    const found = walkForImageGenerationCall(event);
    if (found?.result) images.push(found.result);
  }

  if (images.length > 0) return images;
  try {
    const parsed = JSON.parse(raw);
    const found = walkForImageGenerationCall(parsed);
    if (found?.result) return [found.result];
    const base64 = walkForBase64Image(parsed);
    if (base64) return [base64];
  } catch {
    // The normal Responses path is SSE, so raw JSON is only a fallback.
  }
  if (partialImages.length > 0) return [partialImages[partialImages.length - 1]];
  return [];
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

function aspectInstructionForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return "";
  const divisor = gcd(parsed.width, parsed.height);
  if (!divisor) return "";
  const aspect = `${parsed.width / divisor}:${parsed.height / divisor}`;
  const orientation = parsed.width === parsed.height
    ? "square"
    : parsed.width > parsed.height
      ? "landscape"
      : "portrait";
  return `The selected output aspect ratio is ${aspect} (${orientation}). The image_generation result MUST use a ${aspect} canvas and must not return any other aspect ratio.`;
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

function buildResponsesImageBody(prompt, size, action, sourceDataURLs = []) {
  const aspectInstruction = aspectInstructionForSize(size);
  const aspectPromptSuffix = aspectPromptSuffixForSize(size);
  const promptText = aspectPromptSuffix ? `${prompt}\n\n${aspectPromptSuffix}` : prompt;
  const content = [{ type: "input_text", text: promptText }];
  for (const dataURL of sourceDataURLs) {
    if (dataURL) content.push({ type: "input_image", image_url: dataURL });
  }
  return {
    model: TEXT_MODEL,
    input: [{
      role: "user",
      content,
    }],
    tools: [{
      type: "image_generation",
      model: IMAGE_MODEL,
      action,
      size,
      quality: "auto",
      output_format: "png",
      moderation: "low",
      partial_images: parseSizeForAspect(size) ? 0 : 1,
    }],
    tool_choice: { type: "image_generation" },
    reasoning: { effort: "xhigh" },
    store: false,
    stream: true,
    instructions: [NO_PROMPT_REVISION_INSTRUCTIONS, aspectInstruction].filter(Boolean).join(" "),
  };
}

function buildResponsesGenerationBody(prompt, size) {
  return buildResponsesImageBody(prompt, size, "generate");
}

function buildResponsesEditBody(prompt, size, sourceDataURLs) {
  return buildResponsesImageBody(prompt, size, "edit", sourceDataURLs);
}

async function generateImage(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const start = Date.now();
  try {
    const res = await requestWithTimeout(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildResponsesGenerationBody(prompt, size)),
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) return { ok: false, elapsed: Date.now() - start, error: await parseErrorResponse(res) };

    const raw = await res.text();
    const [base64] = extractImagesFromResponses(raw);
    const saved = saveBase64Image(base64, outputDir, "img", null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No image_generation_call result in Responses stream" };
    return { ok: true, elapsed, ...saved };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
    };
  }
}

function loadSourceImage(imagePath) {
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
    dataURL: imageDataURLFromBuffer(sourceBuffer, mimeType),
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

async function editImageViaResponsesOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const start = Date.now();
  const sourceDataURLs = sources.map((item) => item.dataURL).filter(Boolean);
  const sourceName = summarizeSources(sources);
  const rawLogPath = options.rawLogPath || null;
  try {
    const res = await requestWithTimeout(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildResponsesEditBody(prompt, size, sourceDataURLs)),
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      if (rawLogPath) saveTextArtifact(rawLogPath, raw);
      return { ok: false, elapsed: Date.now() - start, error: parseErrorBody(res.status, raw), sourceName };
    }

    const raw = await res.text();
    if (rawLogPath) saveTextArtifact(rawLogPath, raw);
    const [base64] = extractImagesFromResponses(raw);
    const saved = options.savePath
      ? saveBase64ImageToPath(base64, options.savePath, resize ? size : null)
      : saveBase64Image(base64, outputDir, "edit", options.saveIndex ?? null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No image_generation_call result in Responses stream", sourceName };
    return { ok: true, elapsed, ...saved, sourceName };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      sourceName,
    };
  }
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
  console.log(`Workers: total=${report.workerCount}, enabled=${report.enabledWorkerCount}, used=${report.activeWorkerCount}, peak concurrency=${report.peakConcurrency}`);
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

  const sessions = enabledWorkers.map(createWorkerSession);
  const taskStates = createTaskStates(tasks);
  const groupAssignments = new Map();
  const runningGroups = new Set();
  const started = Date.now();
  const initialConcurrency = Math.max(1, Math.min(Number(concurrency) || DEFAULTS.concurrency, total || 1, enabledWorkers.length, MAX_CONCURRENCY));
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
        worker.fatal = true;
        worker.stats.fatalErrors += 1;
        console.log(`[worker:${workerLabel(worker)}] Disabled for this run: ${result.error}`);
      } else if (retryable && adaptive) {
        worker.disabledUntil = Date.now() + schedulerCooldownMs(sessions, retryDelayMs, cooldownMs);
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
    if (sources.length === 1) {
      console.log(`Loaded ${sources[0].sourceName} (${(sources[0].sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
    } else {
      const totalMb = sources.reduce((sum, item) => sum + item.sourceBuffer.length, 0) / 1024 / 1024;
      console.log(`Loaded ${sources.length} source images (${totalMb.toFixed(2)}MB total)`);
      for (const source of sources) {
        console.log(`- ${source.sourceName} (${(source.sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
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
    runTask: async (worker, task) => editImageViaResponsesOnce(worker.apiKey, task.sources, prompt, size, outputDir, {
      resize,
      saveIndex: task.saveIndex,
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
    returnReport = false,
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
    runTask: async (worker, task) => generateImage(worker.apiKey, task.prompt, size, outputDir, {
      resize,
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
    runTask: async (worker, task) => editImageViaResponsesOnce(worker.apiKey, task.sources, prompt, size, outputDir, {
      resize,
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

function printNailStressDryRun(personaPath, productDir, limit, size, outputRoot, selection, tasks, concurrency) {
  console.log("Nail stress test dry run");
  console.log(`Persona: ${personaPath}`);
  console.log(`Product dir: ${productDir}`);
  console.log(`Available product images: ${selection.availableCount}`);
  console.log(`Selected products: ${selection.products.length}`);
  console.log(`Aspect: 9:16 (${size})`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Output root: ${outputRoot}`);
  console.log(`Total tasks: ${tasks.length}`);
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
  if (text.includes("no image_generation_call result")) return "no_image_result";
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
      return editImageViaResponsesOnce(worker.apiKey, [...fixedSources, item], task.prompt, size, task.outputDir, {
        resize,
        savePath: task.outputPath,
        rawLogPath: `${task.rawLogBasePath}.${repair ? "repair" : "main"}.attempt${context.attempt}.sse.txt`,
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

function printWorkflowDryRun(fixedRefPaths, itemDir, limit, size, outputRoot, selection, templates, tasks, concurrency) {
  console.log("Workflow batch edit dry run");
  console.log(`Fixed refs: ${fixedRefPaths.length}`);
  for (const refPath of fixedRefPaths) console.log(`- ${refPath}`);
  console.log(`Item dir: ${itemDir}`);
  console.log(`Available item images: ${selection.availableCount}`);
  console.log(`Selected items: ${selection.items.length}`);
  console.log(`Templates: ${templates.length}`);
  console.log(`Total tasks: ${tasks.length}`);
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
  };

  if (dryRun) {
    printWorkflowDryRun(fixedRefPaths, itemDir, limit, size, outputRoot, selection, workflowTemplates, tasks, concurrency);
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
  const outputRoot = join(tmpdir(), `88api-workflow-self-test_${timestamp()}`);
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
    size: "1152x2048",
    aspect: "9:16",
  }, [{
    label: "mock-main",
    queuedCount: firstQueue.length,
    retries: 1,
  }], { partial: false });

  const ok = firstQueue.length === 2
    && repairQueue.length === 1
    && records[0].status === "success"
    && records[1].errorClass === "timeout_524"
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
  };

  if (dryRun) {
    printNailStressDryRun(personaPath, productDir, limit, size, outputRoot, selection, tasks, concurrency);
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
      return editImageViaResponsesOnce(worker.apiKey, [persona, product], task.prompt, size, task.outputDir, {
        resize,
        savePath: task.outputPath,
        rawLogPath: `${task.rawLogBasePath}.attempt${context.attempt}.sse.txt`,
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

  if (!singleOk || !retryableOk || !authFatalOk || !allFatalOk) {
    console.error("Worker pool self-test FAILED.");
    console.error(JSON.stringify({ singleReport, retryableReport, authFatalReport, allFatalReport }, null, 2));
    return 1;
  }

  console.log("");
  console.log("Worker pool self-test OK.");
  return 0;
}

async function runEditResponsesSelfTest() {
  console.log("Edit Responses self-test: payload shape and SSE extraction.");
  const sources = [
    {
      sourceName: "mock-a.png",
      sourceBuffer: Buffer.from("mock-source-a"),
      mimeType: "image/png",
      ext: "png",
      dataURL: "data:image/png;base64,bW9jay1zb3VyY2UtYQ==",
    },
    {
      sourceName: "mock-b.jpg",
      sourceBuffer: Buffer.from("mock-source-b"),
      mimeType: "image/jpeg",
      ext: "jpg",
      dataURL: "data:image/jpeg;base64,bW9jay1zb3VyY2UtYg==",
    },
  ];
  const payload = buildResponsesEditBody("mock edit prompt", "1152x2048", sources.map((item) => item.dataURL));
  const content = payload.input?.[0]?.content || [];
  const tool = payload.tools?.[0] || {};
  const payloadOk = payload.model === TEXT_MODEL
    && payload.stream === true
    && payload.store === false
    && content[0]?.type === "input_text"
    && content[1]?.type === "input_image"
    && content[1]?.image_url === sources[0].dataURL
    && content[2]?.type === "input_image"
    && content[2]?.image_url === sources[1].dataURL
    && tool.type === "image_generation"
    && tool.model === IMAGE_MODEL
    && tool.action === "edit"
    && tool.size === "1152x2048"
    && tool.output_format === "png"
    && tool.partial_images === 0
    && payload.tool_choice?.type === "image_generation";

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const raw = `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${pngB64}"}}\n`;
  const [base64] = extractImagesFromResponses(raw);
  const outputDir = resolveOutputDir(join(tmpdir(), "88api-image-gen-self-test"));
  const saved = saveBase64Image(base64, outputDir, "self_test_edit");
  const savedOk = !!saved?.path && existsSync(saved.path) && saved.width === 1 && saved.height === 1;

  if (!payloadOk || !savedOk) {
    console.error("Edit Responses self-test FAILED.");
    console.error(JSON.stringify({
      payloadOk,
      savedOk,
      saved,
    }, null, 2));
    return 1;
  }

  console.log("Edit Responses self-test OK.");
  console.log(`Saved: ${saved.path}`);
  return 0;
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const value = argv[i];
    if (value === "--get-config") args.flags.getConfig = true;
    else if (value === "--list-workers") args.flags.listWorkers = true;
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
    else if (value === "--ratio" && argv[i + 1]) args.flags.ratio = argv[++i];
    else if (value === "--aspect" && argv[i + 1]) args.flags.aspect = argv[++i];
    else if (value === "--size" && argv[i + 1]) args.flags.size = argv[++i];
    else if (value === "--count" && argv[i + 1]) args.flags.count = Number.parseInt(argv[++i], 10);
    else if (value === "--repeat" && argv[i + 1]) args.flags.repeat = Number.parseInt(argv[++i], 10);
    else if (value === "--limit" && argv[i + 1]) args.flags.limit = Number.parseInt(argv[++i], 10);
    else if (value === "--output-dir" && argv[i + 1]) args.flags.outputDir = argv[++i];
    else if (value === "--concurrency" && argv[i + 1]) args.flags.concurrency = Number.parseInt(argv[++i], 10);
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
      if (route && route !== "responses") args.flags.unsupportedEditRoute = `edit-api:${route}`;
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
    else if (value === "--self-test-edit-responses") args.flags.selfTestEditResponses = true;
    else if (value === "--self-test-workflow") args.flags.selfTestWorkflow = true;
    else if (value === "--help" || value === "-h") args.flags.help = true;
    i++;
  }
  return args;
}

function printUsage() {
  console.log(`88API-image-gen

CONFIG
  --get-config
  --list-workers
  --set-key <YOUR_88API_IMAGE_GROUP_KEY>
  --add-worker-key <ANOTHER_88API_IMAGE_GROUP_KEY> [--worker-name <name>]
  --set-worker-key <worker> <key>
  --remove-worker <worker>
  --enable-worker <worker>
  --disable-worker <worker>
  --set-quick-mode --ratio R --count 1..${MAX_GENERATION_COUNT}
  --set-batch-mode --ratio R --concurrency 1..${MAX_CONCURRENCY}

FIRST USE
  runtime: Node.js 18+ (Python is not required)
  create one or more image-generation group keys at https://88api.ai/
  recommended: one key/worker; add distinct keys only for concurrent independent images
  maximum: ${MAX_WORKERS} workers; multiple workers can use substantial memory and are not recommended on low-spec computers

GENERATE
  --prompt "..." [--ratio R|--aspect R] [--count 1..${MAX_GENERATION_COUNT}] [--no-resize]
  --prompt "..." --repeat 1..${MAX_REPEAT} [--concurrency 1..${MAX_CONCURRENCY}] [--adaptive|--no-adaptive]
  --batch prompts.json [--ratio R|--aspect R] [--concurrency N] [--no-resize]
  --batch-inline "prompt 1" "prompt 2" ... [--ratio R|--aspect R] [--concurrency N] [--no-resize]

EDIT
  --edit --image path.png --prompt "..." [--ratio R|--aspect R] [--count 1..${MAX_EDIT_COUNT}] [--concurrency N]
  --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R] [--count 1..${MAX_EDIT_COUNT}] [--concurrency N]    combine all sources in one Responses edit request
  --batch-edit --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R] [--concurrency N]
  image-to-image route is fixed to Responses API; --legacy-edit and --edit-api images are disabled

WORKFLOW BATCH EDIT
  --workflow-batch-edit --fixed-ref ref.png --item-dir dir --templates templates.json [--limit ${WORKFLOW_DEFAULT_LIMIT}] [--aspect R] [--concurrency 1..${MAX_CONCURRENCY}] [--repair-passes 0..5|--no-repair] [--dry-run]
  --workflow-batch-edit --fixed-ref ref.png --item-dir dir --template-inline "scene prompt" [--template-inline "..."] [--limit N]
  --workflow-batch-edit --fixed-ref persona.png --item-dir dir --preset ${WORKFLOW_NAIL_PRESET} [--limit N] [--aspect 9:16]
  templates JSON: array of strings/objects or { "templates": [{ "key": "scene", "prompt": "..." }] }

NAIL STRESS TEST
  --nail-stress-test --persona path.png --product-dir dir [--limit ${NAIL_STRESS_DEFAULT_LIMIT}] [--aspect 9:16] [--concurrency 1..${MAX_CONCURRENCY}] [--dry-run]

TOOLS
  --resolve-size --quality 2K --aspect 16:9
  --self-test-adaptive
  --self-test-workers
  --self-test-edit-responses
  --self-test-workflow

DEFAULTS
  API root: ${API_ROOT}
  responses text model: ${TEXT_MODEL}
  image model: ${IMAGE_MODEL}
  edit API: responses only
  request quality: fixed ${FIXED_REQUEST_QUALITY}
  output: ~/Pictures/88api-image-gen
  worker pool: enabled, one worker per task, auto parallel for independent tasks, max workers ${MAX_WORKERS}
  adaptive: on, concurrency ${DEFAULTS.concurrency}, retries ${MAX_RETRIES}, worker cooldown ${DEFAULT_WORKER_COOLDOWN_MS / 1000}s
  notice: ${API_SIZE_LIMIT_NOTICE}
  workflow batch edit: generic fixed refs + variable item refs + user templates, auto resume and repair passes
  nail stress test: compatibility preset for ${WORKFLOW_NAIL_PRESET}; do not assume product type in generic workflow

RATIOS
  ${supportedRatioText()}
  aliases: square=1:1, landscape=4:3, portrait=3:4
  disabled after repeated upstream 502 tests: 5:4, 4:5, 3:1, 1:3

SIZE MATRIX
  2K: 1:1 2048x2048, 3:2 2048x1360, 2:3 1360x2048, 4:3 2048x1536, 3:4 1536x2048, 16:9 2048x1152, 9:16 1152x2048, 2:1 2048x1024, 1:2 1024x2048, 7:4 2208x1264, 4:7 1264x2208
  --size WxH is disabled. Use only --ratio/--aspect from the fixed supported list above.`);
}

function resolveGenerationParams(flags, modeConfig) {
  const requestedQuality = flags.quality || modeConfig?.quality || DEFAULTS.quality;
  const quality = normalizeQuality(requestedQuality);
  if (shouldWarnFixedQuality(requestedQuality)) {
    console.warn(`NOTICE: 88API image generation is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${API_SIZE_LIMIT_NOTICE}`);
  }

  if (flags.size) {
    console.error(`ERROR: --size is disabled in this plugin. Use only --aspect/--ratio. Supported ratios: ${supportedRatioText()}. Disabled ratios: 5:4, 4:5, 3:1, 1:3.`);
    process.exit(1);
  }

  const requestedRatio = flags.aspect ?? flags.ratio ?? modeConfig?.ratio ?? DEFAULTS.ratio;
  let ratio = normalizeRatio(requestedRatio);
  if (isDisabledRatio(ratio)) {
    console.error(`ERROR: Ratio="${requestedRatio}" is disabled because repeated upstream tests returned 502 for 5:4, 4:5, 3:1, and 1:3. Use one of: ${supportedRatioText()}.`);
    process.exit(1);
  }
  const size = resolveSize(quality, ratio);
  if (!size) {
    console.error(`ERROR: Invalid ratio="${requestedRatio}". Supported ratios: ${supportedRatioText()}. Aliases: square, landscape, portrait.`);
    process.exit(1);
  }
  return { quality, ratio, size, explicitSize: false, requestedSize: flags.size || null };
}

async function main() {
  const { prompts, flags } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (flags.getConfig) {
    console.log(JSON.stringify(buildConfigSummary(config), null, 2));
    return;
  }

  if (flags.listWorkers) {
    printWorkerList(config);
    return;
  }

  if (flags.setKey) {
    const workers = getConfiguredWorkers(config);
    if (workers.length > 1) {
      console.error("ERROR: --set-key only works when zero or one worker is configured. Use --add-worker-key or --set-worker-key <worker> <key> for multi-worker setups.");
      process.exit(1);
    }
    if (workers.length === 0) {
      config.workers = [createWorkerRecord(flags.setKey, DEFAULT_WORKER_NAME, [])];
    } else {
      config.workers = config.workers.map((worker, index) => (index === 0
        ? { ...worker, apiKey: String(flags.setKey).trim() }
        : worker));
    }
    saveConfig(config);
    console.log(`88API worker saved: ${previewKey(flags.setKey)} (${config.workers[0].name})`);
    return;
  }

  if (flags.addWorkerKey) {
    const workers = getConfiguredWorkers(config);
    if (workers.length >= MAX_WORKERS) {
      console.error(`ERROR: Worker pool supports up to ${MAX_WORKERS} API workers. Remove or disable an existing worker before adding another one.`);
      process.exit(1);
    }
    const duplicate = findDuplicateWorkerKey(workers, flags.addWorkerKey);
    if (duplicate) {
      console.error(`ERROR: This API key is already configured on ${duplicate.name} [${duplicate.id}].`);
      process.exit(1);
    }
    const worker = createWorkerRecord(flags.addWorkerKey, flags.workerName, workers);
    config.workers = [...workers, worker];
    saveConfig(config);
    console.log(`Worker added: ${worker.name} [${worker.id}] key=${previewKey(worker.apiKey)}`);
    return;
  }

  if (flags.setWorkerKey) {
    const resolved = resolveWorkerReference(config, flags.setWorkerKey.worker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.setWorkerKey.worker}" was not found.`);
      process.exit(1);
    }
    const duplicate = findDuplicateWorkerKey(getConfiguredWorkers(config), flags.setWorkerKey.key, resolved.worker.id);
    if (duplicate) {
      console.error(`ERROR: This API key is already configured on ${duplicate.name} [${duplicate.id}].`);
      process.exit(1);
    }
    config.workers[resolved.index] = {
      ...config.workers[resolved.index],
      apiKey: String(flags.setWorkerKey.key).trim(),
    };
    saveConfig(config);
    console.log(`Worker key updated: ${resolved.worker.name} [${resolved.worker.id}] -> ${previewKey(flags.setWorkerKey.key)}`);
    return;
  }

  if (flags.removeWorker) {
    const resolved = resolveWorkerReference(config, flags.removeWorker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.removeWorker}" was not found.`);
      process.exit(1);
    }
    const removed = config.workers.splice(resolved.index, 1)[0];
    saveConfig(config);
    console.log(`Worker removed: ${removed.name} [${removed.id}]`);
    return;
  }

  if (flags.enableWorker) {
    const resolved = resolveWorkerReference(config, flags.enableWorker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.enableWorker}" was not found.`);
      process.exit(1);
    }
    config.workers[resolved.index] = { ...config.workers[resolved.index], enabled: true };
    saveConfig(config);
    console.log(`Worker enabled: ${resolved.worker.name} [${resolved.worker.id}]`);
    return;
  }

  if (flags.disableWorker) {
    const resolved = resolveWorkerReference(config, flags.disableWorker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.disableWorker}" was not found.`);
      process.exit(1);
    }
    config.workers[resolved.index] = { ...config.workers[resolved.index], enabled: false };
    saveConfig(config);
    console.log(`Worker disabled: ${resolved.worker.name} [${resolved.worker.id}]`);
    return;
  }

  if (flags.setQuickMode) {
    const previous = config.quickMode || {};
    const requestedQuality = flags.quality || previous.quality || DEFAULTS.quality;
    const quality = normalizeQuality(requestedQuality);
    if (shouldWarnFixedQuality(requestedQuality)) {
      console.warn(`NOTICE: Quick mode is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${API_SIZE_LIMIT_NOTICE}`);
    }
    const ratio = normalizeRatio(flags.aspect ?? flags.ratio ?? previous.ratio ?? DEFAULTS.ratio);
    const count = clampInteger(flags.count ?? previous.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
    const size = resolveSize(quality, ratio);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported ratios: ${supportedRatioText()}.`);
      process.exit(1);
    }
    config.quickMode = { quality, ratio, count };
    saveConfig(config);
    console.log(`Quick mode saved: ${quality}, ${ratioLabel(ratio)} (${size}), count ${count}`);
    return;
  }

  if (flags.setBatchMode) {
    const config = loadConfig() || {};
    const previous = config.batchMode || {};
    const requestedQuality = flags.quality || previous.quality || DEFAULTS.quality;
    const quality = normalizeQuality(requestedQuality);
    if (shouldWarnFixedQuality(requestedQuality)) {
      console.warn(`NOTICE: Batch mode is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${API_SIZE_LIMIT_NOTICE}`);
    }
    const ratio = normalizeRatio(flags.aspect ?? flags.ratio ?? previous.ratio ?? DEFAULTS.ratio);
    const concurrency = clampInteger(flags.concurrency ?? previous.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const size = resolveSize(quality, ratio);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported ratios: ${supportedRatioText()}.`);
      process.exit(1);
    }
    config.batchMode = { quality, ratio, concurrency };
    saveConfig(config);
    console.log(`Batch mode saved: ${quality}, ${ratioLabel(ratio)} (${size}), concurrency ${concurrency}`);
    return;
  }

  if (flags.resolveSize) {
    const { quality, ratio, size, explicitSize } = resolveGenerationParams(flags, config.quickMode);
    console.log(JSON.stringify({ quality, ratio, size, explicitSize }, null, 2));
    return;
  }

  if (flags.selfTestAdaptive) {
    process.exitCode = await runAdaptiveSelfTest();
    return;
  }

  if (flags.selfTestEditResponses) {
    process.exitCode = await runEditResponsesSelfTest();
    return;
  }

  if (flags.selfTestWorkflow) {
    process.exitCode = await runWorkflowSelfTest();
    return;
  }

  if (flags.help || (prompts.length === 0 && !flags.batchFile && !flags.edit && !flags.nailStressTest && !flags.workflowBatchEdit)) {
    printUsage();
    return;
  }

  if (isWorkerLimitExceeded(config)) {
    console.error(workerLimitErrorMessage(getConfiguredWorkers(config).length));
    process.exit(1);
  }

  const configuredWorkers = getConfiguredWorkers(config);
  if (configuredWorkers.filter((worker) => worker.enabled !== false).length === 0) {
    console.error("ERROR: No enabled 88API worker is configured. Create an image-generation group key at https://88api.ai/ and run --set-key <YOUR_88API_IMAGE_GROUP_KEY>. Start with one worker; multiple workers use more memory.");
    process.exit(1);
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
    const { ratio, size } = resolveGenerationParams({ ...flags, aspect: workflowAspect }, { quality: FIXED_REQUEST_QUALITY, ratio: workflowAspect });
    const limitExplicit = flags.limit != null;
    const limit = clampInteger(flags.limit, 1, 1000, WORKFLOW_DEFAULT_LIMIT);
    const concurrency = clampInteger(flags.concurrency ?? MAX_CONCURRENCY, 1, MAX_CONCURRENCY, Math.min(MAX_CONCURRENCY, DEFAULTS.concurrency));
    const repairPasses = clampInteger(flags.repairPasses, 0, 5, WORKFLOW_DEFAULT_REPAIR_PASSES);
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
    const { size } = resolveGenerationParams({ ...flags, aspect: "9:16" }, { quality: FIXED_REQUEST_QUALITY, ratio: "9:16" });
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
    if (images.length > MAX_EDIT_SOURCES) {
      console.error(`ERROR: Edit supports up to ${MAX_EDIT_SOURCES} source images.`);
      process.exit(1);
    }
    if (flags.unsupportedEditRoute) {
      console.error("ERROR: Image-to-image is fixed to Responses API with input_image blocks. --legacy-edit and --edit-api images are disabled in this plugin.");
      process.exit(1);
    }
    const { size } = resolveGenerationParams(flags, config.quickMode);
    if (images.length > 1 && flags.batchEdit) {
      const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
      process.exitCode = await runBatchEdit(configuredWorkers, images, prompts[0], size, concurrency, outputDir, {
        adaptive: flags.adaptive !== false,
        resize: flags.resize !== false,
      });
      return;
    }
    const count = clampInteger(flags.count, 1, MAX_EDIT_COUNT, 1);
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency ?? count, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const result = await editImage(configuredWorkers, images, prompts[0], size, outputDir, count, false, {
      adaptive: flags.adaptive !== false,
      concurrency,
      resize: flags.resize !== false,
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
  const { size } = resolveGenerationParams(flags, modeConfig);

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
    process.exit(await runBatch(configuredWorkers, batchPrompts.map(String), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
    }));
  }

  if (flags.batchInline) {
    if (prompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(configuredWorkers, prompts, size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
    }));
  }

  const prompt = prompts[0];
  const total = flags.repeat != null
    ? clampInteger(flags.repeat, 1, MAX_REPEAT, DEFAULTS.count)
    : clampInteger(flags.count ?? config.quickMode?.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
  if (total > 1) {
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(configuredWorkers, Array(total).fill(prompt), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      isVariation: true,
      resize: flags.resize !== false,
    }));
  }

  process.exit(await runBatch(configuredWorkers, [prompt], size, 1, outputDir, {
    adaptive: flags.adaptive !== false,
    resize: flags.resize !== false,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
