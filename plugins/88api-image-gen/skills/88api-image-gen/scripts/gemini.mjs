// Gemini image models over OpenAI Chat Completions (ported from 88API-Nano-Banana).
//
// The image comes back inside choices[0].message.content as a Markdown data URI
// that can be tens of MB, so the request uses a direct HTTPS/1.1 call with
// identity encoding, a bounded response buffer and no streaming.

import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = 96 * 1024 * 1024;
const MAX_TEXT_SUMMARY_CHARS = 4000;
const NO_AUTO_RETRY_PREFIX = "[NO-AUTO-RETRY]";
const HTTPS_AGENT = new HttpsAgent({ keepAlive: true, maxSockets: 10 });

export function buildGeminiChatBody(model, prompt, plan, references = [], { redactImageData = false } = {}) {
  const text = [prompt.trim(), plan?.promptSuffix].filter(Boolean).join(" ");
  const content = references.length === 0
    ? text
    : [
      { type: "text", text },
      ...references.map((reference) => ({
        type: "image_url",
        image_url: {
          url: reference.url
            || `data:${reference.mimeType};base64,${redactImageData ? `<${reference.sourceBuffer.length} bytes omitted>` : reference.sourceBuffer.toString("base64")}`,
        },
      })),
    ];
  const body = { model, messages: [{ role: "user", content }] };
  // Must be snake_case under extra_body.google; top-level image_config is ignored.
  if (plan?.imageConfig && Object.keys(plan.imageConfig).length > 0) {
    body.extra_body = { google: { image_config: plan.imageConfig } };
  }
  return body;
}

function normalizeMime(mimeType) {
  const value = String(mimeType || "image/png").toLowerCase();
  if (value.includes("jpeg") || value.includes("jpg")) return "image/jpeg";
  if (value.includes("webp")) return "image/webp";
  if (value.includes("gif")) return "image/gif";
  return "image/png";
}

function isBase64Character(code) {
  return (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57)
    || code === 43 || code === 47 || code === 61 || code === 45 || code === 95;
}

function isBase64Whitespace(code) {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

// Finds data:image/...;base64, runs without building giant regex matches.
function scanDataUrls(text) {
  const ranges = [];
  const pattern = /data:(image\/(?:png|jpe?g|webp|gif))(?:;[a-z0-9._-]+=[^;,\s]+)*;base64,/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const dataStart = pattern.lastIndex;
    let end = dataStart;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (!isBase64Character(code) && !isBase64Whitespace(code)) break;
      end += 1;
    }
    const length = end - dataStart;
    if (length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error(`${NO_AUTO_RETRY_PREFIX} A text-embedded image in the response exceeds the ${MAX_IMAGE_BASE64_CHARS}-character safety limit`);
    }
    if (length > 0) ranges.push({ start: match.index, dataStart, end, mimeType: match[1], data: text.slice(dataStart, end) });
    pattern.lastIndex = Math.max(end, pattern.lastIndex);
  }
  return ranges;
}

function summarizeText(text, ranges, limit = MAX_TEXT_SUMMARY_CHARS) {
  const chunks = [];
  let used = 0;
  let cursor = 0;
  const append = (value) => {
    if (used >= limit) return;
    const fragment = value.slice(0, limit - used);
    chunks.push(fragment);
    used += fragment.length;
  };
  for (const range of ranges) {
    append(text.slice(cursor, range.start));
    append(`[image Base64 omitted: ${range.end - range.dataStart} characters]`);
    cursor = range.end;
    if (used >= limit) break;
  }
  if (used < limit) append(text.slice(cursor));
  return chunks.join("").trim();
}

function collectImages(value, result, seen = new Set(), context = { image: false, key: "" }) {
  if (typeof value === "string") {
    const ranges = scanDataUrls(value);
    for (const range of ranges) result.images.push({ type: "base64", data: range.data, mimeType: normalizeMime(range.mimeType) });
    for (const match of value.matchAll(/!\[[^\]\r\n]{0,512}\]\((https?:\/\/[^)\s]+)\)/gi)) {
      result.images.push({ type: "url", url: match[1] });
    }
    if (context.image && (context.key === "url" || context.key === "content") && /^https?:\/\/\S+$/i.test(value)) {
      result.images.push({ type: "url", url: value });
    }
    const summary = summarizeText(value, ranges);
    if (summary) result.text.push(summary);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const mimeHint = String(value.mime_type || value.mimeType || "");
  const imageContext = context.image
    || /image/i.test(String(value.type || ""))
    || /^image\//i.test(mimeHint)
    || Object.keys(value).some((key) => /image/i.test(key));
  for (const [key, child] of Object.entries(value)) {
    if ((key === "b64_json" || key === "base64" || key === "data") && imageContext && typeof child === "string") {
      if (child.length > MAX_IMAGE_BASE64_CHARS) {
        throw new Error(`${NO_AUTO_RETRY_PREFIX} A Base64 image in the response exceeds the ${MAX_IMAGE_BASE64_CHARS}-character safety limit`);
      }
      result.images.push({ type: "base64", data: child, mimeType: normalizeMime(mimeHint) });
    } else if (key !== "b64_json" && key !== "base64") {
      collectImages(child, result, seen, { image: imageContext || /image/i.test(key), key: key.toLowerCase() });
    }
  }
}

