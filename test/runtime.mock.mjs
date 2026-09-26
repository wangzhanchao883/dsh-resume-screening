/**
 * 回归测试:模拟 DSH 0.1.7-rc.2 的加载契约,真调插件的工具(不连宿主、不联网)。
 *
 * 为什么必须有这个测试:
 *   0.1.7 把 `Config` 的 `.volatile()` 字段解析成 **cosmokit 的 Volatile 盒**(只有 `get()`)。
 *   插件如果直接把配置当纯值用,`path.join(盒, …)` 会抛
 *   `The "path" argument must be of type string ... Received an instance of Object` ——
 *   表现成「面板正常、工具一调就崩」。只验设置面板/契约是发现不了这个的,必须真调一次工具。
 *
 * 覆盖两个已修 bug:
 *   ① 入口配置未解包 volatile 盒  → 所有工具失败(0.1.2 修)
 *   ② settings 写入不触发重新 apply → 运行期一直用旧配置(0.1.2 在每个入口重读 describe())
 *
 * 0.1.3 追加覆盖四个筛选正确性 bug(2026-09-26 用真实简历库挖出,每个都配"反证"用例):
 *   ③ contains 大小写敏感且无词边界 → `Java` 漏判、`JavaScript` 被当成 Java([6][11])
 *   ④ 归档产物被当原始简历再吃一遍 → 归档 MD 互相嵌套、抽取读到上一层 frontmatter([7][9][10])
 *   ⑤ `专业:` 后的 \s* 跨行吞掉 frontmatter 分隔线 → 抽出 major: ---([7])
 *   ⑥ LLM 把年龄填进工作年限且覆盖规则值 → "22 岁 22 年经验"([8][10])
 *   ⑦ rebuild 只读 frontmatter、不读「## 标签」→ 重建后 skill/分类标签全丢([10])
 *
 * 跑法:`npm test`
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { containsLoose } from "../scoring.mjs";
import { ruleExtract } from "../extract.mjs";
import { DEFAULT_CONFIG } from "../config.mjs";

const plugin = await import("../index.mjs");

let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
};

const root = join(tmpdir(), `rsc-mock-${Date.now()}`);
const dirA = join(root, "libA");
const dirB = join(root, "libB");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

/** 复刻宿主:用插件自己的 Config 解析出「带 Volatile 盒」的配置,这就是 apply 真正收到的东西 */
const resolveLikeHost = (patch) => plugin.Config(patch);

/** 假 settings 服务:describe() 返回带盒的解析值,可随时改(模拟面板写入) */
// 注意必须带上 tags:Config 的 tags 字段默认是 [],会把 DEFAULT_CONFIG 的标签字典整体冲掉
// (这是宿主真实注册过的行该有的样子:面板注册时会把默认标签写进设置行)。
const hostRow = (libraryRoot) => ({ libraryRoot, tags: DEFAULT_CONFIG.tags });
let liveRowPatch = hostRow(dirA);
const fakeSettings = {
  describe: () => [{ ns: "dsh-resume-screening", value: resolveLikeHost(liveRowPatch) }],
};

const tools = new Map();
const commands = new Map();
const fakeCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => (typeof fn === "function" ? fn() : undefined),
  on: () => {},
  llm: { stream: () => { throw new Error("本测试不涉及 LLM"); } },
  tools: { register: (def) => tools.set(def.name ?? def.definition?.name, def) },
  commands: { register: (def) => commands.set(def.name, def) },
  inject: (deps, callback) => { if (deps.includes("settings")) callback({ settings: fakeSettings }); },
};

console.log("\n[1] apply(带 Volatile 盒的解析配置)");
const resolvedAtBoot = resolveLikeHost(liveRowPatch);
const rawBox = resolvedAtBoot.libraryRoot;
ok("宿主确实传的是 Volatile 盒(不是纯字符串)", typeof rawBox === "object" && typeof rawBox.get === "function",
  `typeof=${typeof rawBox}`);
