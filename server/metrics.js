"use strict";

/**
 * 逐题指标层（metrics，纯程序，零 LLM）——设计 §6.1。
 *
 * 长度口径：字符数（code unit）；token 为估算值 ceil(chars / 3.5)（家族系数）。
 * 思考双口径：reasoning（梳理后，主口径）/ reasoningRaw（原始）。
 */

const CHARS_PER_TOKEN = 3.5;

const estTokens = (chars) => (chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0);
const countChars = (s) => (s === null || s === undefined ? 0 : String(s).length);

function countParagraphs(s) {
  const t = String(s ?? "").trim();
  if (!t) return 0;
  return t.split(/\n\s*\n/).filter((p) => p.trim()).length;
}

function countSentences(s) {
  const t = String(s ?? "");
  if (!t.trim()) return 0;
  const m = t.match(/[^.!?。！？]+[.!?。！？]+/g);
  return m ? m.length : (t.trim() ? 1 : 0);
}

/**
 * 单行指标。evalLow：低分阈值（默认 3，0~5 制；evalScore>5 视为别的分制，仍按绝对值比较）。
 */
function computeRowMetrics(row, { evalLow = 3 } = {}) {
  const qChars = countChars(row.question);
  const aChars = countChars(row.answer);
  const rChars = countChars(row.reasoning);
  const rRawChars = countChars(row.reasoningRaw);
  const aTokens = estTokens(aChars);
  const rTokens = estTokens(rChars);

  // 未映射字段（schema 探测后仍归 other 的文本字段）：只计长度，不猜语义
  const extraLens = {};
  if (row.extra) for (const [k, v] of Object.entries(row.extra)) extraLens[k] = countChars(v);

  const hasRefs = Array.isArray(row.references);
  return {
    len: {
      qChars,
      aChars,
      rChars,
      rRawChars,
      qTokens: estTokens(qChars),
      aTokens,
      rTokens,
      rRawTokens: estTokens(rRawChars),
      aParas: countParagraphs(row.answer),
      aSents: countSentences(row.answer),
      reasoningAnswerRatio: rChars > 0 ? Number((rTokens / Math.max(aTokens, 1)).toFixed(3)) : null,
      cleanupCompression: rRawChars > 0 && row.reasoning !== null
        ? Number((1 - rChars / rRawChars).toFixed(3))
        : null,
      extraLens: Object.keys(extraLens).length ? extraLens : null,
    },
    flags: {
      truncated: row.finishReason === "length",
      emptyAnswer: aChars === 0,
      lowScore: row.evalScore !== null && row.evalScore < evalLow,
      refMissing: row.flow === "research" && hasRefs && row.references.length === 0,
      outlierLen: false, // 二次遍历（flagOutliers）按全语料 P1–P99 标注
    },
  };
}

/**
 * 离群标注（需全语料分位数，二次遍历）：答案或思考长度超出 P1–P99 区间 → outlierLen。
 * rows 为「统一行 + 已挂 metrics」的数组（attachMetrics 产物）。
 */
function flagOutliers(rows) {
  const bounds = [
    rows.map((r) => r.metrics.len.aChars).filter((v) => v > 0),
    rows.map((r) => r.metrics.len.rChars).filter((v) => v > 0),
  ].map((vals) => {
    if (vals.length < 20) return null; // 样本太少不算离群
    vals.sort((a, b) => a - b);
    return { lo: quantileSorted(vals, 0.01), hi: quantileSorted(vals, 0.99) };
  });
  for (const r of rows) {
    const { aChars, rChars } = r.metrics.len;
    let out = false;
    if (bounds[0] && aChars > 0 && (aChars < bounds[0].lo || aChars > bounds[0].hi)) out = true;
    if (bounds[1] && rChars > 0 && (rChars < bounds[1].lo || rChars > bounds[1].hi)) out = true;
    r.metrics.flags.outlierLen = out;
  }
  return rows;
}

function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Number((sorted[base] + rest * (sorted[base + 1] - sorted[base])).toFixed(2));
  }
  return sorted[base];
}

/** 给统一行批量挂 metrics（attach 后每行带 .metrics），并做离群二次标注 */
function attachMetrics(rows, opts) {
  for (const r of rows) r.metrics = computeRowMetrics(r, opts);
  flagOutliers(rows);
  return rows;
}

module.exports = { computeRowMetrics, attachMetrics, flagOutliers, estTokens, countChars, CHARS_PER_TOKEN };
