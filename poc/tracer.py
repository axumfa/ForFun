# PoC: single-step a real process under GDB, emit structured events (JSONL).
# Run: gdb -q -batch -x tracer.py ./list
import gdb, json, sys

OUT = open("trace.jsonl", "w")
step = 0
heap = {}          # addr -> (type, {field: value}) last seen
prev_locals = {}

def val_repr(v, depth=0):
    t = v.type.strip_typedefs()
    try:
        if t.code == gdb.TYPE_CODE_PTR:
            return {"ptr": hex(int(v))}
        if t.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_CHAR):
            return int(v)
        if t.code == gdb.TYPE_CODE_STRUCT and depth < 2:
            return {f.name: val_repr(v[f.name], depth+1) for f in t.fields() if f.name}
    except gdb.error as e:
        return {"error": str(e)}
    return str(v)

def deref_heap(v):
    """Follow pointer-to-struct; return fields of pointee, or None."""
    t = v.type.strip_typedefs()
    if t.code != gdb.TYPE_CODE_PTR or int(v) == 0: return None
    tt = t.target().strip_typedefs()
    if tt.code != gdb.TYPE_CODE_STRUCT: return None
    try: return val_repr(v.dereference())
    except gdb.error: return None

def emit(ev):
    global step
    ev["step"] = step; step += 1
    OUT.write(json.dumps(ev) + "\n")

gdb.execute("set pagination off")
gdb.execute("set confirm off")
gdb.execute("break main")
gdb.execute("run", to_string=True)
depth_stack = [gdb.selected_frame().name()]
MAX = 2000
while step < MAX:
    frame = gdb.selected_frame()
    sal = frame.find_sal()
    if not sal.symtab or not sal.symtab.filename.endswith("list.cpp"):
        try: gdb.execute("finish", to_string=True)
        except gdb.error: break
        continue
    # snapshot locals
    cur = {}
    try:
        blk = frame.block()
        while blk and not blk.is_global:
            for s in blk:
                if s.is_variable or s.is_argument:
                    v = s.value(frame)
                    cur[s.name] = {"type": str(s.type), "value": val_repr(v), "pointee": deref_heap(v)}
            if blk.function: break
            blk = blk.superblock
    except gdb.error: pass
    changes = {k: v for k, v in cur.items() if prev_locals.get(k) != v}
    emit({"type": "line", "function": frame.name(), "line": sal.line,
          "depth": sum(1 for _ in iter(lambda f=[frame]: (f.__setitem__(0, f[0].older()) or f[0]), None)) if False else None,
          "changed": changes})
    prev_locals = cur
    try: gdb.execute("step", to_string=True)
    except gdb.error: break
    if not gdb.selected_inferior().pid: break
OUT.close()
print("steps:", step)
