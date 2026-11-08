"use strict";

/**
 * 标签库管理（v1.1 新增）：
 * - 校验：树非空、一级/全局二级标签唯一（同名二级允许跨一级出现一次以上？
 *   不允许——二级必须唯一，避免 LLM 白名单匹配歧义）、必含兜底类「其他」、
 *   label 非空 ≤12 字、desc ≤60 字；
 * - 保存：version 自增 + updated 时间戳（分类缓存按版本自动失效增量重分类）；
 * - 预置：presets/ 下的学科树清单（通用 / 海洋气象领域），可加载后编辑另存；
 * - 归纳：抽样语料 → LLM 产出建议稿（不落盘，人工确认后走保存）。
 */

const fs = require("fs");
const path = require("path");
const { nowIso } = require("./util");
const { buildTaxonomyProposePrompt } = require("./prompts");
const { extractJsonFromLLMOutput } = require("./llm-util");

const PRESETS_DIR = path.join(__dirname, "..", "presets");
const FALLBACK_LABELS = ["Other", "其他"]; // 兜底一级学科（英文树用 Other，中文树用 其他）

/** 是否含 CJK 字符（决定标签长度上限口径） */
function isCjkLabel(s) {
  return /[\u4e00-\u9fff]/.test(s);
}

function labelLengthLimit(label) {
  return isCjkLabel(label) ? 12 : 48; // 中文 ≤12 字；英文 ≤48 字符
}

/** 当前树生效的兜底类 label（优先 Other） */
function fallbackLabelOf(taxonomy) {
  for (const fb of FALLBACK_LABELS) {
    if ((taxonomy && taxonomy.tree || []).some((n) => n.label === fb)) return fb;
  }
  return FALLBACK_LABELS[0];
}

