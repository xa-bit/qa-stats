"use strict";

/**
 * qa-stats 离线自测（不联网、不依赖 LLM 服务；分类走注入的 mock chat）。
 * 运行：npm test 或 node scripts/selftest.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadQaFile, extractEvalScore, extractQCheck } = require("../server/loader");
const { computeRowMetrics, attachMetrics, estTokens } = require("../server/metrics");
const { runRules, mathDensity } = require("../server/rules");
const { extractJsonFromLLMOutput } = require("../server/llm-util");
const { aggregate, summary, histogram, pearson } = require("../server/stats");
const { classifyFile, loadClsFile, attachCls, applyReview, loadTaxonomy, loadContentTypes } = require("../server/classify");
const { writeReport } = require("../server/report");
const { scanRoot } = require("../server/scanner");
const { cacheKeyOf, loadCache } = require("../server/cache");
const { probeProgram, coreReady, ensureSchema, loadSchema, probeWithLlm } = require("../server/schema");
const taxonomyMgr = require("../server/taxonomy");
const { renderTaxonomy, buildClassifyPrompt, buildTaxonomyProposePrompt, fallbackLabelOf } = require("../server/prompts");

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.error(`✗ ${name}\n    ${e && e.message}`);
  }
}

// ---------------- fixture ----------------

const FACTUAL_ROWS = [
  {
    id: "q1", gaPair: "fact", track: "non-math", chunkIndex: 2, chunkName: "Chapter 2 Ocean Circulation",
    question: "How does the wind-driven surface gyre redistribute heat in the subtropical ocean?",
    answer: "The subtropical gyre accumulates warm water on its western side and releases it poleward through western boundary currents.",
    reasoning: "The question asks about gyre-scale heat transport. Ekman pumping drives interior Sverdrup flow, and western intensification concentrates the return flow.",
    reasoningRaw: "Output answer only. The question asks about gyre-scale heat transport. Ekman pumping drives interior Sverdrup flow, and western intensification concentrates the return flow.",
    finishReason: "stop", label: "overview", model: "mock-1",
    qCheck: { accuracy: true, completeness: true, factual_ok: true }, eval: { score: 4.5 },
  },
  {
    id: "q2", gaPair: "relation", track: "non-math", chunkIndex: 1, chunkName: "Chapter 1",
    question: "Explain the relationship between the two quantities introduced in this section.",
    answer: "The two quantities covary: increasing the first raises the second through the balance described in the text.",
    reasoning: "Identify both quantities, then link them via the stated balance.",
    reasoningRaw: null, finishReason: "stop", model: "mock-1",
    qCheck: { accuracy: true, completeness: false, factual_ok: true }, eval: { score: 3.0 },
  },
  {
    id: "q3", gaPair: "fact", track: "non-math", chunkIndex: 1, chunkName: "Chapter 1",
    question: "What does the key term introduced here mean?",
    answer: "It denotes the vertical boundary separating two distinct regimes.",
    reasoning: "Locate the definition sentence and restate it.", reasoningRaw: null,
    finishReason: "stop", model: "mock-1",
    qCheck: { accuracy: true, completeness: true, factual_ok: true }, eval: 4.0,
  },
  {
    id: "q4", gaPair: "synthesize", track: "non-math", chunkIndex: 2, chunkName: "Chapter 2 Ocean Circulation",
    question: "Synthesize the two processes described above into a single coherent account.",
    answer: "Together they form a coupled sequence: the first sets the background state and the second modulates it seasonally.",
    reasoning: "Combine process A and process B along the seasonal timeline.", reasoningRaw: null,
    finishReason: "stop", model: "mock-1",
    qCheck: { accuracy: true, completeness: true, factual_ok: true }, eval: 5,
  },
  {
    id: "q5", gaPair: "formula", track: "math", chunkIndex: 4, chunkName: "Chapter 4",
    question: "Compute the Rossby number Ro = U/(f*L) for U = 0.1 m/s, L = 1000 km = 1e6 m, f = 1e-4 s^-1, and interpret the value.",
    answer: "Ro = 0.1 / (1e-4 * 1e6) = 1e-3, indicating rotation dominates the motion.",
    reasoning: "Substitute the values and evaluate the ratio; compare with unity.",
    reasoningRaw: "Substitute the values and evaluate the ratio; compare with unity. (任务性内容已略)",
    finishReason: "stop", model: "mock-1",
    qCheck: { accuracy: true, completeness: true, factual_ok: true }, eval: { score: 4.8 },
  },
  {
    id: "q6", gaPair: "formula", track: "math", chunkIndex: 3, chunkName: "Chapter 3 Tides",
    question: "Using R = 0.5 m and phi = 45°, compute the equilibrium tide term 2R*cos^2(45°) = 0.25 m, then estimate the spring range 0.5 + 0.2 = 0.7 m.",
    answer: "2*0.5*(cos45°)^2 = 0.25 m; the spring range sums lunar 0.5 m and solar 0.2 m to 0.7 m.",
    reasoning: "Apply the equilibrium tide formula, then add the lunar and solar contributions for spring tide.",
    reasoningRaw: "Apply the equilibrium tide formula, then add the lunar and solar contributions for spring tide.",
    finishReason: "length", model: "mock-1",
    qCheck: { accuracy: true, completeness: true, factual_ok: false }, eval: { score: 4.2 },
  },
];

const RESEARCH_ROWS = [
  {
    id: "p1", gaPair: "fact", chunkIndex: 3, chunkName: "3 Results", label: "results",
    question: "What did the authors conclude about export flux attenuation?",
    answer: "They concluded that attenuation follows a power law with depth.",
    references: ["Smith et al. 2020, Nature"], model: "mock-2",
    qCheck: { accuracy: true, completeness: true, citations_ok: true }, eval: { score: 4.0 },
  },
  {
    id: "p2", gaPair: "relation", chunkIndex: 3, chunkName: "3 Results", label: "results",
    question: "How does their estimate compare with previous studies?",
    answer: "It is roughly half of earlier values.",
    references: [], model: "mock-2",
    qCheck: { accuracy: true, completeness: false, citations_ok: false }, eval: { score: 2.5 },
  },
  {
    id: "p3", gaPair: "synthesize", chunkIndex: 4, chunkName: "4 Discussion", label: "discussion",
    question: "Synthesize the implications of the reduced flux estimate.",
    answer: "A lower flux implies longer carbon residence times and weaker sequestration.",
    references: ["Smith et al. 2020, Nature", "Jones 2019, GBC"], model: "mock-2",
    qCheck: { accuracy: true, completeness: true, citations_ok: true }, eval: { score: 4.8 },
  },
];

function makeFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-test-"));
  fs.writeFileSync(path.join(dir, "bookA-qa.jsonl"), FACTUAL_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "paperB-qa.jsonl"), RESEARCH_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

// ---------------- mock LLM ----------------

/**
 * 按 id 策略返回结果的 mock chat。策略：
 *  valid 默认（物理海洋学/海洋环流 + 机理过程，conf 0.9）
 *  "omit"      该批不返回（触发单题降级）
 *  "omit-once" 首次不返回，第二次（单题重试）返回
 *  "invalid"   标签全非法（触发缺失仲裁）
 *  "lowconf"   conf 0.4（触发低置信仲裁）
 *  fn(id, nth) 自定义
 */
