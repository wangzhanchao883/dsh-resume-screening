# Changelog

## [0.1.0] - 2026-09-08

- 简历批量入库: docx/pdf/xlsx/xls/md/txt → 统一 Markdown 归档, 内容 hash 去重
- 结构化建档: 学历/性别/年龄/年限/学校/专业(规则) + 细粒度技能(LLM) + 粗分类(技能类别/经验方向)
- 入库时间 `ingested_at` / 源文件修改时间 `source_mtime` 记录与展示
- 两段式筛选: 库内规则粗筛(MUST/NICE 加权) + LLM 精判(0-100 适配分/结论档位/命中技能/缺口/硬字段复核)
- 岗位条件复用: `resume_define_rule` 保存条件, 一键复筛
- 自动入库: `resume_screen(folderPath=...)` 先入库未收录的新简历再整体筛选
- SQLite 物化索引可 `resume_rebuild` 全量重建; 结果可导出 CSV
- LLM 走 DSH 标准流式接口(复用当前对话模型, 结构化调用关闭思维链控成本)
