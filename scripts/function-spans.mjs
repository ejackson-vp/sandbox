/**
 * Function spans for the structural guardrail.
 *
 * `check-structure.mjs` counted files, so the cleanup passes that split a god
 * file into a god *function* read as success: `api/src/server.ts` was 267 lines
 * and 200 of them were `createApp`. This module answers the other question,
 * how long is the longest function, so the guard can ratchet it too.
 *
 * There is no TypeScript parser to lean on: the repo pins `typescript@7`, whose
 * npm package is the native compiler with no `createSourceFile`, and a dev
 * dependency for this check would be a dependency the guard cannot defend. So
 * the scan is two passes over the source text:
 *
 *   1. `mask` blanks comments, string bodies, template-literal text, regex
 *      bodies and Go raw strings, keeping every newline and offset. What is
 *      left is code, so braces inside `"}"` or `` `${a} }` `` cannot be counted.
 *   2. `spans` tokenises the masked text and finds function bodies by their
 *      head: the `function` keyword, an `=>` before a `{`, or a `(...)` that is
 *      followed by `{` and preceded by a name that is not a control keyword.
 *
 * Counting rules: a span runs from the line of its first head token to the line
 * of the closing brace, inclusive. Nested functions are counted separately, so
 * a 30-line arrow inside a 20-line function reports both.
 *
 * Known limitations, all of them shapes this repo does not currently use and
 * none of which is silent about the length of a real function:
 *
 *  - a function whose return type is an object literal type (`): { a: string }
 *    {`) is not recognised, because the type's braces are indistinguishable
 *    from the body's;
 *  - a decorator or an `export default` wrapper is not part of the span, so
 *    those lines are counted against the file, not the function;
 *  - a call followed by a block (`foo(bar)\n{`) would be read as a method, and
 *    a method shorthand with a generic return type is matched by the type
 *    skipping only when the type has no object braces;
 *  - two functions with the same name in one file are keyed `name` and `name#2`
 *    in source order, which is stable until one is inserted between them.
 */

const CONTROL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "await",
  "yield",
  "else",
  "do",
  "try",
  "finally",
  "new",
  "delete",
  "void",
  "in",
  "of",
  "case",
]);

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const IDENT_START = /^[A-Za-z_$]/;

/** Blank what is not code, preserving every newline and every offset. */
function mask(text, lang) {
  const out = text.split("");
  const go = lang === "go";
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };

  // The top frame is the file's code. A template literal at depth 0 of a `${}`
  // hole keeps its own frame so a brace inside the hole cannot close the file.
  const frames = [{ depth: 0 }];
  let inTemplate = false;
  let prev = "";
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inTemplate) {
      let j = i;
      let closed = false;
      let hole = false;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "`") {
          closed = true;
          break;
        }
        if (!go && d === "$" && text[j + 1] === "{") {
          hole = true;
          break;
        }
        j++;
      }
      blank(i, Math.min(j, text.length));
      if (closed) {
        i = j + 1;
        inTemplate = false;
        prev = "a";
        continue;
      }
      if (hole) {
        i = j + 2;
        frames.push({ depth: 0 });
        inTemplate = false;
        prev = "{";
        continue;
      }
      i = text.length;
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c || text[j] === "\n") break;
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, text.length);
      prev = "a";
      continue;
    }
    if (c === "`") {
      // A Go raw string has no interpolation; a TS template may.
      inTemplate = true;
      i++;
      continue;
    }
    // Division unless what precedes it cannot end an expression. `}` is
    // excluded on purpose: a regex after a block (`if (x) /re/.test(s)`) is
    // rare enough that reading it as division is the cheaper mistake.
    if (c === "/" && !go && !/[A-Za-z0-9_$)\]}]/.test(prev) && prev !== ".") {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        prev = "a";
        continue;
      }
      i++;
      prev = "/";
      continue;
    }
    if (c === "{") {
      frames[frames.length - 1].depth++;
      prev = "{";
      i++;
      continue;
    }
    if (c === "}") {
      const frame = frames[frames.length - 1];
      if (frame.depth === 0 && frames.length > 1) {
        frames.pop();
        inTemplate = true;
        i++;
        continue;
      }
      frame.depth--;
      prev = "}";
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

function tokenize(masked) {
  const tokens = [];
  let i = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (IDENT_CHAR.test(c)) {
      let j = i;
      while (j < masked.length && IDENT_CHAR.test(masked[j])) j++;
      tokens.push({ value: masked.slice(i, j), at: i });
      i = j;
      continue;
    }
    // `=>` is one token: as two it reads as an assignment followed by a `>`,
    // and every arrow function in the repo went uncounted.
    if (c === "=" && masked[i + 1] === ">") {
      tokens.push({ value: "=>", at: i });
      i += 2;
      continue;
    }
    tokens.push({ value: c, at: i });
    i++;
  }
  return tokens;
}