function mockChat(policy = {}, defaults) {
  const d = defaults || {
    subject: { l1: "物理海洋学", l2: "海洋环流" },
    contentType: "机理过程",
    confidence: 0.9,
    reasons: "题面与章节指向环流",
  };
  const calls = { count: 0, byId: {} };
  const fn = async (messages) => {
    calls.count++;
    const user = messages[messages.length - 1].content;
    let ids = [];
    const iList = user.indexOf("题目列表：");
    const iSingle = user.indexOf("题目：");
    try {
      if (iList !== -1) ids = JSON.parse(user.slice(iList + 5).trim()).map((x) => String(x.id));
      else if (iSingle !== -1) ids = JSON.parse(user.slice(iSingle + 3).trim()).map((x) => String(x.id));
    } catch {
      /* 解析失败 → 空响应，触发容错路径 */
    }
    const out = [];
    for (const id of ids) {
      calls.byId[id] = (calls.byId[id] || 0) + 1;
      const p = policy[id];
      if (p === "omit") continue;
      if (p === "omit-once" && calls.byId[id] === 1) continue;
      if (p === "invalid") {
        out.push({ id, subject: { l1: "不存在学科", l2: "xx" }, contentType: "不存在类型", confidence: 0.9, reasons: "" });
        continue;
      }
      if (p === "lowconf") {
        out.push({ id, subject: { l1: "气象学与气候", l2: "大气动力" }, contentType: "机理过程", confidence: 0.4, reasons: "把握不足" });
        continue;
      }
      if (typeof p === "function") {
        out.push(p(id, calls.byId[id]));
        continue;
      }
      out.push({ id, subject: { ...d.subject }, contentType: d.contentType, confidence: d.confidence, reasons: d.reasons });
    }
    return {
      ok: true, content: JSON.stringify(out), finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, error: null,
    };
  };
  fn.calls = calls;
  return fn;
}

const judgeMock = () => mockChat({}, {
  subject: { l1: "数学与统计方法", l2: "统计与数据分析" },
  contentType: "数值计算",
  confidence: 0.85,
  reasons: "仲裁确认",
});

// ---------------- 单元测试 ----------------

