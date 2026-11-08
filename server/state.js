"use strict";

// 配置管理：server/state.json 持久化，白名单深合并 + 类型收敛（同家族约定）。

const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "state.json");

const MODEL_PROVIDERS = [
  { id: "custom", label: "自定义 / 本地（OpenAI 兼容）", endpoint: "" },
  { id: "local", label: "本地 llama-server", endpoint: "http://127.0.0.1:8080" },
  { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com/v1" },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1" },
  { id: "siliconflow", label: "SiliconFlow 硅基流动", endpoint: "https://api.siliconflow.cn/v1" },
  { id: "zhipu", label: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "moonshot", label: "Moonshot Kimi", endpoint: "https://api.moonshot.cn/v1" },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1" },
  { id: "modelscope", label: "ModelScope", endpoint: "https://api-inference.modelscope.cn/v1" },
];

const DEFAULT_SETTINGS = {
  root: "", // 文件夹模式：扫描根目录（递归查找 .jsonl）
  batchSize: 12, // L1 每批题数
  concurrency: 2, // LLM 并发
  lowConf: 0.6, // 低于此值 → 仲裁/人审
  useJudge: true, // 低置信/冲突时启用 judge 模型仲裁
  evalLow: 3, // 低分阈值（0~5 制）
  maxSubjects: 3, // 每题学科标签上限（多标签；下限固定 1）
  autoSchema: true, // 分类前自动结构探测（程序 → 置信不足时 LLM 仲裁）
  taxonomyPath: "", // 空 = presets/taxonomy.json
  contentTypesPath: "", // 空 = presets/content-types.json
  models: {
    primary: {
      name: "主分类模型",
      provider: "local",
      endpoint: "http://127.0.0.1:8080/v1",
      apiKey: "",
      modelId: "",
      temperature: 0,
      maxTokens: 4096,
    },
    judge: {
      name: "仲裁模型（可选，低置信/冲突时单题重判）",
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/v1",
      apiKey: "",
      modelId: "",
      temperature: 0,
      maxTokens: 1024,
    },
  },
};

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    /* 无文件用默认 */
  }
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), saved);
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in base)) continue; // 白名单：忽略未知键
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (typeof v === typeof base[k] || base[k] === null || base[k] === undefined) {
      base[k] = v;
    }
  }
  return base;
}

module.exports = { loadState, saveState, DEFAULT_SETTINGS, MODEL_PROVIDERS, STATE_PATH };
