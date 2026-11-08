"use strict";

/* qa-stats 仪表盘（原生 JS，无构建）。家族风格：直接 fetch 本服务 API。 */

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;

let selectedFiles = []; // 已选 jsonl（含元数据）
let currentPayload = null; // 最近一次 /api/stats 响应
let tableRowsData = [];
let page = 0;
let charts = {};
let pollTimer = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (data.errors && data.errors.join("；")) || `HTTP ${res.status}`);
  return data;
}
async function post(path, body) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}
async function put(path, body) {
  return api(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}

function fmtNum(v) {
  if (v === null || v === undefined) return "—";
  return typeof v === "number" ? v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : String(v);
}

/** 保存文件：优先 File System Access API（弹出系统保存位置选择框），不支持则退化为下载 */
async function saveWithPicker(defaultName, blob) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: defaultName });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { ok: true, via: "picker" };
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, aborted: true };
      /* 其它异常走退化路径 */
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { ok: true, via: "download" };
}

function csvOf(headers, rows) {
  const esc = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v ?? "").replace(/"/g, '""')}"` : String(v ?? ""));
  return "\ufeff" + [headers.join(",")].concat(rows.map((r) => headers.map((h) => esc(r[h])).join(","))).join("\n");
}

// ---------------- Tab 切换 ----------------
document.querySelectorAll("#tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("on"));
    document.querySelectorAll("section.tab").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    $("tab-" + b.dataset.tab).classList.add("on");
    if (b.dataset.tab === "review") syncReviewFile();
    if (b.dataset.tab === "tax") loadTaxonomyTab(false);
  };
});

// ---------------- 文件选择 ----------------
function renderFileList() {
  const box = $("file-list");
  box.innerHTML = "";
  selectedFiles.forEach((f) => {
    const div = document.createElement("div");
    div.className = "file-item";
    const schemaBadge = f.schemaInfo
      ? `<span class="badge ${f.schemaInfo.coreReady ? "ok" : "warn"}" title="${escapeHtml(JSON.stringify(f.schemaInfo.mapping || {}))}">结构${f.schemaInfo.usedLlm ? "·LLM" : "·程序"}${f.schemaInfo.coreReady ? "" : "·存疑"}</span>`
      : `<button class="tax-probe-btn" data-path="${escapeHtml(f.path)}">探测结构</button>`;
    div.innerHTML = `<span class="path">${escapeHtml(f.path)}</span>
      <span class="meta">${f.count != null ? f.count + " 条" : ""} ${f.flow || ""}</span>
      <span class="badge ${f.hasCls ? "ok" : "warn"}">${f.hasCls ? "已分类" : "未分类"}</span>
      ${schemaBadge}
      <button>移除</button>`;
    div.querySelector("button:last-child").onclick = () => {
      selectedFiles = selectedFiles.filter((x) => x.path !== f.path);
      renderFileList();
    };
    const probeBtn = div.querySelector(".tax-probe-btn");
    if (probeBtn) probeBtn.onclick = async () => {
      probeBtn.disabled = true;
      probeBtn.textContent = "探测中…";
      try {
        const r = await post("/api/schema/probe", { file: f.path, force: true, allowLlm: true });
        f.schemaInfo = { source: r.schema.source, usedLlm: !!r.schema.usedLlm, coreReady: r.schema.coreReady !== false, mapping: r.schema.mapping };
        alert(`结构探测完成（${r.schema.source}${r.schema.usedLlm ? "，LLM 仲裁" : ""}）：\n` +
          Object.entries(r.schema.mapping || {}).filter(([, v]) => v).map(([k, v]) => `${k} ← "${v}"`).join("\n"));
        queryStats();
      } catch (e) {
        alert("探测失败：" + e.message);
      }
      renderFileList();
    };
    box.appendChild(div);
  });
}

async function scanRoot() {
  const root = $("root-input").value.trim();
  if (!root) return alert("请填写扫描根目录");
  try {
    const data = await api("/api/scan?root=" + encodeURIComponent(root));
    if (!data.files.length) return alert("未找到 .jsonl（递归扫描，跳过 node_modules / qa-stats-cache / qa-stats-report / -cls 产物）");
    for (const f of data.files) {
      if (!selectedFiles.some((x) => x.path === f.path)) selectedFiles.push(f);
    }
    renderFileList();
  } catch (e) {
    alert("扫描失败：" + e.message);
  }
}

function addManualFile() {
  const p = $("file-input").value.trim();
  if (!p || !/\.jsonl$/i.test(p) || /-cls\.jsonl$/i.test(p)) return alert("请输入 .jsonl 路径（-cls.jsonl 产物除外）");
  if (!selectedFiles.some((x) => x.path === p)) {
    selectedFiles.push({ path: p, stem: p.split(/[\\/]/).pop().replace(/\.jsonl$/i, ""), hasCls: false, hasSchema: false });
    renderFileList();
  }
  $("file-input").value = "";
}

$("btn-scan").onclick = scanRoot;
$("btn-add-file").onclick = addManualFile;

// ---------------- 筛选与查询 ----------------
function fillSelect(id, values, allLabel) {
  const sel = $(id);
  const cur = sel.value;
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = allLabel || "全部";
  sel.appendChild(optAll);
  values.filter(Boolean).forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function currentFilters() {
  return {
    stems: $("f-stem").value ? [$("f-stem").value] : [],
    flow: $("f-flow").value,
    track: $("f-track").value,
    gaPair: $("f-ga").value,
    subjectL1: $("f-subj").value,
    contentType: $("f-ct").value,
    confMin: $("f-conf").value === "" ? null : Number($("f-conf").value),
    excludeTruncated: $("f-notrunc").checked,
  };
}

async function queryStats() {
  if (!selectedFiles.length) return alert("请先扫描或添加 jsonl 文件");
  $("btn-query").disabled = true;
  try {
    const data = await post("/api/stats", { files: selectedFiles.map((f) => f.path), filters: currentFilters() });
    currentPayload = data;
    // 回填已选文件元数据（条数/流/结构探测）
    for (const meta of data.files || []) {
      const f = selectedFiles.find((x) => x.path === meta.path);
      if (f) {
        f.count = meta.count;
        f.flow = meta.flow;
        if (meta.schema) f.schemaInfo = { source: meta.schema.source, usedLlm: !!meta.schema.usedLlm, coreReady: !!meta.schema.coreReady, mapping: meta.schema.mapping };
      }
    }
    renderFileList();
    fillOptions(data.options || {});
    renderCards(data.stats);
    renderCharts(data.stats);
    tableRowsData = data.rows || [];
    page = 0;
    renderTable();
  } catch (e) {
    alert("统计失败：" + e.message);
  } finally {
    $("btn-query").disabled = false;
  }
}

function fillOptions(opt) {
  fillSelect("f-stem", opt.stems || []);
  fillSelect("f-flow", opt.flows || []);
  fillSelect("f-track", opt.tracks || []);
  fillSelect("f-ga", opt.gaPairs || []);
  fillSelect("f-subj", opt.subjects || []);
  fillSelect("f-ct", opt.contentTypes || []);
}
["f-stem", "f-flow", "f-track", "f-ga", "f-subj", "f-ct", "f-notrunc"].forEach((id) => ($(id).onchange = queryStats));
$("btn-query").onclick = queryStats;

// ---------------- 概览卡 ----------------
function renderCards(s) {
  const med = s.overview.hasReasoning && s.length.r.summary ? s.length.r.summary.median : (s.length.a.summary ? s.length.a.summary.median : "—");
  const cards = [
    { k: "QA 总数", v: fmtNum(s.overview.total) },
    { k: "文献数", v: fmtNum(s.overview.stems) },
    { k: s.overview.hasReasoning ? "思考长度中位数(字)" : "答案长度中位数(字)", v: fmtNum(med) },
    { k: "eval 均分", v: s.quality.eval ? fmtNum(s.quality.eval.summary.mean) : "—" },
    { k: "截断率 %", v: fmtNum(s.overview.truncatedRate) },
    { k: "平均学科标签数", v: s.subject.multiLabel ? fmtNum(s.subject.multiLabel.avgSubjects) : "—" },
    { k: "待人审", v: fmtNum(s.classifyQuality.needsReview) },
  ];
  $("cards").innerHTML = cards.map((c) => `<div class="card"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join("");
}

