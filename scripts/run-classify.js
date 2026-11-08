"use strict";

/**
 * 分类 CLI：对 -qa.jsonl 执行混合分类（L0 规则 + L1 批量 LLM + L2 仲裁）。
 * 模型配置优先读 server/state.json（与 Web 端共用），可用命令行参数覆盖 primary。
 *
 * 用法：node scripts/run-classify.js <qa.jsonl ...>
 *      [--force] [--batch 12] [--concurrency 2] [--no-judge] [--limit N]
 *      [--endpoint URL] [--model ID] [--api-key KEY]
 *      [--judge-endpoint URL] [--judge-model ID] [--judge-api-key KEY]
 */

const path = require("path");
const fs = require("fs");
const { classifyFile } = require("../server/classify");
const { loadState } = require("../server/state");

function parseArgs(argv) {
  const files = [];
  const opt = { force: false, batch: undefined, concurrency: undefined, useJudge: true, limit: 0 };
  const model = { primary: {}, judge: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opt.force = true;
    else if (a === "--batch") opt.batch = Number(argv[++i]);
    else if (a === "--concurrency") opt.concurrency = Number(argv[++i]);
    else if (a === "--no-judge") opt.useJudge = false;
    else if (a === "--limit") opt.limit = Number(argv[++i]) || 0;
    else if (a === "--endpoint") model.primary.endpoint = argv[++i];
    else if (a === "--model") model.primary.modelId = argv[++i];
    else if (a === "--api-key") model.primary.apiKey = argv[++i];
    else if (a === "--judge-endpoint") model.judge.endpoint = argv[++i];
    else if (a === "--judge-model") model.judge.modelId = argv[++i];
    else if (a === "--judge-api-key") model.judge.apiKey = argv[++i];
    else if (a === "--help" || a === "-h") opt.help = true;
    else files.push(a);
  }
  return { files, opt, model };
}

async function main() {
  const { files, opt, model } = parseArgs(process.argv.slice(2));
  if (opt.help || !files.length) {
    console.log("用法: node scripts/run-classify.js <qa.jsonl ...> [--force] [--batch N] [--concurrency N] [--no-judge]\n" +
      "      [--endpoint URL] [--model ID] [--api-key KEY] [--judge-endpoint URL] [--judge-model ID] [--judge-api-key KEY]");
    process.exit(opt.help ? 0 : 1);
  }
  const settings = loadState();
  if (opt.batch) settings.batchSize = opt.batch;
  if (opt.concurrency) settings.concurrency = opt.concurrency;
  settings.useJudge = opt.useJudge;
  Object.assign(settings.models.primary, model.primary);
  Object.assign(settings.models.judge, model.judge);

  const primary = settings.models.primary;
  const llmRows = files.filter((f) => fs.existsSync(f));
  const missing = files.filter((f) => !fs.existsSync(f));
  for (const m of missing) console.error(`文件不存在，跳过：${m}`);
  if (!llmRows.length) process.exit(1);
  if (!primary.endpoint || !primary.modelId) {
    console.error("主模型未配置：请在 Web 设置页配置 server/state.json，或用 --endpoint/--model 指定");
    process.exit(1);
  }
  console.log(`主模型：${primary.endpoint} · ${primary.modelId}`);
  if (settings.useJudge && settings.models.judge.endpoint && settings.models.judge.modelId) {
    console.log(`仲裁模型：${settings.models.judge.endpoint} · ${settings.models.judge.modelId}`);
  } else {
    console.log("仲裁模型：未配置（低置信/冲突条目将直接进入人审队列）");
  }

  for (const f of llmRows) {
    console.log(`\n===== 分类 ${path.basename(f)} =====`);
    const meta = await classifyFile(f, {
      settings,
      force: opt.force,
      onProgress: (p) => {
        const barLen = 24;
        const filled = p.total ? Math.round((p.done / p.total) * barLen) : 0;
        process.stdout.write(`\r[${"=".repeat(filled)}${" ".repeat(barLen - filled)}] ${p.done}/${p.total}  LLM ${p.llmCalls} · judge ${p.judgeCalls}   `);
      },
    });
    process.stdout.write("\n");
    const c = meta.counts;
    console.log(
      `完成：缓存命中 ${c.cached} · 规则定案 ${c.ruleDecided} · LLM 调用 ${c.llmCalls} · judge ${c.judgeCalls}\n` +
      `      待人审 ${c.needsReview} · 失败 ${c.failed} · 中断未跑 ${c.pending} · 耗时 ${(meta.durationMs / 1000).toFixed(1)}s\n` +
      `      token：LLM ${meta.usage.llm.totalTokens} / judge ${meta.usage.judge.totalTokens}\n` +
      `产物：${f.replace(/\.jsonl$/i, "")}-cls.jsonl`
    );
  }
}

main().catch((e) => {
  console.error("分类失败：", e && e.message ? e.message : e);
  process.exit(1);
});
