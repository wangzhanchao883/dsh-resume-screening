/**
 * 归档 MD 的读写助手(零依赖,可单测)。
 *
 * 为什么单独抽一层:
 *   归档 MD 既是"产物"又是 rebuild 的"真相源"。一旦把归档产物当原始简历再吃一遍,
 *   就会把整份旧 MD(含 frontmatter / ## 标签 / ## 简历原文)嵌进新 MD 的正文里,
 *   形成 `-4.md → -21.md` 这种嵌套,并让规则抽取读到上一层 frontmatter 的残留
 *   (典型症状:major 被抽成 "---")。所以剥壳逻辑必须集中一处、可复用、可测试。
 *
 * 约定:归档 MD 的形状 = [可选 frontmatter] + "# 候选人 X" + "## 标签" 段 + "## 简历原文" 段。
 */
import { isAbsolute, relative, resolve } from "node:path";

export const BODY_MARKER = "## 简历原文";
export const TAGS_MARKER = "## 标签";

/** 我们自己的 frontmatter 才会用的键;用来把"归档 frontmatter"和简历正文里的分隔线区分开 */
const FM_KEYS = ["id", "name", "raw_hash", "学历", "性别", "年龄", "工作年限", "学校", "专业"];
const FM_KEY_RE = new RegExp(`^\\s*(?:${FM_KEYS.join("|")})\\s*:`, "m");
const DELIM_RE = /^\s*-{3,}\s*$/;
const MAX_FM_LINES = 40;

function fmKeyCount(block) {
  let n = 0;
  for (const line of String(block).split("\n")) {
    if (FM_KEY_RE.test(line)) n += 1;
  }
  return n;
}

/** 这份文本是不是我们生成的归档 MD(而不是原始简历) */
export function looksLikeArchiveMd(text) {
  return String(text ?? "").includes(BODY_MARKER);
}

/**
 * 是不是"嵌套归档"(正文里还套着一份归档 MD)。
 * 这种文件是历史 bug 的产物,rebuild 时应让位给同 raw_hash 的干净文件。
 */
export function isNestedArchiveMd(text) {
  const raw = String(text ?? "");
  return raw.split(BODY_MARKER).length > 2;
}

/**
 * 去掉所有"像我们 frontmatter"的 YAML 块(含嵌套的那一层)。
 * 判据是块内至少 2 个已知键 —— 简历正文里常见的 `---` 分隔线不会被误删。
 */
export function stripFrontmatterBlocks(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (DELIM_RE.test(lines[i])) {
      let close = -1;
      const limit = Math.min(lines.length, i + 1 + MAX_FM_LINES);
      for (let j = i + 1; j < limit; j += 1) {
        if (DELIM_RE.test(lines[j])) { close = j; break; }
      }
      if (close > i && fmKeyCount(lines.slice(i + 1, close).join("\n")) >= 2) {
        i = close + 1; // 整块丢弃
        continue;
      }
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join("\n");
}

/**
 * 取真正的简历正文。
 * 嵌套时取**最内层**的 `## 简历原文`(最内层才是原始简历,外层包着的是上一次的归档产物),
 * 并再次剥掉残留的 frontmatter,保证返回的是干净的简历文本。
 */
export function extractResumeBody(text) {
  let t = String(text ?? "");
  const i = t.lastIndexOf(BODY_MARKER);
  if (i >= 0) t = t.slice(i + BODY_MARKER.length);
  return stripFrontmatterBlocks(t).replace(/^\s*\n/, "").trim();
}

/** 取外层「## 标签」段的 key/value 列表 */
export function parseTagSection(head) {
  const out = [];
  const i = String(head ?? "").indexOf(TAGS_MARKER);
  if (i < 0) return out;
  let sec = head.slice(i + TAGS_MARKER.length);
  const nxt = sec.search(/\n##\s/);
  if (nxt >= 0) sec = sec.slice(0, nxt);
  for (const line of sec.split("\n")) {
    const s = line.trim();
    if (!s || s === "(无)") continue;
    const k = s.indexOf(":");
    if (k <= 0) continue;
    const key = s.slice(0, k).trim();
    const value = s.slice(k + 1).trim();
    if (key && value) out.push({ key, value });
  }
  return out;
}

/**
 * 解析一份归档 MD:meta 取**外层** frontmatter(权威值),tags 取**外层**「## 标签」段,
 * body 取**最内层**正文。不是归档 MD 时返回 null。
 */
export function splitArchiveMd(text) {
  const raw = String(text ?? "").replace(/\r/g, "");
  if (!looksLikeArchiveMd(raw)) return null;

  const meta = {};
  const m = raw.match(/^\s*-{3,}\s*\n([\s\S]*?)\n\s*-{3,}\s*(?:\n|$)/);
  if (m) {
    for (const line of m[1].split("\n")) {
      const k = line.indexOf(":");
      if (k <= 0) continue;
      meta[line.slice(0, k).trim()] = line.slice(k + 1).trim();
    }
  }

  const bodyStart = raw.indexOf(BODY_MARKER);
  const head = bodyStart >= 0 ? raw.slice(0, bodyStart) : raw;
  return { meta, tags: parseTagSection(head), body: extractResumeBody(raw) };
}

/** child 是否位于 parent 目录之内(用于识别"归档目录里的文件") */
export function isInsideDir(child, parent) {
  if (!child || !parent) return false;
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
