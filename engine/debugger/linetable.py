"""DWARF line rows for sub-line stepping (M9), read with the vendored pyelftools (engine/vendor/pyelftools, Python >= 3.10).
GDB's own line table drops the rows that carry a discriminator (the 2nd+ statement with a call, loop parts) and has no columns; the raw rows have both.
Pure Python, no gdb import: unit-tested on binaries compiled by the tests (tests/substep.test.ts). Any failure (pyelftools not importable, no DWARF line
program, unreadable file) raises and the tracer falls back to per-line reads with the reason in the end record."""
import bisect, json, os, re, sys

class ParseError(Exception): pass

def _elftools():
    here = os.path.dirname(os.path.abspath(__file__))
    v = os.path.join(here, "..", "vendor", "pyelftools")
    if v not in sys.path: sys.path.insert(0, v)
    try:
        from elftools.elf.elffile import ELFFile
        return ELFFile
    except Exception as e: raise ParseError("pyelftools not importable (needs Python >= 3.10): %s" % (e,))

def read_rows(path):
    """-> list of (addr, file_basename, line|None, is_stmt, column, discriminator) in line-program order; line None = end of sequence.
    Addresses are as in the ELF file (not relocated). Raises ParseError when the file cannot be read as an ELF with DWARF line information."""
    ELFFile = _elftools()
    rows = []
    try:
        with open(path, "rb") as f:
            dw = ELFFile(f).get_dwarf_info()
            for cu in dw.iter_CUs():
                lp = dw.line_program_for_CU(cu)
                if lp is None: continue
                files, ver = lp["file_entry"], lp["version"]
                for e in lp.get_entries():
                    st = e.state
                    if st is None: continue
                    i = st.file if ver >= 5 else st.file - 1
                    if not 0 <= i < len(files): raise ParseError("row refers to file index %d of %d" % (st.file, len(files)))
                    name = os.path.basename(files[i].name.decode("utf8", "replace"))
                    rows.append((st.address, name, None if st.end_sequence else st.line, bool(st.is_stmt) or st.end_sequence, st.column, st.discriminator))
    except ParseError: raise
    except Exception as e: raise ParseError("cannot read DWARF line table of %s: %s: %s" % (os.path.basename(path), type(e).__name__, e))
    if not rows: raise ParseError("no DWARF line rows (compiled without -g?)")
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
    def col(self, addr, fname, line):
        """Column (1-based) of the statement row containing `addr` for (file, line); 0 when none or the compiler gave no column."""
        i = bisect.bisect_right(self.addrs, addr) - 1
        return self.rows[i][4] if i >= 0 and self.rows[i][1] == fname and self.rows[i][2] == line else 0
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
if __name__ == "__main__" and sys.argv[1:2] == ["rows"]:      # test hook: `linetable.py rows BINARY BASENAME` -> {"lines": {line: [[addr, column, discriminator], ...]}} or {"error"}
    try: rows = read_rows(sys.argv[2])
    except ParseError as e: print(json.dumps({"error": str(e)})); sys.exit(0)
    out = {}
    for a, f, l, st, c, d in rows:
        if f == sys.argv[3] and l is not None and st: out.setdefault(str(l), []).append([a, c, d])
    print(json.dumps({"lines": out}))
