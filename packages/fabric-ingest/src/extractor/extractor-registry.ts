import { extname } from "node:path";
import { CsvExtractor } from "./csv-extractor.js";
import { DocxExtractor } from "./docx-extractor.js";
import { JsonExtractor } from "./json-extractor.js";
import { MdExtractor } from "./md-extractor.js";
import { PdfExtractor } from "./pdf-extractor.js";
import { PptxExtractor } from "./pptx-extractor.js";
import { TxtExtractor } from "./txt-extractor.js";
import { XlsxExtractor } from "./xlsx-extractor.js";
import { YamlExtractor } from "./yaml-extractor.js";
import type { Extractor } from "./extractor.js";

/**
 * Maps file extensions to Extractor instances.
 * Extensions are stored normalised to lower-case with leading dot.
 */
export class ExtractorRegistry {
  private readonly map = new Map<string, Extractor>();

  /** Register an extractor for a file extension (e.g. ".pdf"). */
  register(extension: string, extractor: Extractor): void {
    const key = normaliseExt(extension);
    this.map.set(key, extractor);
  }

  /** Look up the extractor for a file path based on its extension. */
  getExtractor(filePath: string): Extractor | undefined {
    const ext = normaliseExt(extname(filePath));
    return this.map.get(ext);
  }

  /** Return all registered extensions, sorted alphabetically. */
  getSupportedExtensions(): string[] {
    return [...this.map.keys()].sort();
  }
}

/**
 * Create a registry pre-loaded with all default extractors.
 */
export function createDefaultRegistry(): ExtractorRegistry {
  const registry = new ExtractorRegistry();

  const txt = new TxtExtractor();
  const pdf = new PdfExtractor();
  const docx = new DocxExtractor();
  const pptx = new PptxExtractor();
  const xlsx = new XlsxExtractor();
  const csv = new CsvExtractor();
  const json = new JsonExtractor();
  const md = new MdExtractor();
  const yaml = new YamlExtractor();

  registry.register(".txt", txt);
  registry.register(".pdf", pdf);
  registry.register(".docx", docx);
  registry.register(".pptx", pptx);
  registry.register(".xlsx", xlsx);
  registry.register(".csv", csv);
  registry.register(".json", json);
  registry.register(".md", md);
  registry.register(".markdown", md);
  registry.register(".yaml", yaml);
  registry.register(".yml", yaml);

  return registry;
}

function normaliseExt(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}