function lineTable(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const PAIR = { ")": "(", "]": "[", "}": "{" };
const CLOSER = { "(": ")", "[": "]", "{": "}" };

function matchBack(tokens, i) {
  const want = PAIR[tokens[i].value];
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    const v = tokens[k].value;
    if (v === tokens[i].value) depth++;
    else if (v === want && --depth === 0) return k;
  }
  return -1;
}

function matchForward(tokens, i) {
  const want = CLOSER[tokens[i].value];
  let depth = 0;
  for (let k = i; k < tokens.length; k++) {
    const v = tokens[k].value;
    if (v === tokens[i].value) depth++;
    else if (v === want && --depth === 0) return k;
  }
  return -1;
}

/**
 * Index of the `{` that opens a body, scanning forward over a return type.
 * Bracket depth keeps `Promise<{ id: string }>` and `(a: A) => B` inside the
 * type, where they belong.
 */
function typeThenBrace(tokens, i) {
  let depth = 0;
  for (; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (v === "<" || v === "(" || v === "[") depth++;
    else if (v === ">" || v === ")" || v === "]") depth--;
    else if (depth === 0) {
      if (v === "{") return i;
      if (v === ";" || v === "}" || v === "=") return -1;
    }
  }
  return -1;
}

/** The last token of the type that ends at `k`, or -1 if it is not a type. */
function typeStart(tokens, k) {
  for (;;) {
    if (k < 0) return -1;
    const v = tokens[k].value;
    if (v === ")") return -1;
    if (v === "]" || v === ">") {
      k = matchBack(tokens, k);
      if (k < 0) return -1;
      k--;
      continue;
    }
    if (v === ":") return k;
    if (v === "{" || v === "}" || /^([A-Za-z0-9_$.|&?,]|\(|\))+$/.test(v)) {
      k--;
      continue;
    }
    return -1;
  }
}

function fromKeyword(tokens, i) {
  let j = i + 1;
  if (tokens[j]?.value === "*") j++;
  let name = "(anonymous)";
  if (tokens[j] && IDENT_START.test(tokens[j].value)) {
    name = tokens[j].value;
    j++;
  }
  if (tokens[j]?.value !== "(") return null;
  const closeParen = matchForward(tokens, j);
  if (closeParen < 0) return null;
  const body = typeThenBrace(tokens, closeParen + 1);
  return body < 0 ? null : { body, name, head: i };
}

function fromArrow(tokens, i) {
  if (tokens[i + 1]?.value !== "{") return null;
  let k = i - 1;
  if (tokens[k]?.value !== ")") {
    k = typeStart(tokens, k);
    if (k < 0 || tokens[k].value !== ":") return null;
    k--;
  }
  while (k >= 0 && (tokens[k].value === "?" || tokens[k].value === "!")) k--;
  if (tokens[k]?.value !== ")") return null;
  const open = matchBack(tokens, k);
  if (open < 0) return null;

  let m = open - 1;
  let name = "(arrow)";
  let head = open;
  if (tokens[m]?.value === "async") m--;
  if (tokens[m]?.value === "=") {
    m--;
    if (tokens[m] && IDENT_START.test(tokens[m].value) && !CONTROL.has(tokens[m].value)) {
      name = tokens[m].value;
      head = m;
      const decl = tokens[m - 1]?.value;
      if (decl === "const" || decl === "let" || decl === "var") head = m - 1;
    } else if (tokens[m]?.value === ":") {
      // an object literal property: `handler: async (req) => { ... }`
      m--;
      if (tokens[m] && IDENT_START.test(tokens[m].value)) {
        name = tokens[m].value;
        head = m;
      }
    }
  }
  return { body: i + 1, name, head };
}

