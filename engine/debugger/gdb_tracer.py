"""GDB backend: single-steps a -O0 -g debuggee and writes trace schema v3 (JSONL).
Run:  gdb -q -batch -x gdb_tracer.py --args ./prog    with DSV_* env vars (see CONFIG).
Principle: every value written here was read from the debuggee's memory; nothing is inferred or invented."""
import gdb, glob, itertools, json, os, re, signal, sys, threading, time

SCHEMA = 3
E = os.environ
MAX_STEPS = int(E.get("DSV_MAX_STEPS", "20000"))
STALL_SECONDS = float(E.get("DSV_STALL_SECONDS", "3"))      # max wall time inside ONE gdb `step`
MAX_OBJECTS = int(E.get("DSV_MAX_OBJECTS", "3000"))
MAX_ELEMS = 512
MAX_STL = int(E.get("DSV_MAX_STL_ELEMS", "200"))   # entries read per STL container per step (the rest is only counted)
NO_PRINTERS = E.get("DSV_NO_PRINTERS") == "1"      # test hook: behave as if no libstdc++ pretty-printers exist
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

# --- STL containers (M8): map/set/list read by a validated node walk, everything else via libstdc++'s GDB pretty-printers --------
STL_RE = re.compile(r"^std::(?:__cxx11::)?(map|multimap|set|multiset|unordered_map|unordered_multimap|unordered_set|unordered_multiset|list|deque)<")
MAPLIKE = ("map", "multimap", "unordered_map", "unordered_multimap")
# Iterator locals (`auto it = m.begin()`) hold pointers to libstdc++'s own node types; those blocks belong to the container (read by its
# reader) and must not turn into stray "pointer graph" objects of their own.
INTERNAL_NODE_RE = re.compile(r"^std::(_Rb_tree_node|_List_node|__detail::_List_node|__detail::_Hash_node|_Deque_)")
# Their iterators (`it`, a range-for's hidden `__begin`) point into node/chunk storage owned by the container: shown as text, not walked.
ITER_RE = re.compile(r"^std::(_Rb_tree_(const_)?iterator|_List_(const_)?iterator|_Deque_iterator|__detail::_Node_(const_)?iterator)<")
class Unavailable(Exception): pass
class NotTracked(Unavailable): pass     # a node is not a live allocation of the shim: container unconstructed, destroyed or garbage

def stl_kind(t):
    m = STL_RE.match(t.name or ""); return m.group(1) if m else None

printers_tried = [False]
def register_printers():
    """Tier 1: gdb did not auto-load libstdc++'s printers; load them from the gcc python dir if it exists."""
    for d in sorted(glob.glob("/usr/share/gcc*/python")):
        if not os.path.isdir(os.path.join(d, "libstdcxx")): continue
        sys.path.insert(0, d)
        try:
            from libstdcxx.v6 import register_libstdcxx_printers
            register_libstdcxx_printers(None); return True
        except Exception: sys.path.remove(d)
    return False

def visualizer(v):
    if NO_PRINTERS: return None
    vis = gdb.default_visualizer(v)
    if vis is None and not printers_tried[0]:
        printers_tried[0] = True
        if register_printers(): vis = gdb.default_visualizer(v)
    return vis

