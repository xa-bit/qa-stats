"use strict";

/**
 * 报告生成（设计 §8）：
 * - tables/*.csv     各维度明细表（Excel 二次分析）
 * - qa-report.md     Markdown 报告（表格 + 自动要点 + 口径脚注）
 * - qa-report.html   单文件交互报告（内嵌 ECharts + 数据，双击可看，零依赖可分享）
 *
 * 思考长度口径：默认 reasoning（梳理后），rRaw 为原始口径，报告中可切换。
 */

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./util");

const REPORT_DIR_NAME = "qa-stats-report";

// ---------- CSV ----------

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  return lines.join("\n") + "\n";
}

function writeCsvs(csvDir, stats) {
  fs.mkdirSync(csvDir, { recursive: true });
  const files = [];
  const put = (name, headers, rows) => {
    fs.writeFileSync(path.join(csvDir, name), toCsv(headers, rows), "utf8");
    files.push(name);
  };

  put("overview.csv", ["stem", "count", "pct"], stats.overview.perStem);

  put("subject-l1.csv", ["label", "count", "pct"], stats.subject.l1);
  const l2Rows = [];
  for (const n of stats.subject.tree) for (const c of n.children || []) l2Rows.push({ l1: n.name, l2: c.name, count: c.value });
  put("subject-l2.csv", ["l1", "l2", "count"], l2Rows);

  put("content-type.csv", ["label", "count", "pct"], stats.contentType.dist);
  put("ga-pair.csv", ["label", "count", "pct"], stats.gaPair.dist);
  put("ga-content-cross.csv", ["gaPair", "contentType", "count"],
    stats.consistency.gaContentType.cells.map((c) => ({ gaPair: c.a, contentType: c.b, count: c.count })));

  const lenRows = [];
  for (const [key, label] of [["q", "问题"], ["a", "答案"], ["r", "思考(梳理后)"], ["rRaw", "思考(原始)"]]) {
    const s = stats.length[key] && stats.length[key].summary;
    if (s) lenRows.push({ metric: label, ...s });
  }
  if (stats.length.ratio.summary) lenRows.push({ metric: "思考/答案比", ...stats.length.ratio.summary });
  if (stats.length.compression && stats.length.compression.summary) lenRows.push({ metric: "梳理压缩率", ...stats.length.compression.summary });
  put("length-quantiles.csv",
    ["metric", "n", "min", "p25", "median", "p75", "p90", "p95", "max", "mean", "std"], lenRows);

  const groupedRows = [];
  for (const [dim, arr] of Object.entries(stats.length.grouped)) {
    for (const g of arr) {
      groupedRows.push({
        dimension: dim, group: g.group, n: g.n,
        min: g.box[0], p25: g.box[1], median: g.box[2], p75: g.box[3], max: g.box[4], mean: g.mean,
      });
    }
  }
  put("grouped-length.csv", ["dimension", "group", "n", "min", "p25", "median", "p75", "max", "mean"], groupedRows);

  const qRows = [];
  if (stats.quality.eval) qRows.push({ item: "eval 分数", ...stats.quality.eval.summary });
  if (stats.quality.qCheck) {
    qRows.push({ item: "qCheck 总通过率(%)", value: stats.quality.qCheck.passRate });
    for (const [k, v] of Object.entries(stats.quality.qCheck.items)) {
      qRows.push({ item: `qCheck.${k} 通过率(%)`, value: v.passRate });
    }
  }
  if (stats.quality.refMissingRate !== null) qRows.push({ item: "空引用率(%)", value: stats.quality.refMissingRate });
  put("quality.csv", ["item", "n", "min", "p25", "median", "p75", "p90", "p95", "max", "mean", "std", "value"], qRows);

  put("anomalies.csv", ["type", "count", "ids"],
    Object.entries(stats.anomalies).map(([type, v]) => ({ type, count: v.count, ids: (v.ids || []).join(" ") })));

  put("classify-source.csv", ["source", "count"], Object.entries(stats.classifyQuality.source).map(([source, count]) => ({ source, count })));

  put("subject-content-cross.csv", ["subject", "contentType", "count"],
    stats.cross.subjectContentType.cells.map((c) => ({ subject: c.a, contentType: c.b, count: c.count })));

  // v1.1 多标签口径：共现对 + 每题标签数分布
  if (stats.cross.subjectCooccurrence) {
    put("subject-cooccurrence.csv", ["subjectA", "subjectB", "count"],
      stats.cross.subjectCooccurrence.pairs.map((p) => ({ subjectA: p.a, subjectB: p.b, count: p.count })));
  }
  if (stats.subject.multiLabel) {
    put("tags-per-qa.csv", ["tags", "count"], stats.subject.multiLabel.tagsPerQa.map((x) => ({ tags: x.label, count: x.count })));
  }

  return files;
}