// ---------------- 图表 ----------------
function chart(id) {
  if (!charts[id]) charts[id] = echarts.init($(id));
  return charts[id];
}
function noData(c, text) {
  c.setOption({ title: { text: text || "无数据", left: "center", top: "middle", textStyle: { fontSize: 12, color: "#9ca3af" } } }, true);
}

function renderCharts(s) {
  // 旭日
  const sun = chart("c-sunburst");
  if (s.subject.tree.length) {
    sun.setOption({
      tooltip: {},
      series: [{ type: "sunburst", radius: ["14%", "90%"], label: { fontSize: 11, minAngle: 8 },
        data: s.subject.tree.map((n) => ({ name: n.name, value: n.value, children: n.children })) }],
    }, true);
  } else noData(sun, "无学科分类（先执行分类任务）");

  // 条形
  const barCfg = (dist, color) => dist && dist.length ? {
    tooltip: {},
    grid: { left: 120 },
    xAxis: { type: "value" },
    yAxis: { type: "category", data: dist.map((d) => d.label).reverse() },
    series: [{ type: "bar", itemStyle: { color }, label: { show: true, position: "right" }, data: dist.map((d) => d.count).reverse() }],
  } : null;
  const ct = chart("c-ct");
  const ctCfg = barCfg(s.contentType.dist, "#2563eb");
  ctCfg ? ct.setOption(ctCfg, true) : noData(ct, "无内容类型分类");
  const ga = chart("c-ga");
  const gaCfg = barCfg(s.gaPair.dist, "#0d9488");
  gaCfg ? ga.setOption(gaCfg, true) : noData(ga, "无 gaPair 字段");

  // 每题标签数分布（数量纪律）
  const tg = chart("c-tags");
  if (s.subject.multiLabel && s.subject.multiLabel.tagsPerQa.length) {
    tg.setOption({
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: s.subject.multiLabel.tagsPerQa.map((x) => x.label) },
      yAxis: { type: "value" },
      series: [{ type: "bar", itemStyle: { color: "#db2777" }, label: { show: true, position: "top" }, data: s.subject.multiLabel.tagsPerQa.map((x) => x.count) }],
    }, true);
  } else noData(tg, "无分类结果");

  // 长度直方图（口径切换）
  renderHistCtl(s);
  // 分组箱线（维度切换）
  renderBoxCtl(s);

  // 热力图
  const heat = chart("c-heat");
  const m = s.cross.subjectContentType;
  if (m.cells.length) {
    heat.setOption({
      tooltip: { position: "top" },
      grid: { left: 130, bottom: 80 },
      xAxis: { type: "category", data: m.bLabels, axisLabel: { rotate: 28 } },
      yAxis: { type: "category", data: m.aLabels },
      visualMap: { min: 0, max: Math.max(...m.cells.map((c) => c.count)), calculable: true, orient: "horizontal", left: "center", bottom: 0 },
      series: [{ type: "heatmap", label: { show: true },
        data: m.cells.map((c) => [m.bLabels.indexOf(c.b), m.aLabels.indexOf(c.a), c.count]) }],
    }, true);
  } else noData(heat, "无学科 × 内容类型数据");

  // 学科交叉共现
  const co = chart("c-cooc");
  const coD = s.cross.subjectCooccurrence;
  if (coD && coD.pairs && coD.pairs.length) {
    const labels = coD.labels;
    const cells = [];
    coD.pairs.forEach((p) => {
      const i = labels.indexOf(p.a), j = labels.indexOf(p.b);
      cells.push([i, j, p.count], [j, i, p.count]);
    });
    co.setOption({
      tooltip: { position: "top" },
      grid: { left: 110, bottom: 90 },
      xAxis: { type: "category", data: labels, axisLabel: { rotate: 35 } },
      yAxis: { type: "category", data: labels },
      visualMap: { min: 0, max: coD.pairs[0].count, calculable: true, orient: "horizontal", left: "center", bottom: 0 },
      series: [{ type: "heatmap", label: { show: true }, data: cells }],
    }, true);
  } else noData(co, "无交叉学科题（或未分类）");

  // 散点
  const sc = chart("c-scatter");
  const info = s.cross.lenScoreCorr;
  if (info && info.r !== null) {
    sc.setOption({
      title: { text: `Pearson r = ${info.r}（n=${info.n}）`, left: "right", textStyle: { fontSize: 12 } },
      tooltip: { trigger: "item" },
      xAxis: { type: "value", name: "估算思考 token" },
      yAxis: { type: "value", name: "eval 分数" },
      series: [{ type: "scatter", symbolSize: 5, itemStyle: { opacity: 0.5, color: "#dc2626" }, data: info.pts || [] }],
    }, true);
  } else noData(sc, "样本不足 / 无思考或分数字段");

  // eval 分布
  const ev = chart("c-eval");
  if (s.quality.eval && s.quality.eval.hist) {
    ev.setOption({
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: s.quality.eval.hist.bins.map((b) => b.from), name: "分数" },
      yAxis: { type: "value" },
      series: [{ type: "bar", itemStyle: { color: "#d97706" }, data: s.quality.eval.hist.bins.map((b) => b.count) }],
    }, true);
  } else noData(ev, "无 eval 字段");

  // 置信度
  const cf = chart("c-conf");
  if (s.classifyQuality.confidenceHist) {
    cf.setOption({
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: s.classifyQuality.confidenceHist.bins.map((b) => b.from), name: "confidence" },
      yAxis: { type: "value" },
      series: [{ type: "bar", itemStyle: { color: "#65a30d" }, data: s.classifyQuality.confidenceHist.bins.map((b) => b.count) }],
    }, true);
  } else noData(cf, "无分类结果");
}