_lay = {}
def base_layout(tname, fields):
    """{field: (offset, size)} of a libstdc++ node base, taken from DWARF (not hard-coded)."""
    if tname not in _lay:
        try: t = gdb.lookup_type(tname)
        except gdb.error: raise Unavailable("type %s not in debug info" % tname)
        o = {f.name: (f.bitpos // 8, f.type.sizeof) for f in t.fields() if f.name and getattr(f, "bitpos", None) is not None}
        for f in fields:
            if f not in o: raise Unavailable("%s has no field %s (unsupported libstdc++ layout)" % (tname, f))
        _lay[tname] = (o, t.sizeof)
    return _lay[tname]

def mem(addr, n):
    try: return bytes(gdb.selected_inferior().read_memory(addr, n))
    except gdb.MemoryError: raise NotTracked("node memory at %s is unreadable" % hx(addr))

def live_node(a):
    i = allocs.get(a)
    if i is None or i["state"] != "LIVE": raise NotTracked("node %s is not a live heap allocation" % hx(a))

def storage_offset(tmpl, vt):
    try: nt = gdb.lookup_type("%s<%s>" % (tmpl, vt))
    except gdb.error: raise Unavailable("node type %s<%s> not in debug info" % (tmpl, vt))
    o = {f.name: f.bitpos // 8 for f in nt.fields() if f.name and getattr(f, "bitpos", None) is not None}
    if "_M_storage" not in o: raise Unavailable("node type has no _M_storage (unsupported libstdc++ layout)")
    return o["_M_storage"]

def int_field(b, lay, f): return int.from_bytes(b[lay[f][0]:lay[f][0] + lay[f][1]], sys.byteorder)

def walk_rb(v, size, cap):
    """In-order walk of a std::map/set red-black tree (the successor algorithm of _Rb_tree_increment) from the leftmost node.
    Returns (header, [node addr], links, root) with links[addr] = (color, parent, left, right) as raw addresses.
    With size <= cap the whole tree is walked and every link is cross-checked; above cap only the first `cap` nodes are returned."""
    impl = v["_M_t"]["_M_impl"]; lay, sz = base_layout("std::_Rb_tree_node_base", ["_M_color", "_M_parent", "_M_left", "_M_right"])
    cache = {}; budget = [30 * min(size, cap) + 100]
    def links(a):
        if a not in cache:
            budget[0] -= 1
            if budget[0] < 0: raise Unavailable("tree walk did not terminate")
            b = mem(a, sz); cache[a] = tuple(int_field(b, lay, f) for f in ("_M_color", "_M_parent", "_M_left", "_M_right"))
        return cache[a]
    def succ(n):
        if links(n)[3]:
            n = links(n)[3]
            while links(n)[2]: n = links(n)[2]
            return n
        p = links(n)[1]
        while n == links(p)[3]: n, p = p, links(p)[1]
        return p if links(n)[3] != p else n
    hdr = int(impl["_M_header"].address); full = size <= cap
    root, node = links(hdr)[1], links(hdr)[2]
    order = []
    while node != hdr and len(order) < min(size, cap):
        live_node(node); order.append(node); node = succ(node)
    if full:
        if node != hdr or len(order) != size: raise Unavailable("tree has %d reachable nodes but size() is %d" % (len(order), size))
        idx = {a: i for i, a in enumerate(order)}
        if size and (root not in idx or links(root)[1] != hdr): raise Unavailable("root link inconsistent")
        for a in order:
            c, p, l, r = links(a)
            if c not in (0, 1): raise Unavailable("invalid node colour %d" % c)
            if p != hdr and p not in idx: raise Unavailable("parent link leaves the tree")
            for ch in (l, r):
                if ch and (ch not in idx or links(ch)[1] != a): raise Unavailable("child/parent links disagree")
    return hdr, order, {a: links(a) for a in order}, root

def walk_list(v, size, cap):
    lay, sz = base_layout("std::__detail::_List_node_base", ["_M_next", "_M_prev"])
    hdr = int(v["_M_impl"]["_M_node"].address); order = []; cur = int_field(mem(hdr, sz), lay, "_M_next"); prev = hdr
    while cur != hdr and len(order) < min(size, cap):
        live_node(cur); b = mem(cur, sz)
        if size <= cap and int_field(b, lay, "_M_prev") != prev: raise Unavailable("prev/next links disagree")
        order.append(cur); prev = cur; cur = int_field(b, lay, "_M_next")
    if size <= cap and (cur != hdr or len(order) != size): raise Unavailable("list has %d reachable nodes but size() is %d" % (len(order), size))
    return hdr, order

def printer_size(vis):
    try:
        txt = str(vis.to_string()); m = re.search(r"with (\d+) element", txt)
        return int(m.group(1)) if m else (0 if txt.startswith("empty") else None)
    except Exception: return None

def lazy_children(vis, maplike, cap):
    """First `cap` elements of the printer, consumed lazily (never the whole container); map-like printers yield key, value, key, value, ..."""
    it = iter(vis.children()); out = []
    cv = lambda x: x if isinstance(x, gdb.Value) else gdb.Value(x)
    while len(out) < cap:
        try: k = next(it)
        except StopIteration: break
        if maplike:
            try: out.append((cv(k[1]), cv(next(it)[1])))
            except StopIteration: break
        else: out.append((None, cv(k[1])))
    return out

def entry(kv, objs, depth, maplike):
    k, val = kv
    e = {"value": read_val(val, objs, depth + 1)}
    if maplike: e["key"] = read_val(k, objs, depth + 1)
    return e

def read_stl(v, t, kind, objs, depth):
    maplike = kind in MAPLIKE
    r = {"kind": "stl", "container": kind, "type": t.name, "size": -1, "truncated": False, "entries": [], "source": "raw"}
    a = addr_of(v)
    if a: r["addr"] = a
    try:
        r["valType"] = str(t.template_argument(1 if maplike else 0))
        if maplike: r["keyType"] = str(t.template_argument(0))
    except Exception: pass
    rb, ls = kind in ("map", "multimap", "set", "multiset"), kind == "list"
    vis = visualizer(v)
    size = None
    try:
        if rb: size = int(v["_M_t"]["_M_impl"]["_M_node_count"])
        elif ls: size = int(v["_M_impl"]["_M_node"]["_M_size"])
        elif kind.startswith("unordered"): size = int(v["_M_h"]["_M_element_count"])
    except gdb.error: pass
    if size is None and vis is not None: size = printer_size(vis)
    if kind.startswith("unordered"):
        try: r["bucketCount"] = int(v["_M_h"]["_M_bucket_count"])
        except gdb.error: pass
    if size is not None: r["size"] = size
    trunc = size is not None and size > MAX_STL
    r["truncated"] = trunc
    why = None
    if rb or ls:                                         # --- node walk (identity = node address) ---
        try:
            targ = t.template_argument(2 if kind in ("set", "multiset") else 3) if rb else t.template_argument(1)
            if not str(targ).startswith("std::allocator<"): raise Unavailable("allocator %s is not std::allocator" % targ)
            if size is None or size < 0: raise Unavailable("size() unreadable")
            vt = v["_M_t"].type.strip_typedefs().template_argument(1) if rb else t.template_argument(0)
            off = storage_offset("std::_Rb_tree_node" if rb else "std::_List_node", vt)
            if rb: hdr, order, lk, root = walk_rb(v, size, MAX_STL)
            else: hdr, order = walk_list(v, size, MAX_STL)
            ents = []
            for n in order:
                val = gdb.Value(n + off).cast(vt.pointer()).dereference()
                e = entry((val["first"], val["second"]) if maplike else (None, val), objs, depth, maplike)
                e["id"] = hx(n); ents.append(e)
            if vis is not None:                          # cross-check the first entries against the printer: a wrong layout must not pass silently
                for (k, x), e in zip(lazy_children(vis, maplike, 4), ents):
                    if (maplike and read_val(k, {}, depth + 1) != e["key"]) or read_val(x, {}, depth + 1) != e["value"]:
                        raise Unavailable("node walk disagrees with the pretty-printer")
            if trunc:
                r["internal"] = None; r["internalError"] = "%d elements: the internal view needs at most %d" % (size, MAX_STL)
            elif rb:
                idx = {n: i for i, n in enumerate(order)}; ix = lambda p: -2 if p == hdr else idx.get(p, -1)
                for e, n in zip(ents, order): c, p, l, rr = lk[n]; e["n"] = [c, ix(p), ix(l), ix(rr)]
                r["internal"] = {"kind": "rb", "header": hx(hdr), "root": idx.get(root, -1)}
            else: r["internal"] = {"kind": "list", "header": hx(hdr)}
            r["entries"] = ents; r["source"] = "walk"
            return r
        except NotTracked as e:
            r["internal"] = None; r["internalError"] = str(e)
            if size != 0:
                r["unavailable"] = "contents not readable (container not constructed yet, already destroyed, or memory not tracked)"
                return r
        except Unavailable as e:
            r["internal"] = None; r["internalError"] = str(e)
        except gdb.error as e:
            r["internal"] = None; r["internalError"] = "walk failed: %s" % e
    if vis is not None:                                  # --- printer (identity = key / position) ---
        try:
            r["entries"] = [entry(kv, objs, depth, maplike) for kv in lazy_children(vis, maplike, MAX_STL)]
            r["source"] = "printer"
            if size is None: r["size"] = len(r["entries"])
            return r
        except Exception as e: why = "pretty-printer failed: %s" % e
    r["text"] = v.format_string(raw=True, max_elements=8)[:300]
    r["unavailable"] = why or ("libstdc++ pretty-printers are not available (no node walk for std::%s)" % kind)
    return r

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
                if off == 0 and tt.code != gdb.TYPE_CODE_VOID and tt.code != gdb.TYPE_CODE_FUNC and len(objs) < MAX_OBJECTS and not INTERNAL_NODE_RE.match(tname(t.target())):
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
        if t.code == gdb.TYPE_CODE_STRUCT and ITER_RE.match(n): return str(v)[:200]
        if t.code == gdb.TYPE_CODE_STRUCT and depth < 6 and stl_kind(t): return read_stl(v, t, stl_kind(t), objs, depth)
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

def slim(v):
    """local_changed carries old/new values only for the explanation text; a container's entries (up to MAX_STL, already in `frames`) are left out."""
    if isinstance(v, dict) and v.get("kind") == "stl":
        r = {k: v[k] for k in ("kind", "container", "type", "size", "truncated", "source", "addr") if k in v}; r["entries"] = []; return r
    return v

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
            if of.get(k) != v: ev.append({"type": "local_changed", "var": k, "old": slim(of.get(k)), "new": slim(v)})
    return ev

def write(rec):
    rec["schema"] = SCHEMA; OUT.write(json.dumps(rec, separators=(",", ":")) + "\n"); OUT.flush()

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
