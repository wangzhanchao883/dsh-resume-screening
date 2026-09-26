import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { DEFAULT_CONFIG, resolveConfig, withCoarseTags } from "./config.mjs";
import { openDb, ensureTags, upsertCandidate, updateCandidateProfile, setCandidateTags, setStatus, findCandidateByHash, candidateTagMap, addRequirement, listRequirements, getScreeningResults, listCandidates, statusCounts, resetIndex, saveScreeningLlm, getScreeningLlm, getCandidateBody } from "./db.mjs";
import { convertFile, extOf } from "./convert.mjs";
import { ruleExtract, needsLlmFallback, normalizeLlmProfile } from "./extract.mjs";
import { splitArchiveMd, extractResumeBody, looksLikeArchiveMd, isNestedArchiveMd, isInsideDir } from "./md.mjs";
import { screenAll } from "./scoring.mjs";
import { buildJobDesc, buildJudgePrompt, normalizeJudge } from "./judge.mjs";

export const name = "dsh-resume-screening";
export const inject = ["tools", "commands", "settings", "llm"];

const SETTINGS_NS = "dsh-resume-screening";

/**
 * schemastery < 3.18.4 没有 `.volatile()`(3.18.2 上调用会抛 `volatile is not a function`,模块加载期就崩)
 * → 降级为原 schema,保证老 DSH 上照常加载。DSH 0.1.7 自带 3.18.4,走的是带标记的分支。
 */
const vol = (schema) => (typeof schema.volatile === "function" ? schema.volatile() : schema);

/**
 * ⚠️ 0.1.7 最大的坑(2026-09-26 实测):标了 `.volatile()` 的字段,经 schema 解析后**不是纯值**,
 * 而是 cosmokit 的 **Volatile 盒**(冻结对象,只有 `get()`);不 `.get()` 解包就当字符串用,
 * `path.join()` 会抛 `The "path" argument must be of type string ... Received an instance of Object`,
 * 表现成「插件装上后所有工具一调就崩」。
 * 宿主自己的插件也这么解包(如 dsh-agent-default-model 的 `this.config.provider.get()`)。
 * `isVolatile` 内部走共享 Symbol,跨 ESM/CJS 副本也认。
 */
const unwrap = (value) => (isVolatile(value) ? value.get() : value);

/** 把一份解析后的配置(顶层字段可能是 Volatile 盒)摊平成纯值 */
const plainConfig = (config) =>
  Object.fromEntries(
    Object.entries(config && typeof config === "object" ? config : {}).map(([key, value]) => [key, unwrap(value)]),
  );

/**
 * DSH 0.1.7 起设置面板由本插件的 `Config` 投影(不再由 settings.register 托管值):
 *  - 必须**具名导出**(模块里不能有 `export default`,否则 loader 剥壳后读不到 `.Config`)
 *  - 每个可写字段要标 `.volatile()`(=「能现场改、改完即时生效」);**一个都没标 → 整个条目被静默过滤**,面板消失且不报错
 *  - 结构保持扁平:客户端便捷方法 `configForms.set(field, value)` 一次只写一个一级键
 * 字段定义逐字沿用旧 settingsSchema,只是逐项盖章 —— 迁移零行为变化。
 */