function renderHistCtl(s) {
  const ctl = $("ctl-hist");
  ctl.innerHTML = "";
  const metrics = [["r", "思考(梳理后)"], ["rRaw", "思考(原始)"], ["a", "答案"], ["q", "问题"]];
  const avail = metrics.filter((m) => s.length[m[0]] && s.length[m[0]].hist);
  let cur = s.length.r && s.length.r.hist ? "r" : "a";
  function render() {
    const c = chart("c-hist");
    const h = s.length[cur] && s.length[cur].hist;
    if (!h) return noData(c);
    c.setOption({
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: h.bins.map((b) => Math.round(b.from)), name: "字符" },
      yAxis: { type: "value" },
      series: [{ type: "bar", itemStyle: { color: "#7c3aed" }, data: h.bins.map((b) => b.count) }],
    }, true);
  }
  avail.forEach((m) => {
    const b = document.createElement("button");
    b.textContent = m[1];
    if (m[0] === cur) b.className = "on";
    b.onclick = () => {
      cur = m[0];
      [...ctl.children].forEach((x) => (x.className = ""));
      b.className = "on";
      render();
    };
    ctl.appendChild(b);
  });
  render();
}

function renderBoxCtl(s) {
  const ctl = $("ctl-box");
  ctl.innerHTML = "";
  const dims = [["byTrack", "track"], ["bySubjectL1", "学科"], ["byContentType", "内容类型"], ["byGaPair", "gaPair"]];
  let cur = "bySubjectL1";
  function render() {
    const c = chart("c-box");
    const groups = s.length.grouped[cur] || [];
    if (!groups.length) return noData(c);
    c.setOption({
      tooltip: { trigger: "item" },
      grid: { left: 140 },
      xAxis: { type: "value", name: s.length.boxLabel },
      yAxis: { type: "category", data: groups.map((g) => `${g.group} (n=${g.n})`) },
      series: [{ type: "boxplot", itemStyle: { color: "#bfdbfe" }, data: groups.map((g) => g.box) }],
    }, true);
  }
  dims.forEach((d) => {
    const b = document.createElement("button");
    b.textContent = d[1];
    if (d[0] === cur) b.className = "on";
    b.onclick = () => {
      cur = d[0];
      [...ctl.children].forEach((x) => (x.className = ""));
      b.className = "on";
      render();
    };
    ctl.appendChild(b);
  });
  render();
}

window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));

// ---------------- 明细表 ----------------
function renderTable() {
  const tb = $("rows-table").querySelector("tbody");
  tb.innerHTML = "";
  const totalPages = Math.max(1, Math.ceil(tableRowsData.length / PAGE_SIZE));
  if (page >= totalPages) page = totalPages - 1;
  const slice = tableRowsData.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  for (const r of slice) {
    const tr = document.createElement("tr");
    const flags = [r.truncated ? "截断" : "", r.needsReview ? "待人审" : ""].filter(Boolean).join("，");
    tr.innerHTML = `<td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.stem)}</td><td class="q">${escapeHtml(r.question)}</td>
      <td>${escapeHtml(r.subject)}</td><td>${escapeHtml(r.subjectSource)}</td><td>${r.tagCount ?? ""}</td><td>${escapeHtml(r.contentType)}</td>
      <td>${r.conf ?? ""}</td><td>${escapeHtml(r.gaPair)}</td><td>${escapeHtml(r.track)}</td>
      <td>${fmtNum(r.rChars)}</td><td>${fmtNum(r.aChars)}</td><td>${r.evalScore ?? "—"}</td><td>${flags}</td>`;
    tb.appendChild(tr);
  }
  $("rows-count").textContent = `共 ${tableRowsData.length} 条（展示前 10000 条内）`;
  $("pg-info").textContent = `第 ${page + 1} / ${totalPages} 页`;
}
$("pg-prev").onclick = () => { if (page > 0) { page--; renderTable(); } };
$("pg-next").onclick = () => { page++; renderTable(); };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function downloadCsv() {
  if (!tableRowsData.length) return alert("无数据");
  const headers = Object.keys(tableRowsData[0]);
  const csv = csvOf(headers, tableRowsData);
  saveWithPicker("qa-stats-rows.csv", new Blob([csv], { type: "text/csv" }));
}
$("btn-csv").onclick = downloadCsv;

