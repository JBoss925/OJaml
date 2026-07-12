import { OJamlError } from "./errors";

export type TokenKind =
  | "int"
  | "float"
  | "string"
  | "ident"
  | "typevar"
  | "keyword"
  | "operator"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "lbrace"
  | "rbrace"
  | "comma"
  | "colon"
  | "dot"
  | "semicolon"
  | "coloncolon"
  | "pipe"
  | "arrow"
  | "equals"
  | "semicolon2"
  | "eof";

export type Token = {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
};

const keywords = new Set(["let", "rec", "in", "if", "then", "else", "true", "false", "fun", "match", "with", "mod", "type", "of", "open", "not"]);
const symbolicOperators = new Set(["+", "-", "*", "/", "**", "<", ">", "<=", ">=", "<>", "&&", "||", "|>"]);

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "(" && source[i + 1] === "*") {
      i = skipComment(source, i + 2);
      continue;
    }

    const start = i;
    if (/[0-9]/.test(ch)) {
      i++;
      while (/[0-9]/.test(source[i] ?? "")) i++;
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        i++;
        while (/[0-9]/.test(source[i] ?? "")) i++;
        tokens.push({ kind: "float", text: source.slice(start, i), start, end: i });
      } else {
        tokens.push({ kind: "int", text: source.slice(start, i), start, end: i });
      }
      continue;
    }

    if (ch === "\"") {
      const result = readString(source, i);
      tokens.push({ kind: "string", text: result.value, start, end: result.end });
      i = result.end;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      i++;
      while (/[A-Za-z0-9_'.]/.test(source[i] ?? "")) i++;
      const text = source.slice(start, i);
      tokens.push({ kind: keywords.has(text) ? "keyword" : "ident", text, start, end: i });
      continue;
    }

    if (ch === "'" && /[A-Za-z_]/.test(source[i + 1] ?? "")) {
      i += 2;
      while (/[A-Za-z0-9_]/.test(source[i] ?? "")) i++;
      tokens.push({ kind: "typevar", text: source.slice(start, i), start, end: i });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === ";;") {
      tokens.push({ kind: "semicolon2", text: two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if (two === "->") {
      tokens.push({ kind: "arrow", text: two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if (two === "::") {
      tokens.push({ kind: "coloncolon", text: two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if (symbolicOperators.has(two)) {
      tokens.push({ kind: "operator", text: two, start, end: i + 2 });
      i += 2;
      continue;
    }

    if (ch === "(") tokens.push({ kind: "lparen", text: ch, start, end: ++i });
    else if (ch === ")") tokens.push({ kind: "rparen", text: ch, start, end: ++i });
    else if (ch === "[") tokens.push({ kind: "lbracket", text: ch, start, end: ++i });
    else if (ch === "]") tokens.push({ kind: "rbracket", text: ch, start, end: ++i });
    else if (ch === "{") tokens.push({ kind: "lbrace", text: ch, start, end: ++i });
    else if (ch === "}") tokens.push({ kind: "rbrace", text: ch, start, end: ++i });
    else if (ch === ",") tokens.push({ kind: "comma", text: ch, start, end: ++i });
    else if (ch === ":") tokens.push({ kind: "colon", text: ch, start, end: ++i });
    else if (ch === ".") tokens.push({ kind: "dot", text: ch, start, end: ++i });
    else if (ch === ";") tokens.push({ kind: "semicolon", text: ch, start, end: ++i });
    else if (ch === "|") tokens.push({ kind: "pipe", text: ch, start, end: ++i });
    else if (ch === "=") tokens.push({ kind: "equals", text: ch, start, end: ++i });
    else if (symbolicOperators.has(ch)) tokens.push({ kind: "operator", text: ch, start, end: ++i });
    else throw new OJamlError(`Unexpected character '${ch}'`, start, start + 1);
  }

  tokens.push({ kind: "eof", text: "", start: source.length, end: source.length });
  return tokens;
}

function readString(source: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let value = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\"") return { value, end: i + 1 };
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) break;
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "r") value += "\r";
      else if (next === "\"" || next === "\\") value += next;
      else throw new OJamlError(`Unknown string escape '\\${next}'`, i, i + 2);
      i += 2;
      continue;
    }
    value += ch;
    i++;
  }
  throw new OJamlError("Unterminated string literal", start, source.length);
}

function skipComment(source: string, i: number): number {
  let depth = 1;
  while (i < source.length) {
    if (source[i] === "(" && source[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (source[i] === "*" && source[i + 1] === ")") {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  throw new OJamlError("Unterminated comment", source.length - 1, source.length);
}