/** 可加载的预置学科树（presets/taxonomy*.json） */
function listPresets() {
  const out = [];
  try {
    for (const name of fs.readdirSync(PRESETS_DIR).sort()) {
      if (!/^taxonomy.*\.json$/i.test(name)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, name), "utf8"));
        out.push({
          id: name,
          name: data.name || name.replace(/\.json$/i, ""),
          version: data.version || 1,
          l1Count: (data.tree || []).length,
          l2Count: (data.tree || []).reduce((s, n) => s + (n.children || []).length, 0),
          note: data.note || "",
        });
      } catch {
        /* 坏文件跳过 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return out;
}

function loadPreset(id) {
  const file = path.join(PRESETS_DIR, path.basename(String(id)));
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * 树校验（v1.2 双语标签）。返回 {ok, errors: [], tree}；ok=false 时 errors 给出可读原因。
 * 规则（对应「学科交叉」的约束方式：交叉发生在打标阶段而非树结构上）：
 * 1. tree 非空数组，1~40 个一级；
 * 2. label 为最终统计口径（英文树用英文规范名）：非空、全局唯一；含 CJK 时 ≤12 字，否则 ≤40 字符；
 * 3. zh 为中文对照（可选，便于理解）：≤12 字；desc ≤80 字；
 * 4. 二级同理且必须隶属唯一一级（同名二级不允许出现在两个一级下）；
 * 5. 必须包含兜底一级「Other」（中文树兼容「其他」）。
 */
function validateTaxonomy(input) {
  const errors = [];
  const tree = input && Array.isArray(input.tree) ? input.tree : null;
  if (!tree || !tree.length) errors.push("树为空：至少需要 1 个一级学科");
  if (tree && tree.length > 40) errors.push("一级学科过多（>40）");

  const l1Seen = new Map();
  const l2Owner = new Map();
  const clean = [];
  if (tree) {
    for (const node of tree) {
      const label = String((node && node.label) || "").trim();
      if (!label) { errors.push("存在空 label 的一级学科"); continue; }
      if (label.length > labelLengthLimit(label)) errors.push(`一级标签过长（中文≤12字/英文≤48字符）：${label}`);
      if (l1Seen.has(label)) errors.push(`一级标签重复：${label}`);
      l1Seen.set(label, true);
      const zh = String((node && node.zh) || "").trim();
      if (zh.length > 12) errors.push(`中文名过长（≤12 字）：${zh}`);
      const children = [];
      for (const c of node.children || []) {
        const cl = String((c && c.label) || "").trim();
        if (!cl) { errors.push(`「${label}」下存在空 label 的二级方向`); continue; }
        if (cl.length > labelLengthLimit(cl)) errors.push(`二级标签过长（中文≤12字/英文≤48字符）：${cl}`);
        if (cl === label) errors.push(`二级与一级同名：${cl}`);
        if (l2Owner.has(cl) && l2Owner.get(cl) !== label) {
          errors.push(`二级标签「${cl}」同时挂在「${l2Owner.get(cl)}」与「${label}」下（二级必须唯一归属，交叉由打标多标签表达）`);
        }
        l2Owner.set(cl, label);
        const czh = String((c && c.zh) || "").trim();
        if (czh.length > 12) errors.push(`中文名过长（≤12 字）：${czh}`);
        children.push({
          label: cl,
          ...(czh ? { zh: czh } : {}),
          desc: String((c && c.desc) || "").trim().slice(0, 80),
        });
      }
      clean.push({
        label,
        ...(zh ? { zh } : {}),
        desc: String(node.desc || "").trim().slice(0, 80),
        children,
      });
    }
  }
  if (tree && !FALLBACK_LABELS.some((fb) => l1Seen.has(fb))) {
    errors.push(`缺少兜底一级学科「${FALLBACK_LABELS.join(" / ")}」`);
  }

  return { ok: errors.length === 0, errors, tree: clean };
}

/** 当前生效路径（settings.taxonomyPath 优先） */
function taxonomyPathOf(settings) {
  return (settings && settings.taxonomyPath && String(settings.taxonomyPath).trim()) ||
    path.join(PRESETS_DIR, "taxonomy.json");
}

/**
 * 保存学科树：校验 → version 自增 → 原子写。返回 {ok, errors, saved}。
 * saved 含 version/updated，前端据此提示「将触发增量重分类」。
 */
function saveTaxonomy(settings, input) {
  const v = validateTaxonomy(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const file = taxonomyPathOf(settings);
  const prevVersion = (() => {
    try {
      return Number(JSON.parse(fs.readFileSync(file, "utf8")).version) || 0;
    } catch {
      return 0;
    }
  })();
  const data = {
    version: prevVersion + 1,
    dimension: "subject",
    updated: nowIso(),
    name: String(input.name || "").slice(0, 60) || undefined,
    note: String(input.note || "").slice(0, 300) || undefined,
    tree: v.tree,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, errors: [], saved: { file, version: data.version, updated: data.updated } };
}

/**
 * 内容类型封闭集校验与保存（同款规则：非空、唯一、含兜底类）。
 */
function validateContentTypes(input) {
  const errors = [];
  const types = input && Array.isArray(input.types) ? input.types : null;
  if (!types || !types.length) errors.push("内容类型清单为空");
  const seen = new Set();
  const clean = [];
  if (types) {
    for (const t of types) {
      const label = String((t && t.label) || "").trim();
      if (!label) { errors.push("存在空 label 的内容类型"); continue; }
      if (label.length > labelLengthLimit(label)) errors.push(`内容类型过长：${label}`);
      if (seen.has(label)) errors.push(`内容类型重复：${label}`);
      seen.add(label);
      clean.push({ label, desc: String((t && t.desc) || "").trim().slice(0, 80) });
    }
    if (!seen.has(FALLBACK_LABELS[1]) && !seen.has(FALLBACK_LABELS[0])) {
      errors.push(`缺少兜底内容类型「${FALLBACK_LABELS.join(" / ")}」`);
    }
  }
  return { ok: errors.length === 0, errors, types: clean };
}

function saveContentTypes(settings, input) {
  const v = validateContentTypes(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const file = (settings && settings.contentTypesPath && String(settings.contentTypesPath).trim()) ||
    path.join(PRESETS_DIR, "content-types.json");
  let prevVersion = 0;
  try {
    prevVersion = Number(JSON.parse(fs.readFileSync(file, "utf8")).version) || 0;
  } catch {
    /* 新文件 */
  }
  const data = { version: prevVersion + 1, dimension: "contentType", updated: nowIso(), types: v.types };
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, errors: [], saved: { file, version: data.version } };
}

/**
 * LLM 归纳学科树建议稿（easy-dataset getLabelPrompt 范式；只返回建议，不落盘）。
 * rows：统一行数组；chatFn 缺省用 settings.models.primary。
 */
async function proposeTaxonomy(rows, { settings, chatFn, sampleSize = 80, seed = 7 } = {}) {
  const llm = require("./llm");
  const fn = chatFn || ((messages, o) => llm.chat(settings && settings.models && settings.models.primary, messages, o));
  // 简单可复现抽样（线性同余）
  const pool = rows.filter((r) => r && r.question);
  if (pool.length < 5) return { ok: false, error: "样本过少（<5 条），无法归纳" };
  // 样本不超过池子时直接全量；否则线性同余抽样（可复现）
  const picked = [];
  if (pool.length <= sampleSize) {
    picked.push(...pool);
  } else {
    let s = seed;
    for (let i = 0; i < sampleSize; i++) {
      s = (s * 48271) % 2147483647;
      picked.push(pool[s % pool.length]);
    }
  }
  const dedup = [];
  const seenQ = new Set();
  for (const r of picked) {
    if (seenQ.has(r.id)) continue;
    seenQ.add(r.id);
    dedup.push({ question: r.question, answer: r.answer, chunkName: r.chunkName || "" });
  }
  const res = await fn(
    [{ role: "user", content: buildTaxonomyProposePrompt(dedup) }],
    { temperature: 0.2, maxTokens: 4096, label: "taxonomy-propose" }
  );
  if (!res.ok) return { ok: false, error: res.error || "LLM 调用失败" };
  const parsed = extractJsonFromLLMOutput(res.content);
  if (!parsed || !Array.isArray(parsed.tree)) return { ok: false, error: "LLM 响应无法解析为树", debug: String(res.content).slice(0, 300) };
  // 排序无关的结构校验：允许建议稿暂不满足全部规则（人工确认时再校验），但基础结构要有
  const v = validateTaxonomy(parsed);
  return {
    ok: true,
    proposal: { dimension: "subject", name: "LLM 归纳建议稿", tree: v.tree, notes: String(parsed.notes || "").slice(0, 300) },
    errors: v.errors, // 非空时前端提示需要人工修订后再保存
    sampleUsed: dedup.length,
  };
}

module.exports = {
  listPresets, loadPreset, validateTaxonomy, saveTaxonomy,
  validateContentTypes, saveContentTypes, proposeTaxonomy, taxonomyPathOf,
  FALLBACK_LABELS, fallbackLabelOf, labelLengthLimit,
};