// Returns the final image of a Chat Completions response. Embedded Base64 wins
// over links: some upstreams append their own storage URL after the image.
export function parseGeminiChatResponse(body) {
  const found = { images: [], text: [] };
  const seen = new Set();
  for (const choice of Array.isArray(body?.choices) ? body.choices : []) {
    if (choice?.message) collectImages(choice.message, found, seen, { image: true, key: "message" });
  }
  collectImages(body, found, seen);
  const base64 = found.images.filter((image) => image.type === "base64");
  const pick = (base64.length ? base64 : found.images).at(-1);
  return { image: pick || null, text: [...new Set(found.text)].join("\n").slice(0, MAX_TEXT_SUMMARY_CHARS) };
}

export function decodeBase64Image(data) {
  const normalized = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error(`${NO_AUTO_RETRY_PREFIX} The API returned invalid Base64 image data`);
  return Buffer.from(normalized, "base64");
}

function errorDetail(error) {
  const parts = [error?.message || String(error)];
  if (error?.code) parts.push(error.code);
  if (error?.cause?.code) parts.push(error.cause.code);
  return [...new Set(parts.filter(Boolean))].join(" | ");
}

// POSTs JSON and buffers the reply. On failure error.stage says how far the
// request got: not-sent (no connection, nothing billed), submit (sent, no
// response yet) or read-result (response started, body failed).
export function postJsonOverHttps(url, body, apiKey, { timeoutMs, userAgent, maxBytes = MAX_RESPONSE_BYTES, onResponse = null } = {}) {
  const payload = JSON.stringify(body);
  let connected = false;
  let httpStatus = 0;
  return new Promise((resolvePromise, rawReject) => {
    const rejectPromise = (error) => {
      const tagged = error instanceof Error ? error : new Error(String(error));
      tagged.stage ||= !connected ? "not-sent" : (httpStatus ? "read-result" : "submit");
      tagged.httpStatus ||= httpStatus || null;
      rawReject(tagged);
    };
    const request = httpsRequest(new URL(url), {
      method: "POST",
      agent: HTTPS_AGENT,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        accept: "application/json",
        "accept-encoding": "identity",
        connection: "keep-alive",
        "user-agent": userAgent,
      },
    }, (response) => {
      httpStatus = response.statusCode || 0;
      onResponse?.(httpStatus);
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new Error(`${NO_AUTO_RETRY_PREFIX} response body exceeds the ${maxBytes}-byte safety limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolvePromise({ status: httpStatus, raw: Buffer.concat(chunks, total).toString("utf8") }));
      response.on("aborted", () => rejectPromise(new Error("the server closed the response before it finished")));
      response.on("error", rejectPromise);
    });
    request.on("socket", (socket) => {
      // A reused keep-alive socket is already connected; a new one counts once TLS is up.
      if (!socket.connecting) connected = true;
      else socket.once("secureConnect", () => { connected = true; });
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`);
      error.name = "AbortError";
      request.destroy(error);
    });
    request.on("error", rejectPromise);
    request.end(payload);
  });
}

// Same stage wording as the Images API path, so the Agent rules apply unchanged.
export function geminiStageError(label, error) {
  const message = String(error?.message || error || "");
  if (message.startsWith(NO_AUTO_RETRY_PREFIX)) return message;
  const detail = errorDetail(error);
  if (error?.stage === "not-sent") return `${label} request was not sent: could not connect to 88API (${detail}); no charge was made`;
  if (error?.stage === "read-result") {
    return `${NO_AUTO_RETRY_PREFIX} ${label} request completed and was billed, but reading the result failed (stage: read-result): ${detail}`;
  }
  return `${NO_AUTO_RETRY_PREFIX} ${label} request state is unknown (stage: submit): ${detail}`;
}

export function safeErrorText(raw) {
  let value = raw;
  try {
    const parsed = JSON.parse(raw);
    value = parsed?.error?.message || parsed?.message || raw;
  } catch {
    // not JSON: keep the raw text
  }
  value = String(value || "");
  return summarizeText(value, scanDataUrls(value), 2000);
}
