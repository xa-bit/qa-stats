"use strict";

/**
 * 扫盘：递归查找 QA 语料 jsonl。
 * v1.1 放宽：不要求 -qa.jsonl 后缀——字段名与命名未知的通用 QA 语料（*.jsonl）也纳入；
 * 排除本工具自身产物（-cls.jsonl）与 node_modules / 缓存 / 报告目录。
 */

const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", "qa-stats-cache", ".git", "qa-stats-report"]);

function fileMeta(full) {
  const st = fs.statSync(full);
  return {
    path: full,
    stem: path.basename(full).replace(/\.jsonl$/i, ""),
    size: st.size,
    mtime: st.mtime.toISOString(),
    hasCls: fs.existsSync(full.replace(/\.jsonl$/i, "") + "-cls.jsonl"),
    hasSchema: fs.existsSync(full.replace(/\.jsonl$/i, "") + "-schema.json"),
  };
}

function scanRoot(root, { maxDepth = 6 } = {}) {
  const out = [];
  walk(String(root), 0);
  // 家族 -qa.jsonl 产物排前，其余通用 jsonl 按名称排
  out.sort((a, b) =>
    (b.path.endsWith("-qa.jsonl") ? 1 : 0) - (a.path.endsWith("-qa.jsonl") ? 1 : 0) || a.path.localeCompare(b.path));
  return out;

  function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && /\.jsonl$/i.test(e.name) && !/-cls\.jsonl$/i.test(e.name)) {
        try {
          out.push(fileMeta(full));
        } catch {
          /* 不可读跳过 */
        }
      }
    }
  }
}

/** 文件模式：显式路径列表（存在且为 .jsonl，排除 -cls 产物） */
function scanFiles(list) {
  const out = [];
  for (const p of list || []) {
    const f = String(p);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && /\.jsonl$/i.test(f) && !/-cls\.jsonl$/i.test(f)) out.push(fileMeta(f));
    } catch {
      /* 不存在跳过 */
    }
  }
  return out;
}

module.exports = { scanRoot, scanFiles };
