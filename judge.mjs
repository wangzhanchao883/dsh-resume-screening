/**
 * LLM 精判层(纯函数,可单测)。
 * 定位:规则粗筛之后,对入围候选逐份读原文,判断"适配某岗位"的语义匹配度。
 * 只输出结构化结果,不碰数据库、不碰 LLM 通道(通道由 host 侧 ctx.llm 提供)。
 *
 * 约定:
 *  - 每份简历一个独立 prompt,绝不混读多份(防串味、防分数不可比)。
 *  - 输出 JSON schema 强约束 + 关键字段必填(score 0-100, dims.*.note, reason),
 *    逼 LLM 给理由,防拍脑袋分。
 *  - hard_check:LLM 读出的硬字段(年龄/性别/学历/年限)与规则值比对,
 *    不一致只标 match:false 供 HR 人工看,不自动改写规则值。
 */

/** 从岗位要求对象(items)拼出人类可读的岗位描述 */
export function buildJobDesc(req, items) {
  const fmt = (i) => `${i.tag_key} ${opWord(i.operator)} ${i.value}`;
  const must = (items || []).filter((i) => i.kind === "must").map((i) => `${fmt(i)}${i.description ? `(${i.description})` : ""}`);
  const nice = (items || []).filter((i) => i.kind !== "must").map((i) => `${fmt(i)} +${i.weight}${i.description ? `(${i.description})` : ""}`);
  return [
    `岗位:${req.title || "未命名"}`,
    `必选(全部满足才入选):${must.join("; ") || "(无)"}`,
    `加分(命中加权):${nice.join("; ") || "(无)"}`,
  ].join("\n");
}

function opWord(op) {
  const map = { "=": "等于", "!=": "不等于", ">=": "大于等于", "<=": "小于等于", ">": "大于", "<": "小于", in: "属于", contains: "包含" };
  return map[op] || op || "";
}

/** 拼单个候选的精判 prompt */
export function buildJudgePrompt({ jobDesc, candProfile, candText, slice = 6000 }) {
  return `你是资深招聘评审。根据岗位要求,评审以下候选人是否适配。

【岗位要求】
${jobDesc}

【候选人基本档案(规则已抽取,供你核对)】
${candProfile}

【候选人简历原文】
${String(candText || "").slice(0, slice)}

【任务】基于简历原文(不受规则档案限制),判断该候选人适配该岗位的程度。
【强约束】只输出一个 JSON,不要任何其他文字。不确定就填 null,不许编造简历里没有的东西。
JSON 结构:
{
  "score": 0到100的整数,
  "verdict": "强烈推荐|可面试|保留|不推荐" 之一,
  "dims": {
    "skills":     {"score": 0到40整数, "note": "技能栈匹配理由"},
    "experience": {"score": 0到25整数, "note": "经验/行业/方向匹配理由"},
    "projects":   {"score": 0到20整数, "note": "项目经历与岗位相关性理由"},
    "intention":  {"score": 0到15整数, "note": "求职意向契合理由"}
  },
  "matched_skills": ["命中的技能关键词"],
  "gaps": ["与岗位要求的缺口"],
  "reason": "一句话总结,供 HR 一眼看懂",
  "hards": {
    "age":       {"rule": "规则年龄", "llm": "你从原文读到的年龄"},
    "gender":    {"rule": "规则性别", "llm": "你从原文读到的性别"},
    "education": {"rule": "规则学历", "llm": "你从原文读到的学历"},
    "years":     {"rule": "规则年限", "llm": "你从原文读到的年限"}
  }
}
候选人简历原文开始:
${String(candText || "").slice(0, slice)}
候选人简历原文结束。`;
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

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function cleanNote(v) {
  return String(v ?? "").trim();
}

/**
 * 解析并归一化 LLM 精判结果。
 * ruleFields: { age, gender, education, experience_years } 规则抽取的硬字段(用于比对)。
 * 返回 { ok, score, verdict, dims, matched_skills, gaps, reason, hard_check } 或 { ok:false, error }。
 */
export function normalizeJudge(raw, ruleFields = {}) {
  const obj = typeof raw === "string" ? safeParse(raw) : raw;
  if (!obj || typeof obj !== "object") return { ok: false, error: "LLM 输出无法解析为 JSON" };

  const dims = obj.dims && typeof obj.dims === "object" ? obj.dims : {};
  const skillNote = obj.score === undefined && !obj.dims ? "LLM 未给出理由" : cleanNote(dims.skills?.note);
  const score = clamp(obj.score, 0, 100);
  const verdict = ["强烈推荐", "可面试", "保留", "不推荐"].includes(obj.verdict) ? obj.verdict : "保留";
  const hard_check = buildHardCheck(obj.hards, ruleFields);

  return {
    ok: true,
    score,
    verdict,
    dims: {
      skills: { score: clamp(dims.skills?.score, 0, 40), note: cleanNote(dims.skills?.note) || skillNote },
      experience: { score: clamp(dims.experience?.score, 0, 25), note: cleanNote(dims.experience?.note) },
      projects: { score: clamp(dims.projects?.score, 0, 20), note: cleanNote(dims.projects?.note) },
      intention: { score: clamp(dims.intention?.score, 0, 15), note: cleanNote(dims.intention?.note) },
    },
    matched_skills: Array.isArray(obj.matched_skills) ? obj.matched_skills.map((x) => String(x)).slice(0, 20) : [],
    gaps: Array.isArray(obj.gaps) ? obj.gaps.map((x) => String(x)).slice(0, 20) : [],
    reason: cleanNote(obj.reason),
    hard_check,
  };
}

function buildHardCheck(hards, ruleFields) {
  const out = [];
  const fields = [
    ["age", "年龄", ruleFields.age],
    ["gender", "性别", ruleFields.gender],
    ["education", "学历", ruleFields.education],
    ["years", "工作年限", ruleFields.experience_years],
  ];
  for (const [key, label, ruleVal] of fields) {
    const llmV = hards?.[key]?.llm;
    const ruleS = ruleVal === undefined || ruleVal === null ? "" : String(ruleVal);
    const llmS = llmV === undefined || llmV === null ? "" : String(llmV).trim();
    const match = ruleS !== "" && llmS !== "" ? normEq(ruleS, llmS) : true; // 规则缺值时不判异常
    out.push({ field: key, label, rule: ruleS, llm: llmS, match });
  }
  return out;
}

function normEq(a, b) {
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (x === y) return true;
  const n1 = Number(x), n2 = Number(y);
  if (Number.isFinite(n1) && Number.isFinite(n2) && n1 === n2) return true;
  return false;
}
