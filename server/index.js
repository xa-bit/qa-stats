"use strict";

/**
 * qa-stats Web 服务（零依赖），家族架构。端口 3222。
 *
 * - 扫描 / 指定 jsonl → 结构探测（未知字段名语料）→ 统计（程序指标 + 分类注记合并）→ 仪表盘
 * - 分类后台任务（L0 规则 + L1 批量 LLM + L2 仲裁，学科多标签），人审队列
 * - 标签库管理（预置加载 / 编辑保存 / LLM 归纳建议 / 完整标签浏览导出）
 * - 报告导出（单文件 HTML / Markdown / CSV）
 */

const http = require("http");
const path = require("path");
const fs = require("fs");

const { scanRoot, scanFiles } = require("./scanner");
const { loadState, saveState, MODEL_PROVIDERS } = require("./state");
const { loadQaFile } = require("./loader");
const { attachMetrics } = require("./metrics");
const { attachCls, loadClsFile, classifyFile, loadTaxonomy, loadContentTypes, applyReview } = require("./classify");
const { aggregate } = require("./stats");
const { writeReport, REPORT_DIR_NAME } = require("./report");
const { listModels, testModel } = require("./llm");
const { ensureSchema, loadSchema, ensureSchemaProgramSync } = require("./schema");
const taxonomyMgr = require("./taxonomy");

const PORT = Number(process.env.PORT) || 3222;
const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
// 家族项目（模型配置导入来源，参考 q-a-factual）
const FAMILY_STATE_PATHS = [
  path.join(ROOT, "..", "q-a-factual", "server", "state.json"),
  path.join(ROOT, "..", "q-a", "server", "state.json"),
];

let state = loadState();

// ---------- 数据载入（带 mtime 内存缓存） ----------

const rowCache = new Map(); // path → {mtime, schemaMtime, data}

