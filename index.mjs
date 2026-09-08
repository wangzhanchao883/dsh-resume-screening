import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { DEFAULT_CONFIG, resolveConfig, withCoarseTags } from "./config.mjs";
import { openDb, ensureTags, upsertCandidate, updateCandidateProfile, setCandidateTags, setStatus, findCandidateByHash, candidateTagMap, addRequirement, listRequirements, getScreeningResults, listCandidates, statusCounts, resetIndex, saveScreeningLlm, getScreeningLlm, getCandidateBody } from "./db.mjs";
import { convertFile, extOf } from "./convert.mjs";
import { ruleExtract, needsLlmFallback, normalizeLlmProfile } from "./extract.mjs";
import { screenAll } from "./scoring.mjs";
import { buildJobDesc, buildJudgePrompt, normalizeJudge } from "./judge.mjs";

export const name = "dsh-resume-screening";
export const inject = ["tools", "commands", "settings", "llm"];

const SETTINGS_NS = "dsh-resume-screening";

/** 扁平 schema:settings 客户端 set(field,value) 只支持单段路径,拍平后 host 映射回嵌套 */
const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  libraryRoot: z.string().default(DEFAULT_CONFIG.libraryRoot),
  archiveFolder: z.string().default(DEFAULT_CONFIG.archiveFolder),
  keepOriginal: z.boolean().default(true),
  dbFile: z.string().default(DEFAULT_CONFIG.dbFile),
  tags: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.union([z.const("enum"), z.const("number"), z.const("boolean"), z.const("text")]),
    description: z.string().default(""),
    multi: z.boolean().default(false),
  })).default([]),
  llmConfidenceThreshold: z.number().min(0).max(1).default(DEFAULT_CONFIG.llmConfidenceThreshold),
  llmFallback: z.boolean().default(true),
  batchSize: z.number().min(1).max(1000).default(DEFAULT_CONFIG.batchSize),
  llmTopN: z.number().min(0).max(10000).default(DEFAULT_CONFIG.llmTopN),
});

/** 归档目录(纯函数) */
function archiveDir(config) {
  return join(config.libraryRoot, config.archiveFolder || "archive");
}

/** 当前插件级配置(host 每次读取最新) */
let liveConfig = null;

