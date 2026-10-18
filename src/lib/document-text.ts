/**
 * Browser-side readable-text extraction for PDF and DOCX evidence documents.
 * Heavy parsers are imported dynamically so they never enter the SSR bundle.
 */

export const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
export const DOC_ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function documentKind(file: File): "pdf" | "docx" | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    return "docx";
  }
  return null;
}

export interface ExtractionResult {
  text: string;
  pages?: number;
}

async function extractPdf(file: File): Promise<ExtractionResult> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const chunks: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (line) chunks.push(line);
  }
  const pages = doc.numPages;
  return { text: chunks.join("\n\n").trim(), pages };
}

async function extractDocx(file: File): Promise<ExtractionResult> {
  const mammoth = (await import("mammoth/mammoth.browser.js")) as unknown as {
    extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
  };
  const buffer = await file.arrayBuffer();
  const out = await mammoth.extractRawText({ arrayBuffer: buffer });
  return { text: String(out.value ?? "").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Extracts readable text, throwing a user-facing message when it cannot. */
export async function extractDocumentText(file: File): Promise<ExtractionResult> {
  const kind = documentKind(file);
  if (!kind) throw new Error("Unsupported file type. Upload a PDF or a Word (.docx) document.");
  if (file.size > MAX_DOC_BYTES) throw new Error("The document exceeds the 10 MB limit.");
  if (file.size === 0) throw new Error("This document is empty.");

  const result = kind === "pdf" ? await extractPdf(file) : await extractDocx(file);
  if (!result.text) {
    throw new Error(
      kind === "pdf"
        ? "No readable text could be extracted. This PDF appears to be scanned or image-only; text recognition is not available in this prototype."
        : "No readable text could be extracted from this document.",
    );
  }
  return result;
}

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}