async function exportReport() {
  if (!selectedFiles.length) return alert("请先选择文件");
  $("export-tip").textContent = "生成中…";
  try {
    const r = await post("/api/report", { files: selectedFiles.map((f) => f.path), filters: currentFilters() });
    $("export-tip").innerHTML = `已导出：<a href="/api/report/view?path=${encodeURIComponent(r.html)}" target="_blank">打开 HTML 报告</a> · 目录 ${escapeHtml(r.dir)}`;
  } catch (e) {
    alert("导出失败：" + e.message);
    $("export-tip").textContent = "";
  }
}
$("btn-export").onclick = exportReport;

// ---------------- 分类任务 ----------------
async function startClassify() {
  if (!selectedFiles.length) return alert("请先选择文件");
  try {
    await post("/api/classify", { files: selectedFiles.map((f) => f.path) });
    pollStatus(true);
  } catch (e) {
    alert("启动失败：" + e.message);
  }
}
async function stopClassify() {
  await post("/api/classify/stop", {});
}
$("btn-classify").onclick = startClassify;
$("btn-stop").onclick = stopClassify;

async function pollStatus(force) {
  try {
    const t = await api("/api/classify/status");
    $("task-state").textContent = t.running ? "运行中" : (t.error ? "出错：" + t.error : "空闲");
    const p = t.progress;
    if (p && p.total) {
      $("task-progress").innerHTML =
        `<div class="bar"><div style="width:${Math.round((p.done / p.total) * 100)}%"></div></div>
         <div class="tip">${p.file ? p.file.split(/[\\/]/).pop() : ""} · ${p.done}/${p.total} · LLM ${p.llmCalls} 次 · judge ${p.judgeCalls} 次</div>`;
    }
    $("task-log").textContent = (t.log || []).join("\n") || "（暂无日志）";
    $("task-log").scrollTop = $("task-log").scrollHeight;
    if (t.running || force) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollStatus, 1500);
    }
  } catch {
    pollTimer = setTimeout(pollStatus, 3000);
  }
}
pollStatus();

// ---------------- 人审队列（学科多标签） ----------------
let taxonomyCache = null;

async function loadTaxonomyOnce(refresh) {
  if (!taxonomyCache || refresh) {
    taxonomyCache = await api("/api/taxonomy");
  }
  return taxonomyCache;
}

function syncReviewFile() {
  if (!$("rv-file").value && selectedFiles.length) $("rv-file").value = selectedFiles[0].path;
}

async function loadReview() {
  const file = $("rv-file").value.trim();
  if (!file) return alert("请输入 jsonl 路径");
  const tax = await loadTaxonomyOnce();
  try {
    const data = await api("/api/review-list?file=" + encodeURIComponent(file));
    $("rv-count").textContent = `待人审 ${data.count} 条`;
    const box = $("rv-list");
    box.innerHTML = "";
    if (!data.count) {
      box.innerHTML = '<p class="tip">没有待人审条目（低置信/冲突/标签数异常且未解决）。可先执行分类任务。</p>';
      return;
    }
    for (const r of data.rows) {
      const div = document.createElement("div");
      div.className = "rv-item";
      const curTxt = (r.subjects || []).map((s) => `${s.l1}${s.l2 ? "/" + s.l2 : ""}`).join("；") || "—";
      div.innerHTML = `
        <div class="q">#${escapeHtml(r.id)} ${escapeHtml(r.question)} ${r.conflict ? '<span class="badge warn">先验冲突</span>' : ""}${r.tagsOutOfRange ? '<span class="badge warn">标签数越界</span>' : ""}</div>
        <div class="a">${escapeHtml(r.answer)}</div>
        <div class="cur">当前：学科 ${escapeHtml(curTxt)} ·
          类型 ${r.contentType ? escapeHtml(r.contentType.type) : "—"} · 依据 ${escapeHtml(r.reasons || "—")} ${r.error ? "· " + escapeHtml(r.error) : ""}</div>
        <div class="ops rv-tags-box" data-tags=""></div>
        <div class="ops">
          类型 <select class="ct"></select>
          <button class="ok-btn">确认提交</button>
        </div>`;
      fillCtSelect(div, tax, r);
      renderTagRows(div, tax, r);
      div.querySelector(".ok-btn").onclick = async () => {
        const subjects = readTagRows(div);
        if (!subjects.length) return alert("至少选择 1 个学科标签");
        const ctVal = div.querySelector(".ct").value;
        try {
          await post("/api/review", { file, id: r.id, patch: { subjects, contentType: ctVal } });
          div.style.opacity = 0.45;
          div.querySelector(".ok-btn").disabled = true;
          div.querySelector(".ok-btn").textContent = "已确认";
        } catch (e) {
          alert("提交失败：" + e.message);
        }
      };
      box.appendChild(div);
    }
  } catch (e) {
    alert("加载失败：" + e.message);
  }
}

/** 人审多标签行：最多 3 行（l1 + l2），第 1 行必填 */
function renderTagRows(div, tax, cur) {
  const box = div.querySelector(".rv-tags-box");
  box.innerHTML = "";
  const tree = tax.taxonomy.tree;
  const initial = (cur.subjects && cur.subjects.length ? cur.subjects : [null]).slice(0, 3);
  const maxTags = 3;
  function addRow(init) {
    if (box.children.length >= maxTags) return;
    const row = document.createElement("div");
    row.className = "rv-tag-row";
    const l1 = document.createElement("select");
    l1.className = "l1";
    tree.forEach((n) => {
      const o = document.createElement("option");
      o.value = n.label;
      o.textContent = n.zh ? `${n.label}（${n.zh}）` : n.label;
      l1.appendChild(o);
    });
    if (init && init.l1) l1.value = init.l1;
    const l2 = document.createElement("select");
    l2.className = "l2";
    function fillL2() {
      l2.innerHTML = "";
      const none = document.createElement("option");
      none.value = ""; none.textContent = "（仅一级）";
      l2.appendChild(none);
      const node = tree.find((n) => n.label === l1.value);
      (node && node.children || []).forEach((c) => {
        const o = document.createElement("option");
        o.value = c.label;
        o.textContent = c.zh ? `${c.label}（${c.zh}）` : c.label;
        l2.appendChild(o);
      });
      if (init && init.l2 && init.l1 === l1.value) l2.value = init.l2;
    }
    fillL2();
    l1.onchange = fillL2;
    const del = document.createElement("button");
    del.textContent = "删标签";
    del.onclick = () => {
      row.remove();
      syncAddBtn();
    };
    row.appendChild(l1); row.appendChild(l2); row.appendChild(del);
    box.appendChild(row);
    syncAddBtn();
  }
  function syncAddBtn() {
    let btn = box.querySelector(".add-tag");
    if (box.children.length < maxTags && !btn) {
      btn = document.createElement("button");
      btn.className = "add-tag";
      btn.textContent = "＋ 学科标签（交叉）";
      btn.onclick = () => addRow(null);
      box.appendChild(btn);
    } else if (box.children.length >= maxTags && btn) {
      btn.remove();
    }
  }
  initial.forEach((s) => addRow(s));
}

