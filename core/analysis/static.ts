/** Lightweight, regex-level static analysis. Results are *estimates* and say so; they never override observed runtime behaviour. */
/** `typedef` is true when `name` is a typedef name (C: use `Name x;`, not `struct Name x;`). */
export interface StructInfo { name: string; line: number; selfPointers: string[]; guess: string; evidence: string; typedef?: boolean; }
export interface FunctionInfo { name: string; params: string; isMethod: boolean; line: number; endLine: number; loopDepth: number; selfCalls: number; estimate: string; evidence: string; }
export interface SourceAnalysis { structs: StructInfo[]; functions: FunctionInfo[]; }

const KW = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "else", "do"]);
const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

function matchBrace(src: string, open: number): number {
  let d = 0;
  for (let i = open; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return i; }
  return src.length - 1;
}
function stripComments(src: string): string {   // keep newlines so line numbers survive
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function guessStruct(name: string, self: string[], body: string): { guess: string; evidence: string } {
  const has = (re: RegExp) => self.some((f) => re.test(f));
  if (/\[\s*\w+\s*\]/.test(body) && new RegExp(`${name}\\s*\\*\\s*\\w+\\s*\\[`).test(body)) return { guess: "trie / n-ary tree node", evidence: `array of ${name}* children` };
  if (has(/^(left|l|lc)$/i) && has(/^(right|r|rc)$/i)) return { guess: /height|balance/i.test(body) ? "AVL tree node" : /colou?r|red|black/i.test(body) ? "red-black tree node" : "binary tree node", evidence: "left/right self-pointers" + (/height|balance/i.test(body) ? " + height field" : /colou?r/i.test(body) ? " + colour field" : "") };
  if (has(/prev/i) && has(/next/i)) return { guess: "doubly linked list node", evidence: "prev/next self-pointers" };
  if (self.length === 1) return { guess: "singly linked list node", evidence: `single self-pointer '${self[0]}'` };
  if (self.length) return { guess: "graph / generic linked node", evidence: `${self.length} self-pointers` };
  return { guess: "plain struct", evidence: "no self-referencing pointer" };
}

export function analyzeSource(source: string): SourceAnalysis {
  const src = stripComments(source);
  const structs: StructInfo[] = [];
  // `struct|class Tag {…}` (C++ and C), plus the C forms `typedef struct Tag {…} Name;` and `typedef struct {…} Name;`
  // (the typedef name is what the user's code and the debugger use; self-pointers may be spelled with the tag or the name).
  for (const m of src.matchAll(/(\btypedef\s+)?\b(struct|class|union)\b\s*(\w+)?\s*(?::[^{;]*)?\{/g)) {
    const isTypedef = !!m[1], tag = m[3];
    if (!isTypedef && (!tag || m[2] === "union")) continue;
    const open = m.index! + m[0].length - 1, close = matchBrace(src, open), body = src.slice(open + 1, close);
    const alias = isTypedef ? /^\s*(\w+)\s*;/.exec(src.slice(close + 1))?.[1] : undefined;
    if (isTypedef && !alias) continue;
    const name = alias ?? tag!, names = [...new Set([name, tag].filter((x): x is string => !!x))];
    // `T *a;` and the C idiom `T *a, *b;` (every declarator of the list is a self-pointer)
    const self = [...body.matchAll(new RegExp(`\\b(?:${names.join("|")})\\s*(\\*\\s*\\w+(?:\\s*,\\s*\\*\\s*\\w+)*)`, "g"))].flatMap((x) => [...x[1]!.matchAll(/\*\s*(\w+)/g)].map((y) => y[1]!));
    const uniq = [...new Set(self)];
    const g = guessStruct(`(?:${names.join("|")})`, uniq, body);
    structs.push({ name, line: lineOf(src, m.index!), selfPointers: uniq, guess: g.guess, evidence: g.evidence, ...(isTypedef ? { typedef: true } : {}) });
  }
  const functions: FunctionInfo[] = [];
  for (const m of src.matchAll(/(?:^|[;}\n])\s*(?:[\w:<>,~*&\s]+?)\s+(\w+)\s*\(([^;{}()]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?::[^{;]*)?\{/g)) {
    const name = m[1]!;
    if (KW.has(name)) continue;
    const open = m.index! + m[0].length - 1, close = matchBrace(src, open), body = src.slice(open + 1, close);
    let depth = 0, maxDepth = 0, pending = false; const stack: boolean[] = [];
    for (const t of body.matchAll(/\b(for|while)\b|\{|\}/g)) {
      if (t[0] === "{") { stack.push(pending); if (pending) { depth++; maxDepth = Math.max(maxDepth, depth); } pending = false; }
      else if (t[0] === "}") { if (stack.pop()) depth--; }
      else pending = true;
    }
    const selfCalls = [...body.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))].length;
    let estimate: string, evidence: string;
    if (selfCalls >= 2) { estimate = "recursive with ≥2 self-calls: O(n) if each element/node is visited once (tree traversal), up to O(2^n) otherwise"; evidence = `${selfCalls} self-calls`; }
    else if (selfCalls === 1) { estimate = maxDepth ? `recursion plus ${maxDepth} loop level(s): at least O(n) per level` : "single recursion: O(n) deep, or O(h) when it descends one child of a tree (O(log n) if balanced)"; evidence = "1 self-call" + (maxDepth ? `, loop depth ${maxDepth}` : ""); }
    else if (maxDepth) { estimate = `O(n^${maxDepth}) in the iterated sizes (loop nesting depth ${maxDepth})`; evidence = `loop nesting depth ${maxDepth}`; }
    else { estimate = "O(1) apart from callees"; evidence = "no loops, no self-recursion"; }
    functions.push({ name, params: m[2]!.replace(/\s+/g, " ").trim(), isMethod: false, line: lineOf(src, m.index! + m[0].indexOf(name)), endLine: lineOf(src, close), loopDepth: maxDepth, selfCalls, estimate: estimate + " (static estimate)", evidence });
  }
  return { structs, functions };
}
