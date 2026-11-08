"use strict";

/**
 * JSONL 结构探测（v1.1 新增）。
 *
 * 目标：在「QA 文件只有 q/a 两部分、其余成分未知、字段名未知」的假设下工作——
 * 扫描 jsonl 每行对象的结构（字段名并集 + 值形态统计），先用程序启发式把字段
 * 映射到内部角色（question / answer / reasoning / …），置信不足时借助 LLM 判断。
 * 结果旁挂为 <stem>-schema.json（不动原文件），可人工查看 / 修改 / 强制重探测。
 *
 * 探测分层：
 * - L-alias 别名词典：常见命名（query/response/thinking/…）直接命中，置信 0.95；
 * - L-feature 特征打分：问句标志（?/疑问词）、长度、段落、推导连接词、唯一率；
 * - L-llm 兜底：question/answer 仍缺或低置信时，把字段名 + 统计 + 样本发给 LLM 判角色。
 */

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic, clip, sha256 } = require("./util");
const { extractJsonFromLLMOutput } = require("./llm-util");

const SCHEMA_VERSION = 1;
const MIN_CONF = 0.75; // question/answer 任一低于此 → 需要 LLM 仲裁
const SAMPLE_LINES = 80; // 结构探测抽样行数（结构远比内容稳定）

/** 内部角色全集（与 loader 统一行模型的列一致） */
const ROLES = [
  "id", "question", "answer", "reasoning", "reasoningRaw", "finishReason", "label",
  "gaPair", "track", "chunkIndex", "chunkName", "model", "references", "qCheck", "eval",
];
const LLM_ROLES = [...ROLES, "other"]; // LLM 可给的额外角色

/** 角色别名词典（归一小写后精确匹配；程序探测第一优先级） */
const ROLE_ALIASES = {
  question: ["question", "q", "query", "prompt", "problem", "questiontext", "ques", "ask", "interrogation", "questionbody", "inputtext", "题面", "问题"],
  answer: ["answer", "a", "response", "resp", "output", "reply", "answertext", "ans", "solution", "finalanswer", "modelanswer", "assistant", "回答", "答案"],
  reasoning: ["reasoning", "cot", "chainofthought", "chainofthought", "thinking", "thought", "thoughts", "rationale", "analysis", "think", "reasoningcontent", "reasoningchain", "reasoningtext", "reflection", "deduction", "推导", "思考"],
  reasoningRaw: ["reasoningraw", "rawreasoning", "cotraw", "reasoningraw", "thinkingraw", "rawthoughts", "rawthinking"],
  id: ["id", "qaid", "qid", "uid", "uuid", "no", "num", "number", "index", "idx"],
  finishReason: ["finishreason", "stopreason", "endreason", "finishcause"],
  label: ["label", "sectionrole", "tag", "category", "class", "kind"],
  gaPair: ["gapair", "ga", "angle", "perspective", "questiontype", "qtype"],
  track: ["track", "lane", "route", "subset"],
  chunkIndex: ["chunkindex", "chunkidx", "blockindex", "blockidx", "seq", "seqno"],
  chunkName: ["chunkname", "chunk", "section", "sectionname", "source", "sourcename", "doc", "docname", "chapter", "chaptername", "title", "章节"],
  model: ["model", "modelname", "modelid", "llm", "generator", "engine"],
  references: ["references", "refs", "citations", "sources", "evidence", "ref", "引用"],
  qCheck: ["qcheck", "check", "questioncheck", "qcheckresult", "qacheck"],
  eval: ["eval", "evaluation", "score", "rating", "quality", "assessment", "grade"],
};
const ALIAS_TO_ROLE = (() => {
  const m = new Map();
  for (const [role, names] of Object.entries(ROLE_ALIASES)) {
    for (const n of names) if (!m.has(n)) m.set(n, role); // 先到先得：question/answer 优先
  }
  return m;
})();

// ---------- 字段统计 ----------