export function apply(ctx, input = {}) {
  liveConfig = resolveConfig(input);

  ctx.inject(["settings"], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(SETTINGS_NS, settingsSchema, { base: toFlat(liveConfig) });
      const resolved = scope.get();
      if (resolved) liveConfig = { ...liveConfig, ...fromFlat(resolved) };
      scope.watch((next) => {
        if (!next) return;
        liveConfig = { ...liveConfig, ...fromFlat(next) };
      });
    } catch (err) {
      ctx.logger.warn(`dsh-resume-screening: 设置命名空间注册失败:${err.message}`);
    }
  });

  // ---------- 工具:建库/初始化 ----------
  ctx.tools.register(textTool({
    name: "resume_init",
    description: "初始化简历库:创建归档目录 + SQLite 数据库 + 预置标签字典。首次使用先跑这个。返回库路径与标签数。",
    parameters: {},
    async execute() {
      const cfg = currentConfig();
      const db = openDb(cfg);
      const tagIds = ensureTags(db, cfg.tags || []);
      db.close();
      return `简历库已初始化:\n目录=${cfg.libraryRoot}\n数据库=${join(cfg.libraryRoot, cfg.dbFile || "resume.db")}\n标签字典=标签共 ${Object.keys(tagIds).length} 个`;
    },
  }));

  // ---------- 工具:摄入文件夹(扫描 + 去重) ----------
  ctx.tools.register(textTool({
    name: "resume_ingest",
    description: "扫描一个文件夹里的简历文件(递归),按内容 hash 去重后入库标记待转。返回新增/重复/跳过统计。支持 .docx/.pdf/.xlsx/.xls/.md/.txt。",
    parameters: {
      folderPath: { type: "string", description: "简历文件所在文件夹(可含子文件夹)" },
    },
    async execute(args) {
      const cfg = currentConfig();
      const fp = (args.folderPath || "").trim();
      if (!fp) return "缺少 folderPath。";
      if (!existsSync(fp)) return `路径不存在:${fp}`;
      const db = openDb(cfg);
      ensureTags(db, cfg.tags || []);
      const files = collectResumeFiles(fp);
      let added = 0, dup = 0, skipped = 0;
      for (const f of files) {
        const hash = await contentHash(f);
        const existing = findCandidateByHash(db, hash);
        if (existing) { dup += 1; continue; }
        const base = basename(f);
        const name = base.replace(/(\.\w+)$/, "");
        // mdPath 留空(归档 MD 转换后才生成);sourcePath 记住原始文件,process 从这里读取转换
        const id = upsertCandidate(db, { name, mdPath: null, sourcePath: f, rawHash: hash, status: "pending" });
        if (id) added += 1;
        else skipped += 1;
      }
      db.close();
      return `扫描完成\n文件夹=${fp}\n文件=${files.length} 份\n新增待处理=${added}\n重复(已去重)=${dup}\n跳过=${skipped}\n支持的格式:.docx/.pdf/.xlsx/.xls/.md/.txt`;
    },
  }));

  // ---------- 工具:转换 + 抽取(批量流水线) ----------
  ctx.tools.register(textTool({
    name: "resume_process",
    description: "对已摄入的待处理简历执行 转换→规则抽取→(低置信/语义软标签→LLM兜底)→归档MD+入库SQLite.状态机: pending→converted→extracted→archived/failed.返回处理进度。",
    parameters: {
      limit: { type: "number", description: "可选:本批最多处理份数,缺省用配置 batchSize" },
      llm: { type: "boolean", description: "可选:强制启用 LLM 兜底;缺省按规则置信度自动判断" },
    },
    async execute(args, exec) {
      const cfg = currentConfig();
      const db = openDb(cfg);
      ensureTags(db, cfg.tags || []);
      const tagIds = ensureTags(db, cfg.tags || []);
      const limit = args.limit ?? cfg.batchSize;
      const pending = db.prepare("SELECT * FROM candidates WHERE status='pending' OR status='converted' ORDER BY id LIMIT ?").all(limit);
      const results = [];
      for (const c of pending) {
        results.push(await processOne(ctx, db, cfg, c, tagIds, args.llm, resolveRoute(exec)));
      }
      db.close();
      return renderProcessReport(results);
    },
  }));

  // ---------- 工具:查看入库进度 ----------
  ctx.tools.register(textTool({
    name: "resume_status",
    description: "查看简历库的整体处理状态(总份数 + 各状态分布),便于知道还剩多少没处理。",
    parameters: {},
    async execute() {
      const db = openDb(currentConfig());
      const counts = statusCounts(db);
      const total = listCandidates(db).length;
      db.close();
      const lines = [`简历库处理状态(共 ${total} 份)`];
      for (const [k, v] of Object.entries(counts)) lines.push(`- ${k}: ${v}`);
      return lines.join("\n");
    },
  }));

  // ---------- 工具:定义岗位要求(对话自然语言) ----------
  ctx.tools.register(textTool({
    name: "resume_define_rule",
    description: "用对话保存一个岗位的筛选要求。items 数组每项:{tag_key, operator(=|>=|<=|>|<|!=|in|contains), value, weight(仅加分项,数值), kind(must=必选 | nice=最好有)}。例如: 本科必选+经验>=2年加分。",
    parameters: {
      title: { type: "string", description: "岗位名,如 数据分析专员" },
      items: { type: "array", items: { type: "string" }, description: "JSON 字符串数组,每项 {\"tag_key\":\"education\",\"operator\":\"=\",\"value\":\"本科\",\"weight\":0,\"kind\":\"must\"}" },
    },
    async execute(args) {
      const db = openDb(currentConfig());
      const items = (args.items || []).map((s) => typeof s === "string" ? JSON.parse(s) : s);
      const id = addRequirement(db, { title: args.title || "未命名岗位", items });
      db.close();
      return `已保存岗位「${args.title || "未命名岗位"}」要求(第 ${id} 号),共 ${items.length} 条(必选 ${items.filter((i) => i.kind === "must").length} / 加分 ${items.filter((i) => i.kind !== "must").length})。用 resume_screen 执行筛选。`;
    },
  }));

  // ---------- 工具:执行筛选(核心) ----------
  ctx.tools.register(textTool({
    name: "resume_screen",
    description: "对一个岗位要求执行一次性初筛:必选标签全部满足才入选,加分标签按权重求和排序。llm=true 时对入围候选追加 LLM 精判(读原文判适配,输出评分/结论/理由),按 LLM 分重排。传 folderPath 会先把该文件夹里未入库的简历自动入库(含粗分类标签+入库时间),再整体筛选。",
    parameters: {
      reqId: { type: "number", description: "岗位要求 id(用 resume_list_rules 查)" },
      top: { type: "number", description: "可选:Top N 名,缺省 20" },
      llm: { type: "boolean", description: "可选:true=追加 LLM 精判(默认 false,纯规则筛选)" },
      llmTopN: { type: "number", description: "可选:LLM 精判数量,缺省用配置(0=全部精判)" },
      folderPath: { type: "string", description: "可选:包含待入库新简历的文件夹;传了会先自动入库(按内容hash去重)再筛选" },
    },
    async execute(args, exec) {
      const cfg = currentConfig();
      const db = openDb(cfg);
      let ingestNote = "";
      if (args.folderPath) {
        const tagIds = ensureTags(db, cfg.tags || []);
        const ing = await ingestFolderAndProcess(ctx, db, cfg, tagIds, args.folderPath);
        ingestNote = `已自动入库:扫描 ${ing.scanned} 个文件,新增 ${ing.added},重复跳过 ${ing.dup},成功入库 ${ing.processed}。`;
      }
      const req = db.prepare("SELECT * FROM requirements WHERE id=?").get(args.reqId);
      if (!req) { db.close(); return `${ingestNote}未找到岗位要求 #${args.reqId}。先用 resume_list_rules 查看已存岗位。`; }
      const items = db.prepare("SELECT * FROM requirement_items WHERE req_id=?").all(req.id);
      const candidates = loadAllCandidateMaps(db);
      const result = screenAll(candidates, items);
      // 落库筛选结果
      for (const r of result.ranked) {
        db.prepare("DELETE FROM screening_results WHERE req_id=? AND candidate_id=?").run(req.id, r.candidateId);
      }
      for (const r of result.ranked) {
        saveScreeningResultLocal(db, req.id, r.candidateId, r.score, true, r.matchedTags);
      }

      // LLM 精判分支
      if (args.llm) {
        if (!ctx.llm || typeof ctx.llm.stream !== "function") {
          db.close();
          return "LLM 精判已被请求,但 DSH LLM 通道不可用。请检查模型配置,或去掉 llm=true 用纯规则筛选。";
        }
        const topN = args.llmTopN ?? cfg.llmTopN ?? 20;
        const targets = topN === 0 ? result.ranked : result.ranked.slice(0, topN);
        const judged = await judgeCandidates(ctx, db, req, items, targets, resolveRoute(exec));
        db.close();
        return ingestNote ? ingestNote + "\n\n" + renderLlmScreenReport(req.id, judged) : renderLlmScreenReport(req.id, judged);
      }

      const rows = db.prepare(`
        SELECT sr.score, sr.matched_tags_json, c.name, c.education, c.age, c.experience_years, c.ingested_at, c.source_mtime
        FROM screening_results sr JOIN candidates c ON c.id=sr.candidate_id
        WHERE sr.req_id=? ORDER BY sr.score DESC LIMIT ?
      `).all(req.id, args.top || 20);
      db.close();
      return ingestNote ? ingestNote + "\n\n" + renderScreenReport(args.reqId, result, rows) : renderScreenReport(args.reqId, result, rows);
    },
  }));

  // ---------- 工具:列出岗位要求 ----------
  ctx.tools.register(textTool({
    name: "resume_list_rules",
    description: "列出所有已保存的岗位要求及其必选/加分条件,便于选 reqId 执行筛选。",
    parameters: {},
    async execute() {
      const db = openDb(currentConfig());
      const reqs = listRequirements(db);
      db.close();
      if (!reqs.length) return "暂无岗位要求。先用 resume_define_rule 定义。";
      const lines = reqs.map((r) => {
        const must = r.items.filter((i) => i.kind === "must").map((i) => `${i.tag_key}${i.operator}${i.value}`).join(" 且 ");
        const nice = r.items.filter((i) => i.kind !== "must").map((i) => `${i.tag_key}${i.operator}${i.value}(+${i.weight})`).join(" + ");
        return `#${r.id} ${r.title}\n  必选:${must || "(无)"}\n  加分:${nice || "(无)"}`;
      });
      return lines.join("\n\n");
    },
  }));

  // ---------- 工具:导出筛选结果 ----------
  ctx.tools.register(textTool({
    name: "resume_export",
    description: "把一个岗位的筛选结果导出为 CSV 文件(含姓名/学历/年龄/年限/总分/命中明细),便于 HR 跟进。",
    parameters: {
      reqId: { type: "number", description: "岗位要求 id" },
      outPath: { type: "string", description: "导出的 CSV 路径(如 D:\\简历库\\结果.csv)" },
    },
    async execute(args) {
      const db = openDb(currentConfig());
      const rows = getScreeningResults(db, args.reqId);
      db.close();
      if (!rows.length) return `暂无筛选结果(#${args.reqId})。先执行 resume_screen。`;
      const csv = toCsv(rows);
      const out = args.outPath || join(currentConfig().libraryRoot, `screen-${args.reqId}.csv`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, "\ufeff" + csv, "utf8");
      return `已导出 ${rows.length} 条到 ${out}`;
    },
  }));

  // ---------- 工具:从 MD 重建索引 ----------
  ctx.tools.register(textTool({
    name: "resume_rebuild",
    description: "从归档的 MD 全量重建 SQLite 索引(物化索引的可重建性)。重扫 archive 下的 .md,列出的 frontmatter 标签重新灌库。数据丢失/损坏后用它恢复,无锁定。",
    parameters: {},
    async execute() {
      const cfg = currentConfig();
      const db = openDb(cfg);
      resetIndex(db);
      const tagIds = ensureTags(db, cfg.tags || []);
      const arch = archiveDir(cfg);
      let rebuilt = 0;
      if (existsSync(arch)) {
        const files = collectMd(arch);
        for (const f of files) {
          const parsed = parseResumeMd(f);
          if (!parsed) continue;
          const hash = parsed.meta.raw_hash || await contentHash(f);
          const id = upsertCandidate(db, { name: parsed.meta.name || basename(f), mdPath: f, rawHash: hash, status: "archived" });
          if (parsed.profile) updateCandidateProfile(db, id, parsed.profile);
          if (parsed.tags?.length) setCandidateTags(db, id, tagIds, parsed.tags);
          rebuilt += 1;
        }
      }
      db.close();
      return `已从归档重建 ${rebuilt} 份候选人索引`;
    },
  }));

  // ---------- 斜杠命令 /resume_screen(host 直跑,不经模型) ----------
  if (ctx.commands) {
    ctx.commands.register({
      name: "resume_screen",
      description: "对一个岗位要求执行一次性初筛(必选硬过滤 + 加分加权排序)。llm=1 时追加 LLM 精判。需配置好简历库并已导入简历。",
      input: {
        hint: "执行简历筛选。可选参数 reqId=<岗位id> top=<N> llm=<0|1> llmTopN=<N>。先用 resume_list_rules 查岗位。",
        images: false,
      },
      handler: async ({ rawInput, agent, signal }) => {
        try {
          const m = parseScreenArgs(rawInput);
          const cfg = currentConfig();
          const db = openDb(cfg);
          const reqId = m.reqId;
          const req = db.prepare("SELECT * FROM requirements WHERE id=?").get(reqId);
          if (!req) { db.close(); return { kind: "error", text: `未找到岗位 #${reqId}` }; }
          const items = db.prepare("SELECT * FROM requirement_items WHERE req_id=?").all(req.id);
          const candidates = loadAllCandidateMaps(db);
          const result = screenAll(candidates, items);
          for (const r of result.ranked) {
            db.prepare("DELETE FROM screening_results WHERE req_id=? AND candidate_id=?").run(req.id, r.candidateId);
          }
          for (const r of result.ranked) saveScreeningResultLocal(db, req.id, r.candidateId, r.score, true, r.matchedTags);
          // LLM 精判分支
          if (m.llm) {
            if (!ctx.llm || typeof ctx.llm.stream !== "function") {
              db.close();
              return { kind: "error", text: "LLM 精判已被请求,但 DSH LLM 通道不可用。" };
            }
            const topN = m.llmTopN ?? cfg.llmTopN ?? 20;
            const targets = topN === 0 ? result.ranked : result.ranked.slice(0, topN);
            const judged = await judgeCandidates(ctx, db, req, items, targets, resolveRoute({ agent, signal }));
            db.close();
            return { kind: "success", text: renderLlmScreenReport(reqId, judged) };
          }
          const rows = db.prepare(`
            SELECT sr.score, sr.matched_tags_json, c.name, c.education, c.age, c.experience_years
            FROM screening_results sr JOIN candidates c ON c.id=sr.candidate_id
            WHERE sr.req_id=? ORDER BY sr.score DESC LIMIT ?
          `).all(req.id, m.top || 20);
          db.close();
          return { kind: "success", text: renderScreenReport(reqId, result, rows) };
        } catch (e) {
          return { kind: "error", text: `筛选失败:${e && e.message ? e.message : String(e)}` };
        }
      },
    });
  }

  ctx.logger.info("dsh-resume-screening: 简历筛选大师已加载");
}