const CONFIG_FIELDS = {
  enabled: vol(z.boolean().default(true)),
  libraryRoot: vol(z.string().default(DEFAULT_CONFIG.libraryRoot)),
  archiveFolder: vol(z.string().default(DEFAULT_CONFIG.archiveFolder)),
  keepOriginal: vol(z.boolean().default(true)),
  dbFile: vol(z.string().default(DEFAULT_CONFIG.dbFile)),
  // tags 也必须盖章:面板的「标签库」走 scope.set("tags", …),而 host 的 write() 会用
  // isVolatilePath 逐段校验(只看 dict,不认 array 的 inner) —— 不盖章就直接抛
  // `Config field "tags" is not volatile`,标签库变成只读。盖章后才写得进去。
  // ⚠️ default 必须是**完整默认标签库**,不能是 []。
  // 设置行通常只有 `disabled: false`(没写过 tags),此时 schema 默认值就是最终值;
  // 若默认写成 [],resolveConfig 会用它**整体冲掉** DEFAULT_CONFIG.tags
  // (数组在 mergeDeep 里是整体替换,不合并),于是标签字典只剩 withCoarseTags 兜的那 2 个粗分类维度
  // → skill/education/gender/age 这些键在 tags 表里根本不存在 → 所有按标签的筛选静默返回 0 人。
  // 实测:默认 [] 时新库只有「标签共 2 个」。
  tags: vol(z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.union([z.const("enum"), z.const("number"), z.const("boolean"), z.const("text")]),
    description: z.string().default(""),
    multi: z.boolean().default(false),
  })).default(DEFAULT_CONFIG.tags.map((t) => ({ ...t })))),
  llmConfidenceThreshold: vol(z.number().min(0).max(1).default(DEFAULT_CONFIG.llmConfidenceThreshold)),
  llmFallback: vol(z.boolean().default(true)),
  batchSize: vol(z.number().min(1).max(1000).default(DEFAULT_CONFIG.batchSize)),
  llmTopN: vol(z.number().min(0).max(10000).default(DEFAULT_CONFIG.llmTopN)),
};

/** 设置面板的字段声明(DSH 0.1.7 读它来投影表单) */
export const Config = z.object(CONFIG_FIELDS);

/** 归档目录(纯函数) */
function archiveDir(config) {
  return join(config.libraryRoot, config.archiveFolder || "archive");
}

/** 当前插件级配置(host 每次读取最新) */
let liveConfig = null;

/**
 * 0.1.7 起 `settings.register(ns, schema, {base})` / `scope.get()` / `scope.watch()` 全部作废:
 * 设置服务不再替插件保管值,只把插件的 `Config` **投影**成表单。权威值在 profile 配置里。
 *  - 读:`settings.describe()` 找 ns === SETTINGS_NS 的条目(返回 { ns, value })
 *  - 写:由 DSH 侧落盘;**实测写入不会让本插件重新 apply**(见 currentConfig 注释),
 *    所以每个入口都要靠 describe() 重读,不能只依赖 apply 时刻的快照。
 * `describe` 在旧版 DSH 上不存在 → 探测后安全降级,退回 apply 的入参。
 */
let settingsService = null;
/** 模块级 logger:syncFromSettings 是模块级函数,取不到 apply 的 ctx */
let logger = null;

function syncFromSettings() {
  if (!settingsService || typeof settingsService.describe !== "function") return false;
  try {
    const row = settingsService.describe().find((it) => it && it.ns === SETTINGS_NS);
    if (!row || row.value === undefined || row.value === null) return false;
    // describe() 给的同样是「带 Volatile 盒」的解析值 → 先解包再合并
    const patch = plainConfig(row.value);
    // 只覆盖有值的键:避免 undefined 把 resolveConfig 兜好的默认值冲掉
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];
    liveConfig = { ...liveConfig, ...patch };
    return true;
  } catch (err) {
    try {
      logger?.warn(`dsh-resume-screening: 读取设置失败(继续用已有配置):${err && err.message ? err.message : err}`);
    } catch {}
    return false;
  }
}

