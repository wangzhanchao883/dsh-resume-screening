/**
 * 标签抽取层:规则优先 + LLM 兜底 + 置信度。
 * 第 1 层 = 确定性规则(免费/快/可复现),抓结构化硬字段。
 * 第 2 层 = LLM 兜底(低置信 / 语义软标签才触发,防幻觉,强制"不确定填 null")。
 * 每个标签带 confidence;confidence < 0.5 标"未知",筛选时不硬判。
 *
 * 规则抽取结果 = { profile:{age,gender,experience_years,education,school,major}, tags:[{tagKey,value,confidence,source}], maxConf }
 * LLM 兜底由 host 侧通过 ctx.llm 触发(见 index.mjs 的 extractWithLlm),本文件只提供纯函数。
 */
import { extOf } from "./convert.mjs";
import { stripFrontmatterBlocks } from "./md.mjs";

const ALIAS = {
  education: {
    // 值 -> 归一化;识别"本科/学士/研究生/硕士/博士/大专"
    硕士: /硕士|研究生|master|mba/i,
    博士: /博士|phd|doctor/i,
    本科: /本科|学士|bachelor|b\.?s\.?|大学本科/i,
    大专: /大专|专科|高职|associate/i,
  },
};

/** 从归档 MD 正文(txt)做规则抽取 */
export function ruleExtract(mdText, tags) {
  // 先剥掉可能残留的归档 frontmatter。
  // 不剥的话,嵌套归档 MD 里上一层的 `专业:` 空值会跨行吃到分隔线 `---`,
  // 抽出 `major: ---` 这种脏标签(2026-09-26 实测)。
  const text = stripFrontmatterBlocks(String(mdText || "").replace(/\r/g, ""));
  const profile = {};
  const extracted = [];
  let maxConf = 0;

  // 学历:优先命中最高学历(按优先级"博士>硕士>本科>大专"取首个命中的,而非最后出现的)
  const edu = detectHighest(text, ALIAS.education, ["博士", "硕士", "本科", "大专"]);
  if (edu) {
    profile.education = edu;
    extracted.push({ tagKey: "education", value: edu, confidence: 0.9, source: "rule" });
  }

  // 性别:优先"性别:男/女"字段,其次英文 Gender/Sex:Male/Female。
  // 不再用 m\b/f\b 单字符——那会把 "example.com" 结尾的 m 误判成"男"。
  const g = detectGender(text);
  if (g) {
    profile.gender = g;
    extracted.push({ tagKey: "gender", value: g, confidence: 0.85, source: "rule" });
  }

  // 年龄 / 出生年份:先找"年龄 / XX岁",再找"19XX/20XX年出生"
  // 先算年龄,是因为工作年限要做"年限 < 年龄 - 最低工作年龄"的合法性校验(见 normalizeYears)。
  const age = normalizeAge(detectAge(text));
  if (age !== null) {
    profile.age = age;
    extracted.push({ tagKey: "age", value: String(age), confidence: 0.75, source: "rule" });
  }

  // 工作年限:正则"X年(以上/经验)" 或 "X年 X 月";应届/在校/无经验 → 0;
  // 非法值(负数 / >60 / 年限 ≥ 年龄-14)一律丢弃,宁缺毋滥 —— 修掉"22 岁 22 年经验"。
  const rawYears = detectYears(text);
  const years = normalizeYears(rawYears, age);
  if (years !== null) {
    profile.experience_years = years;
    extracted.push({ tagKey: "experience_years", value: String(years), confidence: rawYears === 0 ? 0.85 : 0.8, source: "rule" });
  }

  // 学校:常见院校关键词(示例,规则引擎点到为止;没配到的留给 LLM)
  const school = detectSchool(text);
  if (school) {
    profile.school = school;
    extracted.push({ tagKey: "school", value: school, confidence: 0.7, source: "rule" });
  }

  // 专业(可选)
  const major = detectMajor(text);
  if (major) {
    profile.major = major;
    extracted.push({ tagKey: "major", value: major, confidence: 0.6, source: "rule" });
  }

  // 技能关键字:从配置的 tags 里找 text 型技能标签,命中即打标
  const skillTags = (tags || []).filter((t) => t.type === "text" && (t.multi || t.key === "skill"));
  const skillHit = detectSkills(text, skillTags);
  for (const { tagKey, value } of skillHit) {
    extracted.push({ tagKey, value, confidence: 0.75, source: "rule" });
  }

  // 粗分类:技能类别 + 经验方向(受控词表,关键词→类别,多值标签)
  for (const c of detectCategories(text, tags)) {
    extracted.push({ tagKey: c.tagKey, value: c.value, confidence: 0.7, source: "rule" });
  }

  for (const e of extracted) maxConf = Math.max(maxConf, e.confidence);
  return { profile, tags: extracted, maxConf };
}

