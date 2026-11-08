"use strict";

/**
 * 分类提示词（L1 批量 / L2 单题仲裁共用骨架）。
 * 约束沿用 easy-dataset addLabel + distilabel TextClassification：
 * 标签白名单（带一句描述）、优先二级、兜底"其他"、仅输出 JSON。
 *
 * v2（PROMPT_VERSION 升级 → 分类缓存全量失效）：
 * - 学科改为【多标签】subjects 数组（1~maxSubjects 个，主学科在前），
 *   显式给出"数量纪律"：无交叉不凑数，交叉才加第二学科，抑制标签数失衡；
 * - 系统提示改为领域无关（taxonomy 可为任意领域树）。
 * 另含：标签库归纳建议稿提示词（easy-dataset getLabelPrompt 同款范式）。
 */

const PROMPT_VERSION = "v3";

/** 当前树生效的兜底类 label（英文树 Other / 中文树 其他；与 taxonomy.js 校验口径一致） */
function fallbackLabelOf(taxonomy) {
  const nodes = (taxonomy && taxonomy.tree) || [];
  for (const fb of ["Other", "其他"]) {
    if (nodes.some((n) => n.label === fb)) return fb;
  }
  for (const n of nodes) {
    if (/^others?$/i.test(n.label)) return n.label;
  }
  return "Other";
}

/**
 * 学科树渲染为紧凑清单：英文标签为最终口径，中文对照仅供理解。
 * 格式：- EnglishLabel（中文名）：描述
 */
function renderTaxonomy(taxonomy) {
  const lines = [];
  for (const n of taxonomy.tree) {
    const zh = n.zh ? `（${n.zh}）` : "";
    lines.push(`- ${n.label}${zh}：${n.desc || ""}`);
    for (const c of n.children || []) {
      const czh = c.zh ? `（${c.zh}）` : "";
      lines.push(`  - ${c.label}${czh}：${c.desc || ""}`);
    }
  }
  return lines.join("\n");
}

function renderContentTypes(contentTypes) {
  return contentTypes.types.map((t) => `${t.label}：${t.desc || ""}`).join("\n");
}

function renderItems(items) {
  return JSON.stringify(
    items.map((it) => ({
      id: it.id,
      q: String(it.question).slice(0, 400),
      a: String(it.answer ?? "").slice(0, 400),
      chunk: it.chunkName || "",
      prior: it.priors && (it.priors.subject || it.priors.contentType)
        ? {
            subject: it.priors.subject ? `${it.priors.subject.l1}/${it.priors.subject.l2 || ""}` : "",
            contentType: it.priors.contentType ? it.priors.contentType.type : "",
          }
        : null,
    })),
    null,
    0
  );
}

function buildSystemPrompt() {
  return "你是语料库标注专家，任务是为每道题选择学科与内容类型标签。学科允许交叉多标签，但必须遵守数量纪律。严格按用户给定的标签清单作答，只输出 JSON。";
}

const SUBJECT_RULES = (maxSubjects, fb) => `1. 学科（subjects，多标签，最多 ${maxSubjects} 个，按主次排序）：
   - 第一个必须是主学科（内容最核心的归属）；优先给到二级标签，匹配不到二级再只给一级；
   - 仅当题目内容确实横跨另一学科（该学科知识对回答此题不可或缺）时，才追加第二个学科；交叉学科题常见 2 个，罕见 3 个；
   - 数量纪律：绝大多数题给 1 个；确有交叉才给 2 个；3 个是上限且应当少见。禁止为凑数、求全面而多贴标签——全集语料的标签数量分布应当紧凑；
   - 都匹配不到时，主学科选兜底类「${fb}」（l2 填空字符串）；
   - 【标签语言】输出必须是清单中「英文标签原文」（每行冒号前的英文部分），禁止翻译成中文、禁止改写大小写以外的任何字符；清单中的中文括号内容仅供你理解含义，绝不出现在输出里；
   - 结合题面、答案要点与来源章节名（chunk）综合判断，已给出的先验（prior）仅供参考，可以推翻；`;