// ============ 主机侧批量流水线 ============

async function processOne(ctx, db, cfg, candidate, tagIds, forceLlm, route) {
  try {
    setStatus(db, candidate.id, "converting");
    // 真相来源 = source_path(原始文件);老数据回退到 md_path
    const sourceAbs = candidate.source_path || candidate.md_path;
    let mdText = "";
    if (!sourceAbs || !existsSync(sourceAbs)) {
      setStatus(db, candidate.id, "failed");
      return { id: candidate.id, name: candidate.name, status: "failed", msg: "源文件缺失" };
    }
    const ext = extOf(sourceAbs);
    if (ext === ".docx" || ext === ".pdf" || ext === ".xlsx" || ext === ".xls") {
      const conv = await convertFile(sourceAbs);
      mdText = conv.markdown;
      // 扫描件无文本层 -> 标待人工,不判失败
      if (conv.meta.scanned) {
        setStatus(db, candidate.id, "archived");
        return { id: candidate.id, name: candidate.name, status: "archived", msg: "扫描件无文本层,待人工/OCR" };
      }
    } else if (ext === ".md" || ext === ".txt") {
      mdText = readFileSync(sourceAbs, "utf8");
    } else {
      setStatus(db, candidate.id, "failed");
      return { id: candidate.id, name: candidate.name, status: "failed", msg: `不支持的格式 ${ext}` };
    }

    // 规则抽取
    let ruleRes = ruleExtract(mdText, cfg.tags || []);
    let finalRes = ruleRes;

    // LLM 兜底:低置信 / 语义软标签
    const needs = forceLlm || needsLlmFallback(ruleRes, cfg);
    if (needs) {
      const llmRes = await llmExtractProfile(ctx, mdText, cfg.tags || [], ruleRes, route);
      if (llmRes) {
        finalRes = mergeExtract(ruleRes, llmRes);
        // 把有值字段提出来,作为 profile 补充
        for (const k of ["age", "gender", "experience_years", "education", "school", "major"]) {
          if (finalRes.profile[k] === undefined && llmRes.profile[k] !== undefined) {
            finalRes.profile[k] = llmRes.profile[k];
          }
        }
      }
    }

    // 写归档 MD(frontmatter + 正文)
    const archived = writeResumeMd(cfg, candidate, mdText, finalRes);
    // 回填归档 MD 路径(真相源仍在 source_path),并按"extracted→archived"顺序落状态
    updateCandidateProfile(db, candidate.id, finalRes.profile, (() => { try { return statSync(sourceAbs).mtime.toISOString(); } catch { return null; } })());
    setCandidateTags(db, candidate.id, tagIds, finalRes.tags);
    db.prepare("UPDATE candidates SET md_path=?, status='archived', updated_at=datetime('now') WHERE id=?").run(archived, candidate.id);

    return { id: candidate.id, name: candidate.name, status: "archived", score: finalRes.maxConf?.toFixed?.(2) ?? "-", msg: archived };
  } catch (e) {
    setStatus(db, candidate.id, "failed");
    return { id: candidate.id, name: candidate.name, status: "failed", msg: e.message || String(e) };
  }
}