const Q_WORD_RE = /^(what|why|how|which|when|where|who|whom|whose|whether|is|are|can|could|does|do|did|should|would|will|explain|describe|derive|calculate|compute|compare|discuss|state|define|list)\b/i;
const Q_ZH_RE = /^(什么|为什么|怎么|怎样|如何|哪些|哪个|何|是否|请|试|已知|给出|简述|论述|推导|计算|比较|解释|说明)/;
const THINK_MARK_RE = /<think|首先|其次|然后|因此|所以|由此|逐步|推导过程|我们来|let me|we need|we should|step \d|to (determine|answer|solve|verify)|first,|next,|finally,|in summary|综上/i;

function statsField(values) {
  const n = values.length;
  let strings = 0, numbers = 0, booleans = 0, objects = 0, arrays = 0, nulls = 0;
  const strLens = [];
  let qMark = 0, qWord = 0, thinkMark = 0, paras = 0;
  const samples = [];
  for (const v of values) {
    if (v === null || v === undefined) { nulls++; continue; }
    if (typeof v === "number") { numbers++; continue; }
    if (typeof v === "boolean") { booleans++; continue; }
    if (Array.isArray(v)) { arrays++; if (samples.length < 2 && v.length) samples.push(clip(JSON.stringify(v), 160)); continue; }
    if (typeof v === "object") { objects++; if (samples.length < 2) samples.push(clip(JSON.stringify(v), 160)); continue; }
    const s = String(v);
    strings++;
    strLens.push(s.length);
    if (/\?|？/.test(s)) qMark++;
    if (Q_WORD_RE.test(s.trim()) || Q_ZH_RE.test(s.trim()) || /[吗呢]$/.test(s.trim())) qWord++;
    if (THINK_MARK_RE.test(s)) thinkMark++;
    if (/\n\s*\n/.test(s)) paras++;
    if (samples.length < 2) samples.push(clip(s, 160));
  }
  strLens.sort((a, b) => a - b);
  const solid = n - nulls;
  const rate = (c) => (solid > 0 ? Number((c / solid).toFixed(3)) : 0);
  const med = strLens.length ? strLens[Math.floor(strLens.length / 2)] : 0;
  return {
    present: solid,
    kind: solid === 0 ? "empty" : numbers / solid >= 0.9 ? "number" : booleans / solid >= 0.9 ? "boolean"
      : arrays / solid >= 0.9 ? "array" : objects / solid >= 0.9 ? "object"
        : strings / solid >= 0.5 ? "text" : "mixed",
    stringRate: rate(strings),
    medLen: med,
    maxLen: strLens.length ? strLens[strLens.length - 1] : 0,
    qMarkRate: rate(qMark),
    qWordRate: rate(qWord),
    thinkRate: rate(thinkMark),
    paraRate: rate(paras),
    distinct: new Set(values.filter((v) => v !== null && v !== undefined).map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))).size,
    samples,
  };
}

/** 程序特征打分：字段 → 各候选角色得分（0~1）。仅对文本型字段有意义。 */
function featureScores(st) {
  const scores = {};
  if (st.kind !== "text" || st.stringRate < 0.6) {
    // 非文本字段按角色常识给弱分
    if (st.kind === "number") {
      scores.id = st.medLen <= 8 && st.distinct >= st.present * 0.9 ? 0.45 : 0;
      scores.chunkIndex = 0.35;
      scores.eval = 0.2;
    } else if (st.kind === "array") {
      scores.references = 0.4;
    } else if (st.kind === "object") {
      scores.qCheck = 0.3;
      scores.eval = 0.3;
    }
    return scores;
  }
  const shortish = st.medLen > 0 && st.medLen <= 400 ? 1 : st.medLen <= 800 ? 0.5 : 0;
  const longish = st.medLen >= 200 ? 1 : st.medLen >= 100 ? 0.6 : 0.2;
  // question：短 + 问句标志
  scores.question = Math.min(1,
    0.25 * shortish +
    0.4 * Math.max(st.qMarkRate, st.qWordRate) +
    0.15 * (st.paraRate < 0.3 ? 1 : 0) +
    (st.medLen > 0 && st.medLen < 250 ? 0.15 : 0)
  );
  // answer：长文本、少问号、不一定是推导体
  scores.answer = Math.min(1,
    0.4 * longish +
    0.2 * (st.qMarkRate < 0.2 ? 1 : 0) +
    0.2 * (st.paraRate > 0.05 ? 1 : 0.4) +
    0.2 * (st.thinkRate < 0.6 ? 1 : 0)
  );
  // reasoning：长 + 推导连接词密度
  scores.reasoning = Math.min(1,
    0.35 * longish +
    0.45 * st.thinkRate +
    0.1 * (st.qMarkRate < 0.1 ? 1 : 0)
  );
  return scores;
}

