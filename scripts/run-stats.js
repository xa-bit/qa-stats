"use strict";

/**
 * 纯程序统计 CLI（零 LLM，秒出）：读取 jsonl（可多个，字段名未知亦可——自动程序结构
 * 探测），合并已有分类注记（-cls.jsonl，如有），产出完整报告（HTML / MD / CSV）。
 *
 * 用法：node scripts/run-stats.js <qa.jsonl ...> [--out <目录>] [--eval-low 3] [--title 标题]
 */

const path = require("path");
const fs = require("fs");
const { loadQaFile } = require("../server/loader");
const { attachMetrics } = require("../server/metrics");
const { attachCls, loadClsFile, loadTaxonomy, loadContentTypes } = require("../server/classify");
const { aggregate } = require("../server/stats");
const { writeReport, REPORT_DIR_NAME } = require("../server/report");
const { loadState } = require("../server/state");
const { ensureSchemaProgramSync } = require("../server/schema");

function parseArgs(argv) {
  const files = [];
  const opt = { out: "", evalLow: undefined, title: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opt.out = argv[++i];
    else if (a === "--eval-low") opt.evalLow = Number(argv[++i]);
    else if (a === "--title") opt.title = argv[++i];
    else if (a === "--help" || a === "-h") opt.help = true;
    else files.push(a);
  }
  return { files, opt };
}

function main() {
  const { files, opt } = parseArgs(process.argv.slice(2));
  if (opt.help || !files.length) {
    console.log("用法: node scripts/run-stats.js <qa.jsonl ...> [--out <目录>] [--eval-low 3] [--title 标题]");
    process.exit(opt.help ? 0 : 1);
  }
  const state = loadState();
  const evalLow = Number.isFinite(opt.evalLow) ? opt.evalLow : state.evalLow;
  // 触发一次载入（校验 taxonomy 可读；统计本身不依赖，但保持与 Web 端一致的早失败行为）
  loadTaxonomy(state);
  loadContentTypes(state);

  const allRows = [];
  const meta = [];
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`文件不存在，跳过：${f}`);
      continue;
    }
    // 零 LLM 结构探测：旁挂优先，否则程序启发式（question/answer 不可靠时提示走 Web/分类任务的 LLM 仲裁）
    let schema = null;
    try {
      schema = ensureSchemaProgramSync(f);
    } catch {
      schema = null;
    }
    const d = loadQaFile(f, { schema });
    attachMetrics(d.rows, { evalLow });
    attachCls(d.rows, loadClsFile(f).map);
    allRows.push(...d.rows);
    const clsOk = d.rows.filter((r) => r.cls && r.cls.status === "ok" && ((r.cls.subjects && r.cls.subjects.length) || r.cls.contentType)).length;
    meta.push({ file: f, stem: d.stem, flow: d.flow, count: d.rows.length, bad: d.badLines, clsOk });
    const qField = schema && schema.mapping ? schema.mapping.question : "?";
    const aField = schema && schema.mapping ? schema.mapping.answer : "?";
    console.log(`载入 ${path.basename(f)}：${d.rows.length} 行（flow=${d.flow}${d.badLines ? `，坏行 ${d.badLines}` : ""}），已分类 ${clsOk}` +
      (schema ? `；结构：question←"${qField}" answer←"${aField}"${schema.coreReady === false ? "（存疑，建议分类任务时 LLM 仲裁）" : ""}` : ""));
  }
  if (!allRows.length) {
    console.error("没有可用数据");
    process.exit(1);
  }

  const stats = aggregate(allRows);
  const outDir = opt.out || path.join(path.dirname(files[0]), REPORT_DIR_NAME);
  const result = writeReport(outDir, stats, { title: opt.title || "QA 语料统计报告" });

  console.log("\n===== 概览 =====");
  console.log(`样本 ${stats.overview.total} 条 / ${stats.overview.stems} 篇；research ${stats.overview.flows.research} / factual ${stats.overview.flows.factual} / generic ${stats.overview.flows.generic}；截断率 ${stats.overview.truncatedRate}%`);
  if (stats.subject.classified > 0) {
    const top = stats.subject.l1[0];
    console.log(`学科 top：${top ? top.label + " " + top.pct + "%" : "—"}；平均标签 ${stats.subject.multiLabel.avgSubjects} 个/题；「其他」占比 ${stats.subject.otherRate}%；未分类 ${stats.subject.unclassified}`);
  } else {
    console.log("暂无学科分类（先运行 scripts/run-classify.js）");
  }
  if (stats.overview.hasReasoning && stats.length.r.summary) {
    console.log(`思考长度（梳理后）：中位数 ${stats.length.r.summary.median} 字 / 均值 ${stats.length.r.summary.mean} / P90 ${stats.length.r.summary.p90}`);
  }
  if (stats.quality.eval) console.log(`eval：均值 ${stats.quality.eval.summary.mean} / 中位数 ${stats.quality.eval.summary.median}`);
  if (stats.cross.lenScoreCorr.r !== null) console.log(`思考长度 × eval 相关：r = ${stats.cross.lenScoreCorr.r}（n=${stats.cross.lenScoreCorr.n}）`);

  console.log(`\n报告已生成：\n  HTML  ${result.html}${result.echartsInlined ? "" : "（echarts 未内嵌，走 CDN）"}\n  MD    ${result.md}\n  CSV   ${result.csvDir}（${result.csvFiles.length} 个表）`);
}

main();
