# Changelog

## [0.1.5] - 2026-10-02

**发布通道迁移 —— 无代码变更、无行为变更。**

改用 npm Trusted Publishing（GitHub Actions + OIDC）发布，不再依赖任何长期令牌。
本版本用于验证新的发布链路，并让该版本带上 provenance（可验证的来源证明）。

## [0.1.4] - 2026-09-29

### 变更 —— 兼容 DSH 0.2

本机在 `0.2.0-rc.1` 实测通过。**无代码变更**,只改 `peerDependencies` 一行。

- **`peerDependencies` 上界抬高**：`@deepseek-ai/dsh-tools` 由
  `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`
  改为 `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`。
  旧上界 `<0.2.0-0` 的语义是「排除 0.2.0 的全部预发布」,而 DSH 门禁拿到的是**整个 DSH 的版本号**,
  于是 0.2.0 上插件在安装期被 `installation rejected`（0.1.7 只在启动期跳过,0.2.0 提前到安装期硬拒）。
- **必须显式写预发布分支**：node-semver 只放行「范围内存在同一 `major.minor.patch` 元组、且自身带
  预发布标签的比较符」的预发布版本。单写 `>=0.1.0-rc.1 <0.3.0-0` 会静默漏掉 `0.2.0-rc.1`,
  所以 `>=0.2.0-rc.1 <0.3.0-0` 这一段必须显式列出。
- **实测结论**：改后可在 `0.2.0-rc.1` 上直接装入并激活,启动无 `skipping`/`did not activate`,
  host 功能（入库 / 建档 / 筛选 / 导出）与浏览器端设置面板均正常。0.1.7 上行为不变。

## [0.1.3] - 2026-09-26

修**筛选正确性**的四个 bug（全是拿真实简历库跑筛时挖出来的，症状都是「静默出错」：
不报错、但结果少人或多人，HR 看不出来）。

### 修复

- **P1：`contains` 大小写敏感且没有词边界 → 漏判 + 误伤。**
  旧实现是裸 `String.includes()`。同一份库、同一个关键词，只改大小写结果就不同：
  写 `java` 命中 3 人（只有规则抽出来的小写 `java` 标签能匹配），写 `Java` 却命中 4 人 ——
  多出来的那个是**前端**，因为 `HTML/CSS/JavaScript` 里含有子串 `Java`。
  修法：新增 `containsLoose()` —— 大小写不敏感 + **拉丁词整词边界**
  （`java` 命中 `Java`/`Java 开发`、不命中 `JavaScript`）；
  needle 含非字母数字时（`c++`、`.net`、`node.js`、中文词）退化为子串匹配，避免把 `VC++` 判丢。
  已知取舍：整词边界让 `sql` 不再命中 `MySQL`，要匹配这种写法请把关键词写全。
- **P2：归档产物被当原始简历再吃一遍 → 归档 MD 互相嵌套。**
  `processOne` 在老记录 `source_path` 为空时回退读 `md_path`，而 `md_path` 是**我们自己写的归档 MD**：
  于是把整份旧归档（含 frontmatter、`## 标签`、`## 简历原文`）当正文再归档一次，
  产出 `-4.md` → `-21.md` 这种嵌套文件；同时 `collectResumeFiles` 会递归进 `archive/`，
  对着简历库根目录跑一次 `resume_ingest` 就把自己的产物当简历收了。
  修法：入库扫描排除归档目录并按内容识别归档产物；只有真原始文件才走「转换 + 归档」，
  只剩归档 MD 时**只重抽正文、不写新文件**；`writeResumeMd` 落盘前再做一次防御性剥壳。
- **P3：`专业:` 后的 `\s*` 能跨行 → 抽出 `major: ---`。**
  旧正则 `(?:专业|主修)\s*[:：]\s*(...)` 里 `\s` 含换行，遇到 frontmatter 里空值的 `专业:`
  就跨到下一行，把 YAML 分隔线 `---` 当成了专业名。
  修法：冒号后只允许同行空白，值里排除 `-`/`#`/各类括号，并校验至少含一个中英文字符。
