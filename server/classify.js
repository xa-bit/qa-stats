"use strict";

/**
 * 混合分类引擎 L1/L2。
 *
 * 流程：载入（含 schema 结构映射）→ 缓存/人审锁定检查 → L0 规则 → 未定案者分批 LLM
 *      （批量 → 坏批单题降级）→ L2 校验（合法性/先验冲突/低置信/标签数异常 → judge
 *      仲裁，无 judge 进人审队列）→ 落盘 -qa-cls.jsonl + 缓存 + meta。
 *
 * v1.1：
 * - 学科为【多标签】subjects（1~maxSubjects 个，主学科在前；cls.subject 保留为主标签，
 *   兼容旧单标签产物：读入时自动包装成单元素数组）；
 * - 标签数量纪律：LLM 超量 → 截断并标记 tagsOutOfRange（进人审）；0 个 → 仲裁；
 * - 载入前可传/自动补 schema（未知字段名语料的列映射）。
 *
 * 失败不丢数据（distilabel 容错约定）：解析失败置 null + debug 保留原始响应片段。
 */

const fs = require("fs");
const path = require("path");
const { loadQaFile } = require("./loader");
const { runRules, FINAL_CONF } = require("./rules");
const { buildSystemPrompt, buildClassifyPrompt, buildArbitratePrompt, PROMPT_VERSION } = require("./prompts");
const { cacheKeyOf, loadCache, saveCache, getEntry, setEntry } = require("./cache");
const { processInParallel, clip, writeJsonAtomic, nowIso } = require("./util");
const { extractJsonFromLLMOutput } = require("./llm-util");
const { ensureSchema } = require("./schema");

const CLS_VERSION = 2;
const ARBITRATE_CONFLICT_PRIOR = 0.8; // 规则先验置信 ≥ 此值且与 LLM 不一致 → 冲突仲裁

// ---------- 分类体系载入 ----------

function loadTaxonomy(settings) {
  const p = (settings && settings.taxonomyPath) || path.join(__dirname, "..", "presets", "taxonomy.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadContentTypes(settings) {
  const p = (settings && settings.contentTypesPath) || path.join(__dirname, "..", "presets", "content-types.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function clsFilePath(qaFilePath) {
  return qaFilePath.replace(/\.jsonl$/i, "") + "-cls.jsonl";
}

function metaFilePath(qaFilePath) {
  return qaFilePath.replace(/\.jsonl$/i, "") + "-clsmeta.json";
}

/** 旧单标签行 → 多标签规范形（subjects 数组 + subject 主标签）。原地规范化。 */
function normalizeClsRow(o) {
  if (!o || typeof o !== "object") return o;
  if (!Array.isArray(o.subjects)) {
    o.subjects = o.subject && o.subject.l1 ? [o.subject] : [];
  } else {
    o.subjects = o.subjects.filter((s) => s && s.l1);
  }
  o.subject = o.subjects.length ? o.subjects[0] : null;
  return o;
}

/** 读取既有分类注记（按 id 索引；confirmed 行在重跑时锁定不覆盖） */
function loadClsFile(qaFilePath) {
  const file = clsFilePath(qaFilePath);
  const map = new Map();
  const rows = [];
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = normalizeClsRow(JSON.parse(t));
        rows.push(obj);
        if (obj.id !== undefined && !map.has(String(obj.id))) map.set(String(obj.id), obj);
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 文件不存在 */
  }
  return { map, rows };
}

/** 统一行挂分类注记（统计用） */
function attachCls(rows, clsMap) {
  for (const r of rows) {
    const c = clsMap.get(String(r.id));
    r.cls = c ? normalizeClsRow({ ...c }) : null;
  }
  return rows;
}

// ---------- LLM 结果校验（白名单硬约束） ----------

function makeValidators(taxonomy, contentTypes) {
  const l1Map = new Map();
  for (const n of taxonomy.tree) {
    l1Map.set(n.label, new Set((n.children || []).map((c) => c.label)));
  }
  const ctSet = new Set(contentTypes.types.map((t) => t.label));
  return {
    subject(s) {
      if (!s || typeof s !== "object") return null;
      const l1 = String(s.l1 || "").trim();
      let l2 = String(s.l2 || "").trim();
      if (!l1Map.has(l1)) return null;
      if (l2 && (!l1Map.get(l1).has(l2) || l2 === l1)) return null;
      if (l2 === l1) l2 = "";
      return { l1, l2: l2 || null };
    },
    contentType(t) {
      const v = String(t || "").trim();
      return ctSet.has(v) ? v : null;
    },
  };
}

function coerceConf(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, Number(n.toFixed(2))));
}