function renderProcessReport(results) {
  const ok = results.filter((r) => r.status === "archived");
  const fail = results.filter((r) => r.status === "failed");
  const lines = [`本批处理 ${results.length} 份:成功入库 ${ok.length},失败 ${fail.length}`];
  for (const r of results) {
    lines.push(`- [${r.status}] ${r.name} :: ${r.msg || ""}`);
  }
  return lines.join("\n");
}

// ============ 自动入库(筛选前) ============

/** 扫描 folderPath 里未入库的简历(按内容hash去重),转换+抽取(含粗分类标签+入库时间),返回统计。 */
async function ingestFolderAndProcess(ctx, db, cfg, tagIds, folderPath) {
  const out = { scanned: 0, added: 0, dup: 0, processed: 0, results: [] };
  if (!folderPath || !existsSync(folderPath)) return out;
  const files = collectResumeFiles(folderPath);
  out.scanned = files.length;
  for (const f of files) {
    const hash = await contentHash(f);
    if (findCandidateByHash(db, hash)) { out.dup += 1; continue; }
    const name = basename(f).replace(/(\.\w+)$/, "");
    upsertCandidate(db, { name, mdPath: null, sourcePath: f, rawHash: hash, status: "pending" });
    out.added += 1;
  }
  const pending = db.prepare("SELECT * FROM candidates WHERE status='pending' OR status='converted' ORDER BY id").all();
  for (const c of pending) {
    const r = await processOne(ctx, db, cfg, c, tagIds, false);
    out.results.push(r);
    if (r.status === "archived") out.processed += 1;
  }
  return out;
}

