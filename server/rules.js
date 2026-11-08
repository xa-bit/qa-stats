"use strict";

/**
 * L0 规则层（确定性，零 LLM）——设计 §6.2。
 *
 * 产出两类结果：
 * - 定案（confidence >= 0.9）：直接采用，跳过 LLM（省时省钱）
 * - 先验（confidence < 0.9）：附在题上，供 L1 提示参考、L2 校验冲突
 *
 * 关键词字典针对海洋气象语料（上游产物为纯英文题面，中英词汇都收）。
 */

const FINAL_CONF = 0.9; // 定案阈值（与 classify.js 共用约定）

/** 数学符号密度：数字/运算符/数学符号字符占比（0~1） */
function mathDensity(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  const m = s.match(/[0-9.]|%|[+\-*/=^<>]|[∑∫∂∇√±≤≥≈×÷μσ°]|\b\d+(\.\d+)?\s*(m|km|kg|s|h|Pa|hPa|W|mSv|°C|°N|°E|ppt|psu)\b/gi);
  const hits = m ? m.join("").length : 0;
  return Number(Math.min(1, hits / s.length).toFixed(4));
}

/** gaPair（提问角度）→ 内容类型先验；formula 在高数学密度下定案 */
const GA_CONTENT_PRIOR = {
  fact: { type: "概念定义", confidence: 0.55 },
  relation: { type: "关系比较", confidence: 0.6 },
  synthesize: { type: "综合论述", confidence: 0.6 },
  formula: { type: "数值计算", confidence: 0.8 },
  compare: { type: "关系比较", confidence: 0.6 },
  apply: { type: "应用实例", confidence: 0.55 },
  method: { type: "方法流程", confidence: 0.55 },
  evidence: { type: "证据引用", confidence: 0.55 },
};

/**
 * 学科先验词典：按二级树节点（l1 / l2）收录触发词。
 * 书级（stem/chunkName 命中）置信度取 high；题面命中取 low。
 * 顺序即优先级：先精确主题词，后泛主题词。
 */
const SUBJECT_KEYWORDS = [
  // 物理海洋学
  { l1: "物理海洋学", l2: "波浪与潮汐", conf: { high: 0.9, low: 0.6 }, words: ["tide", "tidal", "wave", "swell", "rogue wave", "storm surge", "潮汐", "波浪", "风暴潮"] },
  { l1: "物理海洋学", l2: "海洋环流", conf: { high: 0.9, low: 0.6 }, words: ["circulation", "gyre", "current", "overturning", "thermohaline", "eddy", "环流", "洋流", "涡旋"] },
  { l1: "物理海洋学", l2: "海水性质", conf: { high: 0.85, low: 0.55 }, words: ["salinity", "temperature", "density", "stratification", "thermocline", "halocline", "盐度", "温跃层", "层结"] },
  { l1: "物理海洋学", l2: "海气相互作用", conf: { high: 0.85, low: 0.55 }, words: ["air-sea", "flux", "bulk formula", "sst", "sea surface temperature", "海气", "通量"] },
  // 气象学与气候
  { l1: "气象学与气候", l2: "大气动力", conf: { high: 0.85, low: 0.55 }, words: ["geostrophic", "coriolis", "jet stream", "vorticity", "rossby", "front", "cyclone", "大气环流", "气旋"] },
  { l1: "气象学与气候", l2: "天气现象", conf: { high: 0.85, low: 0.55 }, words: ["precipitation", "cloud", "convection", "thunderstorm", "hurricane", "typhoon", "降水", "对流", "台风"] },
  { l1: "气象学与气候", l2: "气候系统", conf: { high: 0.85, low: 0.55 }, words: ["climate", "enso", "monsoon", "oscillation", "warming", "paleoclimate", "气候", "季风"] },
  { l1: "气象学与气候", l2: "辐射与边界层", conf: { high: 0.85, low: 0.55 }, words: ["radiation", "albedo", "boundary layer", "turbulence", "辐射", "边界层", "湍流"] },
  // 海洋化学
  { l1: "海洋化学", l2: "常量与微量组分", conf: { high: 0.85, low: 0.55 }, words: ["dissolved oxygen", "nutrient", "trace metal", "phosphate", "nitrate", "silicate", "营养盐", "溶解氧"] },
  { l1: "海洋化学", l2: "二氧化碳体系", conf: { high: 0.85, low: 0.55 }, words: ["alkalinity", "carbonate", "ph", "dissolved inorganic carbon", "碳酸", "碱度"] },
  // 生物地球化学
  { l1: "海洋生物地球化学", l2: "碳循环", conf: { high: 0.9, low: 0.6 }, words: ["carbon cycle", "carbon flux", "biological pump", "export production", "carbonate pump", "碳循环", "生物泵"] },
  { l1: "海洋生物地球化学", l2: "营养盐与生产力", conf: { high: 0.85, low: 0.55 }, words: ["primary production", "chlorophyll", "limiting nutrient", "new production", "regenerated", "初级生产力", "叶绿素"] },
  // 海洋生物学
  { l1: "海洋生物学", l2: "生物类群", conf: { high: 0.8, low: 0.5 }, words: ["plankton", "zooplankton", "phytoplankton", "benthos", "nekton", "fish", "marine mammal", "浮游", "底栖"] },
  { l1: "海洋生物学", l2: "生态结构与动力学", conf: { high: 0.8, low: 0.5 }, words: ["food web", "trophic", "ecosystem", "community structure", "niche", "食物网", "生态系统"] },
  // 地质
  { l1: "海洋地质与地球物理", l2: "海底地貌与沉积", conf: { high: 0.8, low: 0.5 }, words: ["sediment", "continental shelf", "seafloor", "turbidity", "deposition", "沉积", "大陆架"] },
  { l1: "海洋地质与地球物理", l2: "地球物理方法", conf: { high: 0.8, low: 0.5 }, words: ["gravity anomaly", "magnetic", "seismic", "bathymetry", "重力异常", "地震勘探"] },
  // 数学与统计
  { l1: "数学与统计方法", l2: "数学基础", conf: { high: 0.8, low: 0.5 }, words: ["derivative", "integral", "differential equation", "vector", "dimensional analysis", "微积分", "微分方程"] },
  { l1: "数学与统计方法", l2: "统计与数据分析", conf: { high: 0.85, low: 0.55 }, words: ["regression", "variance", "correlation", "probability", "hypothesis test", "significance", "statistic", "回归", "方差", "概率"] },
  { l1: "数学与统计方法", l2: "数值计算", conf: { high: 0.8, low: 0.5 }, words: ["finite difference", "numerical model", "stability criterion", "discretization", "差分", "数值模拟"] },
  // 观测与数据分析
  { l1: "观测与数据分析", l2: "现场观测", conf: { high: 0.85, low: 0.55 }, words: ["ctd", "mooring", "buoy", "argo float", "cruise", "drifter", "浮标", "航次"] },
  { l1: "观测与数据分析", l2: "遥感与再分析", conf: { high: 0.85, low: 0.55 }, words: ["satellite", "remote sensing", "altimetry", "reanalysis", "scatterometer", "遥感", "卫星"] },
  { l1: "观测与数据分析", l2: "数据可视化", conf: { high: 0.8, low: 0.5 }, words: ["contour plot", "map projection", "scatter plot", "time series plot", "可视化", "投影"] },
];

