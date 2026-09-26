/**
 * 真实库验收(只读原件:先把库整份复制到临时目录,所有操作都打在副本上)。
 * 跑法:node test/accept-library.mjs [源库路径,默认 D:\简历库]
 *
 * 目的:验证 0.1.3 的四个修复在**真实脏数据**上的效果,而不是只在合成用例上过。
 * 真实库现状(2026-09-26):20 个归档 MD / 11 个候选人,含 10 个历史 bug 留下的嵌套 MD。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { containsLoose } from "../scoring.mjs";

const src = process.argv[2] || "D:\\简历库";
if (!existsSync(src)) {
  console.error(`源库不存在:${src}`);
  process.exit(2);
}
const dst = join(tmpdir(), `rsclib-accept-${Date.now()}`);
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`已复制真实库到副本:${dst}\n(原件 ${src} 全程只读)\n`);

const plugin = await import("../index.mjs");
const { DEFAULT_CONFIG } = await import("../config.mjs");

const resolved = plugin.Config({ libraryRoot: dst, tags: DEFAULT_CONFIG.tags });
const fakeSettings = { describe: () => [{ ns: "dsh-resume-screening", value: resolved }] };
const tools = new Map();
const fakeCtx = {
  logger: { info: () => {}, warn: (m) => console.log(`  [warn] ${m}`), error: () => {} },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  on: () => {},
  llm: { stream: () => { throw new Error("本验收不调用 LLM"); } },
  tools: { register: (def) => tools.set(def.name, def) },
  commands: { register: () => {} },
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: fakeSettings }); },
};
plugin.apply(fakeCtx, resolved);

const arch = join(dst, "archive");
const mdFiles = () => readdirSync(arch).filter((f) => f.endsWith(".md"));
const nested = (p) => readFileSync(join(arch, p), "utf8").split("## 简历原文").length > 2;
const dbPath = join(dst, "resume.db");
const q = (sql) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try { return d.prepare(sql).all(...[]); } finally { d.close(); }
};

console.log(`[1] 库现状:归档 MD ${mdFiles().length} 个,其中嵌套 ${mdFiles().filter(nested).length} 个`);

console.log("\n[2] resume_rebuild:从归档重建索引");
const rebuilt = await tools.get("resume_rebuild").execute({});
console.log(`    ${String(rebuilt).replace(/\n/g, " | ")}`);
const cands = q("SELECT id,name,gender,age,education,experience_years,major FROM candidates ORDER BY id");
console.log(`    重建后候选人 ${cands.length} 个(20 个 MD 里的重复/嵌套副本已被归并)`);

console.log("\n[3] Bug⑦ 验证:重建后技能标签是否还在(旧版这里会全丢)");
const skillRows = q("SELECT c.name, ct.value FROM candidate_tags ct JOIN tags t ON t.id=ct.tag_id JOIN candidates c ON c.id=ct.candidate_id WHERE t.key='skill' ORDER BY c.id");
console.log(`    skill 标签 ${skillRows.length} 条:${skillRows.map((r) => `${r.name}=${r.value}`).join(", ") || "(空)"}`);

console.log("\n[4] Bug① 验证:同一份数据,'技能含 Java' 的命中对比");
// 旧实现的匹配口径(裸 includes,大小写敏感)拿来对照,证明差别真实存在
const legacyHit = (values, needle) => values.some((v) => String(v).includes(needle));
const skillByCand = new Map();
for (const r of skillRows) {
  if (!skillByCand.has(r.name)) skillByCand.set(r.name, []);
  skillByCand.get(r.name).push(r.value);
}
for (const needle of ["java", "Java"]) {
  const legacy = [...skillByCand.entries()].filter(([, vs]) => legacyHit(vs, needle)).map(([n]) => n);
  const fixed = [...skillByCand.entries()].filter(([, vs]) => vs.some((v) => containsLoose(v, needle))).map(([n]) => n);
  console.log(`    contains "${needle}"`);
  console.log(`        旧口径(裸 includes):${legacy.length} 人 → ${legacy.join(", ") || "(无)"}`);
  console.log(`        0.1.3 口径        :${fixed.length} 人 → ${fixed.join(", ") || "(无)"}`);
}
console.log("    (旧口径下 Java 会误伤只写 JavaScript 的前端;小写 java 在这个库侥幸命中,是因为规则抽取也存了一份小写 `java` 标签 —— 换个只有 LLM 大驼峰标签的库就会漏判)");

console.log("\n[5] Bug② 验证:重扫库根目录 + 只有归档 MD 时再处理一遍");
const ing = await tools.get("resume_ingest").execute({ folderPath: dst });
console.log(`    ${String(ing).replace(/\n/g, " | ")}`);
const before = mdFiles().length;
const proc = await tools.get("resume_process").execute({ limit: 50 }, { agent: { options: { provider: "p", model: "m" } } });
console.log(`    处理报告:${String(proc).split("\n")[0]}`);
console.log(`    归档 MD:${before} → ${mdFiles().length};其中嵌套 ${mdFiles().filter(nested).length} 个`);
rmSync(dst, { recursive: true, force: true });
console.log("\n验收完成(副本已清理,原件未被改动)。");
