/* dsh-resume-screening client bundle — 浏览器半端(Web 设置页)。
 * 经典脚本形式注册到 window.__ModuleLoader__;工厂内用 require 取 React,
 * 不能用 JSX(无构建步骤),一律 React.createElement。
 * 与 dsh-study-notebook 的 client.js 同款模式。
 * 面板目标:让用户一眼看懂怎么用 —— 通用配置 + 标签库 + 岗位要求(必选/最好有 + 权重 + 说明文案)。
 * DSH 0.1.7 契约:设置读写走 ctx.configForms.get(条目 id) —— 旧的 ctx.settingsScope 服务已被整个移除;
 * 快照结构与旧版一致({status,value,base,user,revision,writable,mode}),故组件体无需改动。 */
window.__ModuleLoader__.load({
  id: "dsh-resume-screening",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = "settings.resumeScreening";
    const SETTINGS_NAMESPACE = "dsh-resume-screening";

    const zh = {
      nav: "简历筛选大师",
      loading: "正在读取配置…",
      unavailable: "配置面板不可用(设置服务未挂载)。请直接编辑配置文件。",
      saved: "已保存",
      error: "保存失败:",
      general: "通用",
      enabled: "启用插件",
      libraryRoot: "简历库根目录",
      libraryRootHint: "归档 MD + resume.db + 标签库都在这里;一个文件夹 = 完整简历库",
      archiveFolder: "归档子目录",
      keepOriginal: "保留原始文件",
      dbFile: "数据库文件名",
      llmThreshold: "LLM 兜底置信度阈值",
      llmFallback: "启用 LLM 兜底抽取",
      llmTopN: "LLM 精判数量(0=全部精判)",
      batchSize: "批次大小",
      tags: "标签库",
      tagsHint: "标签是筛选的基本单位,每个标签带类型(enum枚举/number数值/text文本)。必选条件必须从标签库里选。",
      addTag: "添加标签",
      tagKey: "标签键",
      tagLabel: "显示名",
      tagType: "类型",
      tagDesc: "说明文案",
      tagMulti: "多值",
      remove: "移除",
      requirements: "岗位要求",
      requirementsHint: "一个岗位一组筛选条件:必选=刚性硬条件(全部满足才入选),最好有=加分项(命中一项 + 权重分)。最终按加分总分降序排序。",
    };

    const en = {
      nav: "Resume Screening",
      loading: "Reading configuration…",
      unavailable: "Configuration panel unavailable (settings service not mounted). Edit the config file directly instead.",
      saved: "Saved",
      error: "Save failed:",
      general: "General",
      enabled: "Enable plugin",
      libraryRoot: "Library root",
      libraryRootHint: "Archive MD + resume.db + tags live here; one folder = one complete library",
      archiveFolder: "Archive folder",
      keepOriginal: "Keep original files",
      dbFile: "DB filename",
      llmThreshold: "LLM fallback confidence threshold",
      llmFallback: "Enable LLM fallback extraction",
      llmTopN: "LLM judge count (0 = judge all)",
      batchSize: "Batch size",
      tags: "Tag library",
      tagsHint: "Tags are the screening unit; each has a type (enum/number/text). Must-conditions pick from the tag library.",
      addTag: "Add tag",
      tagKey: "Tag key",
      tagLabel: "Label",
      tagType: "Type",
      tagDesc: "Description",
      tagMulti: "Multi-value",
      remove: "Remove",
      requirements: "Job requirements",
      requirementsHint: "One job = one set of conditions: MUST (hard filter) + NICE (weighted scoring, each hit adds weight). Rank by total score desc.",
    };

    const STYLES = [
      ".rsc-config{max-width:760px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}",
      ".rsc-group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2)}",
      ".rsc-group h3{margin:0 0 12px;font-size:13px;font-weight:600}",
      ".rsc-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}",
      ".rsc-field label{font-size:12px;font-weight:500}",
      ".rsc-field input[type=text],.rsc-field input[type=number],.rsc-field select,.rsc-field textarea{height:30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:0 8px;font:inherit;font-size:13px;box-sizing:border-box;width:100%}",
      ".rsc-field textarea{height:auto;min-height:34px;padding:6px 8px;resize:vertical}",
      ".rsc-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".rsc-switch{display:flex;align-items:center;gap:8px;margin-bottom:6px}",
      ".rsc-switch input{accent-color:var(--dsw-alias-state-business-primary)}",
      ".rsc-status{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px}",
      ".rsc-row{display:flex;gap:12px;flex-wrap:wrap}",
      ".rsc-row .rsc-field{flex:1;min-width:120px}",
      ".rsc-tag,.rsc-bucket{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px;position:relative}",
      ".rsc-x{position:absolute;align-self:end;background:none;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;margin-top:-4px}",
      ".rsc-add{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px}",
      ".rsc-item{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;margin-bottom:8px;display:flex;flex-direction:column;gap:8px}",
      ".rsc-kind{display:flex;gap:8px;align-items:center}",
      ".rsc-kind label{font-size:12px}",
      ".rsc-item .rsc-row{flex-wrap:nowrap}",
    ].join("");

    function Field({ label, hint, children }) {
      return h("div", { className: "rsc-field" },
        h("label", null, label),
        children,
        hint ? h("div", { className: "rsc-hint" }, hint) : null,
      );
    }

    function TextInput({ value, onCommit, placeholder }) {
      const [draft, setDraft] = useState(value ?? "");
      useEffect(() => setDraft(value ?? ""), [value]);
      return h("input", {
        type: "text", value: draft, placeholder,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => { if (draft !== (value ?? "")) onCommit(draft); },
        onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
      });
    }

    function NumInput({ value, onCommit, min, max, step }) {
      const [draft, setDraft] = useState(String(value ?? ""));
      useEffect(() => setDraft(String(value ?? "")), [value]);
      const commit = () => {
        const n = Number(draft);
        if (Number.isFinite(n) && n !== value) onCommit(n);
        else setDraft(String(value ?? ""));
      };
      return h("input", {
        type: "number", min, max, step, value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
      });
    }

    function Select({ value, options, onCommit }) {
      const [draft, setDraft] = useState(value ?? "");
      useEffect(() => setDraft(value ?? ""), [value]);
      return h("select", {
        value: draft,
        onChange: (e) => { setDraft(e.target.value); onCommit(e.target.value); },
      }, options.map((o) => h("option", { value: o.value, key: o.value }, o.label)));
    }

    const OPERATORS = [
      { value: "=", label: "等于" },
      { value: "!=", label: "不等于" },
      { value: ">=", label: "大于等于" },
      { value: "<=", label: "小于等于" },
      { value: ">", label: "大于" },
      { value: "<", label: "小于" },
      { value: "in", label: "属于(逗号分隔)" },
      { value: "contains", label: "包含" },
    ];
    const TYPES = [
      { value: "enum", label: "枚举" },
      { value: "number", label: "数值" },
      { value: "boolean", label: "布尔" },
      { value: "text", label: "文本" },
    ];

    function ConfigSection({ scope, t }) {
      const [snap, setSnap] = useState(() => scope.getSnapshot());
      const [status, setStatus] = useState("");
      const statusTimer = useRef(null);
      useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
      useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);
      const flash = (msg) => {
        setStatus(msg);
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus(""), 2500);
      };
      const save = (field, v) => {
        Promise.resolve(scope.set(field, v))
          .then(() => flash(t("saved")))
          .catch((err) => flash(`${t("error")} ${err && err.message ? err.message : String(err)}`));
      };

      if (snap.status === "loading") return h("p", { className: "rsc-status" }, t("loading"));
      if (snap.status === "unavailable") return h("p", { className: "rsc-status" }, t("unavailable"));
      const v = snap.value || {};

      const tags = v.tags || [];
      const setTags = (next) => save("tags", next);
      const updateTag = (i, patch) => setTags(tags.map((x, idx) => idx === i ? { ...x, ...patch } : x));
      const addTag = () => setTags([...tags, { key: "", label: "", type: "enum", description: "", multi: false }]);
      const removeTag = (i) => setTags(tags.filter((_, idx) => idx !== i));

      return h("div", { className: "rsc-config" }, [
        // 0) 一句话说明,让用户一眼看懂
        h("div", { className: "rsc-group" }, [
          h("div", { className: "rsc-hint" }, "用法:先在「标签库」配置你关心的标签 → 在「岗位要求」建一个岗位(必选=硬门槛,最好有=加分项) → 导入简历后叫 AI 执行筛选。"),
        ]),

        // 1) 通用
        h("div", { className: "rsc-group" }, [
          h("h3", null, t("general")),
          h("div", { className: "rsc-switch" }, [
            h("input", {
              type: "checkbox", id: "rsc-enabled",
              checked: !!v.enabled,
              onChange: (e) => save("enabled", e.target.checked),
            }),
            h("label", { htmlFor: "rsc-enabled" }, t("enabled")),
          ]),
          Field({
            label: t("libraryRoot"), hint: t("libraryRootHint"),
            children: h(TextInput, { value: v.libraryRoot || "", onCommit: (val) => save("libraryRoot", val) }),
          }),
          h("div", { className: "rsc-row" }, [
            Field({
              label: t("archiveFolder"),
              children: h(TextInput, { value: v.archiveFolder || "", onCommit: (val) => save("archiveFolder", val) }),
            }),
            Field({
              label: t("dbFile"),
              children: h(TextInput, { value: v.dbFile || "", onCommit: (val) => save("dbFile", val) }),
            }),
          ]),
          h("div", { className: "rsc-switch" }, [
            h("input", {
              type: "checkbox", id: "rsc-keep",
              checked: !!v.keepOriginal,
              onChange: (e) => save("keepOriginal", e.target.checked),
            }),
            h("label", { htmlFor: "rsc-keep" }, t("keepOriginal")),
          ]),
          h("div", { className: "rsc-switch" }, [
            h("input", {
              type: "checkbox", id: "rsc-llm-fallback",
              checked: !!v.llmFallback,
              onChange: (e) => save("llmFallback", e.target.checked),
            }),
            h("label", { htmlFor: "rsc-llm-fallback" }, t("llmFallback")),
          ]),
          h("div", { className: "rsc-row" }, [
            Field({
              label: t("llmThreshold"),
              children: h(NumInput, { value: v.llmConfidenceThreshold, min: 0, max: 1, step: 0.1, onCommit: (n) => save("llmConfidenceThreshold", n) }),
            }),
            Field({
              label: t("llmTopN"),
              children: h(NumInput, { value: v.llmTopN, min: 0, max: 10000, onCommit: (n) => save("llmTopN", n) }),
            }),
            Field({
              label: t("batchSize"),
              children: h(NumInput, { value: v.batchSize, min: 1, max: 1000, onCommit: (n) => save("batchSize", n) }),
            }),
          ]),
        ]),

        // 2) 标签库
        h("div", { className: "rsc-group" }, [
          h("h3", null, t("tags")),
          h("div", { className: "rsc-hint" }, t("tagsHint")),
          tags.length === 0 ? h("div", { className: "rsc-hint" }, "尚未配置标签") : tags.map((tg, i) =>
            h("div", { className: "rsc-tag", key: i }, [
              h("button", { className: "rsc-x", onClick: () => removeTag(i) }, t("remove")),
              h("div", { className: "rsc-row" }, [
                Field({ label: t("tagKey"), children: h(TextInput, { value: tg.key || "", onCommit: (val) => updateTag(i, { key: val }) }) }),
                Field({ label: t("tagLabel"), children: h(TextInput, { value: tg.label || "", onCommit: (val) => updateTag(i, { label: val }) }) }),
                Field({
                  label: t("tagType"),
                  children: h(Select, { value: tg.type || "enum", options: TYPES, onCommit: (val) => updateTag(i, { type: val }) }),
                }),
              ]),
              Field({
                label: t("tagDesc"), hint: "向用户解释这个标签从简历哪里抽、怎么判",
                children: h("textarea", {
                  value: tg.description || "",
                  onChange: (e) => updateTag(i, { description: e.target.value }),
                }),
              }),
              h("label", { className: "rsc-switch" }, [
                h("input", { type: "checkbox", checked: !!tg.multi, onChange: (e) => updateTag(i, { multi: e.target.checked }) }),
                t("tagMulti"),
              ]),
            ])
          ),
          h("button", { className: "rsc-add", onClick: addTag }, t("addTag")),
        ]),

        // 3) 岗位要求(存 SQLite,由对话工具 resume_define_rule 管理;面板无 host 工具通道,故此处仅提示)
        h("div", { className: "rsc-group" }, [
          h("h3", null, t("requirements")),
          h("div", { className: "rsc-hint" }, t("requirementsHint")),
          h("div", { className: "rsc-hint" }, "岗位要求请直接在对话里告诉 AI(如「定义一个 JAVA 工程师岗,本科以上、会 Java」),AI 会通过 resume_define_rule 存进简历库,再用 resume_screen 按岗位 id 执行筛选。"),
        ]),

        h("div", { className: "rsc-status" }, status),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dsh-resume-screening");
        tag.textContent = STYLES;
        document.head.appendChild(tag);
        return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
      }, "dsh-resume-screening: styles");

      ctx.effect(() => {
        return ctx.locale.register(NS, { zh, en });
      }, "dsh-resume-screening: dictionaries");

      const t = ctx.locale.bind(NS);
      // 0.1.7:ctx.settingsScope 已被整个移除 → 改为向 configForms 取该 profile 条目的表单。
      // 入参是「条目 id」(= cordis.patch.yml 里的 id),不是 locale 命名空间;返回对象的
      // getSnapshot()/subscribe()/set(field,value)/mutate() 与旧的 scope 同名同义。
      const scope = ctx.configForms.get(SETTINGS_NAMESPACE);
      const injected = () => ({ scope });

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "resume-screening",
        order: 265,
        label: () => t("nav"),
        locale: NS,
        inject: injected,
      }, ConfigSection));
    }

    module.exports = {
      name: "dsh-resume-screening",
      inject: ["slots", "locale", "configForms"],
      apply,
    };
    return module.exports;
  },
});
