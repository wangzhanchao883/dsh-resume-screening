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
    case "contains": {
      const cs = String(c ?? "");
      const ts = String(t ?? "");
      if (Array.isArray(c)) return c.some((x) => String(x).includes(ts) || ts.includes(String(x)));
      return cs.includes(ts);
    }
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
