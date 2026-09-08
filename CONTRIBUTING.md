# Contributing

Thanks for your interest in dsh-resume-screening.

## Design notes

- **Markdown archive = source of truth**; SQLite is a derived searchable index that can be fully rebuilt from the archive (`resume_rebuild`). Never make SQLite the only store.
- **Hard fields belong to rules** (age/gender/education/years/school/major) — deterministic, reproducible, zero LLM cost.
- **Semantic fields belong to the LLM** (skills, coarse categories, project-management hint). Rules only offer a low-confidence fallback; when the LLM fallback succeeds it overrides the rule value for those keys.
- A screening is two-stage: rule pre-filter in the DB (must + weighted nice), then LLM fine-judge only the shortlisted few.
- Coarse tags `skill_category` / `experience_direction` are core dimensions: always injected by `withCoarseTags()` so persisted settings that shadow the default tag list cannot drop them.

## Checks before submitting

```sh
npm run check   # node --check every module
```

Then exercise at least one ingest → process → screen(rule) → screen(llm) round-trip on a small sample.

## Pull requests

Keep one PR per concern, update `CHANGELOG.md`, and state what changed for HR-facing behavior vs internals.
