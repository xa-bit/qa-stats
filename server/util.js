"use strict";

// 通用工具：并发、sleep、hash、截断、无依赖 HTTP 请求（沿用家族 md-clean / q-a-factual 约定）

/** 并行处理数组，限制并发数。借用自 easy-dataset lib/util/async.js（processInParallel）。 */
const processInParallel = async (items, processFunction, concurrencyLimit, onProgress) => {
  const results = [];
  const inProgress = new Set();
  const queue = [...items];
  let completedCount = 0;

  while (queue.length > 0 || inProgress.size > 0) {
    while (inProgress.size < concurrencyLimit && queue.length > 0) {
      const item = queue.shift();
      const promise = processFunction(item).then((result) => {
        inProgress.delete(promise);
        onProgress && onProgress(++completedCount, items.length);
        return result;
      });
      inProgress.add(promise);
      results.push(promise);
    }
    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }
  return Promise.all(results);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nowIso = () => new Date().toISOString();

const clip = (s, n = 200) => {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + `…(${str.length} chars)` : str;
};

/** sha256 十六进制（缓存键用） */
function sha256(text) {
  return require("crypto").createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** 原子写 JSON：临时文件 + rename（家族 base.js 约定） */
function writeJsonAtomic(file, data) {
  const fs = require("fs");
  const path = require("path");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 带超时的原始 HTTP 请求（基于全局 fetch，Node >= 18） */
async function fetchRaw(url, { method = "GET", headers = {}, body, timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

/** JSON 请求便捷封装。body 为对象时自动序列化。 */
async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 120000 } = {}) {
  const finalHeaders = { ...headers };
  let payload = body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
    finalHeaders["content-type"] = "application/json";
  }
  const res = await fetchRaw(url, { method, headers: finalHeaders, body: payload, timeoutMs });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* 非 JSON 响应，保持 null */
  }
  return { status: res.status, ok: res.ok, json, text: res.text };
}

/** 简易模板替换：{{key}} */
function fillTemplate(template, params) {
  let out = String(template || "");
  for (const [k, v] of Object.entries(params || {})) {
    out = out.split("{{" + k + "}}").join(String(v ?? ""));
  }
  return out;
}

module.exports = { processInParallel, sleep, nowIso, clip, sha256, writeJsonAtomic, fetchRaw, requestJson, fillTemplate };