- **P4：LLM 把年龄填进工作年限，还覆盖了规则抽到的正确值。**
  `mergeExtract` 用 `{...规则, ...LLM}` 合并，LLM 覆盖硬字段；实测 22 岁应届生被写成
  `experience_years: 22`（筛选结果里显示「22 岁 22 年」）。
  修法：① 规则抽取新增「应届/在校/无经验 → 0」，并对年限做合法性校验
  （非负、≤ 60、且必须 < 年龄 − 14，否则整条丢弃而不是留脏值）；
  ② 年龄同样做 14–80 校验；③ 硬字段改为**规则优先、LLM 只补缺**；
  ④ LLM 输出侧同样过一遍校验（性别/学历归一化到枚举）；⑤ 精判提示词里写死「年限不是年龄」。

### 修复（重建路径）

- **`resume_rebuild` 只读 frontmatter、不读「## 标签」段 → 重建后 skill/分类标签全丢。**
  重建 = 恢复数据，但 0.1.2 只恢复了 6 个硬字段，multi 标签（`skill`/`skill_category`/
  `experience_direction`）全部丢失 → 重建之后任何「技能含 X」的筛选都会返回 0，且不报错。
  修法：`parseResumeMd` 从「## 标签」段恢复全部标签；同一 `raw_hash` 有多份副本时
  **优先保留标签更全的那份**（其次非嵌套、最后文件序号大的），报告里带上跳过的副本数。
  只按"非嵌套"择优会选错：实测真实库里干净的那份反而是技能抽坏的老文件（`skill: 技能`）。
- 抽出 `md.mjs`（归档 MD 解析/剥壳，零依赖、可单测）：`splitArchiveMd` / `extractResumeBody` /
  `stripFrontmatterBlocks` / `isNestedArchiveMd` / `isInsideDir`，供 db/extract/index 共用。
- 筛选/精判输出里年限为 0 时显示 `0年` 而不是空白（0 是有效值：应届生）。

### 打包/依赖声明