// ---------- 程序探测 ----------

/**
 * 程序启发式探测（零 LLM）。
 * 返回 { fields, mapping, confidence, source:"program" }；mapping: role → 字段名。
 */
function probeProgram(raws) {
  const names = [];
  const seen = new Set();
  for (const r of raws) {
    if (!r || typeof r !== "object") continue;
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); names.push(k); }
    }
  }
  const fields = {};
  for (const name of names) {
    fields[name] = statsField(raws.slice(0, SAMPLE_LINES).map((r) => (r && typeof r === "object" ? r[name] : undefined)));
  }

  // 每字段候选角色：别名命中（0.95）或特征最高分
  const cand = []; // {name, role, score, via}
  for (const [name, st] of Object.entries(fields)) {
    const aliasRole = ALIAS_TO_ROLE.get(name.toLowerCase().replace(/[\s_-]/g, ""));
    if (aliasRole) {
      cand.push({ name, role: aliasRole, score: 0.95, via: "alias" });
      continue;
    }
    const scores = featureScores(st);
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) cand.push({ name, role: best[0], score: Number(best[1].toFixed(2)), via: "feature" });
  }

  // 全局每角色一个字段：同角色竞争取高分；落败与低分（<0.3）候选丢弃
  const byRole = new Map();
  const roleScores = new Map(); // role → 得分降序数组（含被丢弃的低分候选，用于竞争判定）
  for (const c of cand) {
    if (c.score < 0.3) continue;
    if (!roleScores.has(c.role)) roleScores.set(c.role, []);
    roleScores.get(c.role).push(c.score);
  }
  const roleBest = new Map();
  for (const c of cand) {
    if (c.score < 0.3) continue;
    const cur = roleBest.get(c.role);
    if (!cur || c.score > cur.score) roleBest.set(c.role, c);
  }

  const mapping = {};
  const confidence = {};
  const roleSource = {};
  for (const [role, c] of roleBest) {
    mapping[role] = c.name;
    roleSource[c.name] = c.via;
    let conf = c.score;
    // 竞争削减置信：仅当次高分接近胜者（差 ≤0.2）时视为真竞争，远弱候选不拉低置信
    const scores = (roleScores.get(role) || []).sort((a, b) => b - a);
    const runnerUp = scores[1];
    if (runnerUp !== undefined && c.via === "feature" && c.score - runnerUp <= 0.2) conf = Math.min(conf, 0.6);
    if (c.via === "alias") conf = Math.max(conf, 0.9);
    confidence[role] = Number(conf.toFixed(2));
  }
  for (const name of names) if (!(name in roleSource)) roleSource[name] = "";

  return { fields, mapping, confidence, roleSource, source: "program" };
}

/** question/answer 是否已可靠映射（决定是否需要 LLM） */
function coreReady(probe) {
  const need = ["question", "answer"];
  for (const r of need) {
    if (!probe.mapping[r] || (probe.confidence[r] ?? 0) < MIN_CONF) return false;
  }
  return true;
}

// ---------- LLM 探测 ----------

