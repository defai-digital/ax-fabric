/**
 * Convert HTML to Markdown-formatted text.
 * Preserves headings, tables, lists, and emphasis.
 * Used by HtmlExtractor and DocxExtractor.
 */
export function htmlToMarkdown(html: string): string {
  // Process block elements first, then inline
  let text = html;

  // Remove script, style, nav, header, footer
  text = text.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Headings
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Tables: convert to Markdown pipe tables
  text = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, tableContent: string) => {
    return convertTableToMarkdown(tableContent);
  });

  // Lists
  text = text.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_match, listContent: string) => {
    return convertListToMarkdown(listContent, "ul");
  });
  text = text.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_match, listContent: string) => {
    return convertListToMarkdown(listContent, "ol");
  });

  // Paragraphs and line breaks
  text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n");

  // Inline formatting
  text = text.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  text = text.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
  text = text.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  text = text.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Clean up whitespace: collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

function convertTableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];

  // Extract rows
  const rowMatches = tableHtml.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
  for (const rowHtml of rowMatches) {
    const cells: string[] = [];
    const cellMatches = rowHtml.match(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) ?? [];
    for (const cellHtml of cellMatches) {
      const cellText = cellHtml.replace(/<[^>]+>/g, "").trim();
      cells.push(cellText);
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return "";

  // Build Markdown table
  const maxCols = Math.max(...rows.map(r => r.length));
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    // Pad row to max columns
    while (row.length < maxCols) row.push("");
    lines.push("| " + row.join(" | ") + " |");

    // Add separator after first row (header)
    if (i === 0) {
      lines.push("| " + row.map(() => "---").join(" | ") + " |");
    }
  }

  return "\n" + lines.join("\n") + "\n";
}

function convertListToMarkdown(listHtml: string, type: "ul" | "ol"): string {
  const items: string[] = [];
  const itemMatches = listHtml.match(/<li\b[^>]*>([\s\S]*?)<\/li>/gi) ?? [];
  for (let i = 0; i < itemMatches.length; i++) {
    const text = itemMatches[i]!.replace(/<[^>]+>/g, "").trim();
    const prefix = type === "ul" ? "- " : `${i + 1}. `;
    items.push(prefix + text);
  }
  return "\n" + items.join("\n") + "\n";
}
