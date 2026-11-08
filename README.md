# qa-stats · QA 语料统计分析工具

qa-stats 是家族流水线的**下游统计工具**：读取 q-a / q-a-factual 的 `-qa.jsonl` 产物，也接受**任何字段名未知的通用 QA jsonl**（只有 q、a 两部分亦可），做**结构探测、学科多标签分类、内容分类、长度**等维度的统计分析，以表格（CSV / Markdown / Web 明细表）+ 图表（交互仪表盘 / 单文件 HTML 报告）全面解析语料。分类采用**程序规则 + LLM 混合引擎**（参考 easy-dataset 的标签树范式与 distilabel 的结构化输出/缓存范式，详见 [docs/设计方案.md](docs/设计方案.md)）。

**旁挂不侵入**：所有新产物独立落盘，原 jsonl 永不修改。

```
… → chunks-q(-factual)(问题) → q-a(-factual)(答案) → 【qa-stats】(统计) → human-verify
                                 任意来源的 QA jsonl ──↑（字段名未知亦可）
```

## 核心能力

- **结构探测（v1.1）**：假设语料只有 q、a 两部分、其余成分与字段名未知——扫 jsonl 结构（字段名并集 + 值形态统计：问句率/长度/段落/推导词/唯一率），**程序启发式**把字段映射到内部角色（question/answer/reasoning/id/…），置信不足时**LLM 仲裁**；结果旁挂 `<stem>-schema.json`，Web 可查看/一键重探测。未识别字段进「未知字段长度统计」，不丢单。
- **零 LLM 统计**（`run-stats.js`，秒出）：规模概览 / gaPair 分布 / 思考长度双口径分布（reasoning 梳理后 + reasoningRaw 原始）/ 分位数表 / 分组箱线（track·学科·内容类型·gaPair）/ eval 与 qCheck 质量 / 截断偏差 / 异常清单 / 14 个 CSV 明细表。
- **混合分类引擎（学科多标签）**（`run-classify.js`）：
  - **L0 规则**（零成本）：数学符号密度、gaPair/track 映射、文献名与章节名关键词 → 高置信直接定案（≥0.9），其余作先验；
  - **L1 LLM**：批量（默认 12 题/批）OpenAI 兼容调用，温度 0，白名单约束 JSON 输出，坏批自动降级单题重试；**学科为多标签（1~maxSubjects，默认 3）**，主学科在前，提示词内置数量纪律（无交叉不凑数）；
  - **L2 校验仲裁**：标签合法性硬校验 → 与高置信先验冲突 / 低置信（<0.6）/ 标签数越界（超上限被截断）→ judge 模型重判，无 judge 则人审；人审支持多标签改判；
  - **缓存与断点**：内容哈希 + taxonomy 版本 + 提示词版本 三重键，二跑全命中零调用；taxonomy 迭代自动增量重分类；人审确认（confirmed）永不覆盖。
- **标签库管理（v1.1）**：学科二级树 + 内容类型封闭集，**平时不动，Web「标签库」页点击修改**（增删改/排序/描述，校验后保存，version 自增触发增量重分类）；预置两套学科树——**通用学科树**（参考主流期刊分类体系：中科院分区大类 + JCR/ESI 归纳，14 一级）与**海洋气象领域树**；支持 **LLM 从语料归纳建议稿**（抽样 80 条 → 树建议 → 人工修订后保存，不直接生效）；「浏览完整标签信息」生成全标签表 + 旭日/共现图，**保存弹出系统保存位置选择框**（File System Access API，不支持时退化为下载），可存 CSV / JSON / 单文件 HTML。
- **学科交叉统计（v1.1）**：多标签计数口径、每题标签数分布（数量纪律自检）、**学科共现矩阵**（同题多学科对，直接监控交叉学科）、平均标签数、多学科题占比。
- **Web 仪表盘**（端口 3222）：概览卡 / 筛选联动图表（旭日·箱线·热力·共现·标签数·散点）/ 明细表分页与导出（系统保存框）/ 分类任务进度（含结构探测日志）/ **人审队列**（多标签改判）/ 设置（双模型·并发·标签上限·测试连通·**一键导入家族项目模型配置**）。
- **报告导出**：单文件 HTML（内嵌 ECharts 与数据，双击可看、可分享）、Markdown（表格+自动要点+口径脚注）、CSV ×14。

## 启动

```bash
cd "/mnt/d/git project/qa-stats" && npm start    # http://localhost:3222（PORT=xxxx 可换）
npm test                                         # 离线自测 54 项（不联网，分类走 mock LLM）
```

## CLI

```bash
# 纯程序统计（零 LLM，秒出全量报告；字段名未知文件自动程序结构探测）
node scripts/run-stats.js <qa.jsonl...> [--out <目录>] [--eval-low 3] [--title 标题]

# 混合分类（模型配置读 server/state.json，与 Web 共用；命令行可覆盖）
node scripts/run-classify.js <qa.jsonl...> [--force] [--batch 12] [--concurrency 2] [--no-judge] \
      [--endpoint URL] [--model ID] [--api-key KEY] [--judge-endpoint URL] [--judge-model ID]

# 只导报告（all|html|md|csv）
node scripts/export-report.js <qa.jsonl...> [--out <目录>] [--format all]
```

## 输入与产物

输入契约（v1.1 起**三层自适应**）：

1. **任意 jsonl**：字段名未知 → 程序探测（别名 + 特征）→ 置信不足时 LLM 仲裁；question/answer 之外的字段按角色映射或进未知字段长度统计；flow 标 `generic`；
2. `q-a-factual` 产物（行含 `reasoning/track` → factual 轨）；
3. `q-a` 产物（行含 `references` → research 轨）。