// 反证:不 .get() 解包就当路径用,正是线上「所有工具一调就崩」的成因
try {
  join(rawBox, "x");
  ok("反证:未解包的盒当路径用会抛错(本 bug 成因)", false, "居然没抛错?");
} catch {
  ok("反证:未解包的盒当路径用会抛错(本 bug 成因)", true);
}
ok("解包后是纯字符串", typeof rawBox.get() === "string", `=> ${rawBox.get()}`);
try {
  plugin.apply(fakeCtx, resolvedAtBoot);
  ok("apply 不抛异常", true);
} catch (err) {
  ok("apply 不抛异常", false, err.message);
}

console.log("\n[2] 工具注册");
ok("注册了 resume_init", tools.has("resume_init"));
ok("注册了 resume_screen", tools.has("resume_screen"));
ok("工具数量 = 9", tools.size === 9, `实际 ${tools.size}`);
ok("注册了斜杠命令 resume_screen", commands.has("resume_screen"));

console.log("\n[3] 真调 resume_init(未修 bug 时这里会抛 path 参数是对象)");
let initOut = "";
try {
  initOut = await tools.get("resume_init").execute({});
  ok("resume_init 执行成功", typeof initOut === "string" && initOut.includes("简历库已初始化"));
  ok("库 A 的 resume.db 真的建出来了", existsSync(join(dirA, "resume.db")));
  ok("返回文案里的目录是 A", initOut.includes(dirA));
} catch (err) {
  ok("resume_init 执行成功", false, err.message);
}
console.log(`      → ${String(initOut).replace(/\n/g, " | ")}`);

console.log("\n[4] 改设置后立刻生效(不重启、不重新 apply)");
ok("库目录 B 此刻还不存在", !existsSync(dirB));
liveRowPatch = hostRow(dirB);          // 模拟面板写入
let out2 = "";
try {
  out2 = await tools.get("resume_init").execute({});
  ok("第二次 resume_init 成功", typeof out2 === "string");
  ok("用的是新目录 B(说明每个入口都重读了 describe())", existsSync(join(dirB, "resume.db")) && out2.includes(dirB));
} catch (err) {
  ok("第二次 resume_init 成功", false, err.message);
}

console.log("\n[5] resume_status 也能跑(读状态,不经 LLM)");
try {
  const status = await tools.get("resume_status").execute({});
  ok("resume_status 执行成功", typeof status === "string" && status.length > 0);
  console.log(`      → ${String(status).replace(/\n/g, " | ").slice(0, 160)}`);
} catch (err) {
  ok("resume_status 执行成功", false, err.message);
}

console.log("\n[6] Bug③ contains:大小写不敏感 + 拉丁整词边界");
{
  const cases = [
    ["Java", "java", true, "大小写不同必须能命中"],
    ["Java 开发", "java", true, ""],
    ["JavaScript", "java", false, "前端技能不能被当成 Java"],
    ["HTML/CSS/JavaScript", "java", false, "实测误伤场景"],
    ["MySQL", "sql", false, "整词边界的已知代价"],
    ["SQL", "sql", true, ""],
    ["VC++", "c++", true, "含符号的关键词退化为子串"],
    ["数据分析", "数据分析", true, "中文仍按子串"],
    [["Python", "Java"], "java", true, "多值标签数组"],
    [["Python", "JavaScript"], "java", false, "多值标签也不误伤"],
  ];
  for (const [hay, needle, want, note] of cases) {
    ok(`contains ${JSON.stringify(hay)} ⊃ ${needle} = ${want}${note ? ` — ${note}` : ""}`, containsLoose(hay, needle) === want);
  }
  // 反证:复刻修复前的实现(裸 includes,大小写敏感),证明旧行为两个方向都错
  const legacy = (c, t) => String(c).includes(String(t));
  ok("反证:旧实现把 JavaScript 判成 Java(误伤前端)", legacy("HTML/CSS/JavaScript", "Java") === true);
  ok("反证:旧实现漏掉大小写不同的 Java(漏判)", legacy("Java", "java") === false);
}

