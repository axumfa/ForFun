"""GDB backend: single-steps a -O0 -g debuggee and writes trace schema v2 (JSONL).
Run:  gdb -q -batch -x gdb_tracer.py --args ./prog    with DSV_* env vars (see CONFIG).
Principle: every value written here was read from the debuggee's memory; nothing is inferred or invented."""
import gdb, json, os, re, signal, threading, time

SCHEMA = 2
E = os.environ
MAX_STEPS = int(E.get("DSV_MAX_STEPS", "20000"))
STALL_SECONDS = float(E.get("DSV_STALL_SECONDS", "3"))      # max wall time inside ONE gdb `step`
MAX_OBJECTS = int(E.get("DSV_MAX_OBJECTS", "3000"))
MAX_ELEMS = 512
SRC = os.path.realpath(E["DSV_SRC"])
DRIVER = os.path.realpath(E["DSV_DRIVER"]) if E.get("DSV_DRIVER") else None
OUT = open(E["DSV_OUT"], "w")
LOG = E["DSV_ALLOC_LOG"]
open(LOG, "w").close()

allocs = {}        # base -> {"size", "state"}
known = {}         # base -> gdb.Type of element/struct (learned the first time a typed pointer reaches it)
double_frees = []
logpos = 0
hx = hex

def tname(ty):
    """One spelling per type. A struct/union/enum with a tag is named by its tag however it was reached ("struct Node", "Node", or a
    typedef of it); an anonymous one (`typedef struct {...} Name;`) is named by the typedef, which only the UNSTRIPPED type still has."""
    try:
        st = ty.strip_typedefs().unqualified()
        if st.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION, gdb.TYPE_CODE_ENUM) and st.name: return st.name
    except gdb.error: pass
    return re.sub(r"\b(struct|union|enum)\s+(?=\w)", "", str(ty))

def read_log():
    global logpos
    with open(LOG) as f:
        f.seek(logpos); data = f.read(); logpos = f.tell()
    for ln in data.splitlines():
        p = ln.split()
        if len(p) < 2: continue
        a = int(p[1], 16)
        if p[0] == "A": allocs[a] = {"size": int(p[2]), "state": "LIVE"}; known.pop(a, None)
        elif p[0] == "R":     # realloc: R old new size. The learned type follows the block, whether it grew in place or moved.
            new = int(p[2], 16); ty = known.get(a) if a else None
            if a and a != new and a in allocs: allocs[a]["state"] = "FREED"      # moved: the old block is freed (keeps its type, like free())
            allocs[new] = {"size": int(p[3]), "state": "LIVE"}
            if a != new: known.pop(new, None)
            if ty is not None: known[new] = ty
        elif p[0] == "F":
            if a in allocs and allocs[a]["state"] == "FREED": double_frees.append(hx(a))
            if a in allocs: allocs[a]["state"] = "FREED"

def find_alloc(addr):
    stale = (None, None)
    for b, i in allocs.items():
        if b <= addr < b + max(i["size"], 1):
            if i["state"] == "LIVE": return b, i
            if stale[0] is None: stale = (b, i)     # a freed block may overlap memory reused by a live one: live wins
    return stale

def classify(addr):
    if addr == 0: return "null", None, 0
    b, i = find_alloc(addr)
    if b is None: return "unresolved", None, 0
    return ("object" if i["state"] == "LIVE" else "freed"), b, addr - b

def is_vector(t):
    n = t.name or str(t)
    return n.startswith("std::vector<") and not n.startswith("std::vector<bool")

def addr_of(v):
    try: return hx(int(v.address))
    except Exception: return None

def read_struct_fields(v, t, objs, depth):
    fields = {}
    for f in t.fields():
        if f.is_base_class:
            fields.update(read_struct_fields(v[f], f.type.strip_typedefs(), objs, depth)); continue
        if f.name and not hasattr(f, "enumval"):
            if f.bitpos is None: continue            # static member
            fields[f.name] = read_val(v[f.name], objs, depth + 1)
    return fields