research 轨无思考字段时，思考长度板块自动降级并在报告标明。产物（全部在 jsonl 同目录旁挂）：

| 文件 | 内容 |
|---|---|
| `<stem>-schema.json` | **结构探测注记**：每字段形态统计 + role 映射 + 置信 + 来源（program/llm） |
| `<stem>-cls.jsonl` | 分类注记：每行 `{id, status, subjects:[{l1,l2,confidence,source}], subject(=主标签), contentType, reasons, confirmed, needsReview, conflict, tagsOutOfRange, ...}`；`source ∈ rule/llm/llm-judge/human`；旧单标签文件读入时自动规范化；解析失败不丢数据（null + debug 存原始响应） |
| `<stem>-clsmeta.json` | 运行元数据：计数（缓存/规则/LLM/judge/待人审/失败/越界/平均标签数）、token 用量、耗时、schema 映射 |
| `qa-stats-report/qa-report.html` | 单文件交互报告（内嵌 ECharts，双击可看） |
| `qa-stats-report/qa-report.md` | Markdown 报告（表格 + 自动要点 + 口径脚注） |
| `qa-stats-report/tables/*.csv` | 14 个明细表（overview / subject-l1 / subject-l2 / content-type / ga-pair / ga-content-cross / length-quantiles / grouped-length / quality / anomalies / classify-source / subject-content-cross / **subject-cooccurrence** / **tags-per-qa**） |
| `qa-stats-cache/<stem>-cls.json` | 分类缓存（内容哈希→结果；taxonomy/提示词版本变更自动失效） |

## 分类体系与标签库

- **学科**：二级树 + **多标签**，**双语标签**（label=英文规范名为最终统计口径，zh=中文对照仅供过程理解）。预置三套（`presets/`，Web 标签库页可加载/编辑/另存）：
  - `taxonomy-mainstream.json` **主流期刊标准学科树**（v1.2 预置，24 一级 + Other、153 二级）：一级骨架取 AGU 学科分会（JGR/GRL 所属；地球与空间科学按其粒度细化，Ocean Sciences 下按 AGU 四子学科——物理/化学/生物/地质——展开）+ Nature Portfolio 六大顶层（Physical/Biological/Chemistry/Earth & environmental/Health/Social），命名与 Science/Scopus 标准学科类别兼容；Climate Sciences 二级方向与 AMS Journal of Climate 主题逐项对应（ENSO & Interannual Variability、Decadal Variability & Modes、Climate Models & Numerical Simulation、Extreme Climate Events、Climate Projection & Scenario Analysis、Global Warming & Climate Change、Climate Feedback Mechanisms 等，见 [docs/主流期刊分类标准调研.md](docs/主流期刊分类标准调研.md) 完整双语分类表）。LLM 提示词以「英文标签原文」为白名单约束（附中文对照辅助理解），分类输出、统计、报告全部为英文标签。
  - `taxonomy-general.json` **通用学科树（中文）**：一级粒度参考中科院期刊分区大类 + JCR/ESI 归纳，14 一级；
  - `taxonomy.json` **海洋气象领域树（中文）**（物理海洋学 / 气象学与气候 / …，二级 23 类）。
- **学科交叉的约束方式**：树内每个二级唯一归属一个一级（白名单校验无歧义）；**交叉通过打标表达**——一条 QA 可带多个学科标签（默认上限 3，设置页可调），共现矩阵统计交叉结构。**数量纪律**：提示词要求绝大多数题 1 个标签、确有交叉才 2 个、3 个是少见上限；超量输出被截断并标 `tagsOutOfRange` 进 judge/人审，每题标签数分布进报告（大量 3 标签题 = 纪律失效信号）。
- **内容类型**：一级封闭集（`presets/content-types.json`：概念定义 / 机理过程 / 数值计算 / 关系比较 / 方法流程 / 应用实例 / 证据引用 / 综合论述 / 其他），单选。
- 改树提升 `version` 即触发增量重分类（缓存自动失效）；「其他」占比 >10% 是学科树需要演进的信号（报告自动呈现，可用 LLM 归纳建议稿演进）。

## 统计口径

- 长度为**字符数**；token 为估算值（÷3.5，与家族一致），报告均标注"估算"；
- 思考长度默认 **reasoning（梳理后）口径**，原始口径（reasoningRaw）可切换；`梳理压缩率 = 1 − 梳理后/原始`；
- **学科分布为多标签计数**（每标签各计 1，标签总数可大于题数，报告/图注明）；学科 × 内容类型交叉表为主标签口径；
- `finishReason=length` 的行单独统计（截断组 vs 非截断组中位数对比）；
- 相关系数为 Pearson（报告标注 n，n<5 不计算）；分组箱线标注各组 n。

## 工程约定

- 零依赖 Node.js（≥18），架构与家族一致（server + web + scripts，OpenAI 兼容直连，`processInParallel` 滑动窗口并发，临时文件+rename 原子写）；
- LLM 调用记 usage（token/延迟/成败）入 `-clsmeta.json`；分类批任务支持中断续跑；结构探测同样走「程序优先、LLM 补位」，统计路径零 LLM；
- 失败容错（distilabel 约定）：LLM 整体失败 → 行标 `failed` 进人审，不丢行不阻塞；部分维度非法 → 该维度仲裁补位；
- 模型配置可**一键从家族项目导入**（q-a-factual / q-a 的 server/state.json，设置页按钮）。

## 端口约定（家族）

| 项目 | 端口 |
|---|---|
| md-chunks / chunks-q / chunks-q-factual | 3216 / 3217 / 3218 |
| q-a-factual | 3220 |
| **qa-stats（本工具）** | **3222** |
