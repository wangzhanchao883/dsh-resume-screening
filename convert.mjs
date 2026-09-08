/**
 * 格式转换层:Word / PDF / Excel → Markdown。
 * 确定性工具链,免费、快、可复现,是抽取的"第 1 层"输入。
 * docx → mammoth;pdf → pdfjs-dist(文本层);xlsx → SheetJS 转 MD 表格。
 * 转换产物 = 归档 MD 的正文来源;扫描件/图片型 PDF 本版转成"仅提示待人工/OCR"。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** 分派到对应转换器,返回 { markdown, meta } */
export async function convertFile(filePath) {
  const ext = extOf(filePath);
  switch (ext) {
    case ".docx":
      return convertDocx(filePath);
    case ".pdf":
      return convertPdf(filePath);
    case ".xlsx":
    case ".xls":
      return convertXlsx(filePath);
    case ".md":
    case ".txt":
      return { markdown: readFileSync(filePath, "utf8"), meta: { ext } };
    default:
      return { markdown: `[警告] 暂不支持转换的格式:${basename(filePath)}(${ext})`, meta: { ext, unsupported: true } };
  }
}

export function extOf(p) {
  const m = /(\.[a-zA-Z0-9]+)$/.exec(p);
  return m ? m[1].toLowerCase() : "";
}

async function convertDocx(filePath) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return { markdown: result.value || "", meta: { ext: ".docx" } };
}

async function convertPdf(filePath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str || "").join(" ");
    text += `\n\n--- 第 ${i} 页 ---\n\n${pageText}`;
  }
  const noText = text.replace(/\s+/g, "").length < 10;
  if (noText) {
    return {
      markdown: `[警告] 这份 PDF 没有文本层(疑似扫描件/图片)。本阶段请走 OCR 或人工查看原文件:${basename(filePath)}`,
      meta: { ext: ".pdf", scanned: true },
    };
  }
  return { markdown: text, meta: { ext: ".pdf", scanned: false } };
}

async function convertXlsx(filePath) {
  const XLSX = await import("xlsx");
  const wb = XLSX.readFile(filePath);
  const mdParts = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    mdParts.push(`\n### 工作表:${sheetName}\n`);
    mdParts.push(mdTable(rows));
  }
  return { markdown: mdParts.join("\n"), meta: { ext: ".xlsx" } };
}

function mdTable(rows) {
  if (!rows.length) return "(空表)";
  const width = Math.max(...rows.slice(0, 100).map((r) => r.length), 1);
  const header = rows[0] || [];
  const lines = [];
  lines.push(`| ${Array(width).fill("").join(" | ")} |`);
  lines.push(`|${" --- |".repeat(width)}`);
  for (const r of rows.slice(1, 200)) {
    const cells = Array.from({ length: width }, (_, i) => cell(String(r[i] ?? "")));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function cell(s) {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
