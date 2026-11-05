# PoC v2: address-keyed heap graph per step, alloc tracking via shim, diff -> events.
import gdb, json, os
SRC = "list.cpp"; LOG = os.path.abspath("alloc.log"); OUT = open("trace2.jsonl", "w")
open(LOG, "w").close()
allocs = {}   # base -> {"size", "state"}
logpos = 0
def read_log():
    global logpos
    with open(LOG) as f:
        f.seek(logpos); data = f.read(); logpos = f.tell()
    for ln in data.splitlines():
        op, a, n = (ln.split() + ["0"])[:3]; a = int(a, 16)
        if op == "A": allocs[a] = {"size": int(n), "state": "LIVE"}
        elif op == "F" and a in allocs: allocs[a]["state"] = "FREED"
def find_alloc(addr):
    for b, i in allocs.items():
        if b <= addr < b + max(i["size"], 1): return b, i
    return None, None
def hx(a): return hex(a)

def classify(addr):
    if addr == 0: return "null", None, 0
    b, i = find_alloc(addr)
    if b is None: return "unresolved", None, 0   # stack/global/garbage: never claimed as heap object
    return ("object" if i["state"] == "LIVE" else "freed"), b, addr - b

def read_obj(base, ty, objs, depth=0):
    """Read struct at base into objs (only LIVE objects are read; FREED ones are not trusted)."""
    if hx(base) in objs: return
    fields = {}
    objs[hx(base)] = {"type": str(ty), "state": "LIVE", "fields": fields}
    try: v = gdb.Value(base).cast(ty.pointer()).dereference()
    except gdb.error as e: objs[hx(base)]["state"] = "UNREADABLE"; return
    for f in ty.strip_typedefs().fields():
        if not f.name or f.is_base_class: continue
        fields[f.name] = read_val(v[f.name], objs)

def read_val(v, objs):
    t = v.type.strip_typedefs()
    if t.code == gdb.TYPE_CODE_PTR:
        a = int(v); kind, base, off = classify(a)
        r = {"ptr": hx(a), "kind": kind}
        if kind == "object":
            r["obj"] = hx(base); r["offset"] = off
            tt = t.target().strip_typedefs()
            if tt.code == gdb.TYPE_CODE_STRUCT and off == 0: read_obj(base, t.target(), objs)
        elif kind == "freed": r["obj"] = hx(base)
        return r
    if t.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_CHAR): return int(v)
    return str(v)

def snapshot():
    read_log(); objs = {}; frames = []
    f = gdb.newest_frame()
    while f is not None:
        sal = f.find_sal()
        if sal.symtab and sal.symtab.filename.endswith(SRC):
            loc = {}
            try:
                b = f.block()
                while b and not b.is_global:
                    for s in b:
                        if s.is_variable or s.is_argument:
                            loc[s.name] = read_val(s.value(f), objs) if s.type.strip_typedefs().code in (gdb.TYPE_CODE_PTR, gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL) else str(s.value(f))
                    if b.function: break
                    b = b.superblock
            except gdb.error: pass
            frames.append({"fn": f.name(), "line": sal.line, "locals": loc})
        f = f.older()
    for b, i in allocs.items():                      # freed objects are listed but contents not trusted
        if i["state"] == "FREED": objs.setdefault(hx(b), {"type": "?", "state": "FREED", "fields": {}})
    return {"frames": frames, "objects": objs}

step = 0
def emit(ev):
    global step; ev["schema"] = 1; ev["step"] = step; step += 1; OUT.write(json.dumps(ev) + "\n")

def diff(old, new):
    for a, o in new["objects"].items():
        p = old["objects"].get(a)
        if p is None or p["state"] != o["state"]:
            if o["state"] == "LIVE": emit({"type": "object_created", "addr": a, "obj_type": o["type"]})
            elif o["state"] == "FREED" and (p is None or p["state"] == "LIVE"): emit({"type": "object_freed", "addr": a})
        if p and o["state"] == "LIVE" and p["state"] == "LIVE":
            for k, v in o["fields"].items():
                if p["fields"].get(k) != v: emit({"type": "field_changed", "addr": a, "field": k, "old": p["fields"].get(k), "new": v})
    of = old["frames"][0]["locals"] if old["frames"] else {}
    nf = new["frames"][0]["locals"] if new["frames"] else {}
    for k, v in nf.items():
        if of.get(k) != v and old["frames"] and new["frames"] and old["frames"][0]["fn"] == new["frames"][0]["fn"]:
            emit({"type": "local_changed", "var": k, "old": of.get(k), "new": v})

gdb.execute("set pagination off"); gdb.execute("set confirm off")
gdb.execute("set environment LD_PRELOAD=" + os.path.abspath("libshim.so"))
gdb.execute("set environment DSV_ALLOC_LOG=" + LOG)
gdb.execute("break main"); gdb.execute("run", to_string=True)
prev = {"frames": [], "objects": {}}
while step < 5000:
    try:
        sal = gdb.selected_frame().find_sal()
        if not (sal.symtab and sal.symtab.filename.endswith(SRC)):
            gdb.execute("finish", to_string=True); continue
        cur = snapshot()
        emit({"type": "line", "fn": cur["frames"][0]["fn"], "line": sal.line, "depth": len(cur["frames"])})
        diff(prev, cur); prev = cur
        gdb.execute("step", to_string=True)
    except gdb.error: break
OUT.close(); print("events:", step)
