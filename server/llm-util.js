"use strict";

/**
 * LLM 输出解析工具。
 * 与家族 q-a-factual/server/llm-util.js 同源（借自 easy-dataset lib/llm/common/util.js 的
 * extractJsonFromLLMOutput；jsonrepair 的轻量替代为「括号配对截取 + 二次解析」）。
 * distilabel 同款容错原则：解析失败不丢数据，由调用方置 null 并保留原始响应。
 */

function tryJsonRepair(s) {
  // 轻量修复：补全字符串外的括号（应对模型截断），仅尽力而为
  let out = s;
  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (ch === "}" && open !== "{") out = out.slice(0, i) + out.slice(i + 1);
      if (ch === "]" && open !== "[") out = out.slice(0, i) + out.slice(i + 1);
    }
  }
  if (inStr) out += '"';
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

function extractJsonFromLLMOutput(output) {
  let text = String(output ?? "");
  if (text.trim().startsWith("<think")) {
    text = extractAnswer(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    /* 继续 */
  }
  const match = /```json\s*([\s\S]*?)```/.exec(text);
  if (match) {
    const jsonString = match[1].trim();
    try {
      return JSON.parse(jsonString);
    } catch {
      return tryJsonRepair(jsonString);
    }
  }
  // 无围栏：尝试括号配对截取后再解析
  const first = text.search(/[[{]/);
  const lastCurly = text.lastIndexOf("}");
  const lastSquare = text.lastIndexOf("]");
  const last = Math.max(lastCurly, lastSquare);
  if (first !== -1 && last > first) {
    const slice = text.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return tryJsonRepair(slice);
    }
  }
  return tryJsonRepair(text);
}

function safeParseJSON(output) {
  try {
    return JSON.parse(String(output ?? ""));
  } catch {
    return extractJsonFromLLMOutput(output);
  }
}

/** 剥离 <think>…</think>（或未闭合的 <think>） */
function extractAnswer(output) {
  const text = String(output ?? "");
  const cleaned = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  const openIdx = cleaned.search(/<think(?:ing)?>/i);
  return (openIdx === -1 ? cleaned : cleaned.slice(0, openIdx)).trim();
}

/** 思维链内容（<think> 包裹形态） */
function extractThinkChain(output) {
  const text = String(output ?? "");
  const m = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/i.exec(text);
  return m ? m[1].trim() : "";
}

module.exports = { extractJsonFromLLMOutput, safeParseJSON, extractAnswer, extractThinkChain };