def read_heap(base, ty, objs):
    """Read the heap allocation at base as struct (typed pointer) or array (scalar/pointer element type)."""
    key = hx(base)
    if key in objs: return
    info = allocs[base]; known[base] = ty
    tt = ty.strip_typedefs()
    ent = {"type": tname(ty), "state": "LIVE", "size": info["size"]}
    objs[key] = ent
    try:
        p = gdb.Value(base).cast(ty.pointer())
        if tt.code == gdb.TYPE_CODE_STRUCT or tt.code == gdb.TYPE_CODE_UNION:
            if info["size"] >= tt.sizeof and tt.sizeof > 0 and info["size"] // tt.sizeof > 1:   # new T[n] of structs
                n = min(info["size"] // tt.sizeof, MAX_ELEMS)
                ent["type"] = tname(ty) + "[]"; ent["elems"] = [read_val((p + i).dereference(), objs, 1) for i in range(n)]
            else: ent["fields"] = read_struct_fields(p.dereference(), tt, objs, 0)
        else:
            sz = max(tt.sizeof, 1); n = min(info["size"] // sz, MAX_ELEMS)
            ent["type"] = tname(ty) + "[]"; ent["elems"] = [read_val((p + i).dereference(), objs, 1) for i in range(n)]
    except gdb.error as e:
        ent["state"] = "UNREADABLE"; ent["error"] = str(e)

def read_val(v, objs, depth=0):
    try:
        t = v.type.strip_typedefs()
        if t.code == gdb.TYPE_CODE_REF or t.code == gdb.TYPE_CODE_RVALUE_REF:
            return read_val(v.referenced_value(), objs, depth)
        if t.code == gdb.TYPE_CODE_PTR:
            a = int(v); kind, base, off = classify(a)
            r = {"ptr": hx(a), "kind": kind, "to": tname(t.target())}
            if kind in ("object", "freed"): r["obj"] = hx(base)
            if kind == "object":
                r["offset"] = off
                tt = t.target().strip_typedefs()
                if off == 0 and tt.code != gdb.TYPE_CODE_VOID and tt.code != gdb.TYPE_CODE_FUNC and len(objs) < MAX_OBJECTS:
                    read_heap(base, t.target(), objs)
            return r
        if t.code == gdb.TYPE_CODE_ENUM: return str(v)
        if t.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR): return int(v)
        if t.code == gdb.TYPE_CODE_BOOL: return bool(v)
        if t.code == gdb.TYPE_CODE_FLT: return float(v)
        if t.code == gdb.TYPE_CODE_ARRAY:
            lo, hi = t.range(); n = min(hi - lo + 1, MAX_ELEMS)
            r = {"kind": "array", "elemType": tname(t.target()), "elems": [read_val(v[lo + i], objs, depth + 1) for i in range(n)]}
            if addr_of(v): r["addr"] = addr_of(v)
            return r
        n = t.name or tname(v.type)
        if t.code == gdb.TYPE_CODE_STRUCT and is_vector(t) and depth < 6:
            st, fi = v["_M_impl"]["_M_start"], v["_M_impl"]["_M_finish"]
            cap = int(v["_M_impl"]["_M_end_of_storage"] - st)
            cnt = min(int(fi - st), MAX_ELEMS)
            if int(st) != 0 and classify(int(st))[0] != "object":      # storage released/unknown: do not read it
                return {"kind": "vector", "elemType": str(t.template_argument(0)), "capacity": 0, "elems": [], "released": True}
            r = {"kind": "vector", "elemType": str(t.template_argument(0)), "capacity": cap,
                 "elems": [read_val((st + i).dereference(), objs, depth + 1) for i in range(cnt)]}
            if addr_of(v): r["addr"] = addr_of(v)
            return r
        if "basic_string" in n:
            return str(v)[:200]
        if t.code == gdb.TYPE_CODE_STRUCT and depth < 5:
            r = {"kind": "struct", "type": n, "fields": read_struct_fields(v, t, objs, depth)}
            try: r["addr"] = hx(int(v.address))
            except Exception: pass
            return r
        return str(v)[:200]
    except gdb.error as e:
        return "<unreadable: %s>" % e

def file_key(sal):
    if not sal.symtab: return None
    p = os.path.realpath(sal.symtab.fullname())
    if p == SRC: return "main"
    if DRIVER and p == DRIVER: return "driver"
    return None

def snapshot():
    read_log(); objs = {}; frames = []
    f = gdb.newest_frame()
    while f is not None:
        sal = f.find_sal(); fk = file_key(sal)
        if fk:
            loc = {}
            try:
                b = f.block()
                while b and not b.is_global:
                    for s in b:
                        if (s.is_variable or s.is_argument) and s.name not in loc: loc[s.name] = read_val(s.value(f), objs)
                    if b.function: break
                    b = b.superblock
            except gdb.error: pass
            frames.append({"fn": f.name(), "file": fk, "line": sal.line, "locals": loc})
        f = f.older()
    # Objects no longer reachable from any local stay visible (leaks, detached nodes): re-read by remembered type.
    for b, i in list(allocs.items()):
        if i["state"] == "LIVE" and hx(b) not in objs and b in known: read_heap(b, known[b], objs)
    for b, i in allocs.items():
        if i["state"] == "FREED" and b in known: objs.setdefault(hx(b), {"type": tname(known[b]), "state": "FREED", "size": i["size"]})
    return {"frames": frames, "objects": objs}

def diff(old, new):
    ev = []
    for a, o in new["objects"].items():
        p = old["objects"].get(a)
        if o["state"] == "LIVE" and (p is None or p["state"] != "LIVE"):
            e = {"type": "object_created", "addr": a, "obj_type": o["type"], "size": o["size"]}
            if "fields" in o: e["fields"] = o["fields"]
            if "elems" in o: e["elems"] = o["elems"]
            ev.append(e)
        elif o["state"] == "FREED" and (p is None or p["state"] == "LIVE"):
            ev.append({"type": "object_freed", "addr": a})
        elif p and o["state"] == "LIVE" and p["state"] == "LIVE":
            for k, v in o.get("fields", {}).items():
                if p.get("fields", {}).get(k) != v: ev.append({"type": "field_changed", "addr": a, "field": k, "old": p.get("fields", {}).get(k), "new": v})
            for i, v in enumerate(o.get("elems", [])):
                pe = p.get("elems", [])
                if i >= len(pe) or pe[i] != v: ev.append({"type": "elem_changed", "addr": a, "index": i, "old": pe[i] if i < len(pe) else None, "new": v})
    if old["frames"] and new["frames"] and old["frames"][0]["fn"] == new["frames"][0]["fn"]:
        of, nf = old["frames"][0]["locals"], new["frames"][0]["locals"]
        for k, v in nf.items():
            if of.get(k) != v: ev.append({"type": "local_changed", "var": k, "old": of.get(k), "new": v})
    return ev

def write(rec):
    rec["schema"] = SCHEMA; OUT.write(json.dumps(rec) + "\n"); OUT.flush()

def end(reason, code=None, message=None, **extra):
    r = {"kind": "end", "reason": reason, "exitCode": code}
    if message: r["message"] = message
    r.update(extra)
    if double_frees: r["doubleFrees"] = double_frees
    write(r); OUT.close()

# --- watchdog: a single `step` that never returns (one-line loop) is interrupted with SIGINT ---------------------------
deadline = [None]; stalled = [False]
def watchdog():
    while True:
        time.sleep(0.2)
        d = deadline[0]
        if d is not None and time.time() > d:
            deadline[0] = None; stalled[0] = True
            try: os.kill(gdb.selected_inferior().pid, signal.SIGINT)
            except Exception: pass
threading.Thread(target=watchdog, daemon=True).start()

def alive():
    inf = gdb.selected_inferior()
    return inf.is_valid() and inf.pid != 0

last_signal = [None]; exit_info = [None]
def on_stop(ev):
    if isinstance(ev, gdb.SignalEvent): last_signal[0] = ev.stop_signal
def on_exit(ev): exit_info[0] = ev.exit_code if hasattr(ev, "exit_code") else None
gdb.events.stop.connect(on_stop); gdb.events.exited.connect(on_exit)

def exit_code():
    return exit_info[0]

def main():
    gdb.execute("set pagination off"); gdb.execute("set confirm off"); gdb.execute("set print thread-events off")
    # Preload via exec-wrapper, not `set environment`: gdb starts the program through /bin/sh, and a shim loaded into that shell
    # would claim the log (root pid) and then be disabled in the exec'd program. The wrapper runs after the shell.
    gdb.execute("set exec-wrapper env LD_PRELOAD=%s DSV_ALLOC_LOG=%s" % (E["DSV_SHIM"], LOG))
    gdb.execute("break main")
    gdb.execute("run > %s < /dev/null" % E["DSV_PROG_OUT"], to_string=True)
    prev = {"frames": [], "objects": {}}; n = 0
    while True:
        if n >= MAX_STEPS: return end("step_limit", None, "stopped after %d steps" % n)
        try:
            sal = gdb.selected_frame().find_sal()
            if not file_key(sal):
                deadline[0] = time.time() + STALL_SECONDS
                try: gdb.execute("finish", to_string=True)
                finally: deadline[0] = None
                continue
            cur = snapshot(); fr = cur["frames"][0]
            write({"kind": "step", "step": n, "fn": fr["fn"], "file": fr["file"], "line": sal.line, "depth": len(cur["frames"]),
                   "frames": cur["frames"], "events": diff(prev, cur)})
            n += 1; prev = cur
            stalled[0] = False; deadline[0] = time.time() + STALL_SECONDS
            try: out = gdb.execute("step", to_string=True)
            finally: deadline[0] = None
            if stalled[0] and alive():
                return end("stalled", None, "execution stayed on line %d for more than %.0fs (tight loop on a single line?)" % (sal.line, STALL_SECONDS), line=sal.line)
            if last_signal[0] and last_signal[0] != "SIGINT" and alive():
                sig = last_signal[0]; last_signal[0] = None
                snap = snapshot(); f0 = snap["frames"][0] if snap["frames"] else None
                if f0:
                    write({"kind": "step", "step": n, "fn": f0["fn"], "file": f0["file"], "line": f0["line"], "depth": len(snap["frames"]),
                           "frames": snap["frames"], "events": diff(prev, snap)})
                return end("crashed", None, "program received signal " + sig, signal=sig, line=f0["line"] if f0 else None)
        except gdb.error as e:
            if not alive(): return end("exited", exit_code())
            return end("error", None, str(e))

try: main()
except Exception as e:
    try: end("error", None, "tracer failure: %r" % e)
    except Exception: pass
