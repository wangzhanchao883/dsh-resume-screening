/**
 * 筛选引擎(纯函数,可单测)。
 * 核心模型:
 *   MUST 项 = 刚性硬条件,全部满足才入选
 *   NICE 项 = 加分项,命中一项 + weight 分
 *   score(c) = Σ_nice w_i × match(c, cond_i)
 *   入选 iff 所有 MUST 满足;结果按 score 降序
 *
 * 约定:
 *   - tag_map: {key -> {value, confidence, source}} 来自 candidateTagMap()
 *   - 候选值 uncertain(confidence 低 / value 为未知)时:
 *       MUST 项 → 不硬判为"不满足",标记 needDecision(交 HR)
 *       NICE 项 → 按 0 分计(不冤加分,也不冤枉)
 *   - operator: = | != | >= | <= | > | < | in | contains
 *       contains = 大小写不敏感 + 拉丁整词边界(见 containsLoose):`java` 命中 `Java`、不命中 `JavaScript`
 */

/** 单个候选人对一个条件的匹配结果 */
export function matchCondition(tagMap, cond) {
  const t = tagMap[cond.tag_key];
  if (!t) return { matched: false, status: "missing" }; // 档案根本无此标签
  const confidence = t.confidence ?? 1;
  const rawValue = t.value;
  // 值未知 / 低置信:不确定
  if (confidence < 0.5 || rawValue === "未知" || rawValue === "未写" || rawValue === null || rawValue === undefined) {
    return { matched: false, status: "uncertain", confidence };
  }
  const ok = compare(rawValue, cond.operator || "=", cond.value);
  return { matched: ok, status: "resolved", confidence, value: rawValue };
}

function compare(candidate, op, target) {
  const c = candidate;
  const t = target;
  switch (op) {
    case "=":
      return normEq(c, t);
    case "!=":
      return !normEq(c, t);
    case "in": {
      const arr = Array.isArray(t) ? t : String(t).split(/[,，]/).map((s) => s.trim());
      return arr.some((x) => normEq(c, x));
    }
    case "contains":
      return containsLoose(c, t);
    case ">=":
    case "<=":
    case ">":
    case "<": {
      const a = Number(c);
      const b = Number(t);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return normEq(c, t);
      if (op === ">=") return a >= b;
      if (op === "<=") return a <= b;
      if (op === ">") return a > b;
      return a < b;
    }
    default:
      return normEq(c, t);
  }
}

/**
 * contains 匹配:大小写不敏感 + 拉丁词整词边界。
 *  - 命中:`java` ↔ `Java` / `Java 开发` / 多值数组里任一项(修掉「大小写不同就漏判」)
 *  - 不命中:`java` ✗ `JavaScript`(右侧紧接字母)—— 修掉「前端被当成 Java 后端」的误伤
 *  - 含非字母数字的 needle(`c++` / `.net` / `node.js` / 中文词)退化为纯子串匹配,
 *    否则 `VC++` 会被整词边界判丢、`数据分析` 也永远匹配不上。
 * 注意:整词边界意味着 `sql` 不再命中 `MySQL`;要匹配这类写法请把关键词写全(如 `mysql`)。
 */
export function containsLoose(candidate, target) {
  const needle = String(target ?? "").trim().toLowerCase();
  if (!needle) return false;
  const values = Array.isArray(candidate) ? candidate : [candidate];
  return values.some((v) => oneContains(String(v ?? "").toLowerCase(), needle));
}

const ASCII_ALNUM = /[a-z0-9]/;
const PURE_ASCII_WORD = /^[a-z0-9]+$/;

function oneContains(hay, needle) {
  if (!hay || !needle) return false;
  if (!PURE_ASCII_WORD.test(needle)) return hay.includes(needle); // 含 + . - / 或中文 → 纯子串
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at > 0 ? hay[at - 1] : "";
    const after = hay[at + needle.length] ?? "";
    const okLeft = !before || !ASCII_ALNUM.test(before);
    const okRight = !after || !ASCII_ALNUM.test(after);
    if (okLeft && okRight) return true;
    from = at + 1;
  }
}

function normEq(c, t) {
  const a = String(c ?? "").trim().toLowerCase();
  const b = String(t ?? "").trim().toLowerCase();
  if (a === b) return true;
  // 数值等价:"5" == 5
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na === nb) return true;
  return false;
}

/**
 * 对一份档案做一次筛选(一个岗位)。
 * items: [{ tag_key, operator, value, weight, kind }]
 * 返回 { mustPass, needDecision, score, matchedTags }。
 */
export function evaluateProfile(tagMap, items) {
  let mustPass = true;
  let needDecision = false;
  let score = 0;
  const matchedTags = [];

  for (const it of items || []) {
    const cond = { tag_key: it.tag_key, operator: it.operator, value: it.value, weight: it.weight ?? 0 };
    const r = matchCondition(tagMap, cond);

    if (it.kind === "must") {
      if (r.status === "uncertain") {
        needDecision = true; // 不硬判,交 HR
        matchedTags.push({ tag: it.tag_key, cond: cond.value, status: "uncertain", weight: null });
      } else if (!r.matched) {
        mustPass = false;
        matchedTags.push({ tag: it.tag_key, cond: cond.value, status: "miss", weight: null });
      } else {
        matchedTags.push({ tag: it.tag_key, cond: cond.value, status: "hit", weight: null });
      }
    } else {
      // nice
      if (r.matched) {
        score += it.weight ?? 0;
        matchedTags.push({ tag: it.tag_key, cond: cond.value, status: "hit", weight: it.weight });
      } else if (r.status === "uncertain") {
        matchedTags.push({ tag: it.tag_key, cond: cond.value, status: "uncertain", weight: it.weight });
      } else {
        matchedTags.push({ tag: it.tag_key, cond: cond.value, status: "miss", weight: it.weight });
      }
    }
  }

  return { mustPass, needDecision, score, matchedTags };
}

/**
 * 对库里的候选人做整库筛选。
 * candidates: [{id, tagMap}],items: 岗位明细。
 * 返回 { total, passed, needDecision, ranked:[{candidateId, score, matchedTags}] }
 */
export function screenAll(candidates, items) {
  const passed = [];
  const needDecision = [];
  for (const c of candidates) {
    const r = evaluateProfile(c.tagMap, items);
    if (r.mustPass) {
      passed.push({ candidateId: c.id, score: r.score, matchedTags: r.matchedTags, needDecision: r.needDecision });
      if (r.needDecision) needDecision.push(c.id);
    }
  }
  passed.sort((a, b) => b.score - a.score);
  return { total: candidates.length, passedCount: passed.length, needDecision, ranked: passed };
}
