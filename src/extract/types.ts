export type SourceFormat = 'csv' | 'xlsx' | 'pdf';

/**
 * The single boundary between extraction and interpretation.
 *
 * Every extractor — CSV, XLS/XLSX, PDF — produces this and nothing else, and
 * the interpreter never sees anything else. That is what keeps a bank's column
 * logic written once even when the same bank ships two formats.
 *
 * Cells are always strings, exactly as they appeared. Type coercion (dates,
 * amounts) belongs to interpretation, not extraction.
 */
export type Table = {
  rows: string[][];
  source: {
    path: string;
    format: SourceFormat;
    /** Sheet name (spreadsheets) or page number (PDF), when meaningful. */
    part?: string;
  };
};