function buildSchemaProbePrompt(fieldsInfo) {
  const table = fieldsInfo
    .map((f) => `- 字段 "${f.name}"：类型=${f.kind}，中位长度=${f.medLen}，问号率=${f.qMarkRate}，疑问词率=${f.qWordRate}，推导词率=${f.thinkRate}，段落率=${f.paraRate}。样本：${f.samples.map((s) => JSON.stringify(s)).join(" | ") || "（无）"}`)
    .join("\n");
  return `下面是一个 QA 语料 JSONL 文件每行对象的字段清单（含值形态统计与样本）。请判断每个字段对应 QA 流水线中的哪个角色。

可选角色（白名单，只能从中选）：
- question：问题/题面
- answer：最终答案
- reasoning：思考/推理/分析过程（模型内部梳理，非最终答案）
- reasoningRaw：未经梳理的原始思考文本
- id：条目编号
- label / gaPair / track / chunkIndex / chunkName / model / references / qCheck / eval / finishReason：上游元数据（依次为：章节角色/提问角度/轨道/块序号/来源块名/生成模型/引用列表/题目自检/质量评分/截断原因）
- other：无法判断或与 QA 内容无关的辅助字段

规则：
1. 每个字段恰好一个角色；answer 与 reasoning 的区分看内容是否为「最终给用户的答复」还是「中间推导」；
2. 结合字段名语义与样本内容判断，样本为空时靠字段名与统计；
3. 仅输出 JSON 对象：{"mapping": {"字段名": "角色", ...}, "notes": "一句话说明"},不要任何其他文字。每个字段都必须出现在 mapping 中。

字段清单：
${table}`;
}

/**
 * LLM 探测：字段角色仲裁。chatFn 缺省用 llm.chat(settings.models.primary)。
 * 返回合并后的 probe（source:"llm"）；LLM 失败则返回程序结果并附 needsLlm 标记。
 */
async function probeWithLlm(probe, { chatFn, settings } = {}) {
  const llm = require("./llm");
  const fn = chatFn || ((messages, o) => llm.chat(settings && settings.models && settings.models.primary, messages, o));
  const fieldsInfo = Object.entries(probe.fields).map(([name, st]) => ({ name, ...st }));
  const res = await fn(
    [{ role: "user", content: buildSchemaProbePrompt(fieldsInfo) }],
    { temperature: 0, maxTokens: 2048, label: "schema-probe" }
  );
  if (!res.ok) return { ...probe, llmError: res.error || "LLM 调用失败" };
  const parsed = extractJsonFromLLMOutput(res.content);
  const mapping = parsed && parsed.mapping && typeof parsed.mapping === "object" ? parsed.mapping : null;
  if (!mapping) return { ...probe, llmError: "LLM 响应无法解析" };

  const known = new Set(Object.keys(probe.fields));
  const roleSet = new Set(LLM_ROLES);
  const out = {
    ...probe,
    source: "llm",
    mapping: {},
    confidence: {},
    roleSource: { ...probe.roleSource },
    llmNotes: String(parsed.notes || "").slice(0, 300),
  };
  // 先保留程序高置信别名命中，LLM 只补/改其余
  for (const [role, name] of Object.entries(probe.mapping)) {
    if ((probe.confidence[role] ?? 0) >= 0.9) {
      out.mapping[role] = name;
      out.confidence[role] = probe.confidence[role];
    }
  }
  for (const [name, role] of Object.entries(mapping)) {
    if (!known.has(name) || !roleSet.has(role)) continue; // 非法字段名/角色丢弃
    if (role === "other" || role === "") { out.roleSource[name] = "llm-other"; continue; }
    const prevRole = Object.entries(out.mapping).find(([, n]) => n === name);
    if (prevRole) delete out.mapping[prevRole[0]]; // 一字段一角色
    out.mapping[role] = name;
    out.confidence[role] = 0.9;
    out.roleSource[name] = "llm";
  }
  return out;
}

// ---------- 旁挂文件 ----------

function schemaFileFor(qaFilePath) {
  return String(qaFilePath).replace(/\.jsonl$/i, "") + "-schema.json";
}

