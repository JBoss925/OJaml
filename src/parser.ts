import type { BinaryOp, Declaration, Expr, MatchArm, Pattern, Program, TopLevelDeclaration, TypeDeclaration, TypeExpr } from "./ast";
import { OJamlError } from "./errors";
import { lex, type Token } from "./lexer";

const expressionTerminators = new Set(["then", "else", "in", "with"]);

export function parse(source: string): Program {
  return new Parser(lex(source)).parseProgram();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const declarations: TopLevelDeclaration[] = [];
    while (!this.at("eof")) {
      if (this.match("semicolon2")) continue;
      declarations.push(this.at("keyword", "type") ? this.parseTypeDeclaration() : this.parseDeclaration());
      this.match("semicolon2");
    }
    return { declarations };
  }

  private parseTypeDeclaration(): TypeDeclaration {
    const start = this.expectKeyword("type").start;
    const nameToken = this.expect("ident", "Expected type name after type");
    this.expect("equals", "Expected '=' in type declaration");
    this.expect("lbrace", "Expected record type body");
    const fields: Array<{ name: string; nameSpan: { start: number; end: number }; type: TypeExpr }> = [];
    if (!this.at("rbrace")) {
      do {
        const field = this.expect("ident", "Expected record field name");
        this.expect("colon", "Expected ':' in record type field");
        fields.push({ name: field.text, nameSpan: { start: field.start, end: field.end }, type: this.parseTypeExpr() });
      } while (this.match("semicolon"));
    }
    this.expect("rbrace", "Expected '}' in type declaration");
    this.ensureUniqueFields(fields.map((field) => field.name), start, this.previous().end);
    return { kind: "Type", name: nameToken.text, nameSpan: { start: nameToken.start, end: nameToken.end }, fields, span: { start, end: this.previous().end } };
  }

  private parseDeclaration(): Declaration {
    const start = this.expectKeyword("let").start;
    const recursive = this.matchKeyword("rec");
    const nameToken = this.expect("ident", "Expected binding name after let");
    const name = nameToken.text;
    const params: string[] = [];
    const paramSpans = [];
    while (this.at("ident")) {
      const param = this.advance();
      params.push(param.text);
      paramSpans.push({ start: param.start, end: param.end });
    }
    const annotation = this.match("colon") ? this.parseTypeExpr() : undefined;
    this.expect("equals", "Expected '=' in let binding");
    const value = this.parseExpr();
    return {
      kind: "Let",
      recursive,
      name,
      nameSpan: { start: nameToken.start, end: nameToken.end },
      params,
      paramSpans,
      annotation,
      value,
      span: { start, end: value.span.end },
    };
  }

  private parseExpr(): Expr {
    if (this.matchKeyword("if")) return this.parseIf(this.previous().start);
    if (this.matchKeyword("let")) return this.parseLetIn(this.previous().start);
    if (this.matchKeyword("fun")) return this.parseFun(this.previous().start);
    if (this.matchKeyword("match")) return this.parseMatch(this.previous().start);
    return this.parseBinary(0);
  }

  private parseIf(start: number): Expr {
    const condition = this.parseExpr();
    this.expectKeyword("then");
    const thenBranch = this.parseExpr();
    this.expectKeyword("else");
    const elseBranch = this.parseExpr();
    return { kind: "If", condition, thenBranch, elseBranch, span: { start, end: elseBranch.span.end } };
  }

  private parseLetIn(start: number): Expr {
    const recursive = this.matchKeyword("rec");
    const nameToken = this.expect("ident", "Expected local binding name");
    const name = nameToken.text;
    const params: string[] = [];
    const paramSpans = [];
    while (this.at("ident")) {
      const param = this.advance();
      params.push(param.text);
      paramSpans.push({ start: param.start, end: param.end });
    }
    const annotation = this.match("colon") ? this.parseTypeExpr() : undefined;
    this.expect("equals", "Expected '=' in local let");
    const parsedValue = this.parseExpr();
    const value: Expr = params.length > 0
      ? { kind: "Fun", params, paramSpans, body: parsedValue, span: { start: paramSpans[0].start, end: parsedValue.span.end } }
      : parsedValue;
    this.expectKeyword("in");
    const body = this.parseExpr();
    return { kind: "LetIn", recursive, name, nameSpan: { start: nameToken.start, end: nameToken.end }, annotation, value, body, span: { start, end: body.span.end } };
  }

  private parseTypeExpr(): TypeExpr {
    const token = this.peek();
    if (this.match("ident")) return { kind: "TName", name: token.text, span: { start: token.start, end: token.end } };
    if (this.match("lparen")) {
      const first = this.parseTypeExpr();
      if (this.match("comma")) {
        const items = [first];
        do {
          items.push(this.parseTypeExpr());
        } while (this.match("comma"));
        this.expect("rparen", "Expected ')' in tuple type");
        return { kind: "TTuple", items, span: { start: token.start, end: this.previous().end } };
      }
      this.expect("rparen", "Expected ')' in type expression");
      return first;
    }
    if (this.match("lbrace")) {
      const fields: Array<{ name: string; nameSpan: { start: number; end: number }; type: TypeExpr }> = [];
      if (!this.at("rbrace")) {
        do {
          const field = this.expect("ident", "Expected record field name");
          this.expect("colon", "Expected ':' in record type field");
          fields.push({ name: field.text, nameSpan: { start: field.start, end: field.end }, type: this.parseTypeExpr() });
        } while (this.match("semicolon"));
      }
      this.expect("rbrace", "Expected '}' in record type");
      this.ensureUniqueFields(fields.map((field) => field.name), token.start, this.previous().end);
      return { kind: "TRecord", fields, span: { start: token.start, end: this.previous().end } };
    }
    throw new OJamlError("Expected type expression", token.start, token.end);
  }

  private parseFun(start: number): Expr {
    const params: string[] = [];
    const paramSpans = [];
    do {
      const param = this.expect("ident", "Expected function parameter");
      params.push(param.text);
      paramSpans.push({ start: param.start, end: param.end });
    } while (this.at("ident"));
    this.expect("arrow", "Expected '->' after function parameters");
    const body = this.parseExpr();
    return { kind: "Fun", params, paramSpans, body, span: { start, end: body.span.end } };
  }

  private parseMatch(start: number): Expr {
    const expr = this.parseExpr();
    this.expectKeyword("with");
    const arms: MatchArm[] = [];
    do {
      const armStart = this.match("pipe") ? this.previous().start : this.peek().start;
      const pattern = this.parsePattern();
      this.expect("arrow", "Expected '->' in match arm");
      const body = this.parseExpr();
      arms.push({ pattern, body, span: { start: armStart, end: body.span.end } });
    } while (this.at("pipe"));
    if (arms.length === 0) throw new OJamlError("Expected at least one match arm", this.peek().start, this.peek().end);
    return { kind: "Match", expr, arms, span: { start, end: arms[arms.length - 1].span.end } };
  }

  private parsePattern(): Pattern {
    return this.parseConsPattern();
  }

  private parseConsPattern(): Pattern {
    const head = this.parseAtomicPattern();
    if (!this.match("coloncolon")) return head;
    const tail = this.parseConsPattern();
    return { kind: "PListCons", head, tail, span: { start: head.span.start, end: tail.span.end } };
  }

  private parseAtomicPattern(): Pattern {
    const token = this.peek();
    if (this.match("operator", "-")) {
      const valueToken = this.peek();
      if (this.match("int")) return { kind: "PInt", value: -Number(valueToken.text), span: { start: token.start, end: valueToken.end } };
      if (this.match("float")) return { kind: "PFloat", value: -Number(valueToken.text), span: { start: token.start, end: valueToken.end } };
      throw new OJamlError("Expected numeric literal after '-' in pattern", token.start, token.end);
    }
    if (this.match("int")) return { kind: "PInt", value: Number(token.text), span: { start: token.start, end: token.end } };
    if (this.match("float")) return { kind: "PFloat", value: Number(token.text), span: { start: token.start, end: token.end } };
    if (this.match("string")) return { kind: "PString", value: token.text, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("true")) return { kind: "PBool", value: true, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("false")) return { kind: "PBool", value: false, span: { start: token.start, end: token.end } };
    if (this.match("ident")) {
      if (token.text === "_") return { kind: "PWildcard", span: { start: token.start, end: token.end } };
      return { kind: "PVar", name: token.text, span: { start: token.start, end: token.end } };
    }
    if (this.match("lbrace")) {
      const fields: Array<{ name: string; nameSpan: { start: number; end: number }; pattern: Pattern }> = [];
      if (!this.at("rbrace")) {
        do {
          const field = this.expect("ident", "Expected record field name");
          this.expect("equals", "Expected '=' in record pattern");
          fields.push({ name: field.text, nameSpan: { start: field.start, end: field.end }, pattern: this.parsePattern() });
        } while (this.match("semicolon"));
      }
      this.expect("rbrace", "Expected '}' in record pattern");
      this.ensureUniqueFields(fields.map((field) => field.name), token.start, this.previous().end);
      return { kind: "PRecord", fields, span: { start: token.start, end: this.previous().end } };
    }
    if (this.match("lbracket")) {
      if (this.match("operator", "||")) {
        this.expect("rbracket", "Expected ']' in empty array pattern");
        return { kind: "PArray", items: [], span: { start: token.start, end: this.previous().end } };
      }
      if (this.match("pipe")) {
        const items: Pattern[] = [];
        if (!this.at("pipe")) {
          do {
            items.push(this.parsePattern());
          } while (this.match("semicolon"));
        }
        this.expect("pipe", "Expected '|]' in array pattern");
        this.expect("rbracket", "Expected '|]' in array pattern");
        return { kind: "PArray", items, span: { start: token.start, end: this.previous().end } };
      }
      this.expect("rbracket", "Expected ']' in empty list pattern");
      return { kind: "PListNil", span: { start: token.start, end: this.previous().end } };
    }
    if (this.match("lparen")) {
      if (this.match("rparen")) return { kind: "PUnit", span: { start: token.start, end: this.previous().end } };
      const pattern = this.parsePattern();
      if (this.match("comma")) {
        const items = [pattern];
        do {
          items.push(this.parsePattern());
        } while (this.match("comma"));
        this.expect("rparen", "Expected ')' in tuple pattern");
        return { kind: "PTuple", items, span: { start: token.start, end: this.previous().end } };
      }
      this.expect("rparen", "Expected ')' in unit pattern");
      return pattern;
    }
    throw new OJamlError("Expected pattern", token.start, token.end);
  }

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseApplication();
    while (true) {
      const token = this.peek();
      const op = this.operatorText(token);
      const precedence = op ? this.precedence(op) : -1;
      if (!op || precedence < minPrecedence) break;
      this.advance();
      const right = this.parseBinary(precedence + (op === "**" ? 0 : 1));
      left = { kind: "Binary", op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private parseApplication(): Expr {
    let expr = this.parseUnary();
    const args: Expr[] = [];
    while (this.canStartApplicationArg(args.length)) args.push(this.parseUnary());
    if (args.length === 0) return expr;
    return { kind: "Call", callee: expr, args, span: { start: expr.span.start, end: args[args.length - 1].span.end } };
  }

  private parseUnary(): Expr {
    if (this.at("operator", "-")) {
      const token = this.peek();
      const next = this.tokens[this.index + 1];
      const afterNumber = this.tokens[this.index + 2];
      if (next && (next.kind === "int" || next.kind === "float") && token.end === next.start && !(afterNumber?.kind === "operator" && afterNumber.text === "**")) {
        this.advance();
        this.advance();
        const atom: Expr = next.kind === "int"
          ? { kind: "Int", value: Number(next.text), span: { start: next.start, end: next.end } }
          : { kind: "Float", value: Number(next.text), span: { start: next.start, end: next.end } };
        return { kind: "Unary", op: "-", expr: atom, span: { start: token.start, end: next.end } };
      }
      const start = this.advance().start;
      const expr = this.parseBinary(this.precedence("**"));
      return { kind: "Unary", op: "-", expr, span: { start, end: expr.span.end } };
    }
    return this.parsePostfix(this.parseAtom());
  }

  private parseAtom(): Expr {
    const token = this.peek();
    if (this.match("int")) return { kind: "Int", value: Number(token.text), span: { start: token.start, end: token.end } };
    if (this.match("float")) return { kind: "Float", value: Number(token.text), span: { start: token.start, end: token.end } };
    if (this.match("string")) return { kind: "String", value: token.text, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("true")) return { kind: "Bool", value: true, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("false")) return { kind: "Bool", value: false, span: { start: token.start, end: token.end } };
    if (this.match("ident")) {
      if (/^[a-z_]/.test(token.text) && token.text.includes(".")) return this.parseDottedFieldAccess(token);
      return { kind: "Var", name: token.text, span: { start: token.start, end: token.end } };
    }
    if (this.match("lbrace")) return this.parseRecord(token.start);
    if (this.match("lparen")) {
      if (this.match("rparen")) return { kind: "Unit", span: { start: token.start, end: this.previous().end } };
      const expr = this.parseExpr();
      if (this.match("comma")) {
        const items = [expr];
        do {
          items.push(this.parseExpr());
        } while (this.match("comma"));
        this.expect("rparen", "Expected ')'");
        return { kind: "Tuple", items, span: { start: token.start, end: this.previous().end } };
      }
      this.expect("rparen", "Expected ')'");
      return expr;
    }
    throw new OJamlError("Expected expression", token.start, token.end);
  }

  private parsePostfix(expr: Expr): Expr {
    let current = expr;
    while (this.match("dot")) {
      if (this.at("int")) {
        const index = this.advance();
        current = {
          kind: "TupleAccess",
          tuple: current,
          index: Number(index.text),
          indexSpan: { start: index.start, end: index.end },
          span: { start: current.span.start, end: index.end },
        };
      } else {
        const field = this.expect("ident", "Expected field name or tuple index after '.'");
        current = {
          kind: "FieldAccess",
          record: current,
          field: field.text,
          fieldSpan: { start: field.start, end: field.end },
          span: { start: current.span.start, end: field.end },
        };
      }
    }
    return current;
  }

  private operatorText(token: Token): BinaryOp | undefined {
    if (token.kind === "equals") return "=";
    if (token.kind === "operator") return token.text as BinaryOp;
    if (token.kind === "keyword" && token.text === "mod") return "mod";
    return undefined;
  }

  private parseRecord(start: number): Expr {
    const fields: Array<{ name: string; nameSpan: { start: number; end: number }; value: Expr }> = [];
    if (!this.at("rbrace")) {
      do {
        const field = this.expect("ident", "Expected record field name");
        this.expect("equals", "Expected '=' in record expression");
        fields.push({ name: field.text, nameSpan: { start: field.start, end: field.end }, value: this.parseExpr() });
      } while (this.match("semicolon"));
    }
    this.expect("rbrace", "Expected '}' in record expression");
    this.ensureUniqueFields(fields.map((field) => field.name), start, this.previous().end);
    return { kind: "Record", fields, span: { start, end: this.previous().end } };
  }

  private parseDottedFieldAccess(token: Token): Expr {
    const parts = token.text.split(".");
    let cursor = token.start;
    let expr: Expr = { kind: "Var", name: parts[0], span: { start: token.start, end: token.start + parts[0].length } };
    cursor += parts[0].length;
    for (const part of parts.slice(1)) {
      const partStart = cursor + 1;
      const partEnd = partStart + part.length;
      expr = /^[0-9]+$/.test(part)
        ? {
          kind: "TupleAccess",
          tuple: expr,
          index: Number(part),
          indexSpan: { start: partStart, end: partEnd },
          span: { start: expr.span.start, end: partEnd },
        }
        : {
          kind: "FieldAccess",
          record: expr,
          field: part,
          fieldSpan: { start: partStart, end: partEnd },
          span: { start: expr.span.start, end: partEnd },
        };
      cursor = partEnd;
    }
    return expr;
  }

  private ensureUniqueFields(fields: string[], start: number, end: number): void {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field)) throw new OJamlError(`Duplicate record field '${field}'`, start, end);
      seen.add(field);
    }
  }

  private precedence(op: BinaryOp): number {
    if (op === "||") return 1;
    if (op === "&&") return 2;
    if (["=", "<>", "<", "<=", ">", ">="].includes(op)) return 3;
    if (op === "+" || op === "-") return 4;
    if (op === "*" || op === "/" || op === "mod") return 5;
    return 6;
  }

  private canStartAtom(): boolean {
    const token = this.peek();
    if (token.kind === "int" || token.kind === "float" || token.kind === "string" || token.kind === "ident" || token.kind === "lparen" || token.kind === "lbrace") return true;
    if (token.kind === "keyword" && ["true", "false"].includes(token.text)) return true;
    if (token.kind === "keyword" && expressionTerminators.has(token.text)) return false;
    return false;
  }

  private canStartApplicationArg(argCount: number): boolean {
    const token = this.peek();
    const next = this.tokens[this.index + 1];
    if (argCount === 0 && token.kind === "operator" && token.text === "-" && next && (next.kind === "int" || next.kind === "float") && token.end === next.start) {
      return true;
    }
    return this.canStartAtom();
  }

  private expectKeyword(text: string): Token {
    const token = this.peek();
    if (token.kind === "keyword" && token.text === text) return this.advance();
    throw new OJamlError(`Expected '${text}'`, token.start, token.end);
  }

  private matchKeyword(text: string): boolean {
    if (this.peek().kind === "keyword" && this.peek().text === text) {
      this.advance();
      return true;
    }
    return false;
  }

  private at(kind: Token["kind"], text?: string): boolean {
    const token = this.peek();
    return token.kind === kind && (text === undefined || token.text === text);
  }

  private match(kind: Token["kind"], text?: string): boolean {
    if (!this.at(kind, text)) return false;
    this.advance();
    return true;
  }

  private expect(kind: Token["kind"], message: string): Token {
    const token = this.peek();
    if (token.kind === kind) return this.advance();
    throw new OJamlError(message, token.start, token.end);
  }

  private advance(): Token {
    return this.tokens[this.index++];
  }

  private previous(): Token {
    return this.tokens[this.index - 1];
  }

  private peek(): Token {
    return this.tokens[this.index];
  }
}