/** 在一段文本中按词典找学科先验；返回首个命中（词典顺序即优先级） */
function matchSubjectKeywords(text, level) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  for (const entry of SUBJECT_KEYWORDS) {
    for (const w of entry.words) {
      if (lower.includes(w.toLowerCase())) {
        return {
          l1: entry.l1,
          l2: entry.l2,
          confidence: level === "high" ? entry.conf.high : entry.conf.low,
          matched: w,
        };
      }
    }
  }
  return null;
}

/**
 * L0 规则主入口。row 为统一行；taxonomy/contentTypes 用于白名单校验（词典命中但树里
 * 没有对应节点时丢弃）。返回：
 * {
 *   subject:      {l1, l2, confidence, source:"rule"} | null,
 *   contentType:  {type, confidence, source:"rule"} | null,
 *   priors:       {subject|null, contentType|null, mathDensity, trackMath},   // 全量先验（含未达定案）
 *   decided:      boolean   // 任一维度达到定案阈值
 * }
 */
function runRules(row, taxonomy, contentTypes) {
  const l1Set = new Set(taxonomy.tree.map((n) => n.label));
  const l2Map = new Map();
  for (const n of taxonomy.tree) for (const c of n.children || []) l2Map.set(c.label, n.label);
  const ctSet = new Set(contentTypes.types.map((t) => t.label));

  // —— 内容类型 ——
  let contentType = null;
  const density = mathDensity(row.question + "\n" + row.answer);
  const gaKey = row.gaPair ? String(row.gaPair).toLowerCase() : "";
  const trackMath = row.track === "math";
  if (gaKey === "formula" && density >= 0.04) {
    contentType = { type: "数值计算", confidence: 0.95, source: "rule" }; // 定案
  } else if (gaKey === "formula") {
    contentType = { type: "数值计算", confidence: 0.8, source: "rule" };
  } else if (trackMath && density >= 0.04) {
    contentType = { type: "数值计算", confidence: 0.9, source: "rule" }; // 定案
  } else if (GA_CONTENT_PRIOR[gaKey] && ctSet.has(GA_CONTENT_PRIOR[gaKey].type)) {
    contentType = { ...GA_CONTENT_PRIOR[gaKey], source: "rule" };
  }
  if (contentType && !ctSet.has(contentType.type)) contentType = null;

  // —— 学科（书级强先验 → 章节级 → 题面弱先验）——
  let subject = null;
  const bookHit = matchSubjectKeywords(row.stem, "high") || matchSubjectKeywords(row.chunkName, "high");
  const qHit = matchSubjectKeywords(row.question, "low");
  const cand = bookHit || qHit;
  if (cand && l1Set.has(cand.l1) && l2Map.get(cand.l2) === cand.l1) {
    subject = { l1: cand.l1, l2: cand.l2, confidence: cand.confidence, source: "rule" };
  }

  const decided =
    (subject && subject.confidence >= FINAL_CONF) ||
    (contentType && contentType.confidence >= FINAL_CONF);

  return {
    subject,
    contentType,
    priors: { subject, contentType, mathDensity: density, trackMath },
    decided,
  };
}

module.exports = { runRules, mathDensity, matchSubjectKeywords, GA_CONTENT_PRIOR, SUBJECT_KEYWORDS, FINAL_CONF };