function loadSchema(qaFilePath) {
  try {
    const data = JSON.parse(fs.readFileSync(schemaFileFor(qaFilePath), "utf8"));
    if (data && typeof data.mapping === "object") return data;
  } catch {
    /* 无旁挂或损坏 */
  }
  return null;
}

function saveSchema(qaFilePath, schema) {
  writeJsonAtomic(schemaFileFor(qaFilePath), schema);
}

/**
 * 确保某个 jsonl 有可用 schema：
 * 1. 旁挂存在且 question/answer 可靠 → 直接用；
 * 2. 否则程序探测（自动保存）；
 * 3. 程序结果 question/answer 仍不可靠且 allowLlm 且配置了模型 → LLM 仲裁后保存。
 * opts：{ allowLlm, chatFn, settings, force, save }
 */
async function ensureSchema(qaFilePath, opts = {}) {
  const { allowLlm = false, force = false, save = true } = opts;
  if (!force) {
    const hit = loadSchema(qaFilePath);
    if (hit && hit.mapping && hit.mapping.question && hit.mapping.answer) return { schema: hit, changed: false };
  }
  const raws = [];
  const text = fs.readFileSync(qaFilePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      raws.push(JSON.parse(t));
      if (raws.length >= SAMPLE_LINES) break;
    } catch {
      /* 坏行跳过 */
    }
  }
  if (!raws.length) throw new Error("文件没有可解析的 JSONL 行");
  let probe = probeProgram(raws);
  const schemaFingerprint = sha256(JSON.stringify(Object.keys(probe.fields))).slice(0, 12);
  let usedLlm = false;
  if (!coreReady(probe) && allowLlm) {
    const merged = await probeWithLlm(probe, opts);
    if (merged.source === "llm") {
      probe = merged;
      usedLlm = true;
    } else {
      probe.llmError = merged.llmError;
    }
  }
  const schema = {
    schemaVersion: SCHEMA_VERSION,
    file: qaFilePath,
    at: new Date().toISOString(),
    source: probe.source,
    usedLlm,
    schemaFingerprint,
    fields: probe.fields,
    mapping: probe.mapping,
    confidence: probe.confidence,
    roleSource: probe.roleSource,
    ...(probe.llmNotes ? { llmNotes: probe.llmNotes } : {}),
    ...(probe.llmError ? { llmError: probe.llmError } : {}),
    coreReady: coreReady(probe),
  };
  if (save) saveSchema(qaFilePath, schema);
  return { schema, changed: true };
}

/**
 * 同步程序探测（零 LLM；统计等零成本路径用）：
 * 旁挂有效直接用；否则程序探测，question/answer 齐才保存旁挂。
 * LLM 仲裁版本见 ensureSchema（async）。
 */
function ensureSchemaProgramSync(qaFilePath) {
  const hit = loadSchema(qaFilePath);
  if (hit && hit.mapping && hit.mapping.question && hit.mapping.answer) return hit;
  const raws = [];
  const text = fs.readFileSync(qaFilePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      raws.push(JSON.parse(t));
      if (raws.length >= SAMPLE_LINES) break;
    } catch {
      /* 坏行跳过 */
    }
  }
  if (!raws.length) return null;
  const probe = probeProgram(raws);
  const schema = {
    schemaVersion: SCHEMA_VERSION,
    file: qaFilePath,
    at: new Date().toISOString(),
    source: "program",
    usedLlm: false,
    fields: probe.fields,
    mapping: probe.mapping,
    confidence: probe.confidence,
    roleSource: probe.roleSource,
    coreReady: coreReady(probe),
  };
  if (schema.mapping.question && schema.mapping.answer) saveSchema(qaFilePath, schema);
  return schema;
}

module.exports = {
  SCHEMA_VERSION, MIN_CONF, ROLES, LLM_ROLES, ROLE_ALIASES,
  probeProgram, coreReady, probeWithLlm, buildSchemaProbePrompt,
  ensureSchema, ensureSchemaProgramSync, loadSchema, saveSchema, schemaFileFor, statsField, featureScores,
};