/**
 * What may sit before a method name. A call is `obj.name(` or `= name(` or
 * `: name(`, and a ternary's `? a() : b(` ended up as a 64-line "function"
 * called `min` in tests/property/capacity-snapshot.test.ts. A member is
 * preceded by the class or object body, another member, or a modifier.
 */
const MEMBER_PREFIX = new Set([
  "{",
  "}",
  ";",
  ",",
  "*",
  "static",
  "async",
  "public",
  "private",
  "protected",
  "readonly",
  "override",
  "abstract",
  "declare",
  "get",
  "set",
]);

/** `name(...) { ... }`: a class method or an object-literal method. */
function fromMethod(tokens, closeParen) {
  const open = matchBack(tokens, closeParen);
  if (open < 0) return null;
  const before = tokens[open - 1];
  if (!before || !IDENT_START.test(before.value) || CONTROL.has(before.value)) return null;
  const lead = tokens[open - 2];
  if (lead && !MEMBER_PREFIX.has(lead.value)) return null;
  let body = closeParen + 1;
  if (tokens[body]?.value !== "{") {
    if (tokens[body]?.value !== ":") return null;
    body = typeThenBrace(tokens, body + 1);
    if (body < 0) return null;
  }
  return { body, name: before.value, head: open - 1 };
}

function fromGoFunc(tokens, i) {
  let k = i + 1;
  let name = "(anonymous)";
  if (tokens[k]?.value === "(") {
    // receiver: `func (m *manager) name(...)`
    const recv = matchForward(tokens, k);
    if (recv < 0) return null;
    k = recv + 1;
    if (!tokens[k] || !IDENT_START.test(tokens[k].value)) return null;
    name = tokens[k].value;
    k++;
  } else if (tokens[k] && IDENT_START.test(tokens[k].value)) {
    name = tokens[k].value;
    k++;
  }
  let depth = 0;
  for (; k < tokens.length; k++) {
    const v = tokens[k].value;
    if (v === "(" || v === "[") depth++;
    else if (v === ")" || v === "]") depth--;
    else if (v === "{" && depth === 0) {
      const prev = tokens[k - 1];
      // `struct { ... }` and `interface { ... }` are part of the signature
      if (prev && (prev.value === "struct" || prev.value === "interface")) {
        k = matchForward(tokens, k);
        continue;
      }
      return { body: k, name, head: i };
    }
  }
  return null;
}

/**
 * Every function in `text`, longest first. `lang` is "go" or "ts" and decides
 * whether backticks interpolate and whether `/` can start a regex.
 */
export function functionSpans(text, lang = "ts") {
  const tokens = tokenize(mask(text, lang));
  const lines = lineTable(text);
  const seen = new Map();
  const bodies = new Set();
  const spans = [];

  const add = (hit) => {
    if (!hit || tokens[hit.body]?.value !== "{") return;
    // An anonymous arrow has no name a baseline can carry. The useful ones in
    // this repo are route handlers inside a counted registration; the rest are
    // `describe`/`it` blocks, which the file ratchet already covers. Skipping
    // them costs little, because an arrow inside a named function still trips
    // that function's pin: the parent's span covers these lines too.
    if (hit.name === "(arrow)" || hit.name === "(anonymous)") return;
    // One body can be reached twice: `function f(a) {` is both a `function`
    // head and a `(...) {` method head. The first hit wins.
    if (bodies.has(hit.body)) return;
    bodies.add(hit.body);
    const close = matchForward(tokens, hit.body);
    if (close < 0) return;
    const startLine = lineAt(lines, tokens[hit.head].at);
    const endLine = lineAt(lines, tokens[close].at);
    // Two functions with one name in one file still get distinct keys, so the
    // baseline cannot pin one and silently cover the other.
    const seenKey = seen.get(hit.name) ?? 0;
    seen.set(hit.name, seenKey + 1);
    spans.push({
      name: seenKey === 0 ? hit.name : `${hit.name}#${seenKey + 1}`,
      startLine,
      endLine,
      lines: endLine - startLine + 1,
    });
  };

  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (lang === "go") {
      if (v === "func") add(fromGoFunc(tokens, i));
    } else if (v === "function") add(fromKeyword(tokens, i));
    else if (v === "=>") add(fromArrow(tokens, i));
    else if (v === ")") add(fromMethod(tokens, i));
  }

  return spans.sort((a, b) => b.lines - a.lines || a.startLine - b.startLine);
}