function statMtimeSafe(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** 载入一个 jsonl 的统一行（挂 metrics + cls）。统计路径零 LLM：schema 只做程序探测。 */
function loadRows(qaPath) {
  const st = fs.statSync(qaPath);
  const schemaMtime = statMtimeSafe(String(qaPath).replace(/\.jsonl$/i, "") + "-schema.json");
  const hit = rowCache.get(qaPath);
  if (hit && hit.mtime === st.mtimeMs && hit.schemaMtime === schemaMtime) return hit.data;
  // schema：旁挂优先；无则程序探测并保存（不调 LLM；LLM 仲裁在分类任务/手动探测时触发）
  let schema = null;
  try {
    schema = ensureSchemaProgramSync(qaPath);
  } catch {
    schema = null;
  }
  const loaded = loadQaFile(qaPath, { schema });
  attachMetrics(loaded.rows, { evalLow: state.evalLow });
  const cls = loadClsFile(qaPath);
  attachCls(loaded.rows, cls.map);
  const data = { ...loaded, clsCount: cls.rows.length };
  rowCache.set(qaPath, { mtime: st.mtimeMs, schemaMtime, data });
  return data;
}

function applyFilters(rows, f) {
  let out = rows;
  if (f.stems && f.stems.length) out = out.filter((r) => f.stems.includes(r.stem));
  if (f.flow) out = out.filter((r) => r.flow === f.flow);
  if (f.track) out = out.filter((r) => r.track === f.track);
  if (f.gaPair) out = out.filter((r) => r.gaPair === f.gaPair);
  if (f.subjectL1) {
    // 多标签：任一学科标签命中即保留
    out = out.filter((r) => r.cls && Array.isArray(r.cls.subjects) && r.cls.subjects.some((s) => s.l1 === f.subjectL1));
  }
  if (f.contentType) out = out.filter((r) => r.cls && r.cls.contentType && r.cls.contentType.type === f.contentType);
  if (Number.isFinite(Number(f.confMin)) && f.confMin !== "" && f.confMin !== null && f.confMin !== undefined) {
    const c = Number(f.confMin);
    out = out.filter((r) => !r.cls || !r.cls.subjects || !r.cls.subjects.length || (r.cls.subjects[0].confidence ?? 0) >= c);
  }
  if (f.excludeTruncated) out = out.filter((r) => !r.metrics.flags.truncated);
  return out;
}

/** 明细表行（压缩体积，截断题面） */
function tableRows(rows, cap = 10000) {
  return rows.slice(0, cap).map((r) => {
    const subjects = r.cls && Array.isArray(r.cls.subjects) ? r.cls.subjects : [];
    return {
      id: r.id,
      stem: r.stem,
      question: r.question.slice(0, 120),
      subject: subjects.map((s) => `${s.l1}${s.l2 ? "/" + s.l2 : ""}`).join("；"),
      subjectSource: subjects.length ? subjects[0].source : "",
      tagCount: subjects.length,
      contentType: r.cls && r.cls.contentType ? r.cls.contentType.type : "",
      conf: subjects.length ? subjects[0].confidence : null,
      gaPair: r.gaPair || "",
      track: r.track || "",
      rChars: r.metrics.len.rChars,
      aChars: r.metrics.len.aChars,
      evalScore: r.evalScore,
      truncated: r.metrics.flags.truncated,
      needsReview: !!(r.cls && r.cls.needsReview),
    };
  });
}

// ---------- 分类后台任务 ----------

let task = { running: false, file: null, progress: null, log: [], stop: false, error: null, doneAt: null };

async function runClassify(files) {
  task = { running: true, file: null, progress: null, log: [], stop: false, error: null, doneAt: null };
  try {
    for (const f of files) {
      if (task.stop) break;
      task.file = f;
      // 结构探测：程序置信不足时自动 LLM 仲裁（未知字段名语料的前置步骤）
      if (state.autoSchema !== false) {
        task.log.push(`结构探测：${path.basename(f)}`);
        try {
          const { schema, changed } = await ensureSchema(f, { allowLlm: true, settings: state });
          if (changed && schema.usedLlm) task.log.push(`结构探测（LLM 仲裁）：question←${schema.mapping.question || "?"} · answer←${schema.mapping.answer || "?"}${schema.mapping.reasoning ? " · reasoning←" + schema.mapping.reasoning : ""}`);
          rowCache.delete(f);
        } catch (e) {
          task.log.push(`结构探测失败（继续用别名兜底）：${e && e.message ? e.message : e}`);
        }
      }
      task.log.push(`开始分类：${path.basename(f)}`);
      const meta = await classifyFile(f, {
        settings: state,
        shouldStop: () => task.stop,
        onProgress: (p) => { task.progress = p; },
      });
      task.log.push(
        `完成 ${path.basename(f)}：LLM ${meta.counts.llmCalls} 次 / judge ${meta.counts.judgeCalls} 次 / 缓存命中 ${meta.counts.cached} / 待人审 ${meta.counts.needsReview}` +
        ` / 平均学科标签 ${meta.counts.avgSubjects}` +
        ` / token ${(meta.usage.llm.totalTokens + meta.usage.judge.totalTokens)}`
      );
      rowCache.delete(f); // 失效行缓存（挂了新 cls）
    }
  } catch (e) {
    task.error = e && e.message ? e.message : String(e);
    task.log.push(`出错：${task.error}`);
  } finally {
    task.running = false;
    task.doneAt = new Date().toISOString();
  }
}

// ---------- HTTP 基础 ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 16 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}

// ---------- 家族模型配置导入 ----------

function importFamilyModels() {
  for (const p of FAMILY_STATE_PATHS) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const models = data && data.settings && data.settings.models;
      if (!models) continue;
      const pickModel = (src) => src && src.endpoint && src.modelId
        ? {
          name: src.name || "导入模型",
          provider: "custom",
          endpoint: src.endpoint,
          apiKey: src.apiKey || "",
          modelId: src.modelId,
          temperature: 0,
          maxTokens: 4096,
        }
        : null;
      const primary = pickModel(models.primary);
      const judge = pickModel(models.judge) || pickModel(models.compare);
      if (primary) {
        return {
          ok: true, source: path.basename(path.dirname(path.dirname(p))),
          models: { primary, ...(judge ? { judge } : {}) },
        };
      }
    } catch {
      /* 下一个 */
    }
  }
  return { ok: false, error: "未找到可用的家族项目模型配置（q-a-factual / q-a 的 server/state.json）" };
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith("/api/")) {
      // ---- 状态与模型 ----
      if (pathname === "/api/state" && req.method === "GET") {
        return sendJson(res, 200, { state, providers: MODEL_PROVIDERS });
      }
      if (pathname === "/api/state" && req.method === "PUT") {
        const body = await readBody(req);
        state = { ...state, ...pickState(body) };
        saveState(state);
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === "/api/test-model" && req.method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 200, await testModel(body.cfg || {}));
      }
      if (pathname === "/api/list-models" && req.method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 200, await listModels(body.cfg || {}));
      }
      if (pathname === "/api/import-models" && req.method === "POST") {
        return sendJson(res, 200, importFamilyModels());
      }

      // ---- 扫描 ----
      if (pathname === "/api/scan" && req.method === "GET") {
        const root = url.searchParams.get("root");
        if (!root) return sendJson(res, 400, { error: "缺少 root 参数" });
        return sendJson(res, 200, { files: scanRoot(root) });
      }

      // ---- 结构探测（未知字段名语料） ----
      if (pathname === "/api/schema" && req.method === "GET") {
        const file = url.searchParams.get("file");
        if (!file) return sendJson(res, 400, { error: "缺少 file 参数" });
        return sendJson(res, 200, { schema: loadSchema(file) });
      }
      if (pathname === "/api/schema/probe" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.file) return sendJson(res, 400, { error: "缺少 file" });
        const { schema } = await ensureSchema(body.file, {
          allowLlm: body.allowLlm !== false,
          force: !!body.force,
          settings: state,
        });
        rowCache.delete(body.file);
        return sendJson(res, 200, { ok: true, schema });
      }

      // ---- 统计 ----
      if (pathname === "/api/stats" && req.method === "POST") {
        const body = await readBody(req);
        const files = (body.files || []).filter(Boolean);
        if (!files.length) return sendJson(res, 400, { error: "未指定文件" });
        const loadedAll = [];
        const fileMeta = [];
        for (const f of files) {
          const d = loadRows(f);
          fileMeta.push({
            path: f, stem: d.stem, flow: d.flow, count: d.rows.length, badLines: d.badLines,
            schema: d.schema ? { source: d.schema.source, usedLlm: !!d.schema.usedLlm, coreReady: d.schema.coreReady !== false, mapping: d.schema.mapping } : null,
          });
          loadedAll.push(...d.rows);
        }
        const filtered = applyFilters(loadedAll, body.filters || {});
        const stats = aggregate(filtered);
        return sendJson(res, 200, {
          stats,
          files: fileMeta,
          totalBeforeFilter: loadedAll.length,
          rows: tableRows(filtered),
          // 筛选候选项
          options: {
            stems: [...new Set(loadedAll.map((r) => r.stem))],
            flows: [...new Set(loadedAll.map((r) => r.flow))],
            tracks: [...new Set(loadedAll.map((r) => r.track).filter(Boolean))],
            gaPairs: [...new Set(loadedAll.map((r) => r.gaPair).filter(Boolean))],
            subjects: stats.subject.l1.map((x) => x.label),
            contentTypes: stats.contentType.dist.map((x) => x.label),
          },
        });
      }

      // ---- 分类任务 ----
      if (pathname === "/api/classify" && req.method === "POST") {
        const body = await readBody(req);
        if (task.running) return sendJson(res, 409, { error: "已有分类任务在运行" });
        const files = (body.files || []).filter(Boolean);
        if (!files.length) return sendJson(res, 400, { error: "未指定文件" });
        runClassify(files);
        return sendJson(res, 200, { ok: true, started: true });
      }
      if (pathname === "/api/classify/status" && req.method === "GET") {
        return sendJson(res, 200, task);
      }
      if (pathname === "/api/classify/stop" && req.method === "POST") {
        task.stop = true;
        return sendJson(res, 200, { ok: true });
      }

      // ---- 人审 ----
      if (pathname === "/api/review-list" && req.method === "GET") {
        const file = url.searchParams.get("file");
        if (!file) return sendJson(res, 400, { error: "缺少 file 参数" });
        const d = loadRows(file);
        const out = d.rows
          .filter((r) => r.cls && r.cls.needsReview)
          .slice(0, 200)
          .map((r) => ({
            id: r.id,
            question: r.question.slice(0, 160),
            answer: r.answer.slice(0, 200),
            chunkName: r.chunkName || "",
            subjects: r.cls.subjects || [],
            contentType: r.cls.contentType,
            reasons: r.cls.reasons || "",
            conflict: r.cls.conflict,
            tagsOutOfRange: r.cls.tagsOutOfRange,
            error: r.cls.error,
          }));
        return sendJson(res, 200, { file, count: out.length, rows: out });
      }
      if (pathname === "/api/review" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.file || !body.id) return sendJson(res, 400, { error: "缺少 file / id" });
        const result = applyReview(body.file, body.id, body.patch || {}, state);
        if (result.ok) rowCache.delete(body.file);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // ---- 标签库 ----
      if (pathname === "/api/taxonomy" && req.method === "GET") {
        return sendJson(res, 200, {
          taxonomy: loadTaxonomy(state),
          contentTypes: loadContentTypes(state),
          presets: taxonomyMgr.listPresets(),
          path: taxonomyMgr.taxonomyPathOf(state),
        });
      }
      if (pathname === "/api/taxonomy" && req.method === "PUT") {
        const body = await readBody(req);
        if (body.taxonomy !== undefined) {
          const r = taxonomyMgr.saveTaxonomy(state, body.taxonomy);
          if (!r.ok) return sendJson(res, 400, { ok: false, errors: r.errors });
          return sendJson(res, 200, r);
        }
        if (body.contentTypes !== undefined) {
          const r = taxonomyMgr.saveContentTypes(state, body.contentTypes);
          if (!r.ok) return sendJson(res, 400, { ok: false, errors: r.errors });
          return sendJson(res, 200, r);
        }
        return sendJson(res, 400, { error: "缺少 taxonomy / contentTypes" });
      }
      if (pathname === "/api/taxonomy/preset" && req.method === "POST") {
        const body = await readBody(req);
        try {
          return sendJson(res, 200, { ok: true, taxonomy: taxonomyMgr.loadPreset(body.id) });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: `预置不存在或损坏：${e.message}` });
        }
      }
      if (pathname === "/api/taxonomy/propose" && req.method === "POST") {
        const body = await readBody(req);
        const files = (body.files || []).filter(Boolean);
        if (!files.length) return sendJson(res, 400, { error: "未指定文件" });
        const rows = [];
        for (const f of files) rows.push(...loadRows(f).rows);
        const r = await taxonomyMgr.proposeTaxonomy(rows, { settings: state });
        return sendJson(res, r.ok ? 200 : 400, r);
      }

      // ---- 报告导出 ----
      if (pathname === "/api/report" && req.method === "POST") {
        const body = await readBody(req);
        const files = (body.files || []).filter(Boolean);
        if (!files.length) return sendJson(res, 400, { error: "未指定文件" });
        const loadedAll = [];
        for (const f of files) loadedAll.push(...loadRows(f).rows);
        const filtered = applyFilters(loadedAll, body.filters || {});
        const stats = aggregate(filtered);
        const firstDir = path.dirname(files[0]);
        const outDir = body.outDir || path.join(firstDir, REPORT_DIR_NAME);
        const result = writeReport(outDir, stats, { title: body.title || "QA 语料统计报告" });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (pathname === "/api/report/view" && req.method === "GET") {
        const file = url.searchParams.get("path");
        if (!file || !file.endsWith(".html")) return sendJson(res, 400, { error: "仅支持查看 html 报告" });
        fs.readFile(file, (err, buf) => {
          if (err) return sendJson(res, 404, { error: "报告不存在" });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(buf);
        });
        return;
      }

      return sendJson(res, 404, { error: "未知接口" });
    }
    return serveStatic(req, res, pathname);
  } catch (e) {
    return sendJson(res, 500, { error: e && e.message ? e.message : String(e) });
  }
});

function pickState(body) {
  // 白名单浅更新（models 深合并由前端提交完整对象）
  const keys = ["root", "batchSize", "concurrency", "lowConf", "useJudge", "evalLow", "maxSubjects", "autoSchema", "taxonomyPath", "contentTypesPath"];
  const out = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  if (body.models && typeof body.models === "object") out.models = body.models;
  return out;
}

server.listen(PORT, () => {
  console.log(`qa-stats 已启动：http://localhost:${PORT}`);
});