console.log("\n[7] Bug④⑤ 嵌套归档 MD + 专业跨行吞 ---");
{
  const nested = [
    "---", "id: 4", "name: 试", "raw_hash: h1", "学历: 本科", "性别: 男", "年龄: 29",
    "工作年限: 7", "学校: 陕西职业技术学院", "专业: 计算机应用技术", "---",
    "# 候选人 试", "", "## 标签", "major: ---", "skill: java", "",
    "## 简历原文", "",
    "---", "id: 9", "name: 试", "raw_hash: h1", "专业: ", "---",
    "刘洋", "性别：男  |  年龄：29 岁  |  专业：计算机应用技术",
  ].join("\n");
  const r = ruleExtract(nested, []);
  ok("嵌套 MD 抽出的 major 是真实专业", r.profile.major === "计算机应用技术", `实际 ${JSON.stringify(r.profile.major)}`);
  ok("标签里没有 '---' 脏值", !r.tags.some((t) => t.value === "---"));
  const orphan = ruleExtract("基本信息\n专业: \n---\n籍贯：北京", []);
  ok("'专业:' 为空时不吞掉下一行的分隔线", orphan.profile.major === undefined, `实际 ${JSON.stringify(orphan.profile.major)}`);
}

console.log("\n[8] Bug⑥ 全流程:LLM 故意把年龄(22)填进工作年限");
const root2 = join(root, "pipe");
const srcDir = join(root, "src");
const archDir = join(root2, "archive");
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(srcDir, "应届生-张三.txt"), [
  "张三", "求职意向：C++ 开发工程师", "基本信息",
  "性别：男  |  年龄：22 岁  |  学历：本科  |  工作年限：应届毕业生",
  "毕业院校：陕西科技大学  |  专业：计算机科学与技术", "教育背景",
  "陕西科技大学，计算机科学与技术专业，本科，2022 年 9 月 - 2026 年 6 月", "专业技能",
  "熟悉 C++ 与 Qt 界面开发；了解 Git 与 Linux 基本操作。",
].join("\n"), "utf8");
writeFileSync(join(srcDir, "前端-李四.txt"), [
  "李四", "求职意向：前端开发工程师", "基本信息",
  "性别：女  |  年龄：26 岁  |  学历：本科  |  工作年限：3 年",
  "毕业院校：西安邮电大学  |  专业：软件工程", "专业技能",
  "熟练使用 HTML/CSS/JavaScript 与 Vue 3、TypeScript、React。",
].join("\n"), "utf8");
liveRowPatch = hostRow(root2);

// 假 LLM:按简历人名返回不同档案。张三那份**故意**回 experience_years=22(当年线上就是这么错的)。
let llmCalls = 0;
fakeCtx.llm = {
  stream: async function* (options) {
    llmCalls += 1;
    const prompt = options?.messages?.[0]?.content?.[0]?.text || "";
    let payload;
    if (prompt.includes("李四")) {
      payload = { age: 26, gender: "女", experience_years: 3, education: "本科", school: "西安邮电大学", major: "软件工程", tags: [{ tag: "skill", value: "HTML/CSS/JavaScript" }, { tag: "skill", value: "Vue 3" }] };
    } else if (prompt.includes("张三")) {
      payload = { age: 22, gender: "男", experience_years: 22, education: "本科", school: "陕西科技大学", major: "计算机科学与技术", tags: [{ tag: "skill", value: "C++" }] };
    } else {
      payload = { age: 30, gender: "男", experience_years: 5, education: "本科", school: "西安财经大学", major: "信息管理与信息系统", tags: [{ tag: "skill", value: "SQL" }] };
    }
    yield { type: "text-delta", text: JSON.stringify(payload) };
    yield { type: "finish", reason: { kind: "stop" } };
  },
};

const execCtx = { agent: { options: { provider: "mock-provider", model: "mock-model" } } };
const dbPath = join(root2, "resume.db");
const q = (sql) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try { return d.prepare(sql).all(); } finally { d.close(); }
};
const mdList = () => readdirSync(archDir).filter((f) => f.endsWith(".md"));
const isNested = (p) => readFileSync(p, "utf8").split("## 简历原文").length > 2;

let ing1 = "";
try {
  ing1 = await tools.get("resume_ingest").execute({ folderPath: srcDir });
  ok("入库 2 份原始简历", ing1.includes("新增待处理=2"), ing1.replace(/\n/g, " | "));
} catch (err) { ok("入库 2 份原始简历", false, err.message); }