// ============ 归档 MD 读写 ============

function writeResumeMd(cfg, candidate, mdText, res) {
  const dir = archiveDir(cfg);
  mkdirSync(dir, { recursive: true });
  const safeName = (candidate.name || "candidate").replace(/[\\/:*?"<>|]/g, "_");
  // 统一归档为 .md,用 candidate.id 保证不同来源同名的原始文件不覆盖
  const mdPath = join(dir, `${safeName}-${candidate.id}.md`);
  const fm = frontmatter({ id: candidate.id, name: candidate.name, raw_hash: candidate.raw_hash, ...(res.profile || {}) });
  const tagsBody = (res.tags || []).map((t) => `${t.tagKey}: ${t.value}`).join("\n");
  const body = `# 候选人 ${candidate.name || ""}\n\n## 标签\n${tagsBody || "(无)"}\n\n## 简历原文\n\n${mdText || ""}\n`;
  writeFileSync(mdPath, fm + body, "utf8");
  return mdPath;
}

function frontmatter(f) {
  const fm = {
    id: f.id, name: f.name, raw_hash: f.raw_hash,
    学历: f.education || "", 性别: f.gender || "", 年龄: f.age ?? "",
    工作年限: f.experience_years ?? "", 学校: f.school || "", 专业: f.major || "",
  };
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v ?? ""}`).join("\n")}\n---\n`;
}

function parseResumeMd(filePath) {
  let text;
  try { text = readFileSync(filePath, "utf8"); } catch { return null; }
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const profile = {
    education: meta["学历"] || undefined,
    gender: meta["性别"] || undefined,
    age: meta["年龄"] ? Number(meta["年龄"]) : undefined,
    experience_years: meta["工作年限"] ? Number(meta["工作年限"]) : undefined,
    school: meta["学校"] || undefined,
    major: meta["专业"] || undefined,
  };
  // frontmatter 用中文键,标签字典用英文 tag_key。这里按中文键→英文 tag_key 映射构建标签,
  // 否则 rebuild 后 candidate_tags 全空,筛选引擎读不到任何字段。
  const FM_TAG_MAP = {
    "学历": "education",
    "性别": "gender",
    "年龄": "age",
    "工作年限": "experience_years",
    "学校": "school",
    "专业": "major",
  };
  const tags = [];
  for (const [cnKey, tagKey] of Object.entries(FM_TAG_MAP)) {
    if (meta[cnKey]) tags.push({ tagKey, value: meta[cnKey], confidence: 1, source: "manual" });
  }
  return { meta, profile, tags };
}

// ============ 辅助 ============

function currentConfig() {
  const c = liveConfig || resolveConfig();
  // 强制注入粗分类维度:防止持久化设置里的旧 tags 数组遮蔽新增标签。
  return c ? { ...c, tags: withCoarseTags(c.tags) } : c;
}

function toFlat(config) {
  return {
    enabled: config.enabled,
    libraryRoot: config.libraryRoot,
    archiveFolder: config.archiveFolder,
    keepOriginal: config.keepOriginal,
    dbFile: config.dbFile,
    tags: config.tags ?? [],
    llmConfidenceThreshold: config.llmConfidenceThreshold,
    llmFallback: config.llmFallback,
    batchSize: config.batchSize,
  };
}

function fromFlat(flat) {
  return {
    enabled: flat.enabled,
    libraryRoot: flat.libraryRoot,
    archiveFolder: flat.archiveFolder,
    keepOriginal: flat.keepOriginal,
    dbFile: flat.dbFile,
    tags: flat.tags ?? [],
    llmConfidenceThreshold: flat.llmConfidenceThreshold,
    llmFallback: flat.llmFallback,
    batchSize: flat.batchSize,
  };
}

function textTool(definition) {
  return defineTool({
    ...definition,
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    presentCall: (args) => ({ card: "generic", kind: "text", title: definition.name, rawInput: args }),
  });
}

/** 从调用上下文(工具 exec 或命令 invocation)解析当前对话的 provider/model 路由 */
function resolveRoute(item) {
  const agent = item?.agent;
  const routed = agent?.session?.requestHeader?.()?.config;
  return {
    provider: routed?.provider ?? agent?.options?.provider,
    model: routed?.model ?? agent?.options?.model,
    signal: item?.signal,
    sessionId: agent?.session?.id,
  };
}

/**
 * 用 DSH 标准流式 LLM API 做一次文本调用(注意:DSH 的 llm 服务是 `stream()` 流式消息接口,
 * 没有 `.call(prompt)` 方法;这里手工构造 message 并拼 text-delta,不依赖额外包)。
 * 返回可见文本。
 */
async function callLlm(ctx, route, prompt) {
  const provider = route?.provider;
  const model = route?.model;
  if (!ctx.llm || typeof ctx.llm.stream !== "function") throw new Error("DSH LLM 通道不可用");
  if (!provider || !model) throw new Error("无法解析当前模型路由(provider/model),请先配置好对话模型");
  const msg = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content: [{ type: "text", text: prompt }],
    source: { kind: "plugin", plugin: "dsh-resume-screening" },
  };
  const options = { provider, model, messages: [msg], maxTokens: 8000, reasoningEffort: "off" };
  // 超时保护:防止模型/网络挂起导致工具永久卡死(默认 120s)。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  let signal = route?.signal;
  try {
    if (signal) {
      signal = typeof AbortSignal.any === "function" ? AbortSignal.any([signal, ac.signal]) : signal;
    } else {
      signal = ac.signal;
    }
    options.signal = signal;
    if (route?.sessionId) options.sessionId = route.sessionId;
    let text = "";
    let reasoning = "";
    let sawTextDelta = false;
    let finishKind = "";
    for await (const chunk of ctx.llm.stream(options)) {
      if (!chunk) continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") { text += chunk.text; sawTextDelta = true; }
      else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") { reasoning += chunk.text; }
      else if (chunk.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string" && !sawTextDelta) {
        text += chunk.block.text;
      }
      else if (chunk.type === "finish") {
        finishKind = chunk.reason?.kind || "";
        if (finishKind === "error" || finishKind === "aborted") {
          throw new Error(`LLM 调用失败:${chunk.reason?.failure?.message || finishKind}`);
        }
      }
    }
    if (!text.trim()) {
      // 推理型模型可能把最终答案也放进 reasoning 块(兜底取 reasoning;正常 off 模式不会走到这)
      if (reasoning.trim()) text = reasoning;
      else throw new Error(`LLM 未返回可用文本(finish=${finishKind || "?"})`);
    }
    return text;
  } catch (e) {
    if (ac.signal.aborted && !(route?.signal?.aborted)) {
      throw new Error(`LLM 调用超时(120s):${e?.message || e}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** LLM 兜底:结构化抽取人物档案 + 语义软标签。走 DSH stream 流式接口,失败回退到规则结果。 */
async function llmExtractProfile(ctx, mdText, tags, ruleRes, route) {
  try {
    const tagDesc = (tags || []).map((t) => `${t.key}(${t.label || t.key},${t.type})`).join(",");
    const prompt = `你是简历解析助手。从下面这份简历文本里抽取候选人的结构化档案和语义标签。
已配置标签:${tagDesc}。
【强约束】只输出一个 JSON,不要别的文字;不确定的字段填 null,不许编造(比如简历没写性别就填 null)。
JSON 结构:
{
  "age": 数字或null, "gender": "男|女|null", "experience_years": 数字或null,
  "education": "博士|硕士|本科|大专|null", "school": 字符串或null, "major": 字符串或null,
  "tags": [ {"tag":"项目管理经验","value":"有"}, {"tag":"skill","value":"Python"}, {"tag":"技能类别","value":"计算机"}, {"tag":"经验方向","value":"编程"} ]
}
技能类别可选值:计算机/财务/金融/管理/外贸/销售/人力资源/设计/制造/医疗/教育/物流/客服;经验方向可选值:编程开发/财务会计/金融/管理/外贸/数据分析/运维/销售市场/行政人事/设计/生产制造。可填多个,拿不准可不填(宁缺毋滥)。
简历文本开始:
${(mdText || "").slice(0, 6000)}
简历文本结束。`;
    const text = await callLlm(ctx, route, prompt);
    return normalizeLlmProfile(text, tags);
  } catch (e) {
    ctx.logger.warn(`dsh-resume-screening: LLM 兜底失败,用规则结果:${e.message}`);
    return null;
  }
}

/** 语义软标签以 LLM 为准:LLM 兜底给了这些 key 时,覆盖规则版,避免规则关键词噪点(设计/工程/客户)残留。 */
const LLM_AUTHORITATIVE_KEYS = new Set(["skill_category", "experience_direction", "project_management"]);

/** 合并规则 + LLM 结果(规则给硬字段,LLM 给语义软标签并覆盖规则版;tags 去重) */
function mergeExtract(ruleRes, llmRes) {
  const profile = { ...(ruleRes.profile || {}), ...(llmRes.profile || {}) };
  const llmKeys = new Set((llmRes?.tags || []).map((t) => t.tagKey).filter((k) => LLM_AUTHORITATIVE_KEYS.has(k)));
  const seen = new Map();
  const tags = [];
  for (const t of [...(ruleRes.tags || []), ...(llmRes.tags || [])]) {
    if (!t.tagKey || t.value === undefined || t.value === null || t.value === "") continue;
    // 语义软标签:LLM 已覆盖该 key → 跳过规则版,只保留 LLM 版
    if (t.source !== "llm" && llmKeys.has(t.tagKey)) continue;
    const key = `${t.tagKey}|${t.value}`;
    if (seen.has(key)) {
      // 保留置信度更高的
      const idx = seen.get(key);
      if (t.confidence > tags[idx].confidence) tags[idx] = t;
      continue;
    }
    seen.set(key, tags.length);
    tags.push(t);
  }
  let maxConf = Math.max(ruleRes.maxConf || 0, llmRes.maxConf || 0);
  return { profile, tags, maxConf };
}

function loadAllCandidateMaps(db) {
  const cands = db.prepare("SELECT id, education, gender, age, experience_years, school, major FROM candidates").all();
  return cands.map((c) => {
    const tagMap = candidateTagMap(db, c.id);
    // 结构化列兜底:候选人的教育/性别/年龄/年限/学校/专业在 candidates 表里有权威值,
    // 若 candidate_tags 缺失或为空(如旧数据/重建未对齐),直接并入,保证筛选能读到硬字段。
    const colMap = {
      education: c.education,
      gender: c.gender,
      age: c.age,
      experience_years: c.experience_years,
      school: c.school,
      major: c.major,
    };
    for (const [k, v] of Object.entries(colMap)) {
      if (v !== null && v !== undefined && v !== "") {
        tagMap[k] = { value: String(v), confidence: 1, source: "column" };
      }
    }
    return { id: c.id, tagMap };
  });
}

function saveScreeningResultLocal(db, reqId, candidateId, score, mustPass, matchedTags) {
  db.prepare("INSERT INTO screening_results (req_id, candidate_id, score, must_pass, matched_tags_json) VALUES (?,?,?,?,?)")
    .run(reqId, candidateId, score, mustPass ? 1 : 0, JSON.stringify(matchedTags));
}

function renderScreenReport(reqId, result, rows) {
  const lines = [
    `岗位要求 #${reqId} 筛选结果`,
    `候选人 ${result.total} 份,全部满足必选 ${result.passedCount} 份,其中需人工确认(必选值未定) ${(result.needDecision || []).length} 份。`,
    `Top ${rows.length} 排名(按加分总分降序):`,
  ];
  for (const r of rows) {
    const matched = (() => {
      try {
        const arr = JSON.parse(r.matched_tags_json || "[]");
        const hits = arr.filter((x) => x.status === "hit").map((x) => `${x.tag}=${x.cond}(+${x.weight ?? 0})`);
        const unc = arr.filter((x) => x.status === "uncertain").length;
        return `${hits.join(" ")}${unc ? ` [${unc}项未定]` : ""}`;
      } catch { return ""; }
    })();
    lines.push(`${String(r.score).padStart(5)} 分  ${r.name || "?"}  ${r.education || ""} ${r.age ? r.age + "岁" : ""} ${r.experience_years ? r.experience_years + "年" : ""}  ${matched}  [入库:${fmtDate(r.ingested_at)}]`);
  }
  return lines.join("\n");
}

/** 把 ISO 时间字符串精简为 YYYY-MM-DD HH:MM(取前 16 位),空则返回 "-" */
function fmtDate(v) {
  const s = String(v || "");
  return s.length ? s.replace("T", " ").slice(0, 16) : "-";
}

/** 对入围候选逐份跑 LLM 精判:读原文 → 判适配 → 归一化 → 落库。返回按 LLM 分降序的 judged 列表。 */
async function judgeCandidates(ctx, db, req, items, targets, route) {
  const jobDesc = buildJobDesc(req, items);
  const judged = [];
  for (const t of targets) {
    const cand = db.prepare("SELECT id, name, age, gender, education, experience_years FROM candidates WHERE id=?").get(t.candidateId);
    if (!cand) continue;
    const body = getCandidateBody(db, cand.id);
    if (!body) {
      judged.push({ candidateId: cand.id, name: cand.name || "?", ok: false, error: "无可读原文" });
      continue;
    }
    const candProfile = [
      `姓名:${cand.name}`,
      cand.age ? `年龄:${cand.age}岁` : "",
      cand.gender ? `性别:${cand.gender}` : "",
      cand.education ? `学历:${cand.education}` : "",
      cand.experience_years ? `经验:${cand.experience_years}年` : "",
    ].filter(Boolean).join(" | ");
    const prompt = buildJudgePrompt({ jobDesc, candProfile, candText: body });
    try {
      const text = await callLlm(ctx, route, prompt);
      const norm = normalizeJudge(text, { age: cand.age, gender: cand.gender, education: cand.education, experience_years: cand.experience_years });
      if (!norm.ok) {
        judged.push({ candidateId: cand.id, name: cand.name || "?", ok: false, error: norm.error });
        continue;
      }
      saveScreeningLlm(db, req.id, cand.id, { ...norm, model: "current" });
      judged.push({ candidateId: cand.id, name: cand.name || "?", ok: true, ...norm });
    } catch (e) {
      judged.push({ candidateId: cand.id, name: cand.name || "?", ok: false, error: e && e.message ? e.message : String(e) });
    }
  }
  // ok 项按 LLM 分降序,ok 为 false 的垫底
  return judged.sort((a, b) => (b.ok ? b.score ?? -1 : -1) - (a.ok ? a.score ?? -1 : -1));
}

/** 渲染 LLM 精判报告 */
function renderLlmScreenReport(reqId, judged) {
  const lines = [
    `岗位要求 #${reqId} LLM 精判结果`,
    `精判 ${judged.length} 人(按适配度评分降序):`,
    "",
  ];
  for (const j of judged) {
    if (!j.ok) {
      lines.push(`  [失败] ${j.name}  ${j.error || "未知错误"}`);
      continue;
    }
    const hardAbnormal = (j.hard_check || []).filter((h) => !h.match);
    const hardStr = hardAbnormal.length ? `  [硬字段复核异常:${hardAbnormal.map((h) => `${h.label}:规则${h.rule}/LLM读${h.llm}`).join("; ")}]` : "";
    lines.push(`${String(j.score).padStart(3)} 分  ${j.verdict}  ${j.name}`);
    lines.push(`    技能:+${j.dims.skills.score} 经验:+${j.dims.experience.score} 项目:+${j.dims.projects.score} 意向:+${j.dims.intention.score}  => ${j.reason || "(无理由)"}${hardStr}`);
    if (j.matched_skills?.length) lines.push(`    命中技能:${j.matched_skills.join(", ")}`);
    if (j.gaps?.length) lines.push(`    缺口:${j.gaps.join("; ")}`);
  }
  return lines.join("\n");
}

/** 收集简历文件(递归,跳过隐藏) */
function collectResumeFiles(root) {
  const exts = new Set([".docx", ".pdf", ".xlsx", ".xls", ".md", ".txt"]);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (exts.has(extOf(e.name))) out.push(full);
    }
  }
  return out;
}

