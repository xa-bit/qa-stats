"use strict";

/**
 * 输入载入与统一行模型（unify）。
 *
 * v1.1：不再假设字段名已知——支持三种来源的列映射（优先级从高到低）：
 * 1. schema 探测旁挂（server/schema.js 产物，role → 实际字段名，可 LLM 仲裁）；
 * 2. 家族双 schema 识别（factual/research 轨的已知字段别名）；
 * 3. 兜底别名表 COLUMNS。
 * flow 识别相应放宽：无法识别为家族两轨时标 generic（统计按维度自动降级）。
 * 未映射的文本字段进入 row.extra（长度统计不丢失），不猜语义。
 */

const fs = require("fs");
const path = require("path");

const QA_SUFFIX = "-qa.jsonl";

/** 内部统一行使用的列名 → 上游可能的名字（首个命中生效；大小写不敏感） */
const COLUMNS = {
  id: ["id", "qaId"],
  question: ["question", "q"],
  answer: ["answer", "a"],
  reasoning: ["reasoning", "cot"],
  reasoningRaw: ["reasoningRaw", "cotRaw"],
  finishReason: ["finishReason", "finish_reason"],
  label: ["label", "sectionRole"],
  gaPair: ["gaPair", "ga"],
  track: ["track"],
  chunkIndex: ["chunkIndex"],
  chunkName: ["chunkName", "chunk"],
  model: ["model", "modelName"],
  references: ["references", "refs"],
  qCheck: ["qCheck", "check"],
  eval: ["eval", "evaluation", "score"],
};

const ROLE_KEYS = Object.keys(COLUMNS);

function pick(row, names) {
  for (const n of names) {
    if (row && row[n] !== undefined && row[n] !== null) return row[n];
    // 大小写不敏感兜底
    const lower = n.toLowerCase();
    for (const k of Object.keys(row || {})) {
      if (k.toLowerCase() === lower && row[k] !== undefined && row[k] !== null) return row[k];
    }
  }
  return null;
}

/** schema 映射（role → 实际字段名）→ 优先列名表（实际字段名在前，家族别名兜底） */
function columnsWithSchema(schema) {
  if (!schema || !schema.mapping || typeof schema.mapping !== "object") return COLUMNS;
  const out = {};
  for (const role of ROLE_KEYS) {
    const mapped = schema.mapping[role];
    out[role] = mapped && typeof mapped === "string" ? [mapped, ...COLUMNS[role]] : COLUMNS[role];
  }
  return out;
}

/** 从文件名推断 stem：xxx-qa.jsonl → xxx */
function stemOf(filePath) {
  const base = path.basename(String(filePath));
  return base.endsWith(QA_SUFFIX) ? base.slice(0, -QA_SUFFIX.length) : base.replace(/\.jsonl$/i, "");
}

/**
 * eval 字段形态不定（数字 / {score, ...} / {overall} 等），统一抽成 0~maxScore 的分数。
 * 无法识别返回 null。
 */