let proc1 = "";
try {
  proc1 = await tools.get("resume_process").execute({ limit: 10, llm: true }, execCtx);
  ok("处理 2 份成功入库", proc1.includes("成功入库 2"), proc1.replace(/\n/g, " | "));
} catch (err) { ok("处理 2 份成功入库", false, err.message); }

{
  const mds = mdList();
  ok("归档出 2 个 MD", mds.length === 2, `实际 ${mds.length}`);
  ok("归档 MD 之间没有嵌套", mds.every((f) => !isNested(join(archDir, f))));
  const sanFile = mds.find((f) => f.includes("张三"));
  const sanTxt = sanFile ? readFileSync(join(archDir, sanFile), "utf8") : "";
  ok("应届生的 frontmatter 工作年限 = 0(不是 22)", /工作年限: 0\s*$/m.test(sanTxt), sanTxt.split("\n").slice(1, 9).join(" | "));
  const sanRow = q("SELECT name, age, experience_years FROM candidates WHERE name LIKE '%张三%'")[0];
  ok("库里 experience_years = 0", sanRow && Number(sanRow.experience_years) === 0, JSON.stringify(sanRow));
  ok("库里 age 仍是 22(没被年限逻辑带偏)", sanRow && Number(sanRow.age) === 22, JSON.stringify(sanRow));
  ok("LLM 兜底确实被调用了", llmCalls > 0, `调用 ${llmCalls} 次`);
}

console.log("\n[9] Bug④ 对着简历库根目录重扫,不会把 archive 产物当简历");
{
  writeFileSync(join(root2, "王五-数据分析.txt"), [
    "王五", "求职意向：数据分析工程师", "基本信息",
    "性别：男  |  年龄：30 岁  |  学历：本科  |  工作年限：5 年",
    "毕业院校：西安财经大学  |  专业：信息管理与信息系统", "专业技能",
    "熟练使用 SQL 与 Python 做业务报表。",
  ].join("\n"), "utf8");
  const ing2 = await tools.get("resume_ingest").execute({ folderPath: root2 });
  ok("扫描库根目录只看到 1 个真简历(archive 里的 MD 被排除)", ing2.includes("文件=1 份"), ing2.replace(/\n/g, " | "));
  ok("新增待处理=1", ing2.includes("新增待处理=1"));
  const proc2 = await tools.get("resume_process").execute({ limit: 10, llm: true }, execCtx);
  ok("王五入库成功", proc2.includes("成功入库 1"), proc2.replace(/\n/g, " | "));
  ok("归档 MD = 3 个,没有把 archive 产物再归档一遍", mdList().length === 3, `实际 ${mdList().length}`);
}

console.log("\n[10] Bug④⑦ rebuild 恢复标签 + 只有归档 MD 时不重复归档");
{
  const rebuilt = await tools.get("resume_rebuild").execute({});
  ok("rebuild 重建 3 份", rebuilt.includes("已从归档重建 3 份"), rebuilt);
  ok("rebuild 后 source_path 全为空(复现老记录形态)", Number(q("SELECT COUNT(*) n FROM candidates WHERE source_path IS NULL")[0].n) === 3);
  const skillRows = q("SELECT c.name, ct.value FROM candidate_tags ct JOIN tags t ON t.id=ct.tag_id JOIN candidates c ON c.id=ct.candidate_id WHERE t.key='skill'");
  ok("Bug⑦:rebuild 后 skill 标签被恢复(不再只剩硬字段)", skillRows.some((r) => r.value === "C++"), JSON.stringify(skillRows));
  ok("粗分类标签也被恢复", q("SELECT COUNT(*) n FROM candidate_tags ct JOIN tags t ON t.id=ct.tag_id WHERE t.key='skill_category'")[0].n > 0);

  // 复现历史脏记录:source_path 为空、md_path 指向归档 MD —— 当年正是它把产物又吃了一遍
  const legacyMd = join(archDir, "legacy-张三-99.md");
  const srcMd = mdList().find((f) => f.includes("张三"));
  writeFileSync(legacyMd, readFileSync(join(archDir, srcMd), "utf8"), "utf8");
  const w = new DatabaseSync(dbPath);
  w.prepare("INSERT INTO candidates (name, md_path, source_path, raw_hash, status) VALUES (?,?,?,?, 'pending')")
    .run("遗留记录-张三", legacyMd, null, "legacy-hash-1");
  w.close();
  const before = mdList().length;
  const proc3 = await tools.get("resume_process").execute({ limit: 10, llm: true }, execCtx);
  ok("只有归档 MD 时:只重抽正文,不重复归档", proc3.includes("仅重抽正文,未重复归档"), proc3.replace(/\n/g, " | ").slice(0, 220));
  ok("归档 MD 数量没增加(自我嵌套的循环被断掉)", mdList().length === before, `${before} → ${mdList().length}`);
  ok("归档目录里没有任何嵌套 MD", mdList().every((f) => !isNested(join(archDir, f))));
}