async function unitTests() {
  const dir = makeFixtureDir();

  await check("loader：factual 轨识别（reasoning 字段）", async () => {
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    assert.strictEqual(d.flow, "factual");
    assert.strictEqual(d.rows.length, 6);
    assert.strictEqual(d.rows[0].reasoning.length > 0, true);
  });

  await check("loader：research 轨识别（references、reasoning=null）", async () => {
    const d = loadQaFile(path.join(dir, "paperB-qa.jsonl"));
    assert.strictEqual(d.flow, "research");
    assert.strictEqual(d.rows[0].reasoning, null);
    assert.deepStrictEqual(d.rows[0].references, ["Smith et al. 2020, Nature"]);
  });

  await check("loader：eval 分数多形态抽取", async () => {
    assert.strictEqual(extractEvalScore(4.5), 4.5);
    assert.strictEqual(extractEvalScore({ score: 4 }), 4);
    assert.strictEqual(extractEvalScore({ overall: 3 }), 3);
    assert.strictEqual(extractEvalScore("4"), 4);
    assert.strictEqual(extractEvalScore("abc"), null);
  });

  await check("loader：qCheck 子项多形态归一", async () => {
    const q = extractQCheck({ a: true, b: "no", c: 0, d: 1, e: "unknown" });
    assert.strictEqual(q.items.a, true);
    assert.strictEqual(q.items.b, false);
    assert.strictEqual(q.items.c, false);
    assert.strictEqual(q.items.d, true);
    assert.strictEqual(q.passed, false);
  });

  await check("metrics：长度/token/比例/压缩率", async () => {
    assert.strictEqual(estTokens(350), 100);
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    const m = computeRowMetrics(d.rows[0]);
    assert.strictEqual(m.len.qChars, d.rows[0].question.length);
    assert.strictEqual(m.len.aChars, d.rows[0].answer.length);
    assert.strictEqual(m.len.rChars, d.rows[0].reasoning.length);
    assert.ok(m.len.reasoningAnswerRatio > 0);
    const m5 = computeRowMetrics(d.rows[4]); // q5 有 reasoningRaw
    assert.ok(m5.len.cleanupCompression > 0 && m5.len.cleanupCompression < 1);
    const m2 = computeRowMetrics(d.rows[1]); // q2 无 reasoningRaw
    assert.strictEqual(m2.len.cleanupCompression, null);
  });

  await check("metrics：标志位（截断/空答案/低分/空引用）", async () => {
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    const rows = attachMetrics(d.rows.slice());
    assert.strictEqual(rows[5].metrics.flags.truncated, true); // q6
    assert.strictEqual(rows[5].metrics.flags.lowScore, false); // 4.2 >= 3
    const r = loadQaFile(path.join(dir, "paperB-qa.jsonl"));
    const rrows = attachMetrics(r.rows.slice());
    assert.strictEqual(rrows[1].metrics.flags.refMissing, true); // p2 空 references
    assert.strictEqual(rrows[1].metrics.flags.lowScore, true); // 2.5 < 3
  });

  await check("metrics：离群二次标注（P1–P99）", async () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ id: "x" + i, stem: "s", flow: "factual", question: "q", answer: "a".repeat(100), reasoning: null, reasoningRaw: null, finishReason: null, references: null, evalScore: 4, qCheck: null });
    }
    rows[3].answer = "a".repeat(5000); // 离群
    attachMetrics(rows);
    assert.strictEqual(rows[3].metrics.flags.outlierLen, true);
    assert.strictEqual(rows[0].metrics.flags.outlierLen, false);
  });

  await check("rules：数学密度判定", async () => {
    assert.ok(mathDensity("Ro = 0.1 / (1e-4 * 1e6) = 1e-3 m/s") >= 0.04);
    assert.ok(mathDensity("The gyre redistributes heat in the subtropical ocean slowly.") < 0.04);
  });

  await check("rules：formula + 高密度 → 数值计算定案", async () => {
    const tax = loadTaxonomy({});
    const cts = loadContentTypes({});
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    const rr = runRules(d.rows[4], tax, cts); // q5
    assert.strictEqual(rr.contentType.type, "数值计算");
    assert.strictEqual(rr.contentType.confidence, 0.95);
  });

  await check("rules：track=math + 密度 → 0.9 先验", async () => {
    const tax = loadTaxonomy({});
    const cts = loadContentTypes({});
    const row = { stem: "x", question: "Compute 5% of 200 = 10 with 2 steps.", answer: "10", gaPair: "method", track: "math", chunkName: "" };
    const rr = runRules(row, tax, cts);
    assert.strictEqual(rr.contentType.type, "数值计算");
    assert.strictEqual(rr.contentType.confidence, 0.9);
  });

  await check("rules：章节关键词 → 学科先验（Tides→波浪与潮汐）", async () => {
    const tax = loadTaxonomy({});
    const cts = loadContentTypes({});
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    const rr = runRules(d.rows[5], tax, cts); // q6 chunkName=Chapter 3 Tides
    assert.strictEqual(rr.subject.l1, "物理海洋学");
    assert.strictEqual(rr.subject.l2, "波浪与潮汐");
    assert.strictEqual(rr.subject.confidence, 0.9);
    assert.strictEqual(rr.decided, true); // ct 亦定案
  });

  await check("rules：gaPair=fact → 概念定义弱先验", async () => {
    const tax = loadTaxonomy({});
    const cts = loadContentTypes({});
    const row = { stem: "x", question: "What does the term mean here?", answer: "It is defined as ...", gaPair: "fact", track: "non-math", chunkName: "Chapter 1" };
    const rr = runRules(row, tax, cts);
    assert.strictEqual(rr.contentType.type, "概念定义");
    assert.strictEqual(rr.contentType.confidence, 0.55);
    assert.strictEqual(rr.decided, false);
  });

  await check("rules：白名单校验（树中不存在 → 丢弃）", async () => {
    const tax = { version: 1, tree: [{ label: "其他", desc: "", children: [] }] };
    const cts = loadContentTypes({});
    const row = { stem: "tide-book", question: "What is a tide?", answer: "...", gaPair: "fact", track: "non-math", chunkName: "Chapter 3 Tides" };
    const rr = runRules(row, tax, cts);
    assert.strictEqual(rr.subject, null); // 波浪与潮汐不在树中
  });

  await check("llm-util：JSON 提取（裸数组/围栏/think 包裹/截断修复）", async () => {
    assert.deepStrictEqual(extractJsonFromLLMOutput('[{"id":"a"}]'), [{ id: "a" }]);
    assert.deepStrictEqual(extractJsonFromLLMOutput('```json\n[{"id":"a"}]\n```'), [{ id: "a" }]);
    assert.deepStrictEqual(extractJsonFromLLMOutput('<think>reasoning</think>[{"id":"a"}]'), [{ id: "a" }]);
    const repaired = extractJsonFromLLMOutput('[{"id":"a"');
    assert.ok(Array.isArray(repaired));
  });

  await check("stats：分位数与摘要", async () => {
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = summary(vals);
    assert.strictEqual(s.median, 50.5);
    assert.strictEqual(s.p25, 25.75);
    assert.strictEqual(s.min, 1);
    assert.strictEqual(s.max, 100);
    assert.strictEqual(s.mean, 50.5);
  });

  await check("stats：直方图计数守恒", async () => {
    const h = histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    assert.strictEqual(h.bins.reduce((s, b) => s + b.count, 0), 10);
    assert.strictEqual(h.bins.length, 5);
  });

  await check("stats：Pearson 完全线性 = 1", async () => {
    const pts = Array.from({ length: 20 }, (_, i) => [i, 2 * i + 1]);
    assert.strictEqual(pearson(pts), 1);
  });

  await check("stats：聚合结构完整性（含 cls）", async () => {
    const tax = loadTaxonomy({});
    const cts = loadContentTypes({});
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    attachMetrics(d.rows);
    for (const r of d.rows) {
      const rr = runRules(r, tax, cts);
      r.cls = {
        status: "ok",
        subject: rr.subject ? { ...rr.subject } : { l1: "物理海洋学", l2: "海洋环流", confidence: 0.8, source: "llm" },
        contentType: rr.contentType ? { ...rr.contentType } : { type: "机理过程", confidence: 0.8, source: "llm" },
        needsReview: false, conflict: false,
      };
    }
    const s = aggregate(d.rows);
    assert.strictEqual(s.overview.total, 6);
    assert.ok(s.subject.tree.length > 0);
    assert.ok(s.length.r.summary);
    assert.ok(s.length.grouped.bySubjectL1.length > 0);
    assert.ok(s.cross.subjectContentType.cells.length > 0);
    assert.ok(s.cross.lenScoreCorr.r !== null);
    assert.strictEqual(s.overview.truncatedRate, 16.7); // 1/6
    assert.ok(s.quality.qCheck.passRate > 0);
    assert.strictEqual(s.anomalies.truncated.count, 1);
  });

  await check("report：三形态产物（HTML 内嵌 echarts / MD / CSV）", async () => {
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    attachMetrics(d.rows);
    attachCls(d.rows, loadClsFile(path.join(dir, "bookA-qa.jsonl")).map);
    const s = aggregate(d.rows);
    const out = path.join(dir, "qa-stats-report");
    const r = writeReport(out, s, { title: "自测报告" });
    assert.ok(fs.existsSync(r.html));
    assert.ok(fs.existsSync(r.md));
    const html = fs.readFileSync(r.html, "utf8");
    assert.ok(html.includes("学科分布"));
    assert.ok(html.includes("Apache Software Foundation") || html.includes("echarts")); // echarts 已内嵌或 CDN 引用
    const md = fs.readFileSync(r.md, "utf8");
    assert.ok(md.includes("思考长度") && md.includes("口径"));
    assert.ok(r.csvFiles.length >= 10);
    assert.ok(fs.existsSync(path.join(r.csvDir, "subject-l1.csv")));
  });

  await check("scanner：跳过 node_modules / qa-stats-cache", async () => {
    fs.mkdirSync(path.join(dir, "node_modules", "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, "qa-stats-cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "sub", "bad-qa.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "qa-stats-cache", "bad2-qa.jsonl"), "{}\n");
    const found = scanRoot(dir);
    const names = found.map((f) => path.basename(f.path)).sort();
    assert.deepStrictEqual(names, ["bookA-qa.jsonl", "paperB-qa.jsonl"]);
  });

  await check("cache：键稳定 + 版本失效", async () => {
    const d = loadQaFile(path.join(dir, "bookA-qa.jsonl"));
    const k1 = cacheKeyOf(d.rows[0]);
    const k2 = cacheKeyOf(d.rows[0]);
    assert.strictEqual(k1, k2);
    assert.notStrictEqual(k1, cacheKeyOf(d.rows[1]));
  });

  return dir;
}

// ---------------- 分类引擎集成测试（mock LLM） ----------------

async function classifyTests() {
  const mkSettings = (over = {}) => ({
    models: {
      primary: { endpoint: "http://mock", apiKey: "", modelId: "mock", temperature: 0, maxTokens: 4096 },
      judge: { endpoint: "http://mock-judge", apiKey: "", modelId: "mock-judge", temperature: 0, maxTokens: 1024 },
    },
    batchSize: 12,
    concurrency: 1,
    lowConf: 0.6,
    useJudge: true,
    ...over,
  });

  await check("classify：全流程（规则定案/批量/单题降级/judge 仲裁）", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    const primary = mockChat({ q4: "omit-once", q3: "invalid", q2: "lowconf" });
    const meta = await classifyFile(f, {
      settings: mkSettings(),
      chatFn: primary,
      judgeChatFn: judgeMock(),
    });
    const cls = loadClsFile(f).map;

    // q1 的 chunkName 含 "Circulation" → 章节关键词先验 0.9 定案学科；内容类型由 LLM 补位
    assert.strictEqual(cls.get("q1").subject.source, "rule");
    assert.strictEqual(cls.get("q1").subject.l2, "海洋环流");
    assert.strictEqual(cls.get("q1").contentType.source, "llm");
    assert.strictEqual(cls.get("q2").subject.source, "llm-judge"); // 低置信 → judge
    assert.strictEqual(cls.get("q2").subject.confidence, 0.85);
    assert.strictEqual(cls.get("q2").needsReview, false);
    assert.strictEqual(cls.get("q3").subject.source, "llm-judge"); // 非法标签 → 缺失仲裁
    assert.strictEqual(cls.get("q4").subject.source, "rule"); // q4 章节名同含 Circulation
    assert.strictEqual(cls.get("q4").contentType.source, "llm"); // 单题降级成功（内容类型维度）
    assert.strictEqual(cls.get("q5").contentType.source, "rule"); // formula 定案不被 LLM 覆盖
    assert.strictEqual(cls.get("q5").contentType.type, "数值计算");
    assert.strictEqual(cls.get("q6").subject.l2, "波浪与潮汐"); // 全规则定案
    assert.strictEqual(cls.get("q6").subject.source, "rule");
    assert.strictEqual(cls.get("q6").contentType.type, "数值计算");

    assert.strictEqual(meta.counts.llmCalls, 2); // 批量 1 + 单题 1
    assert.strictEqual(meta.counts.judgeCalls, 2); // q2 + q3
    assert.strictEqual(meta.counts.ruleDecided, 1); // q6
    assert.strictEqual(meta.counts.needsReview, 0);
    const cache = loadCache(f);
    assert.strictEqual(Object.keys(cache.entries).length, 6);
  });

  await check("classify：二跑全缓存命中（0 LLM 调用）", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    const primary = mockChat({});
    await classifyFile(f, { settings: mkSettings(), chatFn: primary, judgeChatFn: judgeMock() });
    const primary2 = mockChat({});
    const meta = await classifyFile(f, { settings: mkSettings(), chatFn: primary2, judgeChatFn: judgeMock() });
    assert.strictEqual(meta.counts.cached, 6);
    assert.strictEqual(primary2.calls.count, 0);
  });

  await check("classify：taxonomy 版本变更 → 缓存失效", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({}), judgeChatFn: judgeMock() });
    const tax2 = JSON.parse(JSON.stringify(loadTaxonomy({})));
    tax2.version = 999;
    const meta = await classifyFile(f, { settings: mkSettings(), taxonomy: tax2, chatFn: mockChat({}), judgeChatFn: judgeMock() });
    assert.strictEqual(meta.counts.cached, 0);
  });

  await check("classify：无 judge → 低置信/非法进人审队列", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    const meta = await classifyFile(f, {
      settings: mkSettings({ useJudge: false }),
      chatFn: mockChat({ q2: "lowconf", q3: "invalid" }),
    });
    const cls = loadClsFile(f).map;
    assert.strictEqual(cls.get("q2").needsReview, true);
    assert.strictEqual(cls.get("q3").needsReview, true);
    assert.strictEqual(cls.get("q1").needsReview, false);
    assert.ok(meta.counts.needsReview >= 2);
  });

  await check("classify：LLM 整体失败 → status failed + 人审，不丢行", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    const failing = async () => ({ ok: false, content: "", finishReason: null, usage: null, error: "连接拒绝" });
    const meta = await classifyFile(f, { settings: mkSettings(), chatFn: failing, judgeChatFn: judgeMock() });
    assert.strictEqual(meta.counts.failed, 5); // q1-q5（q6 规则定案不依赖 LLM）
    const cls = loadClsFile(f).map;
    assert.strictEqual(cls.get("q1").status, "failed");
    assert.strictEqual(cls.get("q1").needsReview, true);
    assert.strictEqual(cls.get("q6").status, "ok"); // 规则行不受影响
    assert.strictEqual(meta.counts.total, 6); // 行数守恒
  });

  await check("classify：人审确认 → 重跑锁定不被覆盖", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({}), judgeChatFn: judgeMock() });
    const rv = applyReview(f, "q1", { subject: { l1: "数学与统计方法", l2: "统计与数据分析" }, contentType: "数值计算" }, {});
    assert.strictEqual(rv.ok, true);
    const meta = await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({}), judgeChatFn: judgeMock() });
    const cls = loadClsFile(f).map;
    assert.strictEqual(cls.get("q1").subject.source, "human");
    assert.strictEqual(cls.get("q1").confirmed, true);
    assert.strictEqual(meta.counts.humanLocked, 1);
  });

  await check("classify：人审非法标签被拒", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    const rv = applyReview(f, "q1", { subject: { l1: "不存在的学科", l2: "" } }, {});
    assert.strictEqual(rv.ok, false);
  });

  await check("classify：同内容不同 id 共享缓存但 id 不串行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-test-"));
    const row = {
      id: "a1", gaPair: "fact", track: "non-math", chunkIndex: 1, chunkName: "Chapter 1",
      question: "What does the neutral term mean?", answer: "It denotes the background state.",
      reasoning: "Locate the definition.", reasoningRaw: null, finishReason: "stop",
      label: "overview", model: "m", qCheck: { accuracy: true }, eval: 4,
    };
    const twin = { ...row, id: "a2" }; // 完全同内容、不同 id → 同一缓存键
    const f = path.join(dir, "dup-qa.jsonl");
    fs.writeFileSync(f, [row, twin].map((r) => JSON.stringify(r)).join("\n") + "\n");
    await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({}), judgeChatFn: judgeMock() });
    const meta = await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({}), judgeChatFn: judgeMock() });
    assert.strictEqual(meta.counts.cached, 2);
    const cls = loadClsFile(f);
    assert.strictEqual(cls.map.get("a1").id, "a1");
    assert.strictEqual(cls.map.get("a2").id, "a2");
    assert.ok(cls.map.get("a2").subject);
  });
}