/**
 * 判定是否需要 LLM 兜底:
 *  - 若最大规则置信度低于阈值(如 0.6),或提取到的标签总数太少(硬字段大段缺失)
 *  - 语义软标签(如"项目管理经验")规则引擎基本抓不到,直接交给 LLM
 */
export function needsLlmFallback(ruleResult, config) {
  if (!config.llmFallback) return false;
  if (ruleResult.maxConf < config.llmConfidenceThreshold) return true;
  // 硬字段缺失过半(age/gender/education/experience_years 至少要有 2 个)
  const hard = ["age", "gender", "education", "experience_years"];
  const have = hard.filter((k) => ruleResult.profile[k] !== undefined).length;
  if (have < 2) return true;
  // 语义软标签(text 型且非 skill,如 project_management):规则引擎抽不到,必须走 LLM 兜底,
  // 否则这类标签永远为空。只要配置了这类标签就触发一次 LLM(想省成本可关闭 llmFallback 或删掉软标签)。
  const softTags = (config.tags || []).filter((t) => t && t.type === "text" && t.key !== "skill" && t.key !== "");
  return softTags.length > 0;
}

/**
 * LLM 兜底的输出解析:把模型给的 JSON 归一化成 { profile, tags:[] }。
 * 强约束:模型必须用结构化 JSON 输出";不确定就填 null"。逐个字段转并打置信度。
 */
export function normalizeLlmProfile(raw, promptTags) {
  const obj = typeof raw === "string" ? safeParse(raw) : raw;
  if (!obj || typeof obj !== "object") return null;
  const profile = {};
  const tags = [];
  const conf = 0.9;

  mapField(obj, profile, "age", "age", (v) => normalizeAge(v));
  mapField(obj, profile, "gender", "gender", (v) => normalizeGender(v));
  mapField(obj, profile, "experience_years", "experience_years", (v) => v);
  mapField(obj, profile, "education", "education", (v) => normalizeEducation(v));
  mapField(obj, profile, "school", "school");
  mapField(obj, profile, "major", "major", (v) => normalizeMajor(v));

  // 年限必须在拿到年龄之后校验:LLM 最常见的一类错就是把"年龄"填进 experience_years
  // (实测 22 岁应届生被写成 22 年经验)。校验不过就整条丢掉,不留脏值。
  const safeYears = normalizeYears(profile.experience_years, profile.age);
  if (safeYears === null) delete profile.experience_years;
  else profile.experience_years = safeYears;

  const knownMap = {};
  for (const k of ["age", "gender", "experience_years", "education", "school", "major"]) {
    if (profile[k] !== undefined) knownMap[k] = profile[k];
  }
  for (const [k, v] of Object.entries(knownMap)) {
    tags.push({ tagKey: k, value: String(v), confidence: conf, source: "llm" });
  }

  // 语义软标签 + 技能:从 llmTags 数组里取。
  // LLM 可能返回 label(如"项目管理经验")而非 key(project_management),这里做 label→key 归一化,
  // 否则 setCandidateTags 会因 tagIdMap 找不到中文 label 而把整条标签丢弃。
  const keyMap = {};
  for (const t of promptTags || []) {
    if (t && t.key) {
      keyMap[t.key] = t.key;
      if (t.label) keyMap[t.label] = t.key;
    }
  }
  const llmTags = Array.isArray(obj.tags) ? obj.tags : [];
  for (const t of llmTags) {
    if (!t || !t.tag || t.value === null || t.value === undefined || t.value === "") continue;
    const rawKey = String(t.tag);
    tags.push({ tagKey: keyMap[rawKey] || rawKey, value: String(t.value), confidence: conf, source: "llm" });
  }
  return { profile, tags, maxConf: conf };
}

function mapField(obj, target, srcKey, dstKey, cast) {
  if (obj[srcKey] === null || obj[srcKey] === undefined) return;
  let v = obj[srcKey];
  if (cast) v = cast(v);
  if (v === null || v === undefined || Number.isNaN(v)) return;
  target[dstKey] = v;
}