console.log("\n[11] Bug③ 端到端:女 + 技能含 Java,不该命中前端");
{
  const rules = tools.get("resume_define_rule");
  const ruleId = (out) => Number(String(out).match(/(\d+)\s*号/)?.[1]);
  const rJava = await rules.execute({
    title: "回归-女且技能含Java",
    items: [
      JSON.stringify({ tag_key: "gender", operator: "=", value: "女", weight: 0, kind: "must" }),
      JSON.stringify({ tag_key: "skill", operator: "contains", value: "Java", weight: 0, kind: "must" }),
    ],
  });
  const outJava = await tools.get("resume_screen").execute({ reqId: ruleId(rJava), top: 20 });
  ok("女 + 技能含 Java → 0 人入围(前端不再被误判成 Java)", outJava.includes("全部满足必选 0 份"), outJava.replace(/\n/g, " | "));

  const rJs = await rules.execute({
    title: "回归-技能含javascript",
    items: [JSON.stringify({ tag_key: "skill", operator: "contains", value: "javascript", weight: 0, kind: "must" })],
  });
  const outJs = await tools.get("resume_screen").execute({ reqId: ruleId(rJs), top: 20 });
  ok("技能含 javascript → 命中 1 人(正向控制:大小写/子串没被修坏)", outJs.includes("全部满足必选 1 份"), outJs.replace(/\n/g, " | "));

  const rCpp = await rules.execute({
    title: "回归-技能含C++",
    items: [JSON.stringify({ tag_key: "skill", operator: "contains", value: "C++", weight: 0, kind: "must" })],
  });
  const outCpp = await tools.get("resume_screen").execute({ reqId: ruleId(rCpp), top: 20 });
  ok("含符号关键词 C++ 仍能命中", outCpp.includes("张三"), outCpp.replace(/\n/g, " | "));
  ok("应届生显示为 0年(不是空白,0 是有效值)", outCpp.includes("0年"), outCpp.replace(/\n/g, " | "));
}

console.log("\n[12] 标签字典兜底:设置行没写 tags 时,默认标签不能被 schema 的空数组冲掉");
{
  // 真实形态:线上 cordis.patch.yml 里这一条只有 `disabled: false`,没有 tags 键,
  // 于是 Config 的 schema 默认值就是最终值。默认若写成 [] → 标签字典只剩 2 个粗分类维度 →
  // skill/education/gender 打不上标签 → 按标签筛选静默返回 0 人(不报错)。
  const bare = join(root, "bare");
  const prev = liveRowPatch;
  liveRowPatch = { libraryRoot: bare };
  const out = await tools.get("resume_init").execute({});
  const n = Number(String(out).match(/标签共 (\d+) 个/)?.[1]);
  ok("新库标签数 ≥ 10(不是只剩 2 个粗分类)", n >= 10, `实际 ${n}`);
  const d = new DatabaseSync(join(bare, "resume.db"), { readOnly: true });
  let keys = [];
  try { keys = d.prepare("SELECT key FROM tags").all().map((r) => r.key); } finally { d.close(); }
  ok("skill 键存在(否则技能永远打不上标签)", keys.includes("skill"), keys.join(","));
  ok("education / gender / age 键都存在", ["education", "gender", "age"].every((k) => keys.includes(k)), keys.join(","));
  liveRowPatch = prev;
}

// 调试用:KEEP=1 时保留临时库现场(默认清理)
if (process.env.KEEP === "1") console.log(`\n[keep] 现场保留在 ${root}`);
else rmSync(root, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "全部通过 ✅" : `失败 ${failures} 项 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
