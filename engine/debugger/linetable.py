"""DWARF line rows for sub-line stepping (M9), parsed from `objdump --dwarf=decodedline`.
GDB's own line table drops the rows that carry a discriminator (the 2nd+ statement with a call, loop parts), so the raw rows are read here.
Pure Python, no gdb import: unit-tested on fixtures (tests/linetable.test.ts). The parser is strict: any line it does not recognise raises
ParseError and the tracer falls back to per-line reads (never a partial table). pyelftools was rejected: not installed with gdb's Python and a new dependency."""
import bisect, json, os, re, sys

class ParseError(Exception): pass

ROW = re.compile(r"^(?P<f>\S+)\s+(?P<l>\d+|-)\s+(?P<a>0x[0-9a-fA-F]+)(?:\s+(?P<v>\d+|x))?(?:\s+(?P<s>x))?\s*$")
IGNORED = (re.compile(r"^\S.*: +file format \S+$"), re.compile(r"^Contents of the \.debug_line section:$"), re.compile(r"^File name\s+Line number\s+Starting address"),
           re.compile(r"^CU: .*:$"), re.compile(r"^\S[^\s]*:$"))

def parse(text):
    """-> list of (addr, file_basename, line|None, is_stmt) in objdump order; line None = end of sequence. `is_stmt` is True when the column is absent (old binutils)."""
    rows, has_stmt_col = [], "Stmt" in text
    for n, raw in enumerate(text.splitlines(), 1):
        s = raw.strip()
        if not s or any(p.match(s) for p in IGNORED): continue
        m = ROW.match(s)
        if not m: raise ParseError("line %d not understood: %r" % (n, raw[:80]))
        v, st = m.group("v"), m.group("s")
        if v == "x": v, st = None, "x"                          # `x` in the view column: the old layout without views
        rows.append((int(m.group("a"), 16), os.path.basename(m.group("f")), None if m.group("l") == "-" else int(m.group("l")), (st == "x") if has_stmt_col else True))
    if not rows: raise ParseError("no line rows")
    return rows

def strip_comments(line):
    """The line without `// ...` and `/* ... */` (an unterminated `/*` runs to the end of the line); string and char literals are left alone."""
    out, i, n, q = [], 0, len(line), None
    while i < n:
        c = line[i]
        if q:
            out.append(c)
            if c == "\\" and i + 1 < n: out.append(line[i + 1]); i += 1
            elif c == q: q = None
        elif c in "\"'": q = c; out.append(c)
        elif line.startswith("//", i): break
        elif line.startswith("/*", i):
            j = line.find("*/", i + 2)
            if j < 0: break
            out.append(" "); i = j + 1
        else: out.append(c)
        i += 1
    return "".join(out)

HEAD = re.compile(r"^(?:for|while)\b\s*\(")
def is_loop_header(line):
    """True for a source line that holds only a `for`/`while` header (the body is on other lines): its rows are the loop's own init/condition/increment, whose
    stops repeat the first body line's state. `for (...) { body; }` with the body on the same line is False. Also True for the continuation line of a header
    split over several lines (`  i < n; i++) {`). Comments are ignored; this is a text check on the user's source (parens inside literals are skipped)."""
    code = strip_comments(line).strip()
    m, depth, i, closed = HEAD.match(code), 0, 0, False
    if m: i = m.end() - 1
    while i < len(code):
        c = code[i]
        if c in "\"'":
            j = i + 1
            while j < len(code) and code[j] != c: j += 2 if code[j] == "\\" else 1
            i = j
        elif c == "(": depth += 1
        elif c == ")":
            depth -= 1
            if depth <= 0 and (m or depth < 0): closed = True; break
        i += 1
    if not (m or closed): return False
    if not closed: return True                              # header continues on the next line
    return code[i + 1:].strip() in ("", "{")

class Table:
    def __init__(self, rows):
        r = sorted((x for x in rows if x[3] or x[2] is None), key=lambda x: x[0])      # statement rows + end markers, by address (stable)
        self.rows, self.addrs = r, [x[0] for x in r]
    def after(self, addr, fname, line):
        """Addresses of the rows following the row that contains `addr`, while they stay on the same (file, line): the statements of one source line.
        Empty when the row containing addr is not that line or the line has no further row."""
        i = bisect.bisect_right(self.addrs, addr) - 1
        if i < 0 or self.rows[i][1] != fname or self.rows[i][2] != line: return []
        out, j = [], i + 1
        while j < len(self.rows) and self.rows[j][1] == fname and self.rows[j][2] == line:
            if self.rows[j][0] > self.rows[i][0] and (not out or out[-1] != self.rows[j][0]): out.append(self.rows[j][0])
            j += 1
        return out
    def file_rows(self, fname): return {(r[2], r[0]) for r in self.rows if r[1] == fname and r[2] is not None}

def find_bias(gdb_rows, table, fname):
    """Load bias (runtime pc - DWARF address) such that every row GDB knows for the file exists in the table: validates the parse and handles PIE.
    gdb_rows = [(line, pc)]. None when no consistent bias exists (then the file is not sub-stepped)."""
    have, g = table.file_rows(fname), [(l, p) for l, p in gdb_rows if l]
    if not g or not have: return None
    for a in [a for l, a in have if l == g[0][0]]:
        b = g[0][1] - a
        if all((l, p - b) in have for l, p in g): return b
    return None

if __name__ == "__main__" and sys.argv[1:2] == ["header"]:     # test hook: linetable.py header 'source line' -> JSON
    print(json.dumps({"header": is_loop_header(sys.argv[2])})); sys.exit(0)
if __name__ == "__main__":      # test hook: linetable.py FILE BASENAME LINE ADDR -> JSON of table.after(); or `check FILE` to exercise the strict parser
    t = sys.argv[1]
    try: rows = parse(open(t).read())
    except ParseError as e: print(json.dumps({"error": str(e)})); sys.exit(0)
    if len(sys.argv) == 2: print(json.dumps({"rows": len(rows)})); sys.exit(0)
    print(json.dumps({"after": Table(rows).after(int(sys.argv[4], 0), sys.argv[2], int(sys.argv[3]))}))