// ---------------- 结构探测测试（未知字段名语料） ----------------

const UNKNOWN_ROWS = [
  {
    no: 1,
    query1: "What is the thermocline?",
    resp1: "The thermocline is the layer of rapid temperature decrease with depth.\n\nIt separates the mixed layer from the deep ocean.",
    notes: "generated by pipeline v9",
    lang: "en",
  },
  {
    no: 2,
    query1: "Why does salinity affect density?",
    resp1: "More dissolved salt increases water density at fixed temperature.\n\nThis drives haline convection.",
    notes: "generated by pipeline v9",
    lang: "en",
  },
];

async function schemaTests() {
  await check("schema：程序探测（未知字段名 → 角色映射，零 LLM）", async () => {
    const probe = probeProgram(UNKNOWN_ROWS);
    assert.strictEqual(probe.mapping.question, "query1");
    assert.strictEqual(probe.mapping.answer, "resp1");
    assert.strictEqual(probe.mapping.id, "no"); // 唯一数值字段 → id/chunkIndex 类
    assert.ok(coreReady(probe));
    assert.strictEqual(probe.source, "program");
  });

  await check("schema：别名命中（家族字段 question/answer/reasoning）", async () => {
    const probe = probeProgram(FACTUAL_ROWS);
    assert.strictEqual(probe.mapping.question, "question");
    assert.strictEqual(probe.mapping.answer, "answer");
    assert.strictEqual(probe.mapping.reasoning, "reasoning");
    assert.ok((probe.confidence.question ?? 0) >= 0.9);
  });

  await check("schema：歧义字段 → 置信不足 → LLM 仲裁", async () => {
    // 两个长文本字段，名字无语义，程序无法可靠区分 answer/reasoning
    const raws = [
      { zz1: "The result follows from continuity and conservation.".repeat(3), zz2: "First, we consider the balance. Therefore, the answer follows from step one to step two.".repeat(2), rid: 1 },
      { zz1: "It is defined as the vertical gradient of density.".repeat(3), zz2: "Next, we apply the definition. In summary, it denotes stratification.".repeat(2), rid: 2 },
    ];
    const probe = probeProgram(raws);
    assert.strictEqual(coreReady(probe), false, "程序应无法可靠判定（触发 LLM）");
    const chat = async (messages) => ({
      ok: true,
      content: JSON.stringify({ mapping: { zz1: "answer", zz2: "reasoning", rid: "id" }, notes: "按内容区分" }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const merged = await probeWithLlm(probe, { chatFn: chat });
    assert.strictEqual(merged.source, "llm");
    assert.strictEqual(merged.mapping.answer, "zz1");
    assert.strictEqual(merged.mapping.reasoning, "zz2");
    assert.strictEqual(merged.mapping.id, "rid");
  });

  await check("schema：LLM 非法角色/字段名被丢弃", async () => {
    const raws = [{ aa: "hello?", bb: "world".repeat(20), rid: 1 }];
    const probe = probeProgram(raws);
    const chat = async () => ({
      ok: true,
      content: JSON.stringify({ mapping: { aa: "question", bb: "不存在的角色", cc: "answer" }, notes: "" }),
      usage: null,
    });
    const merged = await probeWithLlm(probe, { chatFn: chat });
    assert.strictEqual(merged.mapping.question, "aa");
    assert.strictEqual(merged.mapping.answer, undefined); // cc 不存在 / bb 角色非法 → 丢弃
  });

  await check("schema：ensureSchema 旁挂保存/读取/force 重探测", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-schema-"));
    const f = path.join(dir, "unknown-qa.jsonl");
    fs.writeFileSync(f, UNKNOWN_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r1 = await ensureSchema(f, { allowLlm: false });
    assert.strictEqual(r1.changed, true);
    assert.ok(loadSchema(f), "旁挂 schema 文件已写入");
    const r2 = await ensureSchema(f, { allowLlm: false });
    assert.strictEqual(r2.changed, false); // 二次直接命中旁挂
    const r3 = await ensureSchema(f, { allowLlm: false, force: true });
    assert.strictEqual(r3.changed, true); // force 重探测
  });

  await check("loader：schema 映射载入 + generic 流 + 未知字段长度", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-schema-"));
    const f = path.join(dir, "unknown-qa.jsonl");
    fs.writeFileSync(f, UNKNOWN_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { schema } = await ensureSchema(f, { allowLlm: false });
    const d = loadQaFile(f, { schema });
    assert.strictEqual(d.flow, "generic"); // 无 reasoning/track/references
    assert.strictEqual(d.rows[0].question, UNKNOWN_ROWS[0].query1);
    assert.strictEqual(d.rows[0].answer, UNKNOWN_ROWS[0].resp1);
    assert.ok(d.rows[0].extra && d.rows[0].extra.notes, "未映射字段进 extra");
    attachMetrics(d.rows);
    assert.ok(d.rows[0].metrics.len.extraLens.notes > 0, "extra 字段长度已统计");
    const s = aggregate(d.rows);
    assert.strictEqual(s.overview.flows.generic, 2);
    assert.ok(s.extraFields.some((x) => x.name === "notes"));
  });
}

// ---------------- 多标签分类测试 ----------------

async function multiLabelTests() {
  const mkSettings = (over = {}) => ({
    models: {
      primary: { endpoint: "http://mock", apiKey: "", modelId: "mock", temperature: 0, maxTokens: 4096 },
      judge: { endpoint: "http://mock-judge", apiKey: "", modelId: "mock-judge", temperature: 0, maxTokens: 1024 },
    },
    batchSize: 12, concurrency: 1, lowConf: 0.6, useJudge: true, maxSubjects: 3, ...over,
  });

  await check("classify：多标签 subjects 落盘（主标签在前）", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "paperB-qa.jsonl");
    const cross = (id) => ({
      id,
      subjects: [
        { l1: "海洋生物地球化学", l2: "碳循环" },
        { l1: "物理海洋学", l2: "海洋环流" },
      ],
      contentType: "机理过程", confidence: 0.9, reasons: "碳通量涉及环流输送，交叉",
    });
    await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({ p1: cross, p2: cross, p3: cross }), judgeChatFn: judgeMock() });
    const cls = loadClsFile(f).map;
    assert.strictEqual(cls.get("p1").subjects.length, 2);
    assert.strictEqual(cls.get("p1").subject.l1, "海洋生物地球化学"); // 主标签 = subjects[0]
    assert.strictEqual(cls.get("p1").subject.l2, "碳循环");
    assert.strictEqual(cls.get("p1").subjects[1].l1, "物理海洋学");
    assert.strictEqual(cls.get("p1").tagsOutOfRange, false);
  });

  await check("classify：标签超量 → 截断 + 越界标记 + judge 重判", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "paperB-qa.jsonl");
    const over = (id) => ({
      id,
      subjects: [
        { l1: "海洋化学", l2: "二氧化碳体系" },
        { l1: "海洋生物地球化学", l2: "碳循环" },
        { l1: "物理海洋学", l2: "海洋环流" },
        { l1: "数学与统计方法", l2: "统计与数据分析" },
      ],
      contentType: "概念定义", confidence: 0.9, reasons: "四个都相关",
    });
    const judged = [];
    const judge = async (messages) => {
      judged.push(1);
      return {
        ok: true,
        content: JSON.stringify([{ id: "p1", subjects: [{ l1: "海洋生物地球化学", l2: "碳循环" }, { l1: "海洋化学", l2: "二氧化碳体系" }], contentType: "机理过程", confidence: 0.85, reasons: "仲裁收敛到两个核心学科" }]),
        usage: null,
      };
    };
    await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({ p1: over, p2: over, p3: over }), judgeChatFn: judge });
    const cls = loadClsFile(f).map;
    for (const id of ["p1", "p2", "p3"]) {
      assert.strictEqual(cls.get(id).subjects.length, 2, "judge 重判收敛到 2 个核心学科");
      assert.strictEqual(cls.get(id).tagsOutOfRange, false, "judge 采纳后越界标记清除");
      assert.strictEqual(cls.get(id).needsReview, false);
      assert.strictEqual(cls.get(id).subject.l1, "海洋生物地球化学");
    }
    assert.ok(judged.length >= 3);
  });

  await check("classify：多标签人审（数组提交 + 上限拒绝）", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "paperB-qa.jsonl");
    await classifyFile(f, { settings: mkSettings(), chatFn: mockChat({}), judgeChatFn: judgeMock() });
    const ok = applyReview(f, "p1", {
      subjects: [{ l1: "海洋生物地球化学", l2: "碳循环" }, { l1: "物理海洋学", l2: "" }],
      contentType: "机理过程",
    }, { maxSubjects: 3 });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.row.subjects.length, 2);
    assert.strictEqual(ok.row.subjects[0].source, "human");
    const tooMany = applyReview(f, "p1", {
      subjects: [
        { l1: "海洋化学", l2: "" }, { l1: "海洋生物学", l2: "" },
        { l1: "数学与统计方法", l2: "" }, { l1: "物理海洋学", l2: "" },
      ],
    }, { maxSubjects: 3 });
    assert.strictEqual(tooMany.ok, false); // 4 > 3
    const empty = applyReview(f, "p1", { subjects: [] }, { maxSubjects: 3 });
    assert.strictEqual(empty.ok, false); // 至少 1 个
  });

  await check("stats：多标签计数 / 共现矩阵 / 标签数分布", async () => {
    const rows = [1, 2, 3, 4, 5, 6].map((i) => ({
      id: "m" + i, stem: "s", flow: "generic",
      question: "q" + i, answer: "a" + i, reasoning: null, reasoningRaw: null, finishReason: null,
      label: null, gaPair: null, track: null, chunkIndex: null, chunkName: null, model: null,
      references: null, qCheck: null, evalScore: null, extra: null, cls: null, metrics: null,
    }));
    attachMetrics(rows);
    const tag = (l1, l2 = null) => ({ l1, l2, confidence: 0.9, source: "llm" });
    rows[0].cls = { status: "ok", subjects: [tag("海洋化学"), tag("物理海洋学")], subject: tag("海洋化学"), contentType: { type: "概念定义", confidence: 0.9, source: "llm" } };
    rows[1].cls = { status: "ok", subjects: [tag("海洋化学")], subject: tag("海洋化学"), contentType: { type: "概念定义", confidence: 0.9, source: "llm" } };
    rows[2].cls = { status: "ok", subjects: [tag("海洋化学"), tag("物理海洋学"), tag("数学与统计方法")], subject: tag("海洋化学"), contentType: { type: "机理过程", confidence: 0.9, source: "llm" } };
    rows[3].cls = { status: "ok", subjects: [tag("物理海洋学")], subject: tag("物理海洋学"), contentType: { type: "机理过程", confidence: 0.9, source: "llm" } };
    const s = aggregate(rows);
    assert.strictEqual(s.subject.classified, 4);
    assert.strictEqual(s.subject.multiLabel.tagTotal, 7); // 2+1+3+1
    assert.strictEqual(s.subject.multiLabel.avgSubjects, 1.75);
    const l1 = Object.fromEntries(s.subject.l1.map((x) => [x.label, x.count]));
    assert.strictEqual(l1["海洋化学"], 3); // 多标签计数
    assert.strictEqual(l1["物理海洋学"], 3);
    assert.strictEqual(l1["数学与统计方法"], 1);
    const co = s.cross.subjectCooccurrence;
    const pair = co.pairs.find((p) => (p.a === "海洋化学" && p.b === "物理海洋学"));
    assert.ok(pair, "化学×物理 共现对存在");
    assert.strictEqual(pair.count, 2);
    const tagsMap = Object.fromEntries(s.subject.multiLabel.tagsPerQa.map((x) => [x.label, x.count]));
    assert.strictEqual(tagsMap["1 个标签"], 2);
    assert.strictEqual(tagsMap["2 个标签"], 1);
    assert.strictEqual(tagsMap["3 个标签"], 1);
  });

  await check("兼容：旧单标签 cls 文件 → 自动规范化为多标签", async () => {
    const dir = makeFixtureDir();
    const f = path.join(dir, "bookA-qa.jsonl");
    // 手写旧格式 cls（subject 单对象，无 subjects）
    const legacy = [
      { id: "q1", status: "ok", subject: { l1: "物理海洋学", l2: "海洋环流", confidence: 0.9, source: "llm" }, contentType: { type: "机理过程", confidence: 0.9, source: "llm" }, confirmed: false, needsReview: false, conflict: false, error: null, debug: null },
    ];
    fs.writeFileSync(f.replace(/\.jsonl$/i, "") + "-cls.jsonl", legacy.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const cls = loadClsFile(f);
    assert.ok(Array.isArray(cls.map.get("q1").subjects), "读入时已规范化");
    assert.strictEqual(cls.map.get("q1").subjects.length, 1);
    const d = loadQaFile(f);
    attachMetrics(d.rows);
    attachCls(d.rows, cls.map);
    const s = aggregate(d.rows);
    assert.strictEqual(s.subject.classified, 1);
    assert.ok(s.subject.l1.some((x) => x.label === "物理海洋学"));
  });
}

