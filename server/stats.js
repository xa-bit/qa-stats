"use strict";

/**
 * 全量聚合层（aggregator）——设计 §7。
 * 输入：统一行（已挂 .metrics 与 .cls），输出纯 JSON 统计结构（机器可读，报告/仪表盘共用）。
 * 口径约定：长度默认字符数；token 为估算；思考主口径 reasoning（梳理后），rRaw 为原始口径。
 */

const { quantileSorted } = (() => {
  // 复用 metrics 的分位数实现，避免循环依赖，这里内联同款
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
  return { quantileSorted };
})();

function sortNums(values) {
  return values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
}

/** 分位数 + 均值/标准差摘要 */
function summary(values) {
  const sorted = sortNums(values);
  if (!sorted.length) return null;
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const std = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const q = (p) => quantileSorted(sorted, p);
  return {
    n,
    min: sorted[0],
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p95: q(0.95),
    max: sorted[n - 1],
    mean: Number(mean.toFixed(2)),
    std: Number(std.toFixed(2)),
  };
}

/** 直方图（bins 桶，min==max 时单桶） */
function histogram(values, bins = 20) {
  const sorted = sortNums(values);
  if (!sorted.length) return null;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const width = max > min ? (max - min) / bins : 1;
  const counts = new Array(max > min ? bins : 1).fill(0);
  for (const v of sorted) {
    let idx = max > min ? Math.floor((v - min) / width) : 0;
    if (idx >= counts.length) idx = counts.length - 1; // v===max
    counts[idx]++;
  }
  return {
    bins: counts.map((count, i) => ({
      from: Number((min + i * width).toFixed(2)),
      to: Number((min + (i + 1) * width).toFixed(2)),
      count,
    })),
  };
}

/** Pearson 相关系数；样本 < 5 返回 null（小样本结果仅供参考，报告标注 n） */
function pearson(pairs) {
  const pts = pairs.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const n = pts.length;
  if (n < 5) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return Number((sxy / Math.sqrt(sxx * syy)).toFixed(3));
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined || k === "") continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

const pct = (count, total) => (total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0);

