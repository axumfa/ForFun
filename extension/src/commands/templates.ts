/** Default statements offered for a picked function/struct. No `vscode` import: unit-testable. */
import type { Lang } from "../execution/runner.ts";

export interface TemplatePick { kind_: "function" | "class"; name: string; params?: string; typedef?: boolean; }

/** C has no default-initialising `Node obj;` for plain `struct Node` (the `struct` keyword is required unless it is a typedef name) and no methods. */
export function setupTemplate(p: TemplatePick, lang: Lang): string {
  if (p.kind_ === "function") return `${p.name}(/* ${p.params ?? ""} */);`;
  if (lang === "c") return `${p.typedef ? "" : "struct "}${p.name} obj = {0}; /* use &obj */`;
  return `${p.name} obj; /* obj.method(); */`;
}

export function setupPrompt(lang: Lang): { title: string; prompt: string } {
  return lang === "c"
    ? { title: "C statements to run (variables, inputs, the call)", prompt: "Executed from a generated main(void); the file's own main() is not run. Example: Node* h = NULL; h = push(h, 3); h = push(h, 4);" }
    : { title: "C++ statements to run (variables, inputs, the call)", prompt: "Executed from a generated main(); the file's own main() is not run. Example: Node* h = nullptr; h = push(h, 3); h = push(h, 4);" };
}