// ---------------- 标签库管理测试 ----------------

async function taxonomyTests() {
  const GENERAL = path.join(ROOT, "presets", "taxonomy-general.json");

  await check("taxonomy：通用预置树（期刊分类体系）结构合法", async () => {
    const data = JSON.parse(fs.readFileSync(GENERAL, "utf8"));
    const v = taxonomyMgr.validateTaxonomy(data);
    assert.ok(v.ok, `通用树应通过校验：${(v.errors || []).join("；")}`);
    assert.ok(data.tree.length >= 12, "一级学科 ≥12（期刊分区大类粒度）");
    assert.ok(data.tree.some((n) => n.label === "地球科学" && (n.children || []).some((c) => c.label === "海洋科学")));
  });

  await check("taxonomy：预置树清单包含通用与海洋气象两套", async () => {
    const presets = taxonomyMgr.listPresets();
    const ids = presets.map((p) => p.id);
    assert.ok(ids.includes("taxonomy.json"));
    assert.ok(ids.includes("taxonomy-general.json"));
  });

  await check("taxonomy：校验规则（缺其他/重复/二级跨一级）", async () => {
    const bad1 = { tree: [{ label: "数学", desc: "", children: [] }] };
    assert.strictEqual(taxonomyMgr.validateTaxonomy(bad1).ok, false, "缺兜底「其他」");
    const bad2 = { tree: [{ label: "其他", children: [] }, { label: "其他", children: [] }] };
    assert.strictEqual(taxonomyMgr.validateTaxonomy(bad2).ok, false, "一级重复");
    const bad3 = {
      tree: [
        { label: "A 学科", children: [{ label: "共享方向" }] },
        { label: "B 学科", children: [{ label: "共享方向" }] },
        { label: "其他", children: [] },
      ],
    };
    assert.strictEqual(taxonomyMgr.validateTaxonomy(bad3).ok, false, "同一二级挂两个一级（交叉应由打标表达）");
  });

  await check("taxonomy：保存 → version 自增 + 落盘", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-tax-")), "my-taxonomy.json");
    const tree = [
      { label: "测试学科", desc: "d", children: [{ label: "方向一", desc: "" }] },
      { label: "其他", desc: "", children: [] },
    ];
    const r1 = taxonomyMgr.saveTaxonomy({ taxonomyPath: tmp }, { tree });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.saved.version, 1);
    const r2 = taxonomyMgr.saveTaxonomy({ taxonomyPath: tmp }, { tree });
    assert.strictEqual(r2.saved.version, 2, "二次保存 version 自增");
    const saved = JSON.parse(fs.readFileSync(tmp, "utf8"));
    assert.strictEqual(saved.version, 2);
    assert.ok(saved.updated);
  });

  await check("taxonomy：LLM 归纳建议稿（mock，不落盘）", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: "x" + i, stem: "s", flow: "generic",
      question: `关于海洋碳循环过程 ${i} 的问题是什么？`, answer: "碳循环指碳在大气、海洋与生物圈间的迁移转化。",
      reasoning: null, reasoningRaw: null, finishReason: null, label: null, gaPair: null, track: null,
      chunkIndex: null, chunkName: "", model: null, references: null, qCheck: null, evalScore: null, extra: null,
    }));
    const chat = async () => ({
      ok: true,
      content: JSON.stringify({ tree: [{ label: "海洋科学", desc: "海洋相关", children: [{ label: "碳循环", desc: "碳的迁移" }] }, { label: "其他", desc: "兜底", children: [] }], notes: "集中于海洋碳循环" }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const r = await taxonomyMgr.proposeTaxonomy(rows, { chatFn: chat });
    assert.strictEqual(r.ok, true);
    assert.ok(r.proposal.tree.length >= 2);
    assert.strictEqual(r.sampleUsed, 20);
    // 建议稿不落盘：presets 目录无新文件
    assert.ok(!taxonomyMgr.listPresets().some((p) => p.id.includes("suggest")));
  });

  await check("taxonomy：内容类型校验与保存", async () => {
    assert.strictEqual(taxonomyMgr.validateContentTypes({ types: [{ label: "概念定义" }] }).ok, false, "缺「其他」");
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-ct-")), "ct.json");
    const r = taxonomyMgr.saveContentTypes({ contentTypesPath: tmp }, { types: [{ label: "概念定义", desc: "" }, { label: "其他", desc: "" }] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.saved.version, 1);
  });

  await check("scanner：通用 jsonl 纳入扫描，-cls 产物排除", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-scan-"));
    fs.writeFileSync(path.join(dir, "plain.jsonl"), UNKNOWN_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "plain-cls.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "family-qa.jsonl"), "{}\n");
    const found = scanRoot(dir);
    const names = found.map((f) => path.basename(f.path)).sort();
    assert.deepStrictEqual(names, ["family-qa.jsonl", "plain.jsonl"]);
    const plain = found.find((f) => f.path.endsWith("plain.jsonl"));
    assert.ok(plain.hasSchema === false || plain.hasSchema === true); // 元数据字段存在
  });
}

// ---------------- 主流期刊标准树（双语标签）测试 ----------------

async function mainstreamTaxonomyTests() {
  const MAINSTREAM = path.join(ROOT, "presets", "taxonomy-mainstream.json");

  await check("mainstream：主流期刊树结构合法（英文标签 + zh 对照 + Other 兜底）", async () => {
    const data = JSON.parse(fs.readFileSync(MAINSTREAM, "utf8"));
    const v = taxonomyMgr.validateTaxonomy(data);
    assert.ok(v.ok, `主流树应通过校验：${(v.errors || []).join("；")}`);
    assert.ok(data.tree.length >= 24, "一级学科 ≥24（含 Other）");
    const climate = data.tree.find((n) => n.label === "Climate Sciences");
    assert.ok(climate, "存在 Climate Sciences 一级");
    const enso = (climate.children || []).find((c) => c.label === "ENSO & Interannual Variability");
    assert.ok(enso && enso.zh === "ENSO与年际变率", "气候二级含用户示例方向（ENSO与年际变率）");
    const ocean = data.tree.find((n) => n.label === "Ocean Sciences");
    assert.ok(ocean.children.some((c) => c.label === "Physical Oceanography & Circulation"), "海洋按 AGU 四子学科细化");
    assert.ok(taxonomyMgr.fallbackLabelOf(data) === "Other", "兜底类识别为 Other");
    assert.strictEqual(v.tree[0].zh, "大气科学", "校验清洗后保留 zh");
  });

  await check("mainstream：英文标签长度上限（≤48 字符）", async () => {
    const long = "A".repeat(49);
    const bad = { tree: [{ label: long, desc: "", children: [] }, { label: "Other", desc: "", children: [] }] };
    const v = taxonomyMgr.validateTaxonomy(bad);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("英文≤48字符")));
    const ok40 = { tree: [{ label: "A".repeat(48), desc: "", children: [] }, { label: "Other", desc: "", children: [] }] };
    assert.ok(taxonomyMgr.validateTaxonomy(ok40).ok);
  });

  await check("mainstream：兜底 Other 认可 + 中文树兜底兼容", async () => {
    const en = { tree: [{ label: "Mathematics", zh: "数学", desc: "", children: [] }, { label: "Other", zh: "其他", desc: "", children: [] }] };
    assert.ok(taxonomyMgr.validateTaxonomy(en).ok, "英文树 Other 兜底通过");
    const zh = { tree: [{ label: "数学", desc: "", children: [] }, { label: "其他", desc: "", children: [] }] };
    assert.ok(taxonomyMgr.validateTaxonomy(zh).ok, "中文树 其他 兜底仍通过");
    assert.strictEqual(taxonomyMgr.fallbackLabelOf(zh), "其他");
  });

  await check("prompts：英文树渲染含中文对照、Other 兜底与英文输出约束", async () => {
    const data = JSON.parse(fs.readFileSync(MAINSTREAM, "utf8"));
    const rendered = renderTaxonomy(data);
    assert.ok(rendered.includes("ENSO & Interannual Variability（ENSO与年际变率）"), "二级英文+中文对照");
    const p = buildClassifyPrompt([{ id: "x1", question: "What drives ENSO?", answer: "ocean-atmosphere coupling", chunkName: "", priors: {} }], data, loadContentTypes({}));
    assert.ok(p.includes("兜底类「Other」"), "兜底指令用 Other");
    assert.ok(p.includes("英文标签原文"), "强调输出英文原文");
    assert.ok(p.includes("禁止翻译成中文"), "禁止翻译约束");
  });

  await check("stats：英文 Other 兜底计入 otherRate", async () => {
    const rows = [1, 2].map((i) => ({
      id: "o" + i, stem: "s", flow: "generic", question: "q", answer: "a",
      reasoning: null, reasoningRaw: null, finishReason: null, label: null, gaPair: null,
      track: null, chunkIndex: null, chunkName: null, model: null, references: null,
      qCheck: null, evalScore: null, extra: null, cls: null, metrics: null,
    }));
    attachMetrics(rows);
    rows[0].cls = { status: "ok", subjects: [{ l1: "Other", l2: null, confidence: 0.9, source: "llm" }], contentType: { type: "其他", confidence: 0.9, source: "llm" } };
    rows[1].cls = { status: "ok", subjects: [{ l1: "Mathematics", l2: "Pure Mathematics", confidence: 0.9, source: "llm" }], contentType: { type: "其他", confidence: 0.9, source: "llm" } };
    const s = aggregate(rows);
    assert.strictEqual(s.subject.otherRate, 50); // 1/2 落 Other
  });

  await check("taxonomy：双语树保存保留 zh 字段 + version 自增", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qa-stats-tax-")), "bilingual.json");
    const tree = [
      { label: "Ocean Sciences", zh: "海洋科学", desc: "d", children: [{ label: "Sea Ice", zh: "海冰", desc: "" }] },
      { label: "Other", zh: "其他", desc: "", children: [] },
    ];
    const r = taxonomyMgr.saveTaxonomy({ taxonomyPath: tmp }, { tree });
    assert.strictEqual(r.ok, true);
    const saved = JSON.parse(fs.readFileSync(tmp, "utf8"));
    assert.strictEqual(saved.tree[0].zh, "海洋科学");
    assert.strictEqual(saved.tree[0].children[0].zh, "海冰");
  });

  await check("prompts：归纳提示词要求双语标签（英文 label + 中文 zh）", async () => {
    const p = buildTaxonomyProposePrompt([{ question: "What is a tide?", answer: "periodic sea level change", chunkName: "Tides" }]);
    assert.ok(p.includes("英文规范学科名"), "要求英文 label");
    assert.ok(p.includes("中文对照名"), "要求中文 zh");
    assert.ok(p.includes('"zh":"中文名"'), "输出格式含 zh 字段");
    assert.ok(p.includes("AGU"), "粒度对齐主流期刊体系");
  });
}

// ---------------- 运行 ----------------

(async () => {
  console.log(`qa-stats 自测（${new Date().toISOString()}）\n`);
  await unitTests();
  await classifyTests();
  await schemaTests();
  await multiLabelTests();
  await taxonomyTests();
  await mainstreamTaxonomyTests();
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    process.exit(1);
  }
})();