- `@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 从 `dependencies` 改到
  **`peerDependencies`（+ `peerDependenciesMeta.optional`）**，与已发布的 `dsh-lost-and-found` 一致：
  这两个包由宿主提供（实测宿主树 `D:\MYDSH\node_modules\@deepseek-ai\` 里是
  schemastery 3.18.4 / cosmokit 1.8.5，与本插件开发依赖同版本），放进 `dependencies`
  只会让用户多装一份。第三方包（mammoth / pdfjs-dist / xlsx）仍留在 `dependencies`。
- `package-lock.json` 加入 `.gitignore`：本机 npm 走 npmmirror 镜像，lock 里 65 条 `resolved`
  全指向镜像源，提交到公开仓库会把镜像固化进去（0.1.0 起就没提交过）。

### 修复（配置默认值）

- **P5 潜伏高危：`Config.tags` 的 schema 默认值是 `[]`，会整体冲掉默认标签字典。**
  线上 `cordis.patch.yml` 里这一条只有 `disabled: false`、没有 `tags` 键，所以 schema 默认值就是最终值；
  而 `resolveConfig` 的 `mergeDeep` 对数组是**整体替换、不合并** → `DEFAULT_CONFIG` 的 10 个标签被 `[]` 冲掉，
  `withCoarseTags()` 兜底后**标签字典只剩 2 个粗分类维度**（实测新库「标签共 2 个」）。
  后果：`skill`/`education`/`gender`/`age` 这些键在 `tags` 表里根本不存在 → 所有按标签的筛选
  **静默返回 0 人**。现有库之所以正常，只是因为那 10 行标签是 0.1.1 时代写入的历史数据，
  而 `ensureTags` 只 upsert 不删；**换一个新库就会踩中**。
  修法：默认值改为 `DEFAULT_CONFIG.tags` 的副本。

### 测试

- 回归用例 13 → 56 项，bug 每个都配「反证」用例（复刻修复前的实现，证明它确实错）。
- 新增端到端流水线：入库 → 处理（假 LLM 故意回传 `experience_years: 22`）→ 归档 → 重扫 →
  重建 → 再处理 → 规则筛选，全程断言归档 MD 不嵌套、年限落到 0、rebuild 后技能仍可筛。
- `KEEP=1 npm test` 可保留临时简历库现场用于排查。


## [0.1.2] - 2026-09-26

修 0.1.1 的**致命运行时 bug**。0.1.1 只验了「设置面板链路」，**从没真调过一次工具**，
所以漏掉了下面第一条 —— 装上后 9 个工具**全部一调就崩**。

### 修复

- **P0 致命：volatile 配置没解包 → 所有工具崩。**
  DSH 0.1.7 把标了 `.volatile()` 的字段经 schema 解析后交给 `apply()` 的**不是纯值**，
  而是 cosmokit 的 **Volatile 盒**（冻结对象，只有 `get()`；宿主自己的插件也这么解包，
  如 `dsh-agent-default-model` 的 `this.config.provider.get()`）。
  0.1.1 把 10 个字段全标了 `.volatile()` 却从不 `.get()` → `config.libraryRoot / dbFile / archiveFolder`
  全是对象 → `path.join(对象)` 抛
  `The "path" argument must be of type string ... Received an instance of Object`。
  修法：新增 `unwrap()` / `plainConfig()`（用 `@deepseek-ai/cosmokit` 的 `isVolatile` 判定，
  跨 ESM/CJS 副本也认），在 `apply()` 入口与 `syncFromSettings()` 两处解包；
  `@deepseek-ai/cosmokit` 提为直接依赖。
- **P1：设置改完不生效。** 0.1.1 的注释与 README 都写着「写入由 DSH 侧落盘后触发 Loader 热重载重新 `apply`」——
  **实测为假**：隔离实例探针实测，写入成功落盘（`cordis.patch.yml` 出现新值）但 `apply` **不再执行**。
  0.1.1 只在 apply 时读过一次 `settings.describe()` 并缓存进 `liveConfig` → 面板改完到重启前一直用旧值。
  修法：`currentConfig()` 作为所有入口的唯一出口，每次先 `syncFromSettings()` 重读宿主镜像。
- **P2：读设置失败会把工具带崩。** `syncFromSettings()` 是模块级函数却写了 `ctx.logger.warn`，
  模块作用域没有 `ctx` → 一进 catch 就 `ReferenceError`（把「读设置失败」升级成「崩」）。
  修法：`apply()` 里把 `ctx.logger` 存到模块级 `logger`，并再兜一层 try。
- **P3：面板漏渲染两个可写字段** `llmFallback`、`llmTopN`（0.1.1 新增的 `llmTopN` 之前只能手改 `cordis.patch.yml`）。
- **P4：面板标签显示成「itemWeight·LLM阈值」**（i18n 字典里没有 `itemWeight` 键，是从别的插件抄来的残留）；
  顺手把写死的「批次大小」也改成走字典，并给 `llmFallback/llmTopN/llmThreshold/batchSize` 补齐中英文。

### 新增测试（本次教训的产物）

- `test/runtime.mock.mjs`（`npm test`）：用插件自己的 `Config` 复刻宿主交付的「带 Volatile 盒」配置，
  再**真调 `resume_init` / `resume_status`**，并验证「改设置后不重启即生效」。
  这同一份测试跑在 0.1.1 上会报出线上那个一模一样的 `path` 报错 —— 是「只验面板没验工具」的补课。

### 验证

- `npm run check` 全过；`npm test` 13 项断言全过
- 反向验证：把 0.1.1 的 `index.mjs` 换回去跑同一份测试 → 按预期 FAIL，报错与线上一致
- 真机（DSH 0.1.7-rc.2）：**待重启复验**（宿主侧改动不热更新）

## [0.1.1] - 2026-09-26

适配 DSH 0.1.7 的破坏性契约变更。**功能逻辑零改动**，改的是「配置页面怎么挂上去」这套管道。

### 变更

- **设置面板改走新契约**：删除 `settings.register(ns, schema, {base})` + `scope.get()` + `scope.watch()`
  （0.1.7 的 settings 服务不再替插件托管值，只把插件的 `Config` **投影**成表单）；
  改为**具名导出 `Config`**（`export const Config = z.object({...})`，10 个字段全部标 `.volatile()`），
  读取改走 `settings.describe()`，写入由 DSH 侧落盘后**触发 Loader 热重载**重新 `apply`。
- **前端**：`ctx.settingsScope.bind({ namespace })` → `ctx.configForms.get(条目 id)` —— `settingsScope` 服务在 0.1.7 被**整个移除**；
  inject 同步换名。**组件体未改动**（快照结构 `{status,value,base,user,revision,writable,mode}` 两版一致）。
- **`dsh.client.inject`** 删除 `@deepseek-ai/dsh-client-runtime`（0.1.7 不存在此包）。
- **运行时依赖** `@deepseek-ai/schemastery` `^3.18.1` → `^3.18.4`（`.volatile()` 需 3.18.4；
  旧版上加了降级包装 `vol()`,保证模块加载不崩）。
- **LLM 调用消息**的 source kind 改为 v4 的 `plugin:dsh-resume-screening`
  （该消息只喂 `ctx.llm.stream({messages})`、不写进会话，v4 门禁本不管它；统一形态以防日后改为注入会话时踩坑）。
- **删除死代码**：`index.mjs` 与 `config.mjs` 各有一份 `toFlat`/`fromFlat` —— 后者从未被 import，
  前者随注册块一起废弃；两者都漏了新字段 `llmTopN`,早已过时。

### 验证

- `npm run check` 通过
- 复刻 DSH 的 `volatileForm()`：10 字段全部盖章 → 返回**正常表单**（面板不会被静默过滤）
- 复刻 `write()` 的 `isVolatilePath` 校验：10 字段**全部可写**（不会抛 `not volatile`）
- peer 区间 `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0` 实测满足 `0.1.7-rc.2` → **无需修改**

### 兼容性

设置面板需 DSH 0.1.7+；旧版 DSH 上 host 功能照常（见 README「环境要求」）。

> ⚠️ **2026-09-26 事后修正**：上面「验证」一节与本节只覆盖了**设置面板链路**，**没真调过一次工具**。
> 实际 0.1.1 在 DSH 上 9 个工具全部一调就崩（volatile 未解包），且「写入触发重新 apply」的假设不成立。
> 两处都已在 [0.1.2] 修复 —— 结论：**面板通了 ≠ 插件能用，验收必须真调一次工具。**

## [0.1.0] - 2026-09-08

- 简历批量入库: docx/pdf/xlsx/xls/md/txt → 统一 Markdown 归档, 内容 hash 去重
- 结构化建档: 学历/性别/年龄/年限/学校/专业(规则) + 细粒度技能(LLM) + 粗分类(技能类别/经验方向)
- 入库时间 `ingested_at` / 源文件修改时间 `source_mtime` 记录与展示
- 两段式筛选: 库内规则粗筛(MUST/NICE 加权) + LLM 精判(0-100 适配分/结论档位/命中技能/缺口/硬字段复核)
- 岗位条件复用: `resume_define_rule` 保存条件, 一键复筛
- 自动入库: `resume_screen(folderPath=...)` 先入库未收录的新简历再整体筛选
- SQLite 物化索引可 `resume_rebuild` 全量重建; 结果可导出 CSV
- LLM 走 DSH 标准流式接口(复用当前对话模型, 结构化调用关闭思维链控成本)