// ---------- 单行结果合并（规则优先定案，LLM 补位，先验冲突检测） ----------

function mergeForRow(row, rule, llmItem, validators) {
  const out = {
    id: row.id,
    status: "ok",
    subjects: [],
    subject: null,
    contentType: null,
    reasons: "",
    confirmed: false,
    needsReview: false,
    conflict: false,
    tagsOutOfRange: false,
    error: null,
    debug: null,
  };
  const ruleSubjFinal = rule.subject && rule.subject.confidence >= FINAL_CONF ? rule.subject : null;
  const ruleCtFinal = rule.contentType && rule.contentType.confidence >= FINAL_CONF ? rule.contentType : null;

  // 学科（多标签）：规则定案（单标签） > LLM 多标签 > 规则先验
  if (ruleSubjFinal) {
    out.subjects = [{ ...ruleSubjFinal }];
  } else if (llmItem && llmItem._subjects && llmItem._subjects.length) {
    out.subjects = llmItem._subjects.map((s) => ({ ...s, source: "llm" }));
    out.reasons = llmItem.reasons || "";
    out.tagsOutOfRange = !!llmItem._tagsOutOfRange;
  } else if (rule.subject) {
    out.subjects = [{ ...rule.subject }];
  }
  out.subject = out.subjects.length ? out.subjects[0] : null;

  // 内容类型：同上（单标签）
  if (ruleCtFinal) {
    out.contentType = { ...ruleCtFinal };
  } else if (llmItem && llmItem._contentType) {
    out.contentType = { ...llmItem._contentType, source: "llm" };
    if (!out.reasons) out.reasons = llmItem.reasons || "";
  } else if (rule.contentType) {
    out.contentType = { ...rule.contentType };
  }

  // 先验冲突（分维度）：仅当该维度最终值来自 LLM（先验未定案）且与高置信先验不一致时标记；
  // 规则已定案的维度 LLM 意见本就被丢弃，无需仲裁。学科以主标签比对。
  const conflictDims = { subject: false, contentType: false };
  if (llmItem) {
    if (
      !ruleSubjFinal && rule.subject && rule.subject.confidence >= ARBITRATE_CONFLICT_PRIOR &&
      out.subject && out.subject.source === "llm" &&
      (out.subject.l1 !== rule.subject.l1 || (out.subject.l2 || "") !== (rule.subject.l2 || ""))
    ) conflictDims.subject = true;
    if (
      !ruleCtFinal && rule.contentType && rule.contentType.confidence >= ARBITRATE_CONFLICT_PRIOR &&
      out.contentType && out.contentType.source === "llm" &&
      out.contentType.type !== rule.contentType.type
    ) conflictDims.contentType = true;
  }
  out.conflict = conflictDims.subject || conflictDims.contentType;
  out._conflictDims = conflictDims;
  return out;
}

// ---------- 主流程 ----------

/**
 * 对一个 jsonl 执行分类。opts：
 * { settings:{models:{primary,judge},batchSize,concurrency,lowConf,useJudge,maxSubjects},
 *   taxonomy, contentTypes, chatFn, judgeChatFn, force, schema, autoSchema, onProgress, shouldStop }
 * chatFn/judgeChatFn: (messages, opts) => {ok, content, error}（自测可注入 mock；缺省用 llm.chat）
 * autoSchema：无 schema 旁挂且程序探测不可靠时，自动用 primary 模型做 LLM 结构探测。
 */
