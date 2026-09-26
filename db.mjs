import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractResumeBody } from "./md.mjs";

/**
 * SQLite 存储层(物化索引)。
 * MD 归档做真相源,SQLite 是从 MD 派生的索引,可从 MD 全量重建。
 * 用 Node 内置 node:sqlite(DatabaseSync),免外部依赖,单文件。
 * 表:candidates / tags / candidate_tags / requirements / requirement_items / screening_results
 */
export function openDb(config) {
  const dir = config.libraryRoot;
  if (!dir) throw new Error("未配置 libraryRoot,请先在设置里指定简历库根目录");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, config.dbFile || "resume.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      md_path TEXT UNIQUE,
      raw_hash TEXT UNIQUE,
      extract_conf REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      age INTEGER,
      gender TEXT,
      experience_years REAL,
      education TEXT,
      school TEXT,
      major TEXT,
      ingested_at TEXT,
      source_mtime TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      label TEXT,
      type TEXT,
      description TEXT,
      multi INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS candidate_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      value TEXT,
      confidence REAL DEFAULT 1,
      source TEXT DEFAULT 'rule'
    );

    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS requirement_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      tag_key TEXT,
      operator TEXT,
      value TEXT,
      weight REAL DEFAULT 0,
      description TEXT,
      kind TEXT DEFAULT 'nice'
    );

    CREATE TABLE IF NOT EXISTS screening_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      score REAL DEFAULT 0,
      must_pass INTEGER DEFAULT 0,
      matched_tags_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS screening_llm (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      score REAL DEFAULT 0,
      verdict TEXT,
      dims_json TEXT,
      matched_skills_json TEXT,
      gaps_json TEXT,
      hard_check_json TEXT,
      reason TEXT,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_candidate_tags_tag ON candidate_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_candidate_tags_cand ON candidate_tags(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_req_items_req ON requirement_items(req_id);
    CREATE INDEX IF NOT EXISTS idx_screening_req ON screening_results(req_id);
    CREATE INDEX IF NOT EXISTS idx_screening_llm_req ON screening_llm(req_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_hash ON candidates(raw_hash);
  `);

  // 迁移:补 source_path 列 = 原始简历文件路径(与归档 md_path 分离)。
  // 老库的 pending 记录在修复前一版把 md_path 存成了"归档目标路径",入库时原文件路径被丢掉,
  // 导致 resume_process 拿它当源文件读而报"源文件缺失"。用 source_path 专门保存原始文件位置。
  const candCols = db.prepare("PRAGMA table_info(candidates)").all().map((c) => c.name);
  if (!candCols.includes("source_path")) {
    db.exec("ALTER TABLE candidates ADD COLUMN source_path TEXT");
  }
  if (!candCols.includes("ingested_at")) {
    db.exec("ALTER TABLE candidates ADD COLUMN ingested_at TEXT");
  }
  if (!candCols.includes("source_mtime")) {
    db.exec("ALTER TABLE candidates ADD COLUMN source_mtime TEXT");
  }
}

/** 幂等地确保标签字典里有一组默认标签,返回 {key->id} */
export function ensureTags(db, tags) {
  const stmt = db.prepare(
    "INSERT INTO tags (key,label,type,description,multi) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label, type=excluded.type, description=excluded.description, multi=excluded.multi"
  );
  const map = {};
  for (const t of tags || []) {
    stmt.run(t.key, t.label || t.key, t.type || "text", t.description || "", t.multi ? 1 : 0);
  }
  const rows = db.prepare("SELECT id,key FROM tags").all();
  for (const r of rows) map[r.key] = r.id;
  return map;
}

/** 按内容 hash 查是否已入库(去重),返回 candidate 或 undefined */
export function findCandidateByHash(db, hash) {
  return db.prepare("SELECT * FROM candidates WHERE raw_hash = ?").get(hash);
}

/** 新增候选人或按 hash 更新;返回 candidate id
 *  mdPath    = 归档后 MD 的路径(入库时可为 null,转换归档后回填)
 *  sourcePath= 原始简历文件路径(转换与读取的真相来源)
 */
export function upsertCandidate(db, { name, mdPath, sourcePath = null, rawHash, status = "converted" }) {
  const existing = findCandidateByHash(db, rawHash);
  if (existing) {
    db.prepare("UPDATE candidates SET name=?, md_path=?, source_path=?, status=?, updated_at=datetime('now') WHERE id=?")
      .run(name, mdPath, sourcePath, status, existing.id);
    return existing.id;
  }
  const r = db.prepare("INSERT INTO candidates (name, md_path, source_path, raw_hash, status, ingested_at) VALUES (?,?,?,?,?, datetime('now'))")
    .run(name, mdPath, sourcePath, rawHash, status);
  return r.lastInsertRowid;
}

/** 更新候选人的结构化字段 + 置信度 */
export function updateCandidateProfile(db, id, profile, sourceMtime) {
  db.prepare(`
    UPDATE candidates SET
      age=?, gender=?, experience_years=?, education=?, school=?, major=?,
      extract_conf=?, source_mtime=?, ingested_at=COALESCE(ingested_at, datetime('now')),
      status='extracted', updated_at=datetime('now')
    WHERE id=?
  `).run(
    profile.age ?? null,
    profile.gender ?? null,
    profile.experience_years ?? null,
    profile.education ?? null,
    profile.school ?? null,
    profile.major ?? null,
    profile.extract_conf ?? 1,
    sourceMtime ?? null,
    id
  );
}

/** 放入候选人的标签值;tags: {key->id},values: [{tagKey, value, confidence, source}] */
export function setCandidateTags(db, candidateId, tagIdMap, values) {
  db.prepare("DELETE FROM candidate_tags WHERE candidate_id = ?").run(candidateId);
  const ins = db.prepare(
    "INSERT INTO candidate_tags (candidate_id, tag_id, value, confidence, source) VALUES (?,?,?,?,?)"
  );
  for (const v of values || []) {
    const tagId = tagIdMap[v.tagKey];
    if (!tagId) continue;
    ins.run(candidateId, tagId, v.value, v.confidence ?? 1, v.source || "rule");
  }
}

/** 更新候选人状态机 */
export function setStatus(db, id, status) {
  db.prepare("UPDATE candidates SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
}

/** 取候选人的全部标签值(含标签 key/label/type) */
export function getCandidateTags(db, candidateId) {
  return db.prepare(`
    SELECT t.key, t.label, t.type, t.multi, ct.value, ct.confidence, ct.source
    FROM candidate_tags ct JOIN tags t ON t.id = ct.tag_id
    WHERE ct.candidate_id = ?
  `).all(candidateId);
}

/** 候选人的标签值映射:key -> value(多值取数组) */
export function candidateTagMap(db, candidateId) {
  const map = {};
  for (const row of getCandidateTags(db, candidateId)) {
    if (row.multi) {
      if (!map[row.key]) map[row.key] = { value: [], confidence: row.confidence, source: row.source };
      map[row.key].value.push(row.value);
    } else {
      map[row.key] = { value: row.value, confidence: row.confidence, source: row.source };
    }
  }
  return map;
}

/** 新增岗位要求,返回 req id */
export function addRequirement(db, { title, items }) {
  const r = db.prepare("INSERT INTO requirements (title) VALUES (?)").run(title || "未命名岗位");
  const reqId = r.lastInsertRowid;
  saveRequirementItems(db, reqId, items);
  return reqId;
}

export function saveRequirementItems(db, reqId, items) {
  db.prepare("DELETE FROM requirement_items WHERE req_id = ?").run(reqId);
  const ins = db.prepare(
    "INSERT INTO requirement_items (req_id, tag_key, operator, value, weight, description, kind) VALUES (?,?,?,?,?,?,?)"
  );
  for (const it of items || []) {
    ins.run(reqId, it.tag_key, it.operator || "=", it.value ?? "", it.weight ?? 0, it.description || "", it.kind || "nice");
  }
}

export function listRequirements(db) {
  const reqs = db.prepare("SELECT id, title, created_at FROM requirements ORDER BY id DESC").all();
  for (const req of reqs) {
    req.items = db.prepare(
      "SELECT * FROM requirement_items WHERE req_id = ? ORDER BY id"
    ).all(req.id);
  }
  return reqs;
}

/** 记录一次筛选结果(candidate + score + matched tags json),返回 result id */
export function saveScreeningResult(db, reqId, candidateId, score, mustPass, matchedTags) {
  const r = db.prepare(`
    INSERT INTO screening_results (req_id, candidate_id, score, must_pass, matched_tags_json)
    VALUES (?,?,?,?,?)
  `).run(reqId, candidateId, score, mustPass ? 1 : 0, JSON.stringify(matchedTags));
  return r.lastInsertRowid;
}

/** 查某岗位的筛选结果(已排序) */
export function getScreeningResults(db, reqId) {
  return db.prepare(`
    SELECT sr.*, c.name, c.education, c.age, c.gender, c.experience_years, c.ingested_at, c.source_mtime
    FROM screening_results sr JOIN candidates c ON c.id = sr.candidate_id
    WHERE sr.req_id = ?
    ORDER BY sr.score DESC, sr.must_pass DESC
  `).all(reqId);
}

/** 记录一次 LLM 精判结果 */
export function saveScreeningLlm(db, reqId, candidateId, judge) {
  db.prepare("DELETE FROM screening_llm WHERE req_id=? AND candidate_id=?").run(reqId, candidateId);
  db.prepare(`
    INSERT INTO screening_llm (req_id, candidate_id, score, verdict, dims_json, matched_skills_json, gaps_json, hard_check_json, reason, model)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    reqId,
    candidateId,
    judge.score ?? 0,
    judge.verdict ?? "",
    JSON.stringify(judge.dims || {}),
    JSON.stringify(judge.matched_skills || []),
    JSON.stringify(judge.gaps || []),
    JSON.stringify(judge.hard_check || []),
    judge.reason || "",
    judge.model || ""
  );
}

/** 查某岗位的 LLM 精判结果(已按 LLM 分降序) */
export function getScreeningLlm(db, reqId) {
  return db.prepare(`
    SELECT sl.*, c.name, c.education, c.age, c.gender, c.experience_years
    FROM screening_llm sl JOIN candidates c ON c.id = sl.candidate_id
    WHERE sl.req_id = ?
    ORDER BY sl.score DESC
  `).all(reqId);
}

/** 取候选人的归档正文(精判读原文用)。嵌套归档时取最内层的真实简历正文。 */
export function getCandidateBody(db, candidateId) {
  const row = db.prepare("SELECT md_path FROM candidates WHERE id=?").get(candidateId);
  if (!row || !row.md_path) return "";
  try {
    return extractResumeBody(readFileSync(row.md_path, "utf8"));
  } catch {
    return "";
  }
}

/** 所有候选人的基础列表(对话里看) */
export function listCandidates(db) {
  return db.prepare(`
    SELECT id, name, education, age, gender, experience_years, status, extract_conf, md_path, ingested_at, source_mtime
    FROM candidates ORDER BY id DESC
  `).all();
}

/** 统计状态分布 */
export function statusCounts(db) {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM candidates GROUP BY status").all();
  const out = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** 从 MD 全量重建索引(物化索引的可重建性):清空候选相关表再按归档重灌 */
export function resetIndex(db) {
  db.exec(`
    DELETE FROM screening_results;
    DELETE FROM candidate_tags;
    DELETE FROM candidates;
  `);
}