function readTagRows(div) {
  const out = [];
  div.querySelectorAll(".rv-tag-row").forEach((row) => {
    const l1 = row.querySelector(".l1").value;
    const l2 = row.querySelector(".l2").value;
    if (l1 && !out.some((x) => x.l1 === l1 && x.l2 === l2)) out.push({ l1, l2 });
  });
  return out;
}

function fillCtSelect(div, tax, cur) {
  const selCt = div.querySelector(".ct");
  tax.contentTypes.types.forEach((t) => {
    const o = document.createElement("option");
    o.value = t.label;
    o.textContent = t.label;
    selCt.appendChild(o);
  });
  if (cur.contentType && cur.contentType.type) selCt.value = cur.contentType.type;
}

$("rv-load").onclick = loadReview;
$("rv-refresh").onclick = loadReview;

// ---------------- 标签库管理 ----------------
let taxEdit = null; // {taxonomy, contentTypes} 编辑器内容

async function loadTaxonomyTab(force) {
  const data = await loadTaxonomyOnce(force);
  if (force) taxonomyCache = data;
  if (!taxEdit || force) {
    taxEdit = { taxonomy: JSON.parse(JSON.stringify(data.taxonomy)), contentTypes: JSON.parse(JSON.stringify(data.contentTypes)) };
  }
  $("tax-path").textContent = data.path || "";
  fillPresetSelect(data.presets || []);
  renderTaxTree();
  renderCtList();
}