/** 分组箱线（ECharts boxplot 五元组 [min,p25,median,p75,max] + n + mean） */
function groupBox(rows, keyFn, valFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined || k === "") continue;
    const v = valFn(r);
    if (!Number.isFinite(v)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  return [...groups.entries()]
    .map(([group, vals]) => {
      const s = summary(vals);
      return s
        ? { group, n: s.n, mean: s.mean, box: [s.min, s.p25, s.median, s.p75, s.max] }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.n - a.n);
}

/** 学科 × 内容类型 矩阵 */
function crossMatrix(rows, rowKeyA, rowKeyB) {
  const map = new Map();
  const aSet = new Set();
  const bSet = new Set();
  for (const r of rows) {
    const a = rowKeyA(r);
    const b = rowKeyB(r);
    if (!a || !b) continue;
    aSet.add(a);
    bSet.add(b);
    const k = a + "" + b;
    map.set(k, (map.get(k) || 0) + 1);
  }
  const cells = [];
  for (const [k, count] of map) {
    const [a, b] = k.split("");
    cells.push({ a, b, count });
  }
  return { aLabels: [...aSet], bLabels: [...bSet], cells };
}

/** 主聚合入口 */
function aggregate(rows) {
  const total = rows.length;
  const withReasoning = rows.filter((r) => r.metrics.len.rChars > 0);
  const clsOk = (r) => r.cls && r.cls.status === "ok";
  // 防御性兼容：cls.subjects 缺失但 cls.subject 存在（旧单标签形态/手工构造行）→ 视作单元素数组
  const subjListOf = (r) => {
    if (!r.cls) return [];
    if (Array.isArray(r.cls.subjects)) return r.cls.subjects.filter((s) => s && s.l1);
    return r.cls.subject && r.cls.subject.l1 ? [r.cls.subject] : [];
  };

  // —— 学科分布（多标签计数：每题每个标签各计 1 次；旭日图数据 + 平表）——
  const subjRows = rows.filter((r) => clsOk(r) && subjListOf(r).length);
  const subjectTree = [];
  const subjL1Map = new Map();
  let tagTotal = 0;
  const tagCountByQa = new Map(); // 每题标签数 → 题数（标签数纪律监控）
  for (const r of subjRows) {
    const tags = subjListOf(r);
    tagTotal += tags.length;
    tagCountByQa.set(String(tags.length), (tagCountByQa.get(String(tags.length)) || 0) + 1);
    const seenL1 = new Set(); // 同题内同一级去重（l1 重复时只计一次，l2 分别计）
    for (const s of tags) {
      if (!subjL1Map.has(s.l1)) subjL1Map.set(s.l1, new Map());
      const m = subjL1Map.get(s.l1);
      m.set(s.l2 || "", (m.get(s.l2 || "") || 0) + 1);
      seenL1.add(s.l1);
    }
  }
  for (const [l1, m] of subjL1Map) {
    const children = [...m.entries()]
      .filter(([l2]) => l2)
      .map(([l2, count]) => ({ name: l2, value: count }))
      .sort((a, b) => b.value - a.value);
    const l1Total = [...m.values()].reduce((s, v) => s + v, 0);
    subjectTree.push({ name: l1, value: l1Total, children });
  }
  subjectTree.sort((a, b) => b.value - a.value);
  // 兜底类弹性匹配：英文树用 Other，中文树用 其他
  const isFallbackL1 = (l1) => l1 === "其他" || /^others?$/i.test(l1);
  const otherCount = subjRows.filter((r) => subjListOf(r).some((s) => isFallbackL1(s.l1))).length;

  // —— 学科共现矩阵（交叉学科监控：同题共现的一级学科对）——
  const coocMap = new Map();
  const coocLabels = new Set();
  for (const r of subjRows) {
    const l1s = [...new Set(subjListOf(r).map((s) => s.l1))].sort();
    for (const x of l1s) coocLabels.add(x);
    for (let i = 0; i < l1s.length; i++) {
      for (let j = i + 1; j < l1s.length; j++) {
        const k = `${l1s[i]}	${l1s[j]}`;
        coocMap.set(k, (coocMap.get(k) || 0) + 1);
      }
    }
  }
  const subjectCooccurrence = {
    labels: [...coocLabels].sort(),
    pairs: [...coocMap.entries()].map(([k, count]) => { const [a, b] = k.split("	"); return { a, b, count }; }).sort((x, y) => y.count - x.count),
    multiTagged: subjRows.filter((r) => new Set(subjListOf(r).map((s) => s.l1)).size > 1).length,
  };

  // —— gaPair × contentType 一致性 ——
  const GA_CT = { fact: "概念定义", relation: "关系比较", synthesize: "综合论述", formula: "数值计算" };
  const ctRows = rows.filter((r) => clsOk(r) && r.cls.contentType);
  const gaCt = crossMatrix(
    rows.filter((r) => r.gaPair && clsOk(r) && r.cls.contentType),
    (r) => r.gaPair,
    (r) => r.cls.contentType.type
  );
  let gaCtMatch = 0;
  let gaCtKnown = 0;
  for (const r of rows) {
    if (!r.gaPair || !GA_CT[r.gaPair.toLowerCase()] || !clsOk(r) || !r.cls.contentType) continue;
    gaCtKnown++;
    if (r.cls.contentType.type === GA_CT[r.gaPair.toLowerCase()]) gaCtMatch++;
  }

  // —— 长度分布（双口径）——
  const lengthBlock = (key) => {
    const vals = rows.map((r) => r.metrics.len[key]).filter((v) => v > 0);
    return { summary: summary(vals), hist: histogram(vals) };
  };
  const ratioVals = withReasoning.map((r) => r.metrics.len.reasoningAnswerRatio).filter((v) => v !== null);
  const compVals = rows.map((r) => r.metrics.len.cleanupCompression).filter((v) => v !== null);

  // 分组箱线：思考长度（无思考语料时对答案长度做同维度分组）；
  // 学科维度按多标签展开（每标签各贡献一个样本点，图表口径注明）
  const boxTarget = withReasoning.length ? (r) => r.metrics.len.rChars : (r) => (r.metrics.len.aChars > 0 ? r.metrics.len.aChars : null);
  const boxLabel = withReasoning.length ? "思考长度(字符)" : "答案长度(字符)";
  const subjExpanded = []; // 学科分组专用展开行：每 (题, 标签) 一个样本
  for (const r of subjRows) for (const s of subjListOf(r)) subjExpanded.push({ row: r, l1: s.l1 });
  const grouped = {
    byTrack: groupBox(rows, (r) => r.track, boxTarget),
    bySubjectL1: groupBox(subjExpanded, (x) => x.l1, (x) => boxTarget(x.row)),
    byContentType: groupBox(ctRows, (r) => r.cls.contentType.type, boxTarget),
    byGaPair: groupBox(rows.filter((r) => r.gaPair), (r) => r.gaPair, boxTarget),
  };

  // —— 截断 ——
  const truncated = rows.filter((r) => r.metrics.flags.truncated);
  const truncR = summary(truncated.map((r) => r.metrics.len.rChars).filter((v) => v > 0));
  const nonTruncR = summary(rows.filter((r) => !r.metrics.flags.truncated).map((r) => r.metrics.len.rChars).filter((v) => v > 0));

  // —— 质量 ——
  const evalRows = rows.filter((r) => r.evalScore !== null);
  const qCheckRows = rows.filter((r) => r.qCheck && r.qCheck.passed !== null);
  const qCheckItems = {};
  {
    const itemMap = new Map();
    for (const r of rows) {
      if (!r.qCheck) continue;
      for (const [k, v] of Object.entries(r.qCheck.items || {})) {
        if (v === null) continue;
        if (!itemMap.has(k)) itemMap.set(k, { pass: 0, total: 0 });
        itemMap.get(k).total++;
        if (v) itemMap.get(k).pass++;
      }
    }
    for (const [k, v] of itemMap) qCheckItems[k] = { passRate: pct(v.pass, v.total), pass: v.pass, total: v.total };
  }

  // —— 相关性（散点用原始点，报告里截断上限）——
  const lenScorePts = withReasoning
    .filter((r) => r.evalScore !== null)
    .map((r) => [r.metrics.len.rTokens, r.evalScore]);
  const SCATTER_CAP = 3000;
  const lenScorePtsSampled = lenScorePts.length > SCATTER_CAP
    ? lenScorePts.filter((_, i) => i % Math.ceil(lenScorePts.length / SCATTER_CAP) === 0)
    : lenScorePts;

  // —— 异常清单 ——
  const anomalyIds = (fn) => rows.filter(fn).map((r) => r.id).slice(0, 100);
  const anomalies = {
    truncated: { count: truncated.length, ids: anomalyIds((r) => r.metrics.flags.truncated) },
    emptyAnswer: { count: rows.filter((r) => r.metrics.flags.emptyAnswer).length, ids: anomalyIds((r) => r.metrics.flags.emptyAnswer) },
    outlierLen: { count: rows.filter((r) => r.metrics.flags.outlierLen).length, ids: anomalyIds((r) => r.metrics.flags.outlierLen) },
    lowScore: { count: rows.filter((r) => r.metrics.flags.lowScore).length, ids: anomalyIds((r) => r.metrics.flags.lowScore) },
    refMissing: { count: rows.filter((r) => r.metrics.flags.refMissing).length, ids: anomalyIds((r) => r.metrics.flags.refMissing) },
    needsReview: { count: rows.filter((r) => r.cls && r.cls.needsReview).length, ids: anomalyIds((r) => r.cls && r.cls.needsReview) },
  };

  // —— 分类质量 ——
  const sourceCount = { rule: 0, llm: 0, "llm-judge": 0, human: 0, null: 0 };
  const confVals = [];
  for (const r of rows) {
    if (!r.cls) { sourceCount.null++; continue; }
    const src = r.cls.subjects && r.cls.subjects.length ? r.cls.subjects[0].source : null;
    if (src && sourceCount[src] !== undefined) sourceCount[src]++;
    else if (r.cls.contentType && sourceCount[r.cls.contentType.source] !== undefined) sourceCount[r.cls.contentType.source]++;
    else sourceCount.null++;
    for (const s of subjListOf(r)) {
      if (Number.isFinite(s.confidence)) confVals.push(s.confidence);
    }
    if (r.cls.contentType && Number.isFinite(r.cls.contentType.confidence)) confVals.push(r.cls.contentType.confidence);
  }

  // —— 未知字段长度（schema 探测后仍归 other 的文本字段）——
  const extraAgg = new Map();
  for (const r of rows) {
    const ex = r.metrics.len.extraLens;
    if (!ex) continue;
    for (const [name, chars] of Object.entries(ex)) {
      if (!extraAgg.has(name)) extraAgg.set(name, []);
      extraAgg.get(name).push(chars);
    }
  }
  const extraFields = [...extraAgg.entries()].map(([name, vals]) => ({ name, summary: summary(vals) })).sort((a, b) => (b.summary ? b.summary.n : 0) - (a.summary ? a.summary.n : 0));

  return {
    generatedAt: new Date().toISOString(),
    overview: {
      total,
      stems: new Set(rows.map((r) => r.stem)).size,
      hasReasoning: withReasoning.length > 0,
      perStem: countBy(rows, (r) => r.stem).map((x) => ({ ...x, pct: pct(x.count, total) })),
      flows: {
        research: rows.filter((r) => r.flow === "research").length,
        factual: rows.filter((r) => r.flow === "factual").length,
        generic: rows.filter((r) => r.flow === "generic").length,
      },
      truncatedRate: pct(truncated.length, total),
    },
    subject: {
      classified: subjRows.length,
      unclassified: total - subjRows.length,
      tree: subjectTree,
      l1: subjectTree.map((n) => ({ label: n.name, count: n.value, pct: pct(n.value, subjRows.length) })),
      otherRate: pct(otherCount, subjRows.length),
      // 多标签口径说明：每个标签各计 1 次，标签总数可大于题数
      multiLabel: {
        avgSubjects: subjRows.length ? Number((tagTotal / subjRows.length).toFixed(2)) : 0,
        tagTotal,
        tagsPerQa: [...tagCountByQa.entries()].map(([k, count]) => ({ label: `${k} 个标签`, count })).sort((a, b) => a.label.localeCompare(b.label, "zh-CN", { numeric: true })),
        multiTaggedRate: pct(subjectCooccurrence.multiTagged, subjRows.length),
      },
    },
    contentType: {
      classified: ctRows.length,
      unclassified: total - ctRows.length,
      dist: countBy(ctRows, (r) => r.cls.contentType.type).map((x) => ({ ...x, pct: pct(x.count, ctRows.length) })),
    },
    gaPair: {
      dist: countBy(rows.filter((r) => r.gaPair), (r) => r.gaPair).map((x) => ({ ...x, pct: pct(x.count, total) })),
    },
    consistency: {
      gaContentType: gaCt,
      gaPriorMatchRate: gaCtKnown > 0 ? pct(gaCtMatch, gaCtKnown) : null,
      gaPriorKnown: gaCtKnown,
    },
    length: {
      boxLabel,
      r: lengthBlock("rChars"),
      rRaw: lengthBlock("rRawChars"),
      a: lengthBlock("aChars"),
      q: lengthBlock("qChars"),
      ratio: { summary: summary(ratioVals), hist: histogram(ratioVals) },
      compression: compVals.length ? { summary: summary(compVals), hist: histogram(compVals) } : null,
      grouped,
    },
    truncation: {
      rate: pct(truncated.length, total),
      count: truncated.length,
      byStem: countBy(truncated, (r) => r.stem).map((x) => ({ ...x, pct: pct(x.count, total) })),
      truncatedR: truncR,
      nonTruncatedR: nonTruncR,
    },
    quality: {
      eval: evalRows.length
        ? { count: evalRows.length, summary: summary(evalRows.map((r) => r.evalScore)), hist: histogram(evalRows.map((r) => r.evalScore)), lowCount: rows.filter((r) => r.metrics.flags.lowScore).length }
        : null,
      qCheck: qCheckRows.length
        ? { count: qCheckRows.length, passRate: pct(qCheckRows.filter((r) => r.qCheck.passed).length, qCheckRows.length), items: qCheckItems }
        : null,
      refMissingRate: rows.some((r) => r.flow === "research")
        ? pct(rows.filter((r) => r.metrics.flags.refMissing).length, rows.filter((r) => r.flow === "research").length)
        : null,
    },
    cross: {
      // 学科 × 内容类型：主标签口径（多标签交叉见 subjectCooccurrence）
      subjectContentType: crossMatrix(subjRows, (r) => subjListOf(r)[0].l1, (r) => (r.cls.contentType && r.cls.contentType.type) || null),
      subjectCooccurrence,
      lenScoreCorr: {
        r: pearson(lenScorePts),
        n: lenScorePts.length,
        pts: lenScorePtsSampled,
        note: "Pearson r：估算思考 token × eval 分数",
      },
    },
    anomalies,
    extraFields,
    classifyQuality: {
      source: sourceCount,
      confidenceHist: histogram(confVals, 10),
      needsReview: rows.filter((r) => r.cls && r.cls.needsReview).length,
      conflict: rows.filter((r) => r.cls && r.cls.conflict).length,
      tagsOutOfRange: rows.filter((r) => r.cls && r.cls.tagsOutOfRange).length,
      otherRate: pct(otherCount, Math.max(subjRows.length, 1)),
    },
  };
}

module.exports = { aggregate, summary, histogram, pearson, groupBox, countBy, pct };
