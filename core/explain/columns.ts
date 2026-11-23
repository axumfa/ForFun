/** Statement ranges inside one source line, for the highlight on sub-line stops. Pure text work; no DOM. */

const OPEN = "({[", CLOSE = ")}]";

/**
 * The statement around DWARF column `col` (1-based, counted in UTF-8 bytes) of `text`, as `[start, end)` character indices; null when the column is
 * missing/0/out of range (the caller then highlights the whole line).
 * GCC reports the column of the *operator* of the statement's expression (`=`, `+=`, the `(` of a call), not of its first token, so the range is
 * widened to the statement's boundaries: `;` `,` `{` `}` or an unmatched bracket at the same nesting depth. A trailing `;` is included.
 * `int a = 1, b = 2;` gives `a = 1` and `b = 2;`; `(a = 5, b = 6, a + b)` gives `a = 5`, ` b = 6`, ` a + b` trimmed. This is a text heuristic, not a parse.
 */
export function statementRange(text: string, col: number | undefined): [number, number] | null {
  if (!col || col < 1) return null;
  const bytes = new TextEncoder().encode(text);
  if (col > bytes.length) return null;
  const at = new TextDecoder().decode(bytes.slice(0, col - 1)).length;       // byte column -> character index
  if (at >= text.length) return null;
  let s = at, depth = 0;
  while (s > 0) {
    const c = text[s - 1]!;
    if (CLOSE.includes(c)) depth++;
    else if (OPEN.includes(c)) { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ";" || c === "," || c === "{" || c === "}")) break;
    s--;
  }
  let e = at; depth = 0;
  while (e < text.length) {
    const c = text[e]!;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === "," || c === "{" || c === "}")) break;
    else if (depth === 0 && c === ";") { e++; break; }
    e++;
  }
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return s < e ? [s, e] : null;
}
