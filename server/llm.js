"use strict";

/**
 * 最小 OpenAI 兼容聊天客户端（直连，不经过任何中间服务）。
 * 与家族 q-a-factual/server/llm.js 同款约定：endpoint 归一化、/v1 自动补试、
 * usage/finishReason/reasoning_content 提取。分类调用温度固定 0（可覆盖）。
 */

const { requestJson, clip } = require("./util");

function normalizeEndpoint(endpoint) {
  return String(endpoint || "").replace(/:\/\/0\.0\.0\.0(:\d+)?/, "://127.0.0.1$1");
}

function chatUrls(endpoint) {
  const base = normalizeEndpoint(endpoint).replace(/\/+$/, "");
  const urls = [`${base}/chat/completions`];
  if (!/\/v\d$/.test(base)) urls.push(`${base}/v1/chat/completions`);
  return urls;
}

function modelsUrls(endpoint) {
  const base = normalizeEndpoint(endpoint).replace(/\/+$/, "");
  const urls = [`${base}/models`];
  if (!/\/v\d$/.test(base)) urls.push(`${base}/v1/models`);
  return urls;
}

function parseModelList(payload) {
  const arr = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.data)
      ? payload.data
      : payload && Array.isArray(payload.models)
        ? payload.models
        : null;
  if (!arr) return null;
  const models = [];
  for (const m of arr) {
    const id = String(typeof m === "string" ? m : m && (m.id || m.model || m.name) || "").trim();
    if (id && !models.includes(id)) models.push(id);
  }
  return models;
}

/** 扫描 endpoint 上的可用模型 ID（GET /models）。失败不抛错，返回 {ok:false, detail}。 */
async function listModels(cfg) {
  const base = String((cfg && cfg.endpoint) || "").trim();
  if (!base) return { ok: false, models: [], detail: "未填写接口地址" };
  const headers = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  let lastErr = null;
  for (const url of modelsUrls(base)) {
    try {
      const res = await requestJson(url, { method: "GET", headers, timeoutMs: 15000 });
      if (res.status === 404 || res.status === 405) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}: ${clip(res.text, 120)}`);
        continue;
      }
      const models = parseModelList(res.json);
      if (!models) {
        lastErr = new Error(`无法识别的响应: ${clip(res.text, 120)}`);
        continue;
      }
      return { ok: true, models, detail: `${models.length} 个模型` };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, models: [], detail: lastErr?.message || "连接失败" };
}

/** 发一条极小消息验证模型可用，返回 {ok, detail, latencyMs} */
async function testModel(cfg) {
  const started = Date.now();
  const res = await chat(cfg, [
    { role: "user", content: "Reply with exactly: ok" },
  ], { maxTokens: 16, timeoutMs: 30000 });
  if (res.ok) return { ok: true, detail: `连接成功（${Date.now() - started}ms）：${clip(res.content, 60)}`, latencyMs: Date.now() - started };
  return { ok: false, detail: res.error || "连接失败" };
}

function extractContent(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!msg) return "";
  return String(msg.content || msg.reasoning_content || "").trim();
}

function extractUsage(json) {
  const u = json && json.usage;
  if (!u) return null;
  const promptTokens = Number(u.prompt_tokens) || 0;
  const completionTokens = Number(u.completion_tokens) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(u.total_tokens) || promptTokens + completionTokens,
  };
}

/**
 * 聊天补全。返回 {ok, content, finishReason, usage, error}——不抛错，失败置 ok:false。
 * 每次调用耗时与 usage 通过 onUsage 回调上报（easy-dataset monitoring 同款记账思路）。
 */
async function chat(cfg, messages, { temperature = 0, maxTokens = 2048, timeoutMs = 180000, onUsage, label = "" } = {}) {
  if (!cfg || !cfg.endpoint || !cfg.modelId) {
    return { ok: false, content: "", finishReason: null, usage: null, error: "模型未配置（接口地址 / 模型 ID 缺失）" };
  }
  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.modelId,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  const started = Date.now();
  let lastErr = null;
  for (const url of chatUrls(cfg.endpoint)) {
    try {
      const res = await requestJson(url, { method: "POST", headers, body, timeoutMs });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${clip(res.text, 160)}`;
        continue;
      }
      const json = res.json;
      if (!json || !json.choices || !json.choices.length) {
        lastErr = `响应缺少 choices: ${clip(res.text, 160)}`;
        continue;
      }
      const usage = extractUsage(json);
      onUsage && onUsage({ label, ok: true, latencyMs: Date.now() - started, usage });
      return {
        ok: true,
        content: extractContent(json),
        finishReason: json.choices[0].finish_reason || null,
        usage,
        error: null,
      };
    } catch (e) {
      lastErr = e && e.name === "AbortError" ? "请求超时" : (e && e.message) || String(e);
    }
  }
  onUsage && onUsage({ label, ok: false, latencyMs: Date.now() - started, usage: null });
  return { ok: false, content: "", finishReason: null, usage: null, error: lastErr || "连接失败" };
}

module.exports = { listModels, testModel, chat };