// ---------- Markdown ----------

function mdTable(headers, rows, keys) {
  const ks = keys || headers; // 表头（中文）→ 行对象键（英文）映射
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${ks.map((k) => (r[k] === null || r[k] === undefined ? "" : String(r[k]))).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function corrNote(r) {
  if (r === null) return "样本不足，无法计算";
  const a = Math.abs(r);
  const strength = a < 0.2 ? "极弱" : a < 0.5 ? "中等" : "较强";
  return `r = ${r}（${strength}${r >= 0 ? "正相关" : "负相关"}）`;
}

function buildMarkdown(stats, { title }) {
  const L = [];
  L.push(`# ${title || "QA 语料统计报告"}`, "");
  L.push(`> 生成时间：${stats.generatedAt}；样本 ${stats.overview.total} 条（${stats.overview.stems} 篇文献）。`, "");
  L.push("> 口径：长度为字符数；token 为估算值（÷3.5）；思考长度默认梳理后（reasoning）口径，原始口径见 rRaw；箱线/分布图见 HTML 报告。", "");

  L.push("## 1. 规模概览", "");
  L.push(mdTable(["文献", "条数", "占比%"], stats.overview.perStem, ["label", "count", "pct"]), "");
  L.push(`流构成：research ${stats.overview.flows.research} 条 / factual ${stats.overview.flows.factual} 条；截断率 ${stats.overview.truncatedRate}%。`, "");

  L.push("## 2. 学科分布（多标签口径）", "");
  L.push(`已分类 ${stats.subject.classified} 条，未分类 ${stats.subject.unclassified} 条，"其他"占比 ${stats.subject.otherRate}%。`, "");
  if (stats.subject.multiLabel) {
    L.push(`学科为多标签（交叉学科计多标签）：平均每题 ${stats.subject.multiLabel.avgSubjects} 个标签，标签总数 ${stats.subject.multiLabel.tagTotal}；多学科题占比 ${stats.subject.multiLabel.multiTaggedRate}%。每题标签数分布：`, "");
    L.push(mdTable(["每题标签数", "题数"], stats.subject.multiLabel.tagsPerQa, ["label", "count"]), "");
    L.push("> 口径：每个标签各计 1 次，标签总数可大于题数；标签数分布应紧凑（大量 3 标签题=数量纪律失效信号）。", "");
  }
  L.push(mdTable(["一级学科", "标签数", "占已分类%"], stats.subject.l1, ["label", "count", "pct"]), "");
  const l2Rows = [];
  for (const n of stats.subject.tree) for (const c of n.children || []) l2Rows.push({ l1: n.name, l2: c.name, count: c.value });
  if (l2Rows.length) {
    L.push("", "二级学科：", "");
    L.push(mdTable(["一级", "二级", "标签数"], l2Rows, ["l1", "l2", "count"]), "");
  }
  if (stats.cross.subjectCooccurrence && stats.cross.subjectCooccurrence.pairs.length) {
    const co = stats.cross.subjectCooccurrence.pairs.slice(0, 12);
    L.push("", "学科交叉（同题共现的学科对，Top 12）：", "");
    L.push(mdTable(["学科 A", "学科 B", "共现题数"], co, ["a", "b", "count"]), "");
  }

  L.push("## 3. 内容分类", "");
  L.push(mdTable(["内容类型", "条数", "占比%"], stats.contentType.dist, ["label", "count", "pct"]), "");
  if (stats.gaPair.dist.length) {
    L.push("", "提问角度（gaPair，上游生成维度）：", "");
    L.push(mdTable(["gaPair", "条数", "占比%"], stats.gaPair.dist, ["label", "count", "pct"]), "");
  }
  if (stats.consistency.gaPriorMatchRate !== null) {
    L.push("", `gaPair 先验 ↔ LLM 内容类型 一致率：**${stats.consistency.gaPriorMatchRate}%**（已知先验 ${stats.consistency.gaPriorKnown} 条；显著偏低说明分类或上游 GA 标注存在系统性偏差，建议抽查）。`, "");
  }

  L.push("## 4. 思考长度", "");
  if (!stats.overview.hasReasoning) {
    L.push("**本语料无 reasoning 字段（research 轨）**，思考长度板块自动降级；以下为问题/答案长度。", "");
  }
  const lenTable = [];
  for (const [key, label] of [["q", "问题"], ["a", "答案"], ["r", "思考(梳理后)"], ["rRaw", "思考(原始)"]]) {
    const s = stats.length[key] && stats.length[key].summary;
    if (s) lenTable.push({ 指标: label, n: s.n, 中位数: s.median, 均值: s.mean, P25: s.p25, P75: s.p75, P90: s.p90, P95: s.p95, 标准差: s.std, 最小: s.min, 最大: s.max });
  }
  if (stats.length.ratio.summary) lenTable.push({ 指标: "思考/答案比", n: stats.length.ratio.summary.n, 中位数: stats.length.ratio.summary.median, 均值: stats.length.ratio.summary.mean, P25: "", P75: "", P90: "", P95: "", 标准差: "", 最小: "", 最大: "" });
  L.push(mdTable(["指标", "n", "中位数", "均值", "P25", "P75", "P90", "P95", "标准差", "最小", "最大"], lenTable), "");
  if (stats.length.compression && stats.length.compression.summary) {
    L.push(`梳理压缩率（1 − 梳理后/原始）：中位数 ${stats.length.compression.summary.median}，均值 ${stats.length.compression.summary.mean}（负值=梳理后反而更长）。`, "");
  }
  if (stats.truncation.count > 0) {
    L.push(`**截断提示**：${stats.truncation.count} 条（${stats.truncation.rate}%）finishReason=length，其思考长度被系统性低估；截断组思考中位数 ${stats.truncation.truncatedR ? stats.truncation.truncatedR.median : "—"} vs 非截断组 ${stats.truncation.nonTruncatedR ? stats.truncation.nonTruncatedR.median : "—"}。`, "");
  }

  L.push("## 5. 质量", "");
  if (stats.quality.eval) {
    L.push(`eval 分数：均值 ${stats.quality.eval.summary.mean}，中位数 ${stats.quality.eval.summary.median}（n=${stats.quality.eval.summary.n}）；低分（<阈值）${stats.quality.eval.lowCount} 条。`, "");
  }
  if (stats.quality.qCheck) {
    L.push(`qCheck 总通过率 ${stats.quality.qCheck.passRate}%（n=${stats.quality.qCheck.count}）：`, "");
    L.push(mdTable(["子项", "通过率%", "通过/总数"], Object.entries(stats.quality.qCheck.items).map(([k, v]) => ({ 子项: k, "通过率%": v.passRate, "通过/总数": `${v.pass}/${v.total}` }))), "");
  }
  if (stats.quality.refMissingRate !== null) L.push(`research 轨空引用率：${stats.quality.refMissingRate}%。`, "");
  L.push(`思考长度 × eval 分数相关性：${corrNote(stats.cross.lenScoreCorr.r)}（n=${stats.cross.lenScoreCorr.n}）。`, "");

  L.push("## 6. 异常清单", "");
  L.push(mdTable(["类型", "数量"], Object.entries(stats.anomalies).map(([type, v]) => ({ 类型: type, 数量: v.count }))), "");
  L.push("（明细 id 见 tables/anomalies.csv）", "");

  L.push("## 7. 分类质量", "");
  L.push(mdTable(["来源", "条数"], Object.entries(stats.classifyQuality.source).map(([source, count]) => ({ 来源: source, 条数: count }))), "");
  L.push(`待人审 ${stats.classifyQuality.needsReview} 条；先验冲突 ${stats.classifyQuality.conflict} 条；标签数越界（LLM 超量被截断）${stats.classifyQuality.tagsOutOfRange ?? 0} 条；"其他"占比 ${stats.classifyQuality.otherRate}%。`, "");
  return L.join("\n") + "\n";
}

// ---------- 单文件 HTML ----------

function jsEmbed(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}

function buildHtml(stats, { title, echartsSource }) {
  const cards = [
    { k: "QA 总数", v: stats.overview.total },
    { k: "文献数", v: stats.overview.stems },
    { k: stats.overview.hasReasoning ? "思考长度中位数" : "答案长度中位数", v: (stats.overview.hasReasoning ? stats.length.r.summary : stats.length.a.summary)?.median ?? "—" },
    { k: "截断率%", v: stats.overview.truncatedRate },
    { k: "待人审", v: stats.classifyQuality.needsReview },
    { k: "「其他」学科占比%", v: stats.subject.otherRate },
  ];
  const chartDefs = [
    { id: "chart-subject", title: "学科分布（旭日图：内环一级 / 外环二级，多标签计数）" },
    { id: "chart-ct", title: "内容类型分布" },
    { id: "chart-ga", title: "提问角度 gaPair 分布" },
    { id: "chart-hist", title: "长度分布直方图" },
    { id: "chart-box", title: "分组箱线图" },
    { id: "chart-heat", title: "学科 × 内容类型 热力图（主标签口径）" },
    { id: "chart-cooc", title: "学科交叉共现热力图（同题多学科对，交叉学科监控）" },
    { id: "chart-tags", title: "每题学科标签数分布（数量纪律自检）" },
    { id: "chart-scatter", title: "思考长度 × eval 分数" },
    { id: "chart-eval", title: "eval 分数分布" },
    { id: "chart-conf", title: "分类置信度分布（分类质量自检）" },
  ];
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title || "QA 语料统计报告"}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #1f2329; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin: 34px 0 10px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card .k { color: #6b7280; font-size: 12px; } .card .v { font-size: 24px; font-weight: 600; margin-top: 4px; }
  .chart { background: #fff; border-radius: 10px; padding: 12px 12px 6px; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin: 10px 0; }
  .chart h3 { font-size: 14px; margin: 4px 8px; color: #374151; }
  .chart > div.ec { width: 100%; height: 340px; }
  button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 3px 10px; margin: 0 6px 6px 0; cursor: pointer; font-size: 12px; }
  button.on { background: #2563eb; color: #fff; border-color: #2563eb; }
  .note { color: #6b7280; font-size: 12px; margin: 4px 8px 10px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${title || "QA 语料统计报告"}</h1>
  <div class="note">生成于 ${stats.generatedAt} · 样本 ${stats.overview.total} 条 / ${stats.overview.stems} 篇 · 长度为字符数，token 为估算值（÷3.5） · 思考长度默认梳理后口径</div>
  <div class="cards">
    ${cards.map((c) => `<div class="card"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join("\n    ")}
  </div>

  ${chartDefs.map((c) => `<div class="chart"><h3>${c.title}</h3>${c.id === "chart-hist" || c.id === "chart-box" ? `<div id="${c.id}-ctl"></div>` : ""}<div class="ec" id="${c.id}"></div></div>`).join("\n  ")}
</div>
<script>${echartsSource}</script>
<script>
var S = ${jsEmbed(stats)};
var charts = {};
function init(id) { charts[id] = echarts.init(document.getElementById(id)); return charts[id]; }
function axis(name) { return { type: "value", name: name }; }
var catAxis = { type: "category", axisLabel: { interval: 0, rotate: 20 } };

// 1. 学科旭日
(function () {
  if (!S.subject.tree.length) return;
  init("chart-subject").setOption({
    series: [{ type: "sunburst", radius: ["12%", "90%"], label: { fontSize: 11 },
      data: S.subject.tree.map(function (n) { return { name: n.name, value: n.value, children: n.children }; }); }],
  });
})();

// 2/3. 内容类型 & gaPair 条形
function barOf(id, dist, color) {
  var c = init(id);
  if (!dist || !dist.length) { c.setOption({ title: { text: "无数据", left: "center", top: "middle" } }); return; }
  c.setOption({
    grid: { left: 130 },
    xAxis: axis("条数"), yAxis: { type: "category", data: dist.map(function (d) { return d.label; }).reverse() },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: dist.map(function (d) { return d.count; }).reverse(), itemStyle: { color: color },
      label: { show: true, position: "right" } }],
  });
}
barOf("chart-ct", S.contentType.dist, "#2563eb");
barOf("chart-ga", S.gaPair.dist, "#0d9488");

// 4. 长度直方图（口径切换）
(function () {
  var c = init("chart-hist");
  var ctl = document.getElementById("chart-hist-ctl");
  var metrics = [["r", "思考(梳理后)"], ["rRaw", "思考(原始)"], ["a", "答案"], ["q", "问题"]];
  var cur = S.length.r && S.length.r.hist ? "r" : "a";
  function render() {
    var h = S.length[cur] && S.length[cur].hist;
    if (!h) { c.setOption({ title: { text: "该语料无此口径数据", left: "center", top: "middle" } }); return; }
    c.setOption({
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: h.bins.map(function (b) { return Math.round(b.from); }), name: "字符" },
      yAxis: axis("条数"),
      series: [{ type: "bar", data: h.bins.map(function (b) { return b.count; }), itemStyle: { color: "#7c3aed" } }],
    }, true);
  }
  metrics.forEach(function (m) {
    if (!S.length[m[0]] || !S.length[m[0]].hist) return;
    var b = document.createElement("button");
    b.textContent = m[1];
    if (m[0] === cur) b.className = "on";
    b.onclick = function () {
      cur = m[0];
      Array.prototype.forEach.call(ctl.children, function (x) { x.className = ""; });
      b.className = "on";
      render();
    };
    ctl.appendChild(b);
  });
  render();
})();

// 5. 分组箱线（维度切换）
(function () {
  var c = init("chart-box");
  var ctl = document.getElementById("chart-box-ctl");
  var dims = [["byTrack", "按 track"], ["bySubjectL1", "按一级学科"], ["byContentType", "按内容类型"], ["byGaPair", "按 gaPair"]];
  var cur = "bySubjectL1";
  function render() {
    var groups = S.length.grouped[cur] || [];
    if (!groups.length) { c.setOption({ title: { text: "无数据", left: "center", top: "middle" } }, true); return; }
    c.setOption({
      tooltip: { trigger: "item" },
      grid: { left: 130 },
      xAxis: axis(S.length.boxLabel), yAxis: { type: "category", data: groups.map(function (g) { return g.group + " (n=" + g.n + ")"; }) },
      series: [{ type: "boxplot", data: groups.map(function (g) { return g.box; }), itemStyle: { color: "#bfdbfe" } }],
    }, true);
  }
  dims.forEach(function (d) {
    var b = document.createElement("button");
    b.textContent = d[1];
    if (d[0] === cur) b.className = "on";
    b.onclick = function () {
      cur = d[0];
      Array.prototype.forEach.call(ctl.children, function (x) { x.className = ""; });
      b.className = "on";
      render();
    };
    ctl.appendChild(b);
  });
  render();
})();

// 6. 学科 × 内容类型 热力图
(function () {
  var m = S.cross.subjectContentType;
  if (!m.cells.length) return;
  init("chart-heat").setOption({
    tooltip: { position: "top" },
    grid: { left: 130, bottom: 70 },
    xAxis: { type: "category", data: m.bLabels, axisLabel: { rotate: 30 } },
    yAxis: { type: "category", data: m.aLabels },
    visualMap: { min: 0, max: Math.max.apply(null, m.cells.map(function (c) { return c.count; })), calculable: true, orient: "horizontal", left: "center", bottom: 0 },
    series: [{ type: "heatmap", data: m.cells.map(function (c) { return [m.bLabels.indexOf(c.b), m.aLabels.indexOf(c.a), c.count]; }),
      label: { show: true } }],
  });
})();

// 6b. 学科交叉共现热力（多标签同题学科对）
(function () {
  var co = S.cross.subjectCooccurrence;
  if (!co || !co.pairs || !co.pairs.length) { var cc = init("chart-cooc"); cc.setOption({ title: { text: "无交叉学科题（或未分类）", left: "center", top: "middle" } }); return; }
  var labels = co.labels;
  var cells = [];
  co.pairs.forEach(function (p) {
    var i = labels.indexOf(p.a), j = labels.indexOf(p.b);
    cells.push([i, j, p.count]); cells.push([j, i, p.count]);
  });
  var max = co.pairs[0].count;
  init("chart-cooc").setOption({
    tooltip: { position: "top" },
    grid: { left: 110, bottom: 80 },
    xAxis: { type: "category", data: labels, axisLabel: { rotate: 35 } },
    yAxis: { type: "category", data: labels },
    visualMap: { min: 0, max: max, calculable: true, orient: "horizontal", left: "center", bottom: 0 },
    series: [{ type: "heatmap", data: cells, label: { show: true } }],
  });
})();

// 6c. 每题标签数分布（数量纪律）
(function () {
  if (!S.subject.multiLabel || !S.subject.multiLabel.tagsPerQa.length) return;
  init("chart-tags").setOption({
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: S.subject.multiLabel.tagsPerQa.map(function (x) { return x.label; }) },
    yAxis: axis("题数"),
    series: [{ type: "bar", data: S.subject.multiLabel.tagsPerQa.map(function (x) { return x.count; }), itemStyle: { color: "#db2777" }, label: { show: true, position: "top" } }],
  });
})();

// 7. 思考长度 × eval 分数
(function () {
  var c = init("chart-scatter");
  var info = S.cross.lenScoreCorr;
  if (!info || info.r === null) { c.setOption({ title: { text: "样本不足，无法计算相关", left: "center", top: "middle" } }); return; }
  var s = info.pts || [];
  c.setOption({
    title: { text: "Pearson " + info.r, left: "right", textStyle: { fontSize: 12 } },
    tooltip: { trigger: "item" },
    xAxis: axis("估算思考 token"), yAxis: axis("eval 分数"),
    series: [{ type: "scatter", symbolSize: 5, itemStyle: { opacity: 0.55, color: "#dc2626" }, data: s }],
  });
})();

// 8. eval 分布
(function () {
  if (!S.quality.eval || !S.quality.eval.hist) return;
  init("chart-eval").setOption({
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: S.quality.eval.hist.bins.map(function (b) { return b.from; }), name: "分数" },
    yAxis: axis("条数"),
    series: [{ type: "bar", data: S.quality.eval.hist.bins.map(function (b) { return b.count; }), itemStyle: { color: "#d97706" } }],
  });
})();

// 9. 置信度分布
(function () {
  if (!S.classifyQuality.confidenceHist) return;
  init("chart-conf").setOption({
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: S.classifyQuality.confidenceHist.bins.map(function (b) { return b.from; }), name: "confidence" },
    yAxis: axis("标签数"),
    series: [{ type: "bar", data: S.classifyQuality.confidenceHist.bins.map(function (b) { return b.count; }), itemStyle: { color: "#65a30d" } }],
  });
})();

window.addEventListener("resize", function () { Object.values(charts).forEach(function (c) { c.resize(); }); });
</script>
</body>
</html>
`;
}

/** 主入口：写 CSV + MD + HTML 到 outDir。返回产物清单。 */
function writeReport(outDir, stats, { title } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const csvDir = path.join(outDir, "tables");
  const csvFiles = writeCsvs(csvDir, stats);
  const md = buildMarkdown(stats, { title });
  const mdPath = path.join(outDir, "qa-report.md");
  fs.writeFileSync(mdPath, md, "utf8");

  // 单文件 HTML：内嵌本地 vendor 的 echarts（缺失时回退 CDN 引用）
  const echartsPath = path.join(__dirname, "..", "web", "vendor", "echarts.min.js");
  let echartsSource = null;
  try {
    echartsSource = fs.readFileSync(echartsPath, "utf8");
  } catch {
    /* vendor 缺失 */
  }
  const html = echartsSource
    ? buildHtml(stats, { title, echartsSource })
    : buildHtml(stats, { title, echartsSource: "" }).replace(
        "<script></script>",
        '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>'
      );
  const htmlPath = path.join(outDir, "qa-report.html");
  fs.writeFileSync(htmlPath, html, "utf8");

  return {
    dir: outDir,
    html: htmlPath,
    md: mdPath,
    csvDir,
    csvFiles,
    echartsInlined: !!echartsSource,
  };
}

module.exports = { writeReport, buildMarkdown, buildHtml, toCsv, REPORT_DIR_NAME };