/** 性别归一化:模型可能回 male/female/M/F,统一成 男/女;认不出就丢 */
function normalizeGender(v) {
  const s = String(v ?? "").trim();
  if (/^(男|male|m)$/i.test(s)) return "男";
  if (/^(女|female|f)$/i.test(s)) return "女";
  return undefined;
}

/** 学历归一化:模型可能回"研究生/本科在读"等,落到枚举内;认不出就丢 */
function normalizeEducation(v) {
  const s = String(v ?? "").trim();
  for (const k of ["博士", "硕士", "本科", "大专"]) if (s.includes(k)) return k;
  if (/研究生|master|mba/i.test(s)) return "硕士";
  if (/学士|bachelor/i.test(s)) return "本科";
  if (/专科|高职|associate/i.test(s)) return "大专";
  return undefined;
}

/** 专业归一化:纯符号/分隔线不算专业(防御 LLM 从嵌套 MD 里抄回 "---") */
function normalizeMajor(v) {
  const s = String(v ?? "").trim().replace(/^[-—–]+|[-—–]+$/g, "");
  if (!s || !/[\u4e00-\u9fa5A-Za-z]/.test(s)) return undefined;
  return s;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    const m = String(s).match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

/** 按优先级(高阶在前)取首个命中的枚举值;order = 优先级降序 */
function detectHighest(text, aliases, order) {
  for (const v of order) {
    const re = aliases[v];
    if (re && re.test(text)) return v;
  }
  return null;
}

/** 性别检测:先"性别:男/女"字段,再英文 Gender/Sex:male/female,最后互斥兜底。 */
function detectGender(text) {
  // 中文字段:性别: 男 / 女
  const zh = text.match(/(?:性别|性別)[^\n]{0,4}?[:：]?\s*([男女])/);
  if (zh) return zh[1];
  // 英文字段:Gender/Sex: male/female 或 (M)/(F)
  const en = text.match(/\b(?:gender|sex)\b[^\n]{0,8}?[:：]?\s*(male|female|m\b|f\b)/i);
  if (en) return /^f/i.test(en[1]) ? "女" : "男";
  // 互斥兜底:全文只出现一种性别字符才判定,避免 男/女 都没写或都出现时误判
  const hasMale = /男/.test(text);
  const hasFemale = /女/.test(text);
  if (hasMale && !hasFemale) return "男";
  if (hasFemale && !hasMale) return "女";
  return null;
}

/** 应届 / 在校 / 明确无经验:工作年限按 0 计(而不是让兜底正则去抓别的数字,或让 LLM 拿年龄充数) */
const ENTRY_LEVEL_RE = /应届毕业生|应届生|应届|在校生|无工作经验|暂无工作经验|无经验/;
/** 工作年限合法上限(年) */
export const MAX_WORK_YEARS = 60;
/** 最早可参加工作的年龄:年限必须 < 年龄 - 这个值 */
const MIN_WORK_AGE = 14;

/** 年龄合法性:14–80 之外的当作噪声丢弃(避免"X岁"误抓成荒谬值) */
export function normalizeAge(age) {
  const a = Number(age);
  if (!Number.isFinite(a) || a < 14 || a > 80) return null;
  return Math.round(a);
}

/**
 * 工作年限合法性校验:非法返回 null(不落库,筛选时按"缺此标签"处理,而不是拿错值硬判)。
 *  - 非数字 / 负数 / > MAX_WORK_YEARS → null
 *  - 已知年龄时,年限必须 < 年龄 - MIN_WORK_AGE(22 岁不可能有 22 年经验)→ null
 */
export function normalizeYears(years, age) {
  if (years === null || years === undefined || years === "") return null;
  const y = Number(years);
  if (!Number.isFinite(y) || y < 0) return null;
  if (y > MAX_WORK_YEARS) return null;
  const a = Number(age);
  if (Number.isFinite(a) && a > 0 && y > a - MIN_WORK_AGE) return null;
  return Math.round(y);
}

function detectYears(text) {
  // 应届/在校/无经验优先:这类简历里"工作年限：应届毕业生"没有数字,
  // 老逻辑会掉到兜底正则,再被 LLM 用年龄填成 22。
  if (ENTRY_LEVEL_RE.test(text)) return 0;
  // 优先命中带"工作/经验/年限"上下文的年限,避免把教育起止年份(如 2022 年)里的"22年"误当工作年限。
  const re = /(?:工作|经验|年限|工龄|从业)[^\n]{0,12}?(\d{1,2})\s*年/i;
  const m = text.match(re);
  if (m) return parseInt(m[1], 10);
  // 兜底:独立的"X年"(X 前不能是数字,排除"2022年"里的"22年")
  const m2 = text.match(/(?<![\d])\d{1,2}\s*年(?:以上)?/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function detectAge(text) {
  const m = text.match(/(?:年龄|岁数)[:：]?\s*(\d{1,2})\s*岁/);
  if (m) return parseInt(m[1], 10);
  const m2 = text.match(/(\d{1,2})\s*岁/);
  if (m2) return parseInt(m2[1], 10);
  // 出生年份 → 年龄(假设当前年)
  const yr = text.match(/(19[7-9]\d|20[0-2]\d)\s*(?:年)?(?:出生|生)/);
  if (yr) {
    const born = parseInt(yr[1], 10);
    return Math.max(0, new Date().getFullYear() - born);
  }
  return null;
}

const SCHOOLS = ["清华大学", "北京大学", "复旦大学", "浙江大学", "上海交通大学", "南京大学", "中国人民大学", "武汉大学", "中山大学", "华中科技大学", "四川大学", "西安交通大学", "哈尔滨工业大学", "同济大学", "南开大学", "天津大学", "北京师范大学", "厦门大学", "山东大学", "吉林大学"];
const SCHOOL_BLACK = ["北京大学人民医院", "清华大学附属中学"];

function detectSchool(text) {
  // 先剔除黑名单短语(如"北京大学人民医院"),再按序匹配院校。
  // 旧逻辑对整段文本判断黑名单,会导致简历同时出现黑名单短语和正常院校时,正常院校也被误跳过。
  let t = text;
  for (const b of SCHOOL_BLACK) t = t.split(b).join(" ");
  for (const s of SCHOOLS) {
    if (t.includes(s)) return s;
  }
  return null;
}

const MAJORS = ["计算机科学与技术", "软件工程", "电子信息", "通讯工程", "电子商务", "市场营销", "会计", "财务管理", "人力资源", "工商管理", "英语", "机械", "土木工程", "金融", "经济学", "新闻学", "法学", "临床医学", "护理"];

function detectMajor(text) {
  // 优先取"专业"字段(基本信息里的专业,通常对应当前/最高学历专业),
  // 避免按 MAJORS 数组顺序命中本科专业、盖掉硕士专业(与"学历取最高"同类问题)。
  // 注意:冒号后只允许同行空白([ \t]),不能是 \s —— 否则"专业:"为空时会跨行
  // 吃掉下一行的 frontmatter 分隔线,抽出 `---`(2026-09-26 实测)。
  const field = text.match(/(?:专业|主修)[ \t]*[:：][ \t]*([^\s|，,；;、\n（）()\[\]{}#*]{2,20})/);
  if (field) {
    const v = field[1].trim().replace(/^[-—–]+|[-—–]+$/g, "");
    // 纯符号/纯分隔线不算专业
    if (v.length >= 2 && /[\u4e00-\u9fa5A-Za-z]/.test(v)) return v;
  }
  // 兜底:按 MAJORS 顺序首个命中
  for (const m of MAJORS) {
    if (text.includes(m)) return m;
  }
  return null;
}

/** 技能命中:在文本里找每个技能标签的常见关键词(规则兜底;更丰富语义交给 LLM) */
const SKILL_KEYWORDS = {
  python: /python|py\b/i,
  java: /java(?!script)/i,
  数据分析: /数据分析|数据挖掘|sql|excel|power bi|tableau/i,
  项目管理: /项目(?:管理|经理|负责人|leader|pm)/i,
};

function detectSkills(text, skillTags) {
  const out = [];
  // 文本型技能标签:只用真实技能关键词(或 key 命中 SKILL_KEYWORDS)判定,
  // 不要拿标签的中文名(如"技能")当正则去匹配——那会把"专业技能"这类标题误命中成占位值。
  for (const t of skillTags) {
    const key = (t.key || "").toLowerCase();
    const kw = SKILL_KEYWORDS[key] || SKILL_KEYWORDS[t.label];
    if (kw && kw.test(text)) out.push({ tagKey: t.key, value: t.label || key });
  }
  // 额外:只要文本含常见技能词就作为独立 skill 值(默认 skill 标签是 multi)
  const generic = SKILL_KEYWORDS;
  const hit = Object.keys(generic).filter((k) => generic[k].test(text) && !out.some((o) => o.tagKey === "skill" && (o.value === k || o.value === SKILL_KEYWORDS[k])));
  for (const k of hit) out.push({ tagKey: "skill", value: k });
  return out;
}

/** 粗分类受控词表:技能类别(关键词→类别,多值)。只用**具体领域词**避免宽泛词(设计/工程/客户/项目)误命中;语义归类由 LLM 兜底。 */
const SKILL_CATEGORY_KEYWORDS = {
  计算机: /java|python|c\+\+|\.net|前端|后端|数据库|mysql|sql|linux|node|javascript|html|css|软件开发|后端开发|算法工程师|大数据|数据开发|运维开发|网络安全|人工智能|机器学习|android|ios|小程序|测试开发|系统架构|信息系统|开发工程师/i,
  财务: /财务|会计|审计|税务|记账|出纳|成本核算|预算|财务报表|cpa|acca|注册会计师|财务经理|财务专员/i,
  金融: /金融|投行|银行|证券|基金|保险|风控|量化|理财|信托|信贷|金融科技/i,
  管理: /总经理|董事长|运营总监|部门经理|管理岗|团队管理|运营管理|行政管理|企业管理|供应链管理|管理层|项目负责人/i,
  外贸: /外贸|进出口|国际贸易|单证|报关|跟单|信用证|外贸业务|海外市场|关务|船务/i,
  销售: /销售|市场营销|商务拓展|招商|大客户|渠道拓展|销售经理|销售专员/i,
  人力资源: /人力资源|招聘|薪酬|绩效|组织发展|员工关系|人事专员|人事经理|hrbp/i,
  设计: /ui设计|ux设计|平面设计|视觉设计|交互设计|美工|插画|海报|figma|photoshop|设计岗|ui设计师/i,
  制造: /机械工程|电子信息工程|电气工程|自动化|车间|生产工艺|生产制造|钳工|焊工|cnc|机械制造|工装/i,
  医疗: /医疗|护理|临床|药学|制药|医生|护士|生物医药|医院|医疗器械/i,
  教育: /教师|教学|课程|教研|教务|讲师|家教|培训师/i,
  物流: /物流|仓储|运输|配送|货代|供应链管理|物流管理|物流专员/i,
  客服: /客服|售后|话务|客户服务专员|客服专员/i,
};

/** 粗分类受控词表:经验方向(关键词→方向,多值)。同样只用具体领域词。 */
const EXPERIENCE_DIRECTION_KEYWORDS = {
  编程开发: /软件开发|前端开发|后端开发|java|python|c\+\+|测试开发|算法|架构|开发工程师|程序员|小程序开发/i,
  财务会计: /财务会计|会计|审计|税务|出纳|成本核算|财务报表/i,
  金融: /金融|投行|银行|证券|基金|保险|风控|量化/i,
  管理: /部门经理|主管|负责人|项目经理|管理岗|总经理|团队管理/i,
  外贸: /外贸|进出口|单证|报关|跟单|国际贸易/i,
  数据分析: /数据分析|数据挖掘|数仓|数据仓库|算法模型|报表开发|数据分析师|数据工程师/i,
  运维: /运维|系统运维|部署|网络工程|运维开发|devops|k8s|kubernetes/i,
  销售市场: /销售|市场营销|客户经理|商务拓展|销售经理|市场专员/i,
  行政人事: /行政|人事|招聘|薪酬|绩效|行政助理|人事经理/i,
  设计: /ui设计|平面设计|视觉设计|交互设计|设计师|美工/i,
  生产制造: /生产工艺|生产制造|车间|自动化|质检|生产线/i,
};

/** 根据受控词表把简历文本归类到 skill_category / experience_direction(仅当配置里有这些标签才产出)。 */
function detectCategories(text, tags) {
  const out = [];
  const hasKey = (k) => (tags || []).some((t) => t.key === k);
  if (hasKey("skill_category")) {
    for (const [cat, re] of Object.entries(SKILL_CATEGORY_KEYWORDS)) {
      if (re.test(text)) out.push({ tagKey: "skill_category", value: cat });
    }
  }
  if (hasKey("experience_direction")) {
    for (const [dir, re] of Object.entries(EXPERIENCE_DIRECTION_KEYWORDS)) {
      if (re.test(text)) out.push({ tagKey: "experience_direction", value: dir });
    }
  }
  return out;
}

export { extOf };
