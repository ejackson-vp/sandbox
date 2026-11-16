/**
 * The function-length scanner, on shapes that would fool a brace counter.
 *
 * The guard is only worth the ratchet if its numbers are right: a scanner that
 * counts a brace inside a template literal or a regex would report a span that
 * is shorter than the function, and a baseline pinned to that number would let
 * the real function grow. Each case below is a shape the repo actually uses
 * (`shared/src/domain/session.ts` has the regex, `api/src/server.ts` had the
 * nested arrows, `guest/*.go` has the raw strings) or one the scan has to
 * refuse (`if (x) {` is not a function).
 *
 * The six measurements the guard was written against are pinned in
 * `scripts/check-structure.mjs`, not here: they move when a function is split,
 * and this file must not have to change for that.
 */
import { describe, expect, it } from "vitest";
import { functionSpans } from "../../scripts/function-spans.mjs";

const span = (source: string, lang: "ts" | "go" = "ts") => {
  const spans = functionSpans(source, lang);
  return (name: string) => {
    const found = spans.find((entry) => entry.name === name);
    if (!found) throw new Error(`no span called ${name} in\n${source}`);
    return found;
  };
};

describe("functionSpans", () => {
  it("counts a function whose body holds braces in a string, a comment and a regex", () => {
    const source = [
      "/** a doc comment with { and } */",
      "const pattern = /[{}]+/;",
      "export function first(a: string): string {",
      '  const text = "} not a brace {";',
      "  const tpl = `a ${a} } b`;",
      "  if (a) {",
      "    return text + tpl + pattern.source;",
      "  }",
      "  return a;",
      "}",
    ].join("\n");
    const first = span(source)("first");
    expect(first.lines).toBe(8);
    expect(first.startLine).toBe(3);
    expect(first.endLine).toBe(10);
  });

  it("reads a division as division and a regex as a regex", () => {
    const source = [
      "function divide(total: number): string {",
      "  const half = total / 2;",
      "  const re = /[}]/;",
      "  return String(half) + re.source;",
      "}",
    ].join("\n");
    expect(span(source)("divide").lines).toBe(5);
  });

  it("counts a template literal hole as code, and a nested arrow separately", () => {
    const source = [
      "const second = (a: string): number => {",
      "  const tpl = `${a}}`;",
      "  const inner = () => {",
      "    return 1;",
      "  };",
      "  return inner() + tpl.length;",
      "};",
    ].join("\n");
    const spans = functionSpans(source, "ts");
    expect(span(source)("second").lines).toBe(7);
    expect(span(source)("inner").lines).toBe(3);
    expect(spans).toHaveLength(2);
  });

  it("counts a method shorthand and its generic return type", () => {
    const source = [
      "class A {",
      "  stop(): Promise<void> {",
      "    return Promise.resolve();",
      "  }",
      "}",
    ].join("\n");
    expect(span(source)("stop").lines).toBe(3);
  });

  it("does not read a control block or a class body as a function", () => {
    const source = [
      "class Holder {",
      "  if (x) {",
      "    y();",
      "  }",
      "  for (const a of b) {",
      "    y();",
      "  }",
      "}",
    ].join("\n");
    expect(functionSpans(source, "ts")).toHaveLength(0);
  });

  it("keys two functions with one name by order, so neither is hidden", () => {
    const source = [
      "function dup() {",
      "  return 1;",
      "}",
      "function dup() {",
      "  return 2;",
      "}",
    ].join("\n");
    const spans = functionSpans(source, "ts");
    expect(spans.map((entry) => entry.name).sort()).toEqual(["dup", "dup#2"]);
  });

  it("counts a Go method past its receiver and a raw string with a brace", () => {
    const source = [
      "func (m *manager) run(x int) (int, error) {",
      "\ts := `raw } string`",
      "\tif x > 0 {",
      "\t\treturn x, nil",
      "\t}",
      "\treturn 0, nil",
      "}",
    ].join("\n");
    expect(span(source, "go")("run").lines).toBe(7);
  });

  it("skips a struct or interface in a Go signature on the way to the body", () => {
    const source = [
      "func build(c Config) interface{} {",
      "\treturn struct{}{}",
      "}",
    ].join("\n");
    expect(span(source, "go")("build").lines).toBe(3);
  });
});