function fillPresetSelect(presets) {
  const sel = $("tax-preset");
  sel.innerHTML = "";
  presets.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.name || p.id}（一级 ${p.l1Count} · 二级 ${p.l2Count}）`;
    sel.appendChild(o);
  });
}

function mkInput(cls, value, placeholder, oninput) {
  const el = document.createElement("input");
  el.className = cls;
  el.value = value ?? "";
  el.placeholder = placeholder;
  el.oninput = () => oninput(el.value);
  return el;
}

function renderTaxTree() {
  const box = $("tax-tree");
  box.innerHTML = "";
  const tax = taxEdit.taxonomy;
  $("tax-version").textContent = `version ${tax.version} · 更新于 ${tax.updated || "?"} · label=英文最终口径，zh=中文对照`;
  tax.tree.forEach((node, i) => {
    const div = document.createElement("div");
    div.className = "tax-l1";
    const head = document.createElement("div");
    head.className = "row";
    head.appendChild(mkInput("tlabel", node.label, "英文标签（最终口径）", (v) => { node.label = v; }));
    head.appendChild(mkInput("tzh", node.zh || "", "中文名", (v) => { node.zh = v; }));
    head.appendChild(mkInput("tdesc", node.desc || "", "一句描述", (v) => { node.desc = v; }));
    const up = mkMoveBtn("上移", () => { if (i > 0) { tax.tree.splice(i - 1, 0, tax.tree.splice(i, 1)[0]); renderTaxTree(); } }, i > 0);
    const del = document.createElement("button");
    del.textContent = "删除一级";
    del.className = "danger";
    del.onclick = () => {
      if (!confirm(`删除一级学科「${node.label}」及其全部二级？`)) return;
      tax.tree = tax.tree.filter((n) => n !== node);
      renderTaxTree();
    };
    head.appendChild(up);
    head.appendChild(del);
    div.appendChild(head);
    (node.children || []).forEach((c, j) => {
      const row = document.createElement("div");
      row.className = "tax-l2";
      row.appendChild(mkInput("tlabel", c.label, "英文方向名", (v) => { c.label = v; }));
      row.appendChild(mkInput("tzh", c.zh || "", "中文名", (v) => { c.zh = v; }));
      row.appendChild(mkInput("tdesc", c.desc || "", "一句描述", (v) => { c.desc = v; }));
      const up2 = mkMoveBtn("上移", () => { if (j > 0) { node.children.splice(j - 1, 0, node.children.splice(j, 1)[0]); renderTaxTree(); } }, j > 0);
      const del2 = document.createElement("button");
      del2.textContent = "删";
      del2.onclick = () => { node.children = (node.children || []).filter((x) => x !== c); renderTaxTree(); };
      row.appendChild(up2);
      row.appendChild(del2);
      div.appendChild(row);
    });
    const ops = document.createElement("div");
    ops.className = "tax-ops";
    const addBtn = document.createElement("button");
    addBtn.textContent = "＋ 二级方向";
    addBtn.onclick = () => { (node.children = node.children || []).push({ label: "", zh: "", desc: "" }); renderTaxTree(); };
    ops.appendChild(addBtn);
    div.appendChild(ops);
    box.appendChild(div);
  });
}

function mkMoveBtn(text, fn, enabled) {
  const b = document.createElement("button");
  b.textContent = text;
  b.disabled = !enabled;
  b.onclick = fn;
  return b;
}

function renderCtList() {
  const box = $("ct-list");
  box.innerHTML = "";
  const cts = taxEdit.contentTypes;
  $("ct-version").textContent = `version ${cts.version}`;
  cts.types.forEach((t) => {
    const row = document.createElement("div");
    row.className = "ct-row";
    row.innerHTML = `<input class="tlabel" value="${escapeHtml(t.label)}" placeholder="类型名">
      <input class="tdesc" value="${escapeHtml(t.desc || "")}" placeholder="一句描述">`;
    const del = document.createElement("button");
    del.textContent = "删";
    del.className = "danger";
    del.onclick = () => { cts.types = cts.types.filter((x) => x !== t); renderCtList(); };
    row.appendChild(del);
    row.querySelectorAll("input")[0].oninput = (e) => { t.label = e.target.value; };
    row.querySelectorAll("input")[1].oninput = (e) => { t.desc = e.target.value; };
    box.appendChild(row);
  });
}

$("tax-add-l1").onclick = () => { taxEdit.taxonomy.tree.push({ label: "", desc: "", children: [] }); renderTaxTree(); };
$("ct-add").onclick = () => { taxEdit.contentTypes.types.push({ label: "", desc: "" }); renderCtList(); };
$("tax-reload").onclick = () => loadTaxonomyTab(true).catch((e) => alert("载入失败：" + e.message));

$("tax-load-preset").onclick = async () => {
  const id = $("tax-preset").value;
  if (!id) return;
  if (!confirm("加载预置会替换编辑器中的学科树（未保存的修改将丢失），继续？")) return;
  try {
    const r = await post("/api/taxonomy/preset", { id });
    taxEdit.taxonomy = r.taxonomy;
    renderTaxTree();
    $("tax-tip").textContent = `已加载预置 ${id}（编辑后需点保存才生效）`;
  } catch (e) {
    alert("加载失败：" + e.message);
  }
};

$("tax-propose").onclick = async () => {
  if (!selectedFiles.length) return alert("请先在统计仪表盘选择文件（从其内容归纳）");
  $("tax-tip").textContent = "LLM 归纳中（抽样 80 条）…";
  $("tax-propose").disabled = true;
  try {
    const r = await post("/api/taxonomy/propose", { files: selectedFiles.map((f) => f.path) });
    const apply = confirm(
      `归纳完成（抽样 ${r.sampleUsed} 条）。${r.errors && r.errors.length ? "注意：建议稿存在待修订问题：\n" + r.errors.join("\n") + "\n" : ""}` +
      `是否载入编辑器？（仅替换编辑器内容，需人工修订并保存后才生效）`
    );
    if (apply) {
      taxEdit.taxonomy = { ...r.proposal, version: 0, updated: "" };
      renderTaxTree();
      $("tax-tip").textContent = "已载入 LLM 建议稿（修订后保存生效）";
    } else {
      $("tax-tip").textContent = "已取消（建议稿未应用）";
    }
  } catch (e) {
    alert("归纳失败：" + e.message);
    $("tax-tip").textContent = "";
  } finally {
    $("tax-propose").disabled = false;
  }
};

$("tax-save").onclick = async () => {
  try {
    const r = await put("/api/taxonomy", { taxonomy: taxEdit.taxonomy });
    taxonomyCache = null;
    $("tax-tip").textContent = `已保存：${r.saved.file}（version ${r.saved.version}；旧分类缓存将失效，重跑分类时增量重分类）`;
    loadTaxonomyTab(true).catch(() => {});
  } catch (e) {
    alert("保存失败：\n" + e.message);
  }
};
$("ct-save").onclick = async () => {
  try {
    const r = await put("/api/taxonomy", { contentTypes: taxEdit.contentTypes });
    taxonomyCache = null;
    $("tax-tip").textContent = `内容类型已保存（version ${r.saved.version}）`;
    loadTaxonomyTab(true).catch(() => {});
  } catch (e) {
    alert("保存失败：\n" + e.message);
  }
};

// ---------------- 标签库浏览（表 + 图 + 系统保存框导出） ----------------
function taxBrowserRows() {
  // 标签全表（taxonomy）× 计数（来自最近一次统计，可能没有）
  const stats = currentPayload && currentPayload.stats;
  const l1Count = new Map();
  const l2Count = new Map();
  if (stats && stats.subject) {
    for (const n of stats.subject.tree) {
      l1Count.set(n.name, n.value);
      for (const c of n.children || []) l2Count.set(`${n.name}/${c.name}`, c.value);
    }
  }
  const classified = stats && stats.subject ? stats.subject.classified : null;
  const pct = (v) => (classified && Number.isFinite(v) ? Number(((v / classified) * 100).toFixed(1)) : null);
  const rows = [];
  for (const n of taxEdit.taxonomy.tree) {
    const l1c = l1Count.get(n.label) || 0;
    if (!(n.children || []).length) {
      rows.push({ l1: n.label, l1zh: n.zh || "", l1desc: n.desc || "", l2: "", l2zh: "", l2desc: "", count: l1c, pct: pct(l1c) });
      continue;
    }
    for (const c of n.children) {
      const c2 = l2Count.get(`${n.label}/${c.label}`) || 0;
      rows.push({ l1: n.label, l1zh: n.zh || "", l1desc: n.desc || "", l2: c.label, l2zh: c.zh || "", l2desc: c.desc || "", count: c2, pct: pct(c2) });
    }
  }
  return rows;
}

$("tax-browse").onclick = async () => {
  if (!taxEdit) await loadTaxonomyTab(false).catch(() => {});
  const ov = $("tax-browser");
  ov.hidden = false;
  const stats = currentPayload && currentPayload.stats;
  $("tax-browser-meta").textContent = stats
    ? `（含最近一次统计的 ${stats.subject.classified} 条已分类计数；平均每题 ${stats.subject.multiLabel.avgSubjects} 个标签）`
    : "（尚无统计计数——先在仪表盘点「查询」）";
  const rows = taxBrowserRows();
  const tb = $("tb-table").querySelector("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(r.l1)}</td><td>${escapeHtml(r.l1zh)}</td><td>${escapeHtml(r.l1desc)}</td>
      <td>${escapeHtml(r.l2)}</td><td>${escapeHtml(r.l2zh)}</td><td>${escapeHtml(r.l2desc)}</td>
      <td>${r.count}</td><td>${r.pct == null ? "—" : r.pct + "%"}</td>`;
    tb.appendChild(tr);
  }
  // 旭日：优先用统计树（有计数），否则用标签库树（0 计数仅结构）
  const sunData = (stats && stats.subject.tree.length
    ? stats.subject.tree
    : taxEdit.taxonomy.tree.map((n) => ({ name: n.label, value: 0, children: (n.children || []).map((c) => ({ name: c.label, value: 0 })) })));
  const c1 = chart("tb-sunburst");
  c1.resize();
  c1.setOption({
    tooltip: {},
    series: [{ type: "sunburst", radius: ["14%", "90%"], label: { fontSize: 11, minAngle: 8 }, data: sunData }],
  }, true);
  // 共现热力（有统计才画）
  const c2 = chart("tb-cooc");
  const co = stats && stats.cross && stats.cross.subjectCooccurrence;
  if (co && co.pairs && co.pairs.length) {
    const labels = co.labels;
    const cells = [];
    co.pairs.forEach((p) => {
      const i = labels.indexOf(p.a), j = labels.indexOf(p.b);
      cells.push([i, j, p.count], [j, i, p.count]);
    });
    c2.setOption({
      title: { text: "学科交叉共现", left: "center", textStyle: { fontSize: 13 } },
      tooltip: { position: "top" },
      grid: { left: 110, bottom: 90 },
      xAxis: { type: "category", data: labels, axisLabel: { rotate: 35 } },
      yAxis: { type: "category", data: labels },
      visualMap: { min: 0, max: co.pairs[0].count, calculable: true, orient: "horizontal", left: "center", bottom: 0 },
      series: [{ type: "heatmap", label: { show: true }, data: cells }],
    }, true);
  } else {
    noData(c2, "无交叉学科共现数据（先分类 + 查询）");
  }
};