function collectMd(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (/\.md$/i.test(e.name)) out.push(full);
    }
  }
  return out;
}

async function contentHash(filePath) {
  const { createHash } = await import("node:crypto");
  const bytes = readFileSync(filePath);
  return createHash("sha1").update(bytes).digest("hex");
}

function parseScreenArgs(raw) {
  const s = String(raw || "");
  const reqId = (s.match(/reqId\s*=\s*(\d+)/i) || [])[1] ? Number(s.match(/reqId\s*=\s*(\d+)/i)[1]) : null;
  // top 别名 n:用负向环视 (?<!llmTop) 排除 llmTopN 里的 N,否则 "llmTopN=0" 会被误读成 top=0。
  const topM = s.match(/(?<!llmTop)(?:top|n)\s*=\s*(\d+)/i);
  const top = topM ? Number(topM[1]) : 20;
  const llm = /(?:llm\s*=\s*(1|true|yes))/i.test(s);
  const llmTopN = (s.match(/llmTopN\s*=\s*(\d+)/i) || [])[1] ? Number(s.match(/llmTopN\s*=\s*(\d+)/i)[1]) : undefined;
  return { reqId, top, llm, llmTopN };
}

function toCsv(rows) {
  const header = ["id", "name", "education", "age", "gender", "experience_years", "score", "matched_tags", "ingested_at", "source_mtime"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(",")];
  for (const r of rows) {
    lines.push([r.id, r.name, r.education, r.age, r.gender, r.experience_years, r.score, r.matched_tags_json, r.ingested_at ?? "", r.source_mtime ?? ""]
      .map(esc).join(","));
  }
  return lines.join("\n");
}