function extractEvalScore(evalField) {
  if (evalField === null || evalField === undefined) return null;
  if (typeof evalField === "number" && Number.isFinite(evalField)) return evalField;
  if (typeof evalField === "string") {
    const n = Number(evalField);
    if (Number.isFinite(n)) return n;
    return null;
  }
  if (typeof evalField === "object") {
    for (const key of ["score", "overall", "total", "avg", "average", "rating", "final"]) {
      const v = evalField[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

/**
 * qCheck 子项形态不定（true/false、"yes"/"no"、数值），统一抽成布尔（或 null 未知）。
 * 返回 {子键: bool|null, passed: bool|null}，passed = 全部已知子项为 true。
 */
function extractQCheck(qCheckField) {
  const out = { items: {}, passed: null };
  if (!qCheckField || typeof qCheckField !== "object") return out;
  let known = 0;
  let passedCnt = 0;
  for (const [k, v] of Object.entries(qCheckField)) {
    if (typeof v === "boolean") {
      out.items[k] = v;
      known++;
      if (v) passedCnt++;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out.items[k] = v > 0;
      known++;
      if (v > 0) passedCnt++;
    } else if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["yes", "true", "pass", "passed", "ok"].includes(s)) {
        out.items[k] = true; known++; passedCnt++;
      } else if (["no", "false", "fail", "failed"].includes(s)) {
        out.items[k] = false; known++;
      } else {
        out.items[k] = null;
      }
    }
  }
  if (known > 0) out.passed = passedCnt === known;
  return out;
}

/** 未映射的字符串字段 → extra（只记名字与内容，长度统计用；不猜语义） */
function extractExtra(raw, columns) {
  const used = new Set();
  for (const names of Object.values(columns)) {
    for (const n of names) {
      used.add(n);
      used.add(n.toLowerCase());
    }
  }
  const extra = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (used.has(k) || used.has(k.toLowerCase())) continue;
    if (typeof v === "string") extra[k] = v;
    else if (v !== null && v !== undefined && typeof v === "object") extra[k] = JSON.stringify(v).slice(0, 2000);
  }
  return Object.keys(extra).length ? extra : null;
}

/** 单行 → 统一行模型；columns 为 role→候选名表（schema 优先） */
function unifyRow(raw, stem, flow, columns) {
  const col = columns || COLUMNS;
  const references = pick(raw, col.references);
  const evalField = pick(raw, col.eval);
  return {
    id: String(pick(raw, col.id) ?? ""),
    stem,
    flow,
    question: String(pick(raw, col.question) ?? ""),
    answer: String(pick(raw, col.answer) ?? ""),
    reasoning: pick(raw, col.reasoning) === null ? null : String(pick(raw, col.reasoning)),
    reasoningRaw: pick(raw, col.reasoningRaw) === null ? null : String(pick(raw, col.reasoningRaw)),
    finishReason: pick(raw, col.finishReason) === null ? null : String(pick(raw, col.finishReason)),
    label: pick(raw, col.label) === null ? null : String(pick(raw, col.label)),
    gaPair: pick(raw, col.gaPair) === null ? null : String(pick(raw, col.gaPair)),
    track: pick(raw, col.track) === null ? null : String(pick(raw, col.track)),
    chunkIndex: pick(raw, col.chunkIndex),
    chunkName: pick(raw, col.chunkName) === null ? null : String(pick(raw, col.chunkName)),
    model: pick(raw, col.model) === null ? null : String(pick(raw, col.model)),
    references: Array.isArray(references) ? references : null,
    qCheck: extractQCheck(pick(raw, col.qCheck)),
    evalScore: extractEvalScore(evalField),
    extra: extractExtra(raw, col),
  };
}

/**
 * flow 识别（家族优先，未知 → generic）：
 * - factual：含 reasoning/reasoningRaw 或 track；
 * - research：含 references（且无 reasoning）；
 * - generic：其余（字段未知的通用 QA 语料）。
 */
function detectFlow(raws, columns) {
  const col = columns || COLUMNS;
  const sample = raws.slice(0, 50);
  const hasReasoning = sample.some((r) => pick(r, col.reasoning) !== null || pick(r, col.reasoningRaw) !== null);
  const hasTrack = sample.some((r) => pick(r, col.track) !== null);
  const hasRefs = sample.some((r) => pick(r, col.references) !== null);
  if (hasReasoning || hasTrack) return "factual";
  if (hasRefs) return "research";
  return "generic";
}

/**
 * 读取一个 jsonl：逐行 JSON.parse（坏行跳过并计数），产出统一行。
 * opts.schema：结构探测结果（role → 字段名映射）；无则用家族别名兜底。
 * 返回 {path, stem, flow, rows, badLines, schema}。
 */
function loadQaFile(filePath, opts = {}) {
  const text = fs.readFileSync(filePath, "utf8");
  const stem = stemOf(filePath);
  const schema = opts.schema || null;
  const columns = columnsWithSchema(schema);
  const raws = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      raws.push(JSON.parse(t));
    } catch {
      badLines++;
    }
  }
  const flow = detectFlow(raws, columns);
  const rows = raws.map((r) => unifyRow(r, stem, flow, columns));
  return { path: filePath, stem, flow, rows, badLines, schema };
}

module.exports = {
  loadQaFile, unifyRow, stemOf, pick, COLUMNS, columnsWithSchema, detectFlow,
  extractExtra, extractEvalScore, extractQCheck, QA_SUFFIX, ROLE_KEYS,
};
