import type { BinaryOp, Declaration, Expr, MatchArm, Pattern, Program } from "./ast";
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
    const declarations: Declaration[] = [];
    while (!this.at("eof")) {
      if (this.match("semicolon2")) continue;
      declarations.push(this.parseDeclaration());
      this.match("semicolon2");
    }
    return { declarations };
  }

  private parseDeclaration(): Declaration {
    const start = this.expectKeyword("let").start;
    const recursive = this.matchKeyword("rec");
    const name = this.expect("ident", "Expected binding name after let").text;
    const params: string[] = [];
    while (this.at("ident")) params.push(this.advance().text);
    this.expect("equals", "Expected '=' in let binding");
    const value = this.parseExpr();
    return { kind: "Let", recursive, name, params, value, span: { start, end: value.span.end } };
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
    if (this.matchKeyword("rec")) throw new OJamlError("Local let rec is not implemented yet", this.previous().start, this.previous().end);
    const name = this.expect("ident", "Expected local binding name").text;
    this.expect("equals", "Expected '=' in local let");
    const value = this.parseExpr();
    this.expectKeyword("in");
    const body = this.parseExpr();
    return { kind: "LetIn", name, value, body, span: { start, end: body.span.end } };
  }

  private parseFun(start: number): Expr {
    const params: string[] = [];
    do {
      params.push(this.expect("ident", "Expected function parameter").text);
    } while (this.at("ident"));
    this.expect("arrow", "Expected '->' after function parameters");
    const body = this.parseExpr();
    return { kind: "Fun", params, body, span: { start, end: body.span.end } };
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
    const token = this.peek();
    if (this.match("int")) return { kind: "PInt", value: Number(token.text), span: { start: token.start, end: token.end } };
    if (this.match("string")) return { kind: "PString", value: token.text, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("true")) return { kind: "PBool", value: true, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("false")) return { kind: "PBool", value: false, span: { start: token.start, end: token.end } };
    if (this.match("ident")) {
      if (token.text === "_") return { kind: "PWildcard", span: { start: token.start, end: token.end } };
      return { kind: "PVar", name: token.text, span: { start: token.start, end: token.end } };
    }
    if (this.match("lparen")) {
      this.expect("rparen", "Expected ')' in unit pattern");
      return { kind: "PUnit", span: { start: token.start, end: this.previous().end } };
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
      const right = this.parseBinary(precedence + 1);
      left = { kind: "Binary", op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private parseApplication(): Expr {
    let expr = this.parseUnary();
    const args: Expr[] = [];
    while (this.canStartAtom()) args.push(this.parseUnary());
    if (args.length === 0) return expr;
    return { kind: "Call", callee: expr, args, span: { start: expr.span.start, end: args[args.length - 1].span.end } };
  }

  private parseUnary(): Expr {
    if (this.at("operator", "-")) {
      const start = this.advance().start;
      const expr = this.parseUnary();
      return { kind: "Unary", op: "-", expr, span: { start, end: expr.span.end } };
    }
    return this.parseAtom();
  }

  private parseAtom(): Expr {
    const token = this.peek();
    if (this.match("int")) return { kind: "Int", value: Number(token.text), span: { start: token.start, end: token.end } };
    if (this.match("string")) return { kind: "String", value: token.text, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("true")) return { kind: "Bool", value: true, span: { start: token.start, end: token.end } };
    if (this.matchKeyword("false")) return { kind: "Bool", value: false, span: { start: token.start, end: token.end } };
    if (this.match("ident")) return { kind: "Var", name: token.text, span: { start: token.start, end: token.end } };
    if (this.match("lparen")) {
      if (this.match("rparen")) return { kind: "Unit", span: { start: token.start, end: this.previous().end } };
      const expr = this.parseExpr();
      this.expect("rparen", "Expected ')'");
      return expr;
    }
    throw new OJamlError("Expected expression", token.start, token.end);
  }

  private operatorText(token: Token): BinaryOp | undefined {
    if (token.kind === "equals") return "=";
    if (token.kind === "operator") return token.text as BinaryOp;
    if (token.kind === "keyword" && token.text === "mod") return "mod";
    return undefined;
  }

  private precedence(op: BinaryOp): number {
    if (op === "||") return 1;
    if (op === "&&") return 2;
    if (["=", "<>", "<", "<=", ">", ">="].includes(op)) return 3;
    if (op === "+" || op === "-") return 4;
    return 5;
  }

  private canStartAtom(): boolean {
    const token = this.peek();
    if (token.kind === "int" || token.kind === "string" || token.kind === "ident" || token.kind === "lparen") return true;
    if (token.kind === "keyword" && ["true", "false"].includes(token.text)) return true;
    if (token.kind === "keyword" && expressionTerminators.has(token.text)) return false;
    return false;
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