/** L1 批量分类提示词 */
function buildClassifyPrompt(items, taxonomy, contentTypes, { maxSubjects = 3 } = {}) {
  const fb = fallbackLabelOf(taxonomy);
  return `请为下列每道题选择【学科】（多标签）与【内容类型】。

学科清单（二级树；标签必须严格取自本清单的英文原文）：
${renderTaxonomy(taxonomy)}

内容类型清单（封闭集；标签必须严格取自本清单）：
${renderContentTypes(contentTypes)}

判定规则：
${SUBJECT_RULES(maxSubjects, fb)}
2. 内容类型：单选。按答案的实际内容性质选择，题目的提问角度（prior.contentType，如有）仅供参考，可以推翻；
3. confidence 为你对这道题整体判定的把握程度，取 0~1 的小数（保留一位即可）；
4. reasons 用一句话说明判定依据（中文，不超过 40 字，含是否交叉及为何）；
5. 禁止编造清单之外的标签；仅输出 JSON 数组，不要任何其他文字。

输出格式（数组元素与输入 id 一一对应，逐题给出，不得遗漏）：
[{"id":"...","subjects":[{"l1":"一级标签","l2":"二级标签或空字符串"},{"l1":"...","l2":"..."}],"contentType":"类型标签","confidence":0.0,"reasons":"..."}]
注：subjects 至少 1 个、最多 ${maxSubjects} 个；仅一级可判时该学科对象 l2 填空字符串 ""；选中兜底类「${fb}」时 l2 也填 ""。

题目列表：
${renderItems(items)}`;
}

/** L2 单题仲裁提示词（同一约束，独立重判，可换 judge 模型） */
function buildArbitratePrompt(item, taxonomy, contentTypes, { maxSubjects = 3 } = {}) {
  const fb = fallbackLabelOf(taxonomy);
  return `请仔细重判下面这一道题的【学科】（多标签）与【内容类型】。此题此前被判为低置信、标签数异常或与规则先验冲突，请给出你的独立判断。

学科清单（二级树；标签必须严格取自本清单的英文原文）：
${renderTaxonomy(taxonomy)}

内容类型清单（封闭集；标签必须严格取自本清单）：
${renderContentTypes(contentTypes)}

规则：
${SUBJECT_RULES(maxSubjects, fb)}
- 内容类型单选，按答案实际内容性质判定；confidence 取 0~1；reasons 一句话。
仅输出一个 JSON 对象（不要数组、不要其他文字）：
{"id":"...","subjects":[{"l1":"...","l2":"..."}],"contentType":"...","confidence":0.0,"reasons":"..."}

题目：
${renderItems([item])}`;
}

// ---------- 标签库归纳（建议稿，不直接生效；人工确认后保存） ----------

/**
 * 从语料样本归纳学科二级树建议稿（easy-dataset getLabelPrompt 范式）。
 * 产出双语标签（英文规范名 + 中文对照），与主流期刊分类体系（AGU 分会 / Nature Portfolio /
 * Science 与 Scopus 学科类别）粒度对齐。samples：[{question, answer, chunkName}]
 */
function buildTaxonomyProposePrompt(samples, { maxL1 = 14, maxL2 = 8 } = {}) {
  const items = samples
    .map((s) => `- [${s.chunkName || "无章节"}] Q: ${String(s.question || "").slice(0, 150)} / A: ${String(s.answer || "").slice(0, 120)}`)
    .join("\n");
  return `下面是一个 QA 语料库的抽样。请从内容出发归纳一套【学科分类二级树】，作为该语料的标签库建议稿。

要求：
1. 一级学科 ${maxL1 - 2}~${maxL1} 个（含兜底类），粒度参考主流学术期刊公认分类体系（AGU 学科分会 / Nature Portfolio 学科 / Science 与 Scopus 学科类别），但以本语料实际内容为准——语料集中在某领域时一级要相应细化该领域，不生搬硬套；
2. 每个一级学科下 1~${maxL2} 个二级方向；避免完全重复的方向；
3. 每个标签的 label 用【英文规范学科名】（不超过 4 个英文单词，最终统计口径），zh 用【中文对照名】（不超过 8 个字，仅供理解），desc 用一句不超过 20 字的中文描述；
4. 二级树必须覆盖抽样中出现的学科；兜底类放最后（label 用 "Other"，zh 用 "其他"）、无二级；
5. 仅输出 JSON（不要任何其他文字）：
{"tree":[{"label":"English Name","zh":"中文名","desc":"一句中文描述","children":[{"label":"English Sub","zh":"中文名","desc":"一句描述"}]}],"notes":"归纳思路一句话"}

语料抽样：
${items}`;
}

module.exports = {
  PROMPT_VERSION, buildSystemPrompt, buildClassifyPrompt, buildArbitratePrompt,
  renderTaxonomy, renderContentTypes, buildTaxonomyProposePrompt, SUBJECT_RULES, fallbackLabelOf,
};