async function classifyFile(qaFilePath, opts = {}) {
  const settings = opts.settings || {};
  const lowConf = settings.lowConf ?? 0.6;
  const useJudge = settings.useJudge !== false;
  const batchSize = settings.batchSize || 12;
  const concurrency = settings.concurrency || 2;
  const maxSubjects = Math.max(1, Number(settings.maxSubjects) || 3);
  const taxonomy = opts.taxonomy || loadTaxonomy(settings);
  const contentTypes = opts.contentTypes || loadContentTypes(settings);
  const validators = makeValidators(taxonomy, contentTypes);
  const promptVer = PROMPT_VERSION;
  const taxVer = taxonomy.version || 1;

  const llm = require("./llm");
  const chatFn = opts.chatFn || ((messages, o) => llm.chat(settings.models && settings.models.primary, messages, o));
  const judgeChatFn = opts.judgeChatFn || ((messages, o) => llm.chat(settings.models && settings.models.judge, messages, o));
  const judgeReady = useJudge && settings.models && settings.models.judge && settings.models.judge.endpoint && settings.models.judge.modelId;

  const started = Date.now();

  // —— 结构探测（未知字段名语料）：优先 opts.schema；autoSchema 允许 LLM 兜底 ——
  let schema = opts.schema || null;
  if (!schema) {
    try {
      const r = await ensureSchema(qaFilePath, {
        allowLlm: opts.autoSchema !== false, // 默认允许（分类本就要 LLM）
        chatFn: opts.chatFn || null,
        settings,
      });
      schema = r.schema;
    } catch {
      schema = null; // 探测失败继续（loader 会退回别名兜底）
    }
  }

  const { rows } = loadQaFile(qaFilePath, { schema });
  const existing = loadClsFile(qaFilePath); // 人审锁定（confirmed）
  const cache = loadCache(qaFilePath);
  const usage = { llm: newUsageBucket(), judge: newUsageBucket() };

  const results = new Map(); // id → cls 行
  const pendingRows = [];    // 需要 LLM 的行
  let cachedCount = 0;
  let lockedCount = 0;
  let ruleDecidedCount = 0;

  for (const row of rows) {
    const prev = existing.map.get(String(row.id));
    if (prev && prev.confirmed) {
      results.set(String(row.id), { ...normalizeClsRow({ ...prev }), status: "ok" });
      lockedCount++;
      continue;
    }
    if (!opts.force) {
      const hit = getEntry(cache, cacheKeyOf(row), { taxonomyVersion: taxVer, promptVersion: promptVer });
      if (hit) {
        // 缓存键是内容哈希：同内容不同 id 的行共享同一条缓存，命中时必须换回本行 id
        results.set(String(row.id), { ...normalizeClsRow({ ...hit }), id: row.id });
        cachedCount++;
        continue;
      }
    }
    const rule = runRules(row, taxonomy, contentTypes);
    row._rule = rule;
    row._hasFinal = !!(rule.subject && rule.subject.confidence >= FINAL_CONF) &&
      !!(rule.contentType && rule.contentType.confidence >= FINAL_CONF);
    if (row._hasFinal) ruleDecidedCount++;
    pendingRows.push(row);
  }

  // 分批：仅未定案行进入 LLM 批；规则全定案行单独直接产出结果
  const ruleFinalRows = pendingRows.filter((r) => r._hasFinal);
  const llmRows = pendingRows.filter((r) => !r._hasFinal);
  const batches = [];
  for (let i = 0; i < llmRows.length; i += batchSize) {
    batches.push(llmRows.slice(i, i + batchSize));
  }

  let processed = 0;
  let llmCalls = 0;
  let judgeCalls = 0;
  const stopped = { value: false };

  const makeUsageHook = (bucket) => (info) => {
    bucket.calls++;
    if (info.ok) bucket.ok++; else bucket.fail++;
    bucket.latencyMsSum += info.latencyMs || 0;
    if (info.usage) {
      bucket.promptTokens += info.usage.promptTokens;
      bucket.completionTokens += info.usage.completionTokens;
      bucket.totalTokens += info.usage.totalTokens;
    }
  };

  /** LLM 原始条目 → 校验后的 {subjects, contentType, confidence, reasons}（非法维度置空） */
  function normalizeLlmItem(it, v) {
    // 学科：v2 多标签数组；兼容旧单对象
    let list = [];
    if (Array.isArray(it.subjects)) list = it.subjects;
    else if (it.subject && typeof it.subject === "object") list = [it.subject];
    const seen = new Set();
    const subjects = [];
    for (const s of list) {
      const val = v.subject(s);
      if (!val) continue;
      const key = `${val.l1}/${val.l2 || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push({ l1: val.l1, l2: val.l2, confidence: coerceConf(it.confidence) });
    }
    const ct = v.contentType(it.contentType);
    return {
      _subjects: subjects.slice(0, maxSubjects),
      _tagsOutOfRange: list.length > maxSubjects,
      _contentType: ct ? { type: ct, confidence: coerceConf(it.confidence) } : null,
      reasons: String(it.reasons || "").slice(0, 200),
      error: null,
    };
  }

  /** 解析一批 LLM 输出 → 按 id 映射的合法条目（含降级单题重试） */
  async function classifyBatch(batch) {
    const items = batch.map((r) => ({
      id: r.id, question: r.question, answer: r.answer, chunkName: r.chunkName, priors: r._rule.priors,
    }));
    llmCalls++;
    const res = await chatFn(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildClassifyPrompt(items, taxonomy, contentTypes, { maxSubjects }) },
      ],
      { temperature: 0, maxTokens: 4096, onUsage: makeUsageHook(usage.llm), label: "classify" }
    );
    const out = new Map();
    if (!res.ok) return { out, batchError: res.error || "LLM 调用失败" };

    let parsed = extractJsonFromLLMOutput(res.content);
    let arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);

    // 坏批 → 单题降级重试（每题一次）
    const covered = new Set();
    if (arr) {
      for (const it of arr) {
        if (!it || typeof it !== "object") continue;
        const id = String(it.id ?? "");
        const item = normalizeLlmItem(it, validators);
        if (batch.some((r) => String(r.id) === id)) {
          out.set(id, item);
          covered.add(id);
        }
      }
    }
    for (const r of batch) {
      if (covered.has(String(r.id))) continue;
      llmCalls++;
      const single = await chatFn(
        [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildClassifyPrompt([toItem(r)], taxonomy, contentTypes, { maxSubjects }) },
        ],
        { temperature: 0, maxTokens: 512, onUsage: makeUsageHook(usage.llm), label: "classify-single" }
      );
      if (!single.ok) {
        out.set(String(r.id), { error: single.error || "单题重试失败", debug: null });
        continue;
      }
      const sp = extractJsonFromLLMOutput(single.content);
      const sarr = Array.isArray(sp) ? sp : [sp];
      const mine = sarr.find((x) => x && String(x.id ?? "") === String(r.id)) || sarr[0];
      out.set(String(r.id), mine ? normalizeLlmItem(mine, validators) : { error: "单题响应无法解析", debug: clip(single.content, 300) });
    }
    return { out, batchError: null };
  }

  function toItem(r) {
    return { id: r.id, question: r.question, answer: r.answer, chunkName: r.chunkName, priors: r._rule.priors };
  }

  /** L2 仲裁（分维度）：冲突/低置信/缺失/标签数异常 → judge 单题；仍不行 → 人审 */
  async function arbitrate(row, merged) {
    const ruleFinalSubj = !!(row._rule.subject && row._rule.subject.confidence >= FINAL_CONF);
    const ruleFinalCt = !!(row._rule.contentType && row._rule.contentType.confidence >= FINAL_CONF);
    const cd = merged._conflictDims || { subject: false, contentType: false };
    const subjLow = merged.subjects.length && merged.subjects[0].source === "llm" && merged.subjects[0].confidence < lowConf;
    const ctLow = merged.contentType && merged.contentType.source === "llm" && merged.contentType.confidence < lowConf;
    const subjNeed = cd.subject || subjLow || !merged.subjects.length;
    const ctNeed = cd.contentType || ctLow || !merged.contentType;
    const rangeNeed = merged.tagsOutOfRange; // 超量被截断：交给 judge 重判整组标签
    if (!subjNeed && !ctNeed && !rangeNeed) return;
    if (!judgeReady) {
      merged.needsReview = true;
      return;
    }
    judgeCalls++;
    const res = await judgeChatFn(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildArbitratePrompt(toItem(row), taxonomy, contentTypes, { maxSubjects }) },
      ],
      { temperature: 0, maxTokens: 512, onUsage: makeUsageHook(usage.judge), label: "judge" }
    );
    if (!res.ok) {
      merged.needsReview = true;
      merged.error = merged.error || `仲裁失败: ${res.error || ""}`;
      return;
    }
    const parsed = extractJsonFromLLMOutput(res.content);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== "object") {
      merged.needsReview = true;
      merged.debug = clip(res.content, 300);
      return;
    }
    const item = normalizeLlmItem(obj, validators);
    // judge 结果仅覆盖需要仲裁的维度（规则定案维度不动）
    if ((subjNeed || rangeNeed) && item._subjects.length && !ruleFinalSubj) {
      merged.subjects = item._subjects.map((s) => ({ ...s, source: "llm-judge" }));
      merged.subject = merged.subjects[0];
      merged.tagsOutOfRange = false;
    }
    if (ctNeed && item._contentType && !ruleFinalCt) {
      merged.contentType = { ...item._contentType, source: "llm-judge" };
    }
    if (!merged.reasons && item.reasons) merged.reasons = item.reasons;
    const stillLow =
      (merged.subjects.length && merged.subjects[0].source !== "rule" && merged.subjects[0].confidence < lowConf) ||
      (merged.contentType && merged.contentType.source !== "rule" && merged.contentType.confidence < lowConf);
    const stillMissing = !merged.subjects.length || !merged.contentType;
    if (stillLow || stillMissing || merged.tagsOutOfRange) merged.needsReview = true;
  }

  // 规则全定案行：直接产出（写缓存保持稳定）
  for (const r of ruleFinalRows) {
    const merged = mergeForRow(r, r._rule, null, validators);
    finishRow(merged);
    results.set(String(r.id), merged);
    setEntry(cache, cacheKeyOf(r), merged, { taxonomyVersion: taxVer, promptVersion: promptVer });
  }

  function finishRow(merged) {
    delete merged._conflictDims; // 内部字段，不落盘
    merged.clsVersion = CLS_VERSION;
    merged.taxonomyVersion = taxVer;
    merged.promptVersion = promptVer;
  }

  const workBatches = batches.filter((b) => b.length);
  await processInParallel(
    workBatches,
    async (batch) => {
      if (stopped.value || (opts.shouldStop && opts.shouldStop())) {
        stopped.value = true;
        return;
      }
      const { out, batchError } = await classifyBatch(batch);
      for (const r of batch) {
        const item = out.get(String(r.id));
        let merged;
        if (batchError && !item) {
          merged = mergeForRow(r, r._rule, null, validators);
          merged.status = "failed";
          merged.error = batchError;
          merged.needsReview = true;
        } else if (item && item.error && !item._subjects.length && !item._contentType) {
          merged = mergeForRow(r, r._rule, null, validators);
          merged.status = "failed";
          merged.error = item.error;
          merged.debug = item.debug || null;
          merged.needsReview = !merged.subjects.length && !merged.contentType ? true : merged.needsReview;
        } else {
          merged = mergeForRow(r, r._rule, item || null, validators);
          if (item && item.error) {
            merged.error = item.error; // 部分维度非法
          }
          await arbitrate(r, merged);
        }
        finishRow(merged);
        results.set(String(r.id), merged);
        setEntry(cache, cacheKeyOf(r), merged, { taxonomyVersion: taxVer, promptVersion: promptVer });
      }
      processed += batch.length;
      opts.onProgress && opts.onProgress({
        file: qaFilePath,
        done: cachedCount + lockedCount + ruleFinalRows.length + processed,
        total: rows.length,
        llmCalls,
        judgeCalls,
      });
    },
    Math.max(1, concurrency)
  );

  // 未处理的行（中断）标记 pending
  for (const r of rows) {
    if (!results.has(String(r.id))) {
      results.set(String(r.id), {
        id: r.id, status: "pending", subjects: [], subject: null, contentType: null, reasons: "", confirmed: false,
        needsReview: false, conflict: false, tagsOutOfRange: false, error: "interrupted", debug: null,
        clsVersion: CLS_VERSION, taxonomyVersion: taxVer, promptVersion: promptVer,
      });
    }
  }

  // 落盘
  const clsRows = rows.map((r) => results.get(String(r.id)));
  const clsFile = clsFilePath(qaFilePath);
  fs.mkdirSync(path.dirname(clsFile), { recursive: true });
  fs.writeFileSync(clsFile, clsRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  saveCache(qaFilePath, cache);

  const tagTotal = clsRows.reduce((s, r) => s + (r.subjects ? r.subjects.length : 0), 0);
  const classified = clsRows.filter((r) => r.subjects && r.subjects.length).length;
  const meta = {
    file: qaFilePath,
    at: nowIso(),
    durationMs: Date.now() - started,
    taxonomyVersion: taxVer,
    promptVersion: promptVer,
    clsVersion: CLS_VERSION,
    schema: schema ? { source: schema.source, usedLlm: !!schema.usedLlm, mapping: schema.mapping } : null,
    counts: {
      total: rows.length,
      cached: cachedCount,
      humanLocked: lockedCount,
      ruleDecided: ruleDecidedCount,
      llmBatches: workBatches.length,
      llmCalls,
      judgeCalls,
      needsReview: clsRows.filter((r) => r.needsReview).length,
      failed: clsRows.filter((r) => r.status === "failed").length,
      pending: clsRows.filter((r) => r.status === "pending").length,
      tagsOutOfRange: clsRows.filter((r) => r.tagsOutOfRange).length,
      avgSubjects: classified ? Number((tagTotal / classified).toFixed(2)) : 0,
    },
    usage: {
      llm: usage.llm,
      judge: usage.judge,
    },
  };
  writeJsonAtomic(metaFilePath(qaFilePath), meta);
  return meta;
}

function newUsageBucket() {
  return { calls: 0, ok: 0, fail: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMsSum: 0 };
}

// ---------- 人审 ----------

/**
 * 人审提交：patch = {subjects?: [{l1, l2}, ...], contentType?: "类型"}。
 * 校验合法（每项在 taxonomy 内、二级隶属一级、1~maxSubjects 个）后写回 cls 文件与缓存
 * （source=human, confidence=1, confirmed=true）。
 */
function applyReview(qaFilePath, id, patchIn, settings) {
  const patch = { ...patchIn };
  // 兼容旧单标签提交：{subject: {l1,l2}} → subjects 数组
  if (patch.subjects === undefined && patch.subject && typeof patch.subject === "object") {
    patch.subjects = [patch.subject];
  }
  const taxonomy = loadTaxonomy(settings);
  const contentTypes = loadContentTypes(settings);
  const maxSubjects = Math.max(1, Number(settings && settings.maxSubjects) || 3);
  const validators = makeValidators(taxonomy, contentTypes);
  const { rows } = loadQaFile(qaFilePath);
  const row = rows.find((r) => String(r.id) === String(id));
  if (!row) return { ok: false, detail: "题目不存在" };

  const clsFile = clsFilePath(qaFilePath);
  const cls = loadClsFile(qaFilePath);
  const cur = normalizeClsRow(cls.map.get(String(id)) || {
    id: String(id), status: "ok", subjects: [], subject: null, contentType: null, reasons: "", confirmed: false,
    needsReview: false, conflict: false, tagsOutOfRange: false, error: null, debug: null,
  });
  if (patch.subjects !== undefined) {
    if (!Array.isArray(patch.subjects) || !patch.subjects.length) {
      return { ok: false, detail: "学科标签至少 1 个" };
    }
    if (patch.subjects.length > maxSubjects) {
      return { ok: false, detail: `学科标签最多 ${maxSubjects} 个（当前 ${patch.subjects.length} 个）` };
    }
    const list = [];
    const seen = new Set();
    for (const s of patch.subjects) {
      const v = validators.subject(s);
      if (!v) return { ok: false, detail: `学科标签不合法（不在 taxonomy 内或二级不隶属一级）：${s && s.l1}` };
      const key = `${v.l1}/${v.l2 || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ l1: v.l1, l2: v.l2, confidence: 1, source: "human" });
    }
    if (!list.length) return { ok: false, detail: "学科标签为空" };
    cur.subjects = list;
    cur.subject = list[0];
    cur.tagsOutOfRange = false;
  }
  if (patch.contentType !== undefined) {
    const v = validators.contentType(patch.contentType);
    if (!v) return { ok: false, detail: "内容类型标签不合法" };
    cur.contentType = { type: v, confidence: 1, source: "human" };
  }
  if (patch.reasons !== undefined) cur.reasons = String(patch.reasons).slice(0, 200);
  cur.status = "ok";
  cur.confirmed = true;
  cur.needsReview = false;

  // 全量重写 cls 文件（保持行序 = qa 行序）
  const outRows = rows.map((r) => (String(r.id) === String(id) ? cur : (cls.map.get(String(r.id)) || { id: String(r.id), status: "pending", subjects: [], subject: null, contentType: null, reasons: "", confirmed: false, needsReview: false, conflict: false, tagsOutOfRange: false, error: "not-run", debug: null })));
  fs.writeFileSync(clsFile, outRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  // 同步缓存
  const cache = loadCache(qaFilePath);
  setEntry(cache, cacheKeyOf(row), cur, { taxonomyVersion: taxonomy.version || 1, promptVersion: PROMPT_VERSION });
  saveCache(qaFilePath, cache);
  return { ok: true, detail: "已确认", row: cur };
}

module.exports = {
  classifyFile, loadClsFile, attachCls, applyReview, normalizeClsRow,
  loadTaxonomy, loadContentTypes, clsFilePath, metaFilePath, makeValidators, CLS_VERSION,
};
