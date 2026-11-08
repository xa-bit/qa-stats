"use strict";

/**
 * 报告导出 CLI：对已统计过的文件重新出报告（可指定格式）。
 * 与 run-stats 的区别：仅导出，不打印分析摘要；--format 控制产物
 * （all=HTML+MD+CSV，html/md/csv 单选时其余产物不写）。
 *
 * 用法：node scripts/export-report.js <qa.jsonl ...> [--out <目录>] [--format all|html|md|csv]
 */

const path = require("path");
const fs = require("fs");
const { loadQaFile } = require("../server/loader");
const { attachMetrics } = require("../server/metrics");
const { attachCls, loadClsFile } = require("../server/classify");
const { aggregate } = require("../server/stats");
const { writeReport, REPORT_DIR_NAME, writeCsvs, buildMarkdown } = require("../server/report");
const { loadState } = require("../server/state");
const { ensureSchemaProgramSync } = require("../server/schema");

function parseArgs(argv) {
  const files = [];
  const opt = { out: "", format: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opt.out = argv[++i];
    else if (a === "--format") opt.format = argv[++i];
    else if (a === "--help" || a === "-h") opt.help = true;
    else files.push(a);
  }
  return { files, opt };
}

function main() {
  const { files, opt } = parseArgs(process.argv.slice(2));
  if (opt.help || !files.length || !["all", "html", "md", "csv"].includes(opt.format)) {
    console.log("用法: node scripts/export-report.js <qa.jsonl ...> [--out <目录>] [--format all|html|md|csv]");
    process.exit(opt.help ? 0 : 1);
  }
  const state = loadState();
  const allRows = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let schema = null;
    try {
      schema = ensureSchemaProgramSync(f);
    } catch {
      schema = null;
    }
    const d = loadQaFile(f, { schema });
    attachMetrics(d.rows, { evalLow: state.evalLow });
    attachCls(d.rows, loadClsFile(f).map);
    allRows.push(...d.rows);
  }
  if (!allRows.length) {
    console.error("没有可用数据");
    process.exit(1);
  }
  const stats = aggregate(allRows);
  const outDir = opt.out || path.join(path.dirname(files[0]), REPORT_DIR_NAME);

  if (opt.format === "all") {
    const r = writeReport(outDir, stats, {});
    console.log(`已导出：\n  HTML ${r.html}\n  MD   ${r.md}\n  CSV  ${r.csvDir}`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (opt.format === "csv") {
    const csvs = writeCsvs(path.join(outDir, "tables"), stats);
    console.log(`已导出 CSV（${csvs.length} 个表）：${path.join(outDir, "tables")}`);
  } else if (opt.format === "md") {
    const p = path.join(outDir, "qa-report.md");
    fs.writeFileSync(p, buildMarkdown(stats, {}), "utf8");
    console.log(`已导出 MD：${p}`);
  } else {
    const r = writeReport(outDir, stats, {});
    console.log(`已导出 HTML：${r.html}`);
  }
}

main();
