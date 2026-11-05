import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeSource } from "../core/analysis/static.ts";
import { findings, observedCost, suggestions } from "../core/analysis/findings.ts";
import { explainStep } from "../core/explain/explain.ts";
import { load, root, cfg, stepAt } from "./helpers.ts";
import { runTrace } from "../extension/src/execution/runner.ts";
import { History } from "../core/snapshots/history.ts";

const ex = (f: string) => fs.readFileSync(path.join(root, "examples", f), "utf8");

test("static analysis recognises node kinds", () => {
  const g = (f: string, n: string) => analyzeSource(ex(f)).structs.find((s) => s.name === n)!.guess;
  assert.equal(g("linked-lists/singly.cpp", "Node"), "singly linked list node");
  assert.equal(g("linked-lists/doubly.cpp", "Node"), "doubly linked list node");
  assert.equal(g("binary-trees/bst.cpp", "Node"), "binary tree node");
  assert.equal(g("binary-trees/avl.cpp", "Node"), "AVL tree node");
  assert.equal(g("binary-trees/rbtree.cpp", "Node"), "red-black tree node");
  assert.equal(g("tries/trie.cpp", "TrieNode"), "trie / n-ary tree node");
  assert.equal(g("hash-tables/chained.cpp", "HashTable"), "plain struct");
});

test("static complexity estimates: loops, recursion", () => {
  const fn = (f: string, n: string) => analyzeSource(ex(f)).functions.find((x) => x.name === n)!;
  assert.equal(fn("binary-trees/bst.cpp", "inorder").selfCalls, 2);
  assert.equal(fn("binary-trees/bst.cpp", "min_node").loopDepth, 1);
  assert.match(fn("binary-trees/bst.cpp", "min_node").estimate, /O\(n\^1\)/);
  assert.equal(fn("arrays/array_ops.cpp", "insert_at").loopDepth, 1);
  assert.equal(fn("graphs/bfs.cpp", "main").loopDepth, 2);
});

test("explanations name the exact line and the observed change", async () => {
  const l = await load("linked-lists/list.cpp");
  const i = l.history.steps.findIndex((s) => s.events.some((e) => e.type === "field_changed"));
  const e = explainStep(l.history.stateAt(i), { main: l.lines });
  assert.match(e.executed!.text, /n->next = head;/);
  assert.match(e.effects.join("\n"), /field 'next' changed from nullptr to/);
});

test("findings: leak, dangling pointer, crash with the null pointer named", async () => {
  const leak = await load("linked-lists/list.cpp");           // never frees nodes 1 and 3, head still references them
  const f1 = findings(leak.history, leak.lines);
  assert.ok(f1.some((f) => f.code === "dangling" && /dead/.test(f.message)) || f1.some((f) => f.code === "not-freed"), JSON.stringify(f1));
  const p = path.join(root, "tests", ".tmp-leak.cpp");
  fs.writeFileSync(p, "struct N{int v;};\nint main(){\n new N{1};\n N* q = new N{2};\n q = nullptr;\n return 0;\n}\n");
  const r = await runTrace(p, cfg);
  const h = new History(r.trace);
  assert.ok(findings(h, fs.readFileSync(p, "utf8").split("\n")).some((f) => f.code === "leak"));
  fs.writeFileSync(p, "struct N{int v;};\nint main(){\n N* p=nullptr;\n p->v = 1;\n return 0;\n}\n");
  const r2 = await runTrace(p, cfg);
  const c = findings(new History(r2.trace), fs.readFileSync(p, "utf8").split("\n")).find((f) => f.code === "crash")!;
  assert.match(c.message, /SIGSEGV at line 4/);
  assert.match(c.message, /'p' is nullptr/);
  fs.rmSync(p);
});

test("suggestions and observed cost are derived from the trace", async () => {
  const l = await load("binary-trees/bst.cpp");
  assert.ok(suggestions(l.history).some((s) => /deallocation/.test(s.text)));
  const c = observedCost(l.history).find((x) => x.fn === "insert")!;
  assert.equal(c.calls >= 6, true);
  assert.ok(stepAt(l, "inorder(root);") > 0);
});