$("tb-close").onclick = () => { $("tax-browser").hidden = true; };

$("tb-csv").onclick = async () => {
  const rows = taxBrowserRows();
  const csv = csvOf(["一级学科(英)", "一级中文名", "一级描述", "二级方向(英)", "二级中文名", "二级描述", "QA标签数", "占已分类%"], rows.map((r) => ({
    "一级学科(英)": r.l1, "一级中文名": r.l1zh, "一级描述": r.l1desc,
    "二级方向(英)": r.l2, "二级中文名": r.l2zh, "二级描述": r.l2desc,
    "QA标签数": r.count, "占已分类%": r.pct == null ? "" : r.pct,
  })));
  const r = await saveWithPicker("标签库全表.csv", new Blob([csv], { type: "text/csv" }));
  if (r.ok) $("tax-browser-meta").textContent = "已保存 CSV";
};

$("tb-json").onclick = async () => {
  const stats = currentPayload && currentPayload.stats;
  const payload = {
    exportedAt: new Date().toISOString(),
    taxonomy: taxEdit.taxonomy,
    counts: stats && stats.subject ? { classified: stats.subject.classified, tree: stats.subject.tree, multiLabel: stats.subject.multiLabel, cooccurrence: stats.cross.subjectCooccurrence } : null,
  };
  const r = await saveWithPicker("标签库.json", new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  if (r.ok) $("tax-browser-meta").textContent = "已保存 JSON";
};

$("tb-html").onclick = async () => {
  const rows = taxBrowserRows();
  const stats = currentPayload && currentPayload.stats;
  const trs = rows.map((r) => `<tr><td>${escapeHtml(r.l1)}</td><td>${escapeHtml(r.l1zh)}</td><td>${escapeHtml(r.l1desc)}</td><td>${escapeHtml(r.l2)}</td><td>${escapeHtml(r.l2zh)}</td><td>${escapeHtml(r.l2desc)}</td><td>${r.count}</td><td>${r.pct == null ? "—" : r.pct + "%"}</td></tr>`).join("\n");
  const co = stats && stats.cross && stats.cross.subjectCooccurrence;
  const coHtml = co && co.pairs.length
    ? "<h2>学科交叉共现 Top</h2><table><tr><th>学科 A</th><th>学科 B</th><th>共现题数</th></tr>" +
      co.pairs.slice(0, 30).map((p) => `<tr><td>${escapeHtml(p.a)}</td><td>${escapeHtml(p.b)}</td><td>${p.count}</td></tr>`).join("") + "</table>"
    : "";
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>标签库全表</title>
<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#1f2329}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #e5e7eb;padding:5px 10px;text-align:left}h1{font-size:20px}h2{font-size:16px;margin-top:28px}</style>
</head><body><h1>qa-stats 标签库全表</h1>
<p>导出时间 ${new Date().toISOString()} · 学科树 version ${taxEdit.taxonomy.version}（${taxEdit.taxonomy.updated || "?"}）${stats ? " · 计数来自最近一次统计（" + stats.subject.classified + " 条已分类，多标签口径）" : " · 尚无统计计数"}；学科名称以英文为最终口径，中文为对照</p>
<h2>标签清单</h2>
<table><tr><th>一级学科(英)</th><th>中文名</th><th>描述</th><th>二级方向(英)</th><th>中文名</th><th>描述</th><th>QA 标签数</th><th>占已分类%</th></tr>
${trs}</table>
${coHtml}</body></html>`;
  const r = await saveWithPicker("标签库全表.html", new Blob([html], { type: "text/html" }));
  if (r.ok) $("tax-browser-meta").textContent = "已保存 HTML";
};

// ---------------- 设置 ----------------
let providersList = [];

async function loadSettings() {
  const data = await api("/api/state");
  providersList = data.providers || [];
  renderSettings(data.state);
}

function modelRow(kind, cfg) {
  return `<div class="grp" id="grp-${kind}">
    <h3>${kind === "primary" ? "主分类模型（L1 批量 + 结构探测 + 标签归纳）" : "仲裁模型（L2，可选；低置信/冲突/标签数越界时单题重判）"}</h3>
    <div class="row">
      <label>供应商 <select data-k="${kind}.provider"></select></label>
      <label>接口 <input data-k="${kind}.endpoint" value="${escapeHtml(cfg.endpoint || "")}" style="width:260px"></label>
      <label>Key <input data-k="${kind}.apiKey" type="password" value="${escapeHtml(cfg.apiKey || "")}" style="width:140px"></label>
    </div>
    <div class="row">
      <label>模型 <input data-k="${kind}.modelId" value="${escapeHtml(cfg.modelId || "")}" style="width:320px" list="models-${kind}"></label>
      <datalist id="models-${kind}"></datalist>
      <button data-act="scan-models" data-k="${kind}">扫描模型</button>
      <button data-act="test-model" data-k="${kind}">测试</button>
      <span class="tip" id="tip-${kind}"></span>
    </div>
  </div>`;
}

function renderSettings(s) {
  const p = $("settings-panel");
  p.innerHTML = `
    ${modelRow("primary", s.models.primary)}
    ${modelRow("judge", s.models.judge)}
    <div class="row" style="margin-bottom:14px">
      <button id="btn-import-models">从家族项目导入模型配置（q-a-factual / q-a）</button>
      <span class="tip" id="import-tip"></span>
    </div>
    <div class="grp">
      <h3>引擎参数</h3>
      <div class="row">
        <label>每批题数 <input data-k="batchSize" type="number" min="1" max="40" value="${s.batchSize}" style="width:70px"></label>
        <label>并发 <input data-k="concurrency" type="number" min="1" max="8" value="${s.concurrency}" style="width:60px"></label>
        <label>低置信阈值 <input data-k="lowConf" type="number" min="0" max="1" step="0.05" value="${s.lowConf}" style="width:70px"></label>
        <label>学科标签上限 <input data-k="maxSubjects" type="number" min="1" max="5" value="${s.maxSubjects ?? 3}" style="width:60px"></label>
        <label>eval 低分阈值 <input data-k="evalLow" type="number" min="0" max="10" step="0.5" value="${s.evalLow}" style="width:70px"></label>
        <label class="chk"><input data-k="useJudge" type="checkbox" ${s.useJudge ? "checked" : ""}> 启用 judge 仲裁</label>
        <label class="chk"><input data-k="autoSchema" type="checkbox" ${s.autoSchema !== false ? "checked" : ""}> 分类前自动结构探测（LLM 兜底）</label>
      </div>
      <div class="row">
        <label>扫描根目录 <input data-k="root" value="${escapeHtml(s.root || "")}" style="width:360px"></label>
        <label>学科树路径 <input data-k="taxonomyPath" value="${escapeHtml(s.taxonomyPath || "")}" placeholder="空=presets/taxonomy.json" style="width:260px"></label>
      </div>
      <div class="row"><button id="btn-save-settings">保存设置</button><span class="tip" id="settings-tip"></span></div>
    </div>`;

  // 供应商下拉（切换自动填 endpoint）
  for (const kind of ["primary", "judge"]) {
    const sel = p.querySelector(`select[data-k="${kind}.provider"]`);
    providersList.forEach((pv) => {
      const o = document.createElement("option");
      o.value = pv.id;
      o.textContent = pv.label;
      sel.appendChild(o);
    });
    const cur = providersList.find((pv) => pv.endpoint === s.models[kind].endpoint);
    sel.value = (cur && cur.id) || s.models[kind].provider || "custom";
    sel.onchange = () => {
      const pv = providersList.find((x) => x.id === sel.value);
      if (pv) p.querySelector(`input[data-k="${kind}.endpoint"]`).value = pv.endpoint;
    };
  }

  p.querySelector("#btn-save-settings").onclick = async () => {
    const body = { models: { primary: {}, judge: {} } };
    p.querySelectorAll("[data-k]").forEach((el) => {
      const parts = el.dataset.k.split(".");
      const v = el.type === "number" ? Number(el.value) : el.type === "checkbox" ? el.checked : el.value;
      if (parts[0] === "primary" || parts[0] === "judge") body.models[parts[0]][parts[1]] = v;
      else body[parts[0]] = v;
    });
    try {
      await api("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      $("settings-tip").textContent = "已保存";
      setTimeout(() => ($("settings-tip").textContent = ""), 2000);
    } catch (e) {
      alert("保存失败：" + e.message);
    }
  };

  p.querySelector("#btn-import-models").onclick = async () => {
    $("import-tip").textContent = "读取中…";
    try {
      const r = await post("/api/import-models", {});
      if (!r.ok) {
        $("import-tip").textContent = "失败：" + r.error;
        return;
      }
      for (const kind of ["primary", "judge"]) {
        if (r.models[kind]) {
          p.querySelector(`input[data-k="${kind}.endpoint"]`).value = r.models[kind].endpoint;
          p.querySelector(`input[data-k="${kind}.apiKey"]`).value = r.models[kind].apiKey;
          p.querySelector(`input[data-k="${kind}.modelId"]`).value = r.models[kind].modelId;
        }
      }
      $("import-tip").textContent = `已从 ${r.source} 导入（填入表单，记得点「保存设置」）`;
    } catch (e) {
      $("import-tip").textContent = "失败：" + e.message;
    }
  };

  // 扫描/测试模型
  p.querySelectorAll("button[data-act]").forEach((b) => {
    b.onclick = async () => {
      const kind = b.dataset.k;
      const readCfg = () => {
        const cfg = {};
        p.querySelectorAll(`[data-k^="${kind}."]`).forEach((el) => {
          cfg[el.dataset.k.split(".")[1]] = el.value;
        });
        return cfg;
      };
      const tip = $("tip-" + kind);
      tip.textContent = "请求中…";
      try {
        if (b.dataset.act === "scan-models") {
          const r = await post("/api/list-models", { cfg: readCfg() });
          tip.textContent = r.ok ? r.detail : "失败：" + r.detail;
          if (r.ok) {
            const dl = $("models-" + kind);
            dl.innerHTML = "";
            r.models.forEach((m) => {
              const o = document.createElement("option");
              o.value = m;
              dl.appendChild(o);
            });
          }
        } else {
          const r = await post("/api/test-model", { cfg: readCfg() });
          tip.textContent = r.ok ? r.detail : "失败：" + r.detail;
        }
      } catch (e) {
        tip.textContent = "失败：" + e.message;
      }
    };
  });
}

loadSettings().catch((e) => console.error(e));
