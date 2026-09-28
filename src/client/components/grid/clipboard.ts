/**
 * A block of cells copied from Excel or Google Sheets, as the clipboard's plain text holds it:
 * tab-separated cells, one line per row. A cell with a line break, a tab or a quote in it is
 * wrapped in double quotes, its own quotes doubled, so its line break is not a new row. The
 * line break after the last row only ends the block.
 */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  if (!n) return rows;
  let row: string[] = [];
  let i = 0;
  for (;;) {
    // One cell: quoted (line breaks inside are the cell's own, stored as \n) or up to the next tab or line break.
    const close = text[i] === '"' ? closingQuote(text, i) : -1;
    if (close >= 0) {
      row.push(text.slice(i + 1, close).replace(/""/g, '"').replace(/\r\n?/g, "\n"));
      i = close + 1;
    } else {
      let j = i;
      while (j < n && text[j] !== "\t" && text[j] !== "\n" && text[j] !== "\r") j++;
      row.push(text.slice(i, j));
      i = j;
    }
    if (i >= n) break;
    if (text[i] === "\t") {
      i++;
      continue;
    }
    // A line break (\r\n from Windows, \n, or a lone \r) ends the row; after the last row, the block.
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) return rows;
  }
  rows.push(row);
  return rows;
}

/**
 * One cell as the clipboard's text, the way Excel writes it: quoted, its quotes doubled, when it
 * holds a line break, a tab or a quote, so pasting it back (here or in Excel) keeps it one cell.
 */
export function clipboardCell(text: string): string {
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The closing quote of a quoted cell that opens at `start`: the first quote that is not
 * doubled, when a tab, a line break or the end follows it. -1 when the text only starts with a
 * quote (`"Quoted" text`, from a program that does not quote cells): it is read as it is.
 */
function closingQuote(text: string, start: number): number {
  let i = start + 1;
  for (;;) {
    const q = text.indexOf('"', i);
    if (q < 0) return -1;
    if (text[q + 1] === '"') {
      i = q + 2;
      continue;
    }
    const next = text[q + 1];
    return next === undefined || next === "\t" || next === "\n" || next === "\r" ? q : -1;
  }
}