export function apply(ctx, input = {}) {
  logger = ctx.logger;
  // 0.1.7:入参是经 `Config` 解析后的配置,volatile 字段是盒 → 必须解包
  liveConfig = resolveConfig(plainConfig(input));

  ctx.inject(["settings"], (settingsCtx) => {
    settingsService = settingsCtx.settings;
    syncFromSettings();
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
      const files = collectResumeFiles(fp, [archiveDir(cfg)]);
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
      let dropped = 0;
      if (existsSync(arch)) {
        const files = collectMd(arch);
        // 先解析并按 raw_hash 归并:历史 bug 留下过"嵌套归档"文件(正文里又套着一份归档 MD),
        // 同一份简历会同时存在 -4.md 和 -21.md。
        // 择优顺序:**标签更全的优先**(标签数是抽取质量的直接体现;老文件里常见 `skill: 技能`
        // 这种关键词表 bug 留下的垃圾值)、其次非嵌套、最后文件序号大的(更新)。
        // 只按"非嵌套"选会选错:实测真实库里干净的那份反而是技能抽坏的老文件。
        const picked = new Map();
        for (const f of files) {
          const parsed = parseResumeMd(f);
          if (!parsed) continue;
          const hash = parsed.meta.raw_hash || await contentHash(f);
          const cur = picked.get(hash);
          if (!cur) { picked.set(hash, { f, parsed, hash }); continue; }
          dropped += 1;
          if (isBetterArchiveCopy(parsed, f, cur.parsed, cur.f)) picked.set(hash, { f, parsed, hash });
        }
        for (const { f, parsed, hash } of picked.values()) {
          const id = upsertCandidate(db, { name: parsed.meta.name || basename(f), mdPath: f, rawHash: hash, status: "archived" });
          if (parsed.profile) updateCandidateProfile(db, id, parsed.profile);
          if (parsed.tags?.length) setCandidateTags(db, id, tagIds, parsed.tags);
          rebuilt += 1;
        }
      }
      db.close();
      return `已从归档重建 ${rebuilt} 份候选人索引${dropped ? `(跳过 ${dropped} 个重复/嵌套副本)` : ""}`;
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
    const arch = archiveDir(cfg);
    // 真相来源 = source_path(原始文件)。
    // 但历史数据里有 source_path 为空、只剩 md_path 的记录,而 md_path 是**我们自己的归档产物**:
    // 把它当原始简历再吃一遍,就会把整份归档 MD(含 frontmatter / ## 标签 / ## 简历原文)嵌进新 MD,
    // 形成 -4.md → -21.md 的嵌套,并让规则抽取读到上一层 frontmatter 的残留(如 major: ---)。
    // 所以这里分两条路:能拿到真原始文件才"转换 + 归档";只有归档 MD 时"只重抽正文,不重归档"。
    const sourcePath = candidate.source_path || "";
    const originalSource =
      sourcePath && existsSync(sourcePath) && !isInsideDir(sourcePath, arch) ? sourcePath : null;
    const archiveSource =
      !originalSource && candidate.md_path && existsSync(candidate.md_path) ? candidate.md_path : null;

    if (!originalSource && !archiveSource) {
      setStatus(db, candidate.id, "failed");
      return { id: candidate.id, name: candidate.name, status: "failed", msg: "源文件缺失" };
    }

    let mdText = "";
    let rearchived = true;
    if (originalSource) {
      const ext = extOf(originalSource);
      if (ext === ".docx" || ext === ".pdf" || ext === ".xlsx" || ext === ".xls") {
        const conv = await convertFile(originalSource);
        mdText = conv.markdown;
        // 扫描件无文本层 -> 标待人工,不判失败
        if (conv.meta.scanned) {
          setStatus(db, candidate.id, "archived");
          return { id: candidate.id, name: candidate.name, status: "archived", msg: "扫描件无文本层,待人工/OCR" };
        }
      } else if (ext === ".md" || ext === ".txt") {
        mdText = readFileSync(originalSource, "utf8");
        // 原始文件本身就是我们导出的归档 MD(比如被当成新简历再导入一次)→ 先剥壳,杜绝嵌套
        if (looksLikeArchiveMd(mdText)) mdText = extractResumeBody(mdText);
      } else {
        setStatus(db, candidate.id, "failed");
        return { id: candidate.id, name: candidate.name, status: "failed", msg: `不支持的格式 ${ext}` };
      }
    } else {
      // 只有归档 MD:正文取最内层,并且**不写新文件**,md_path 保持不变(断掉自我嵌套的循环)
      mdText = extractResumeBody(readFileSync(archiveSource, "utf8"));
      rearchived = false;
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

    // 写归档 MD(frontmatter + 正文);只有"真原始文件"这条路径才归档
    const archived = rearchived ? writeResumeMd(cfg, candidate, mdText, finalRes) : candidate.md_path;
    // 回填归档 MD 路径(真相源仍在 source_path),并按"extracted→archived"顺序落状态
    updateCandidateProfile(db, candidate.id, finalRes.profile, (() => {
      try { return statSync(originalSource || archiveSource).mtime.toISOString(); } catch { return null; }
    })());
    setCandidateTags(db, candidate.id, tagIds, finalRes.tags);
    db.prepare("UPDATE candidates SET md_path=?, status='archived', updated_at=datetime('now') WHERE id=?").run(archived, candidate.id);

    return {
      id: candidate.id,
      name: candidate.name,
      status: "archived",
      score: finalRes.maxConf?.toFixed?.(2) ?? "-",
      msg: rearchived ? archived : `${archived} (仅重抽正文,未重复归档)`,
    };
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
  const files = collectResumeFiles(folderPath, [archiveDir(cfg)]);
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
  // 防御性剥壳:万一上游还是把归档 MD 当正文传进来,这里也只取最内层真实简历,
  // 保证归档 MD 永远不会互相嵌套(嵌套会让抽取读到上一层 frontmatter 的残留)。
  const body = looksLikeArchiveMd(mdText) ? extractResumeBody(mdText) : String(mdText ?? "");
  const fm = frontmatter({ id: candidate.id, name: candidate.name, raw_hash: candidate.raw_hash, ...(res.profile || {}) });
  const tagsBody = (res.tags || []).map((t) => `${t.tagKey}: ${t.value}`).join("\n");
  const content = `# 候选人 ${candidate.name || ""}\n\n## 标签\n${tagsBody || "(无)"}\n\n## 简历原文\n\n${body}\n`;
  writeFileSync(mdPath, fm + content, "utf8");
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

/** 归档 MD 文件名尾部的历史 id(如 `张三-21.md` → 21),用于"更新的文件优先" */
function archiveFileSeq(filePath) {
  const m = String(basename(filePath)).match(/-(\d+)\.md$/i);
  return m ? Number(m[1]) : 0;
}

/**
 * 同一 raw_hash 有多份归档副本时,新解析的这份是否比现有的更好。
 * 顺序:标签更全 > 非嵌套 > 文件序号更大(更新)。
 */
function isBetterArchiveCopy(newParsed, newFile, curParsed, curFile) {
  const a = (curParsed.tags || []).length;
  const b = (newParsed.tags || []).length;
  if (a !== b) return b > a;
  if (Boolean(curParsed.nested) !== Boolean(newParsed.nested)) return curParsed.nested && !newParsed.nested;
  return archiveFileSeq(newFile) > archiveFileSeq(curFile);
}

function parseResumeMd(filePath) {
  let text;
  try { text = readFileSync(filePath, "utf8"); } catch { return null; }
  const split = splitArchiveMd(text);
  let meta = split?.meta || null;
  if (!meta) {
    // 兼容没有 "## 简历原文" 标记的老归档:退化为只读文件头 frontmatter
    const m = text.match(/^\s*-{3,}\s*\n([\s\S]*?)\n\s*-{3,}\s*(?:\n|$)/);
    if (!m) return null;
    meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
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
  // 先恢复「## 标签」段 —— multi 标签(skill / skill_category / experience_direction 等)
  // 只存在这里,不恢复的话 rebuild 之后技能筛选会全库失效(重建=恢复,不能只恢复一半)。
  for (const { key, value } of split?.tags || []) {
    tags.push({ tagKey: key, value, confidence: 1, source: "manual" });
  }
  for (const [cnKey, tagKey] of Object.entries(FM_TAG_MAP)) {
    if (!meta[cnKey]) continue;
    if (tags.some((t) => t.tagKey === tagKey && t.value === meta[cnKey])) continue;
    tags.push({ tagKey, value: meta[cnKey], confidence: 1, source: "manual" });
  }
  return { meta, profile, tags, nested: isNestedArchiveMd(text) };
}

// ============ 辅助 ============

function currentConfig() {
  // 0.1.7 的 settings 只「投影」不「通知」:面板写入不会重新 apply 本插件(2026-09-26 探针实测),
  // 所以每个入口(工具 / 斜杠命令)都必须重读宿主镜像,否则运行期一直用加载那一刻的旧值。
  syncFromSettings();
  const c = liveConfig || resolveConfig();
  // 强制注入粗分类维度:防止持久化设置里的旧 tags 数组遮蔽新增标签。
  return c ? { ...c, tags: withCoarseTags(c.tags) } : c;
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
    // 这条消息只喂给 ctx.llm.stream({messages}),不写进会话记录 —— v4 的 source kind 门禁本不管它。
    // 仍统一用 v4 的 producer-owned 形态(plugin:<name>),免得日后把它改成注入会话时踩坑。
    source: { kind: "plugin:dsh-resume-screening", form: "instructions" },
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
【口径】experience_years = 工作年限(年),**不是年龄**,两者绝不能混(22 岁不可能有 22 年经验);简历写"应届/在校/无经验"时填 0。
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

/** 硬字段:规则抽取优先,LLM 只补缺(见 mergeExtract) */
const HARD_PROFILE_KEYS = ["age", "gender", "experience_years", "education", "school", "major"];

/** 合并规则 + LLM 结果(硬字段以规则为准,LLM 补缺;语义软标签以 LLM 为准;tags 去重) */
function mergeExtract(ruleRes, llmRes) {
  // 硬字段:**规则优先**。规则是确定性、可复现的;LLM 只补规则没抽到的空位。
  // 旧实现是 {...rule, ...llm},让 LLM 覆盖了硬字段 —— 实测 LLM 会把「年龄 22」填进
  // experience_years,产出"22 岁 22 年经验"这种明显不可能的数据。
  const profile = { ...(llmRes.profile || {}) };
  for (const k of HARD_PROFILE_KEYS) {
    const rv = ruleRes?.profile?.[k];
    if (rv !== undefined && rv !== null && rv !== "") profile[k] = rv;
  }
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
    lines.push(`${String(r.score).padStart(5)} 分  ${r.name || "?"}  ${r.education || ""} ${numText(r.age, "岁")} ${numText(r.experience_years, "年")}  ${matched}  [入库:${fmtDate(r.ingested_at)}]`);
  }
  return lines.join("\n");
}

/** 把 ISO 时间字符串精简为 YYYY-MM-DD HH:MM(取前 16 位),空则返回 "-" */
function fmtDate(v) {
  const s = String(v || "");
  return s.length ? s.replace("T", " ").slice(0, 16) : "-";
}

/**
 * 数值字段的展示文本。0 是**有效值**(应届生 = 0 年经验),不能被当成"没写"而显示成空白:
 * 空白会让 HR 分不清"应届 0 年"和"没抽到年限"。
 */
function numText(v, unit) {
  return v === null || v === undefined || v === "" ? "" : `${v}${unit}`;
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
    const ageText = numText(cand.age, "岁");
    const yearsText = numText(cand.experience_years, "年");
    const candProfile = [
      `姓名:${cand.name}`,
      ageText ? `年龄:${ageText}` : "",
      cand.gender ? `性别:${cand.gender}` : "",
      cand.education ? `学历:${cand.education}` : "",
      yearsText ? `经验:${yearsText}` : "",
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
function collectResumeFiles(root, excludeDirs = []) {
  const exts = new Set([".docx", ".pdf", ".xlsx", ".xls", ".md", ".txt"]);
  const excludes = excludeDirs.filter(Boolean).map((d) => resolve(d));
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    // 跳过归档目录本身及其子目录:归档 MD 是**产物**,不是待入库的简历。
    // 不排除的话,对着简历库根目录跑一次 ingest 就会把自己的产物再吃一遍(嵌套归档的来源)。
    if (excludes.some((ex) => isInsideDir(dir, ex))) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      const ext = extOf(e.name);
      if (!exts.has(ext)) continue;
      // 内容级兜底:别处复制来的归档 MD 也不当简历收(它只有"## 简历原文"段,没有 frontmatter 之外的原始信息)
      if ((ext === ".md" || ext === ".txt") && isArchiveArtifactFile(full)) continue;
      out.push(full);
    }
  }
  return out;
}

/** 文件内容是否是本插件导出的归档 MD */
function isArchiveArtifactFile(filePath) {
  try {
    return looksLikeArchiveMd(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
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
