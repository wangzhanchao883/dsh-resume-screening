import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * 简历筛选大师 DSH 插件配置。
 * 持久化位置 ~/.dsh-resume-screening/config.json。
 * 核心思想:MD 归档做真相源 + SQLite 做筛选加速层(物化索引,可随时从 MD 全量重建)。
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // 简历库根目录:归档 MD + resume.db + tags 都放这里;一个文件夹 = 完整简历库
  libraryRoot: "D:\\简历库",
  // 归档子目录(原始简历 md + 转换后的 md + profile.json)
  archiveFolder: "archive",
  // 是否保留原始文件(转换后是否删掉原始 docx/pdf/xlsx)
  keepOriginal: true,
  // 数据库文件名(SQLite 单文件,放 libraryRoot 下)
  dbFile: "resume.db",
  // 标签库:预置常用简历标签,可在 Web 面板增改(每个:key/label/type/description)
  // type: enum | number | boolean | text
  tags: [
    { key: "education", label: "学历", type: "enum", description: "最高学历,如 本科/硕士/博士" },
    { key: "gender", label: "性别", type: "enum", description: "男/女;未写则标未知" },
    { key: "age", label: "年龄", type: "number", description: "周岁,从出生年份或自述年龄推" },
    { key: "experience_years", label: "工作经验", type: "number", description: "总工作年限(年)" },
    { key: "school", label: "学校", type: "text", description: "毕业院校(最高学历院校)" },
    { key: "major", label: "专业", type: "text", description: "所学专业,如 计算机科学与技术/软件工程" },
    { key: "project_management", label: "项目管理经验", type: "text", description: "语义软标签:从工作职责/项目经历识别,如'独立负责过XX项目'" },
    { key: "skill", label: "技能", type: "text", description: "专业技能关键字,如 Python/Java/数据分析", multi: true },
    { key: "skill_category", label: "技能类别", type: "text", description: "粗分类技能:计算机/财务/金融/管理/外贸/销售等(多值)", multi: true },
    { key: "experience_direction", label: "经验方向", type: "text", description: "粗分类工作经验方向:编程开发/财务会计/管理/外贸/数据分析等(多值)", multi: true },
  ],
  // 置信度阈值:低于此转 LLM 兜底(规则解析拿不准)
  llmConfidenceThreshold: 0.6,
  // LLM 兜底开关(规则解析抓不到语义软标签时启用)
  llmFallback: true,
  // 批量处理批次大小(每批 N 份,控制内存与进度)
  batchSize: 50,
  // LLM 精判:粗筛后对入围候选逐份读原文精判,取前 N 名;0 = 全部精判(小批量用)
  llmTopN: 20,
});

/** 核心粗分类维度:不受持久化设置遮蔽,始终注入。 */
export const CORE_COARSE_TAGS = [
  { key: "skill_category", label: "技能类别", type: "text", description: "粗分类技能:计算机/财务/金融/管理/外贸/销售等(多值)", multi: true },
  { key: "experience_direction", label: "经验方向", type: "text", description: "粗分类工作经验方向:编程开发/财务会计/管理/外贸/数据分析等(多值)", multi: true },
];

/** 保证粗分类标签一定在 tags 列表里(按 key 去重,缺则补)。 */
export function withCoarseTags(tags) {
  const arr = Array.isArray(tags) ? tags.slice() : [];
  const keys = new Set(arr.map((t) => t && t.key));
  for (const ct of CORE_COARSE_TAGS) {
    if (!keys.has(ct.key)) arr.push({ ...ct });
  }
  return arr;
}

export function configDir() {
  return join(homedir(), ".dsh-resume-screening");
}
export function configPath() {
  return join(configDir(), "config.json");
}

/** 合并默认 + 配置文件 + 运行时入参(插件行 config 覆盖最高) */
export function resolveConfig(input = {}) {
  let file = {};
  try {
    if (existsSync(configPath())) {
      file = JSON.parse(readFileSync(configPath(), "utf8"));
    }
  } catch {
    file = {};
  }
  const merged = mergeDeep(structuredClone(DEFAULT_CONFIG), file);
  const final = mergeDeep(merged, input);
  // 粗分类标签是核心维度:持久化设置里的旧 tags 数组会整体覆盖默认 tags,导致新增维度丢失。
  // 这里强制注入,保证 skill_category / experience_direction 始终存在。
  final.tags = withCoarseTags(final.tags);
  return final;
}

export function saveConfig(config) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

/** 插件嵌套结构 → 扁平 settings 结构(client set() 只支持单段路径) */
export function toFlat(config) {
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
    llmTopN: config.llmTopN,
  };
}

/** 扁平 settings 结构 → 插件嵌套结构 */
export function fromFlat(flat) {
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
    llmTopN: flat.llmTopN,
  };
}

function mergeDeep(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] =
      typeof v === "object" && v !== null && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null
        ? mergeDeep(out[k], v)
        : v;
  }
  return out;
}
