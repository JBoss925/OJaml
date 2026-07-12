import type { BinaryOp, Declaration, Expr, MatchArm, ModuleDeclaration, OpenDeclaration, Pattern, Program, TopLevelDeclaration, TypeDeclaration, TypeExpr } from "./ast";
import { OJamlError } from "./errors";
import { lex, type Token } from "./lexer";

const expressionTerminators = new Set(["then", "else", "in", "with", "end"]);

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
      if (this.at("keyword", "type")) declarations.push(this.parseTypeDeclaration());
      else if (this.at("keyword", "open")) declarations.push(this.parseOpenDeclaration());
      else if (this.at("keyword", "module")) declarations.push(this.parseModuleDeclaration());
      else declarations.push(this.parseDeclaration());
      this.match("semicolon2");
    }
    return { declarations };
  }

  private parseOpenDeclaration(): OpenDeclaration {
    const start = this.expectKeyword("open").start;
    const module = this.expect("ident", "Expected module name after open");
    return {
      kind: "Open",
      module: module.text,
      moduleSpan: { start: module.start, end: module.end },
      span: { start, end: module.end },
    };
  }

  private parseModuleDeclaration(): ModuleDeclaration {
    const start = this.expectKeyword("module").start;
    const nameToken = this.expect("ident", "Expected module name after module");
    if (!/^[A-Z]/.test(nameToken.text)) {
      throw new OJamlError("Module names must start with an uppercase letter", nameToken.start, nameToken.end);
    }
    this.expect("equals", "Expected '=' in module declaration");
    this.expectKeyword("struct");
    const declarations: Declaration[] = [];
    while (!this.at("keyword", "end")) {
      if (this.at("eof")) throw new OJamlError("Expected 'end' to close module", nameToken.start, nameToken.end);
      if (this.at("keyword", "type") || this.at("keyword", "open") || this.at("keyword", "module")) {
        throw new OJamlError("Only value bindings are supported inside modules", this.peek().start, this.peek().end);
      }
      const declaration = this.parseDeclaration(`${nameToken.text}.`);
      declarations.push(declaration);
      this.match("semicolon2");
    }
    const end = this.expectKeyword("end").end;
    return {
      kind: "Module",
      name: nameToken.text,
      nameSpan: { start: nameToken.start, end: nameToken.end },
      declarations,
      span: { start, end },
    };
  }

  private parseTypeDeclaration(): TypeDeclaration {
    const start = this.expectKeyword("type").start;
    const params = this.parseTypeParams();
    const nameToken = this.expect("ident", "Expected type name after type");
    this.expect("equals", "Expected '=' in type declaration");
    if (!this.at("lbrace")) {
      const constructors: Array<{ name: string; nameSpan: { start: number; end: number }; payload?: TypeExpr }> = [];
      do {
        this.match("pipe");
        const constructor = this.expect("ident", "Expected variant constructor name");
        if (!/^[A-Z]/.test(constructor.text)) {
          throw new OJamlError("Variant constructor names must start with an uppercase letter", constructor.start, constructor.end);
        }
        const payload = this.matchKeyword("of") ? this.parseTypeExpr() : undefined;
        constructors.push({ name: constructor.text, nameSpan: { start: constructor.start, end: constructor.end }, payload });
      } while (this.at("pipe"));
      if (constructors.length === 0) throw new OJamlError("Expected variant constructor", nameToken.end, nameToken.end);
      this.ensureUniqueFields(constructors.map((constructor) => constructor.name), start, this.previous().end);
      return { kind: "Type", name: nameToken.text, nameSpan: { start: nameToken.start, end: nameToken.end }, params, body: { kind: "Variant", constructors }, span: { start, end: this.previous().end } };
    }
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
    return { kind: "Type", name: nameToken.text, nameSpan: { start: nameToken.start, end: nameToken.end }, params, body: { kind: "Record", fields }, span: { start, end: this.previous().end } };
  }

  private parseTypeParams(): Array<{ name: string; span: { start: number; end: number } }> {
    const params: Array<{ name: string; span: { start: number; end: number } }> = [];
    if (this.at("typevar")) {
      const param = this.advance();
      params.push({ name: param.text, span: { start: param.start, end: param.end } });
      return params;
    }
    if (!this.at("lparen") || this.tokens[this.index + 1]?.kind !== "typevar") return params;
    this.advance();
    do {
      const param = this.expect("typevar", "Expected type parameter");
      params.push({ name: param.text, span: { start: param.start, end: param.end } });
    } while (this.match("comma"));
    this.expect("rparen", "Expected ')' after type parameters");
    return params;
  }

  private parseDeclaration(namePrefix = ""): Declaration {
    const start = this.expectKeyword("let").start;
    const recursive = this.matchKeyword("rec");
    const nameToken = this.expect("ident", "Expected binding name after let");
    const name = `${namePrefix}${nameToken.text}`;
    const params: string[] = [];
    const paramSpans = [];
    const paramAnnotations = [];
    while (this.canStartParam()) {
      const param = this.parseParam();
      params.push(param.name);
      paramSpans.push(param.span);
      paramAnnotations.push(param.annotation);
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
      paramAnnotations,
      annotation,
      value,
      span: { start, end: value.span.end },
    };
  }

  private parseExpr(): Expr {
    return this.parseSequence();
  }

  private parseSequence(): Expr {
    const first = this.parseNonSequence();
    if (!this.match("semicolon")) return first;
    const second = this.parseSequence();
    return { kind: "Sequence", first, second, span: { start: first.span.start, end: second.span.end } };
  }

  private parseNonSequence(): Expr {
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
    const paramAnnotations = [];
    while (this.canStartParam()) {
      const param = this.parseParam();
      params.push(param.name);
      paramSpans.push(param.span);
      paramAnnotations.push(param.annotation);
    }
    const annotation = this.match("colon") ? this.parseTypeExpr() : undefined;
    this.expect("equals", "Expected '=' in local let");
    const parsedValue = this.parseExpr();
    const value: Expr = params.length > 0
      ? { kind: "Fun", params, paramSpans, paramAnnotations, body: parsedValue, span: { start: paramSpans[0].start, end: parsedValue.span.end } }
      : parsedValue;
    this.expectKeyword("in");
    const body = this.parseExpr();
    return { kind: "LetIn", recursive, name, nameSpan: { start: nameToken.start, end: nameToken.end }, annotation, value, body, span: { start, end: body.span.end } };
  }

  private parseTypeExpr(): TypeExpr {
    let type = this.parseTypeAtom();
    while (this.at("ident") && this.canContinueTypeApplication()) {
      const token = this.advance();
      const name = token.text;
      const args = type.kind === "TTuple" && (name === "map" || !["array", "list", "set"].includes(name)) ? type.items : [type];
      if (name === "map" && args.length !== 2) throw new OJamlError("Map type expects a pair type such as (string, int) map", token.start, token.end);
      type = { kind: "TApp", name, args, span: { start: type.span.start, end: token.end } };
    }
    return type;
  }

  private canContinueTypeApplication(): boolean {
    const text = this.peek().text;
    if (["array", "list", "set", "map"].includes(text)) return true;
    return !["int", "float", "bool", "string", "unit"].includes(text);
  }

  private parseTypeAtom(): TypeExpr {
    const token = this.peek();
    if (this.match("typevar")) return { kind: "TVar", name: token.text, span: { start: token.start, end: token.end } };
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
    const paramAnnotations = [];
    do {
      const param = this.parseParam();
      params.push(param.name);
      paramSpans.push(param.span);
      paramAnnotations.push(param.annotation);
    } while (this.canStartParam());
    this.expect("arrow", "Expected '->' after function parameters");
    const body = this.parseExpr();
    return { kind: "Fun", params, paramSpans, paramAnnotations, body, span: { start, end: body.span.end } };
  }

  private canStartParam(): boolean {
    if (this.at("ident")) return true;
    if (!this.at("lparen")) return false;
    const next = this.tokens[this.index + 1];
    const after = this.tokens[this.index + 2];
    return next?.kind === "ident" && after?.kind === "colon";
  }

  private parseParam(): { name: string; span: { start: number; end: number }; annotation?: TypeExpr } {
    if (this.match("lparen")) {
      const name = this.expect("ident", "Expected parameter name");
      this.expect("colon", "Expected ':' in parameter annotation");
      const annotation = this.parseTypeExpr();
      this.expect("rparen", "Expected ')' after parameter annotation");
      return { name: name.text, span: { start: name.start, end: name.end }, annotation };
    }
    const param = this.expect("ident", "Expected parameter name");
    return { name: param.text, span: { start: param.start, end: param.end } };
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
      if (/^[A-Z]/.test(token.text)) {
        const payload = this.canStartAtomicPattern() ? this.parseAtomicPattern() : undefined;
        return { kind: "PConstructor", name: token.text, nameSpan: { start: token.start, end: token.end }, payload, span: { start: token.start, end: payload?.span.end ?? token.end } };
      }
      return { kind: "PVar", name: token.text, span: { start: token.start, end: token.end } };
    }
    if (this.match("lbrace")) {
      if (this.match("pipe")) return this.parseCollectionPattern(token.start);
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

  private canStartAtomicPattern(): boolean {
    if (this.at("int") || this.at("float") || this.at("string") || this.at("ident") || this.at("lbrace") || this.at("lbracket") || this.at("lparen")) return true;
    if (this.at("operator", "-")) return true;
    if (this.at("keyword", "true") || this.at("keyword", "false")) return true;
    return false;
  }

  private parseCollectionPattern(start: number): Pattern {
    if (this.match("pipe")) {
      this.expect("rbrace", "Expected '|}' in set pattern");
      return { kind: "PSet", items: [], span: { start, end: this.previous().end } };
    }
    if (this.match("colon")) {
      this.expect("pipe", "Expected '|}' in empty map pattern");
      this.expect("rbrace", "Expected '|}' in empty map pattern");
      return { kind: "PMap", entries: [], span: { start, end: this.previous().end } };
    }

    const first = this.parsePattern();
    if (this.match("colon")) {
      const entries = [{ key: first, value: this.parsePattern() }];
      while (this.match("semicolon")) {
        if (this.at("pipe")) break;
        const key = this.parsePattern();
        this.expect("colon", "Expected ':' between map key and value pattern");
        entries.push({ key, value: this.parsePattern() });
      }
      this.expect("pipe", "Expected '|}' in map pattern");
      this.expect("rbrace", "Expected '|}' in map pattern");
      return { kind: "PMap", entries, span: { start, end: this.previous().end } };
    }

    const items = [first];
    while (this.match("semicolon")) {
      if (this.at("pipe")) break;
      items.push(this.parsePattern());
    }
    this.expect("pipe", "Expected '|}' in set pattern");
    this.expect("rbrace", "Expected '|}' in set pattern");
    return { kind: "PSet", items, span: { start, end: this.previous().end } };
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
    if (this.matchKeyword("not")) {
      const start = this.previous().start;
      const expr = this.parseUnary();
      return { kind: "Unary", op: "not", expr, span: { start, end: expr.span.end } };
    }
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
        fields.push({ name: field.text, nameSpan: { start: field.start, end: field.end }, value: this.parseNonSequence() });
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
    if (op === "|>") return 0;
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
