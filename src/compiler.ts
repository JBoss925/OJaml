import type { Declaration, Expr, Pattern, Program } from "./ast";
import { check, type CheckedSymbol, type CheckedToken, type OJamlType, type RuntimeMainType } from "./check";
import { parse } from "./parser";

export type CompileResult = {
  ast: Program;
  wat: string;
  mainType: RuntimeMainType;
};

type LambdaInfo = {
  id: number;
  index: number;
  params: string[];
  body: Expr;
  captures: string[];
};

let lambdaInfos: LambdaInfo[] = [];
let nextLambdaId = 0;
let nextTableIndex = 0;
let topLevelClosureIndices = new Map<string, number>();
let topLevelSpecializations = new Map<string, Map<string, string>>();

export function compile(source: string): CompileResult {
  const ast = parse(source);
  const checked = check(ast);
  return { ast, wat: emitWat(ast, checked.symbols, checked.tokens), mainType: checked.mainType };
}

export function emitWat(program: Program, checkedSymbols: CheckedSymbol[] = [], checkedTokens: CheckedToken[] = []): string {
  lambdaInfos = [];
  nextLambdaId = 0;
  nextTableIndex = 0;
  topLevelSpecializations = new Map();
  topLevelClosureIndices = new Map(program.declarations
    .filter((declaration) => declaration.params.length > 0)
    .map((declaration) => [declaration.name, nextTableIndex++]));
  const strings = new StringPool();
  const globals = new Map<string, number>([
    ...builtinArities(),
    ...program.declarations.map((declaration): [string, number] => [declaration.name, declaration.params.length]),
  ]);
  const symbolTypes = collectSymbolTypes(checkedSymbols);
  const tokenTypes = collectTokenTypes(checkedTokens);
  const globalTypes = collectGlobalTypes(program, symbolTypes.globals);
  const callHints = collectTopLevelCallHints(program, globalTypes);
  topLevelSpecializations = collectTopLevelSpecializations(program, callHints, checkedTokens);
  const topLevelWrapperNames = [
    ...program.declarations.filter((declaration) => declaration.params.length > 0).map((declaration) => declaration.name),
    ...[...topLevelSpecializations.values()].flatMap((variants) => [...variants.values()]),
  ];
  for (const name of topLevelWrapperNames) {
    if (!topLevelClosureIndices.has(name)) topLevelClosureIndices.set(name, nextTableIndex++);
  }
  const declarations = program.declarations.map((declaration) => {
    const checkedLocals = new Map(symbolTypes.locals.get(declaration.name));
    return emitDeclaration(declaration, globals, globalTypes, strings, checkedLocals, tokenTypes);
  }).join("\n\n");
  const specializedDeclarations = emitTopLevelSpecializations(program, globals, globalTypes, strings, tokenTypes);
  const lambdas = emitPendingLambdas(globals, globalTypes, strings, tokenTypes);
  const dataSegments = strings.emitDataSegments();
  const tableEntries = [
    ...topLevelWrapperNames.map((name) => `$__closure_${safe(name)}`),
    ...lambdaInfos.sort((left, right) => left.index - right.index).map((lambda) => `$__lambda_${lambda.id}`),
  ];
  return `(module
  (type $fn_1 (func (param i32 i32) (result i32)))
  (type $fn_2 (func (param i32 i32 i32) (result i32)))
  (type $fn_3 (func (param i32 i32 i32 i32) (result i32)))
  (import "env" "print_i32" (func $print_i32 (param i32)))
  (import "env" "print_f64" (func $print_f64 (param f64)))
  (import "env" "print_string" (func $print_string (param i32)))
  (import "env" "string_concat" (func $host_string_concat (param i32 i32) (result i32)))
  (import "env" "string_length" (func $host_string_length (param i32) (result i32)))
  (import "env" "string_split" (func $host_string_split (param i32 i32) (result i32)))
  (import "env" "to_string" (func $host_to_string (param i32 i32) (result i32)))
  (import "env" "pow_f64" (func $host_pow_f64 (param f64 f64) (result f64)))
  (memory (export "memory") 1)
  (table ${Math.max(1, tableEntries.length)} funcref)
  (global $heap (mut i32) (i32.const 8192))

${indent(emitStdlibWat(), 2)}

${indent(emitTopLevelClosureWrappers(program), 2)}

${indent([declarations, specializedDeclarations].filter(Boolean).join("\n\n"), 2)}
${lambdas ? `\n${indent(lambdas, 2)}\n` : ""}
${dataSegments ? `\n${indent(dataSegments, 2)}\n` : ""}
${tableEntries.length ? `\n  (elem (i32.const 0) ${tableEntries.join(" ")})\n` : ""}

  (export "main" (func $main))
)`;
}

function emitDeclaration(
  declaration: Declaration,
  globals: Map<string, number>,
  globalTypes: Map<string, ValueShape>,
  strings: StringPool,
  checkedLocals = new Map<string, ValueShape>(),
  tokenTypes = new Map<string, ValueShape>(),
  nameOverride = declaration.name,
): string {
  const params = declaration.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
  const locals = collectLocals(declaration);
  for (const param of declaration.params) locals.add(param);
  const localTypes = collectLocalTypes(declaration, globalTypes, checkedLocals);
  const localLines = [...locals].filter((name) => !declaration.params.includes(name)).map((name) => `  (local $${safe(name)} i32)`);
  const body = emitExpr(declaration.value, new EmitContext(globals, locals, localTypes, globalTypes, strings, tokenTypes));
  const head = `(func $${safe(nameOverride)} ${params}${params ? " " : ""}(result i32)`;
  return [head, ...localLines, indent(body, 2), ")"].join("\n");
}

class EmitContext {
  private matchId = 0;
  private callId = 0;
  private tupleId = 0;

  constructor(
    readonly globals: Map<string, number>,
    readonly locals: Set<string>,
    readonly localTypes: Map<string, ValueShape>,
    readonly globalTypes: Map<string, ValueShape>,
    readonly strings: StringPool,
    readonly tokenTypes = new Map<string, ValueShape>(),
    readonly captured = new Map<string, number>(),
  ) {}

  nextMatchLocal(): string {
    return `__match${this.matchId++}`;
  }

  nextCallLocal(): string {
    return `__callee${this.callId++}`;
  }

  nextTupleLocal(): string {
    return `__tuple${this.tupleId++}`;
  }

  exprType(expr: Expr): ValueShape {
    const checked = this.tokenTypes.get(spanKey(expr));
    if (checked && checked.kind !== "unknown") return checked;
    return inferSimpleType(expr, new Map([...this.globalTypes, ...this.localTypes]));
  }
}

function emitExpr(expr: Expr, context: EmitContext): string {
  switch (expr.kind) {
    case "Int":
      return `(i32.const ${expr.value})`;
    case "Float":
      return `(call $box_float (f64.const ${expr.value}))`;
    case "String":
      return `(i32.const ${context.strings.intern(expr.value)})`;
    case "Bool":
      return `(i32.const ${expr.value ? 1 : 0})`;
    case "Unit":
      return `(i32.const 0)`;
    case "Tuple":
      return emitTuple(expr, context);
    case "Var":
      if (context.locals.has(expr.name)) return `(local.get $${safe(expr.name)})`;
      if (context.captured.has(expr.name)) return `(i32.load (i32.add (local.get $__env) (i32.const ${4 + context.captured.get(expr.name)! * 4})))`;
      if (context.globals.get(expr.name) === 0) return `(call $${safe(expr.name)})`;
      if (context.globals.has(expr.name)) return emitTopLevelClosure(functionValueName(expr.name, context.exprType(expr)));
      return `(local.get $${safe(expr.name)})`;
    case "Unary":
      if (context.exprType(expr.expr).kind === "float") return `(call $box_float (f64.neg (call $unbox_float ${emitExpr(expr.expr, context)})))`;
      return `(i32.sub (i32.const 0) ${emitExpr(expr.expr, context)})`;
    case "Binary":
      return emitBinary(expr, context);
    case "If":
      return `(if (result i32) ${emitExpr(expr.condition, context)}
  (then ${emitExpr(expr.thenBranch, context)})
  (else ${emitExpr(expr.elseBranch, context)}))`;
    case "LetIn":
      return `(block (result i32)
  (local.set $${safe(expr.name)} ${emitExpr(expr.value, context)})
  ${emitExpr(expr.body, context)}
)`;
    case "Call":
      if (expr.callee.kind === "Var" && (expr.callee.name === "print" || expr.callee.name === "println")) {
        const argShape = context.exprType(expr.args[0]);
        const newline = expr.callee.name === "println" ? `\n  (call $print_string (i32.const ${context.strings.intern("\n")}))` : "";
        if (argShape.kind === "string") {
          return `(block (result i32)
  (call $print_string ${emitExpr(expr.args[0], context)})${newline}
  (i32.const 0)
)`;
        }
        if (argShape.kind === "float") {
          return `(block (result i32)
  (call $print_f64 (call $unbox_float ${emitExpr(expr.args[0], context)}))${newline}
  (i32.const 0)
)`;
        }
        return `(block (result i32)
  (call $print_i32 ${emitExpr(expr.args[0], context)})${newline}
  (i32.const 0)
)`;
      }
      if (expr.callee.kind === "Var" && expr.callee.name === "to_string") {
        const arg = expr.args[0];
        return `(call $host_to_string ${emitExpr(arg, context)} (i32.const ${context.strings.intern(typeDescriptor(context.exprType(arg)))}))`;
      }
      if (expr.callee.kind === "Var" && (expr.callee.name === "Set.add" || expr.callee.name === "Set.has")) {
        const elementShape = context.exprType(expr.args[1]);
        const helper = elementShape.kind === "float"
          ? `${expr.callee.name}.float`
          : expr.callee.name;
        return `(call $${safe(helper)} ${expr.args.map((arg) => emitExpr(arg, context)).join(" ")})`;
      }
      if (expr.callee.kind === "Var" && (context.locals.has(expr.callee.name) || context.captured.has(expr.callee.name))) {
        return emitIndirectCall(expr.callee, expr.args, context);
      }
      if (expr.callee.kind === "Var" && context.globals.has(expr.callee.name)) {
        const specialization = topLevelSpecializations.get(expr.callee.name)?.get(callShapeKey(expr.args.map((arg) => context.exprType(arg))));
        return `(call $${safe(specialization ?? expr.callee.name)} ${expr.args.map((arg) => emitExpr(arg, context)).join(" ")})`;
      }
      return emitIndirectCall(expr.callee, expr.args, context);
    case "Fun":
      return emitClosure(expr, context);
    case "Match": {
      const local = context.nextMatchLocal();
      return `(block (result i32)
  (local.set $${local} ${emitExpr(expr.expr, context)})
  ${emitMatchArms(local, expr.arms, context, 0)}
)`;
    }
  }
}

function emitTuple(expr: Extract<Expr, { kind: "Tuple" }>, context: EmitContext): string {
  const local = context.nextTupleLocal();
  const stores = expr.items.map((item, index) => `(i32.store (i32.add (local.get $${local}) (i32.const ${4 + index * 4})) ${emitExpr(item, context)})`).join("\n  ");
  return `(block (result i32)
  (local.set $${local} (call $alloc (i32.const ${4 + expr.items.length * 4})))
  (i32.store (local.get $${local}) (i32.const ${expr.items.length}))
  ${stores}
  (local.get $${local})
)`;
}

function emitBinary(expr: Extract<Expr, { kind: "Binary" }>, context: EmitContext): string {
  const leftShape = context.exprType(expr.left);
  const rightShape = context.exprType(expr.right);
  const isFloat = leftShape.kind === "float" || rightShape.kind === "float";
  if (isFloat) {
    const floatOps: Partial<Record<typeof expr.op, string>> = {
      "+": "f64.add",
      "-": "f64.sub",
      "*": "f64.mul",
      "/": "f64.div",
      "**": "host_pow_f64",
      "=": "f64.eq",
      "<>": "f64.ne",
      "<": "f64.lt",
      "<=": "f64.le",
      ">": "f64.gt",
      ">=": "f64.ge",
    };
    const op = floatOps[expr.op];
    if (!op) throw new Error(`Float operator '${expr.op}' is not implemented`);
    const emitted = op === "host_pow_f64"
      ? `(call $host_pow_f64 ${emitF64Operand(expr.left, leftShape, context)} ${emitF64Operand(expr.right, rightShape, context)})`
      : `(${op} ${emitF64Operand(expr.left, leftShape, context)} ${emitF64Operand(expr.right, rightShape, context)})`;
    return ["=", "<>", "<", "<=", ">", ">="].includes(expr.op) ? emitted : `(call $box_float ${emitted})`;
  }
  const left = emitExpr(expr.left, context);
  const right = emitExpr(expr.right, context);
  const op = {
    "+": "i32.add",
    "-": "i32.sub",
    "*": "i32.mul",
    "/": "i32.div_s",
    "**": "pow_i32",
    mod: "i32.rem_s",
    "=": "i32.eq",
    "<>": "i32.ne",
    "<": "i32.lt_s",
    "<=": "i32.le_s",
    ">": "i32.gt_s",
    ">=": "i32.ge_s",
    "&&": "i32.and",
    "||": "i32.or",
  }[expr.op];
  return op === "pow_i32" ? `(call $pow_i32 ${left} ${right})` : `(${op} ${left} ${right})`;
}

function emitF64Operand(expr: Expr, shape: ValueShape, context: EmitContext): string {
  const emitted = emitExpr(expr, context);
  return shape.kind === "int" ? `(f64.convert_i32_s ${emitted})` : `(call $unbox_float ${emitted})`;
}

function emitMatchArms(local: string, arms: { pattern: Pattern; body: Expr }[], context: EmitContext, index: number): string {
  const arm = arms[index];
  if (!arm) return "unreachable";
  if (arm.pattern.kind === "PWildcard") return emitExpr(arm.body, context);
  if (arm.pattern.kind === "PUnit") return emitExpr(arm.body, context);
  if (arm.pattern.kind === "PVar") {
    return `(block (result i32)
  (local.set $${safe(arm.pattern.name)} (local.get $${local}))
  ${emitExpr(arm.body, context)}
)`;
  }
  const test = arm.pattern.kind === "PInt"
    ? `(i32.eq (local.get $${local}) (i32.const ${arm.pattern.value}))`
    : arm.pattern.kind === "PFloat"
      ? `(f64.eq (call $unbox_float (local.get $${local})) (f64.const ${arm.pattern.value}))`
    : arm.pattern.kind === "PString"
      ? `(i32.eq (local.get $${local}) (i32.const ${context.strings.intern(arm.pattern.value)}))`
    : `(i32.eq (local.get $${local}) (i32.const ${arm.pattern.value ? 1 : 0}))`;
  return `(if (result i32) ${test}
  (then ${emitExpr(arm.body, context)})
  (else ${emitMatchArms(local, arms, context, index + 1)}))`;
}

function emitIndirectCall(callee: Expr, args: Expr[], context: EmitContext): string {
  const arity = args.length;
  if (arity < 1 || arity > 3) throw new Error(`Indirect calls with arity ${arity} are not implemented`);
  const calleeLocal = context.nextCallLocal();
  return `(block (result i32)
  (local.set $${calleeLocal} ${emitExpr(callee, context)})
  (call_indirect (type $fn_${arity})
    (local.get $${calleeLocal})
    ${args.map((arg) => emitExpr(arg, context)).join("\n    ")}
    (i32.load (local.get $${calleeLocal})))
)`;
}

function emitTopLevelClosure(name: string): string {
  const index = topLevelClosureIndices.get(name);
  if (index === undefined) throw new Error(`No closure index for ${name}`);
  return `(block (result i32)
  (local.set $__closure (call $alloc (i32.const 4)))
  (i32.store (local.get $__closure) (i32.const ${index}))
  (local.get $__closure)
)`;
}

function emitClosure(expr: Extract<Expr, { kind: "Fun" }>, context: EmitContext): string {
  const captures = [...freeVars(expr.body, new Set(expr.params))].filter((name) => context.locals.has(name) || context.captured.has(name));
  const id = nextLambdaId++;
  const index = nextTableIndex++;
  lambdaInfos.push({ id, index, params: expr.params, body: expr.body, captures });
  const stores = captures.map((name, captureIndex) => {
    const value = context.captured.has(name)
      ? `(i32.load (i32.add (local.get $__env) (i32.const ${4 + context.captured.get(name)! * 4})))`
      : `(local.get $${safe(name)})`;
    return `(i32.store (i32.add (local.get $__closure) (i32.const ${4 + captureIndex * 4})) ${value})`;
  }).join("\n  ");
  return `(block (result i32)
  (local.set $__closure (call $alloc (i32.const ${4 + captures.length * 4})))
  (i32.store (local.get $__closure) (i32.const ${index}))
  ${stores}
  (local.get $__closure)
)`;
}

function emitTopLevelClosureWrappers(program: Program): string {
  const baseWrappers = program.declarations
    .filter((declaration) => declaration.params.length > 0)
    .map((declaration) => {
      const params = declaration.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
      return `(func $__closure_${safe(declaration.name)} (param $__env i32) ${params} (result i32)
  (call $${safe(declaration.name)} ${declaration.params.map((param) => `(local.get $${safe(param)})`).join(" ")})
)`;
    });
  const declarations = new Map(program.declarations.map((declaration) => [declaration.name, declaration]));
  const specializedWrappers = [...topLevelSpecializations.entries()].flatMap(([name, variants]) => {
    const declaration = declarations.get(name);
    if (!declaration) return [];
    const params = declaration.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
    return [...variants.values()].map((specializedName) => `(func $__closure_${safe(specializedName)} (param $__env i32) ${params} (result i32)
  (call $${safe(specializedName)} ${declaration.params.map((param) => `(local.get $${safe(param)})`).join(" ")})
)`);
  });
  return [...baseWrappers, ...specializedWrappers].join("\n\n");
}

function emitPendingLambdas(
  globals: Map<string, number>,
  globalTypes: Map<string, ValueShape>,
  strings: StringPool,
  tokenTypes = new Map<string, ValueShape>(),
): string {
  const emitted: string[] = [];
  let cursor = 0;
  while (cursor < lambdaInfos.length) {
    const lambda = lambdaInfos[cursor++];
    const locals = collectLocalsFromExpr(lambda.body);
    for (const param of lambda.params) locals.add(param);
    locals.add("__closure");
    const localTypes = collectLocalTypesFromExpr(lambda.body, new Map([...globalTypes, ...lambda.params.map((param): [string, ValueShape] => [param, unknownShape])]));
    const captured = new Map(lambda.captures.map((name, index) => [name, index]));
    const localLines = [...locals]
      .filter((name) => !lambda.params.includes(name))
      .map((name) => `  (local $${safe(name)} i32)`);
    const params = lambda.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
    const body = emitExpr(lambda.body, new EmitContext(globals, locals, localTypes, globalTypes, strings, tokenTypes, captured));
    emitted.push([`(func $__lambda_${lambda.id} (param $__env i32) ${params} (result i32)`, ...localLines, indent(body, 2), ")"].join("\n"));
  }
  return emitted.join("\n\n");
}

function collectLocals(declaration: Declaration): Set<string> {
  const locals = new Set<string>();
  locals.add("__closure");
  addCallScratchLocals(locals);
  addTupleScratchLocals(locals);
  walk(declaration.value, locals, { matchId: 0 });
  return locals;
}

function collectLocalsFromExpr(expr: Expr): Set<string> {
  const locals = new Set<string>(["__closure"]);
  addCallScratchLocals(locals);
  addTupleScratchLocals(locals);
  walk(expr, locals, { matchId: 0 });
  return locals;
}

function addCallScratchLocals(locals: Set<string>): void {
  for (let i = 0; i < 16; i++) locals.add(`__callee${i}`);
}

function addTupleScratchLocals(locals: Set<string>): void {
  for (let i = 0; i < 16; i++) locals.add(`__tuple${i}`);
}

type ValueShape =
  | { kind: "int" | "float" | "bool" | "string" | "unit" | "unknown" }
  | { kind: "array" | "list" | "set"; elem: ValueShape }
  | { kind: "tuple"; items: ValueShape[] }
  | { kind: "map"; key: ValueShape; value: ValueShape }
  | { kind: "fn"; result: ValueShape };

const intShape: ValueShape = { kind: "int" };
const floatShape: ValueShape = { kind: "float" };
const boolShape: ValueShape = { kind: "bool" };
const stringShape: ValueShape = { kind: "string" };
const unitShape: ValueShape = { kind: "unit" };
const unknownShape: ValueShape = { kind: "unknown" };

function collectLocalTypes(declaration: Declaration, globalTypes: Map<string, ValueShape>, checkedLocals = new Map<string, ValueShape>()): Map<string, ValueShape> {
  const types = new Map<string, ValueShape>([...globalTypes, ...checkedLocals]);
  for (const param of declaration.params) {
    if (!types.has(param)) types.set(param, unknownShape);
  }
  walkTypes(declaration.value, types);
  return types;
}

function collectSymbolTypes(symbols: CheckedSymbol[]): {
  globals: Map<string, ValueShape>;
  locals: Map<string, Map<string, ValueShape>>;
} {
  const globals = new Map<string, ValueShape>();
  const locals = new Map<string, Map<string, ValueShape>>();
  for (const symbol of symbols) {
    const globalShape = shapeFromDetail(symbol.detail);
    if (globalShape) globals.set(symbol.name, globalShape);
    const localShapes = new Map<string, ValueShape>();
    for (const param of symbol.params ?? []) {
      const shape = shapeFromDetail(param.detail);
      if (shape) localShapes.set(param.name, shape);
    }
    for (const local of symbol.locals ?? []) {
      const shape = shapeFromDetail(local.detail);
      if (shape) localShapes.set(local.name, shape);
    }
    if (localShapes.size > 0) locals.set(symbol.name, localShapes);
  }
  return { globals, locals };
}

function collectTokenTypes(tokens: CheckedToken[]): Map<string, ValueShape> {
  const types = new Map<string, ValueShape>();
  for (const token of tokens) {
    const shape = shapeFromDetail(token.detail);
    if (shape) types.set(`${token.span.start}:${token.span.end}`, shape);
  }
  return types;
}

function shapeFromDetail(detail: string): ValueShape | undefined {
  const type = detail.slice(detail.indexOf(":") + 1).trim();
  return shapeFromTypeText(type);
}

function shapeFromTypeText(type: string): ValueShape {
  if (type.includes("->")) return { kind: "fn", result: shapeFromTypeText(type.split("->").at(-1)!.trim()) };
  if (type === "int") return intShape;
  if (type === "float") return floatShape;
  if (type === "number") return unknownShape;
  if (type === "bool") return boolShape;
  if (type === "string") return stringShape;
  if (type === "unit") return unitShape;
  if (type.endsWith(" array")) return { kind: "array", elem: shapeFromTypeText(type.slice(0, -" array".length).trim()) };
  if (type.endsWith(" list")) return { kind: "list", elem: shapeFromTypeText(type.slice(0, -" list".length).trim()) };
  if (type.endsWith(" set")) return { kind: "set", elem: shapeFromTypeText(type.slice(0, -" set".length).trim()) };
  if (type.startsWith("(") && type.endsWith(") map")) {
    const parts = splitTopLevelComma(type.slice(1, -" map".length - 1));
    if (parts.length === 2) return { kind: "map", key: shapeFromTypeText(parts[0].trim()), value: shapeFromTypeText(parts[1].trim()) };
  }
  if (type.startsWith("(") && type.endsWith(")")) {
    const parts = splitTopLevelComma(type.slice(1, -1));
    if (parts.length > 1) return { kind: "tuple", items: parts.map((part) => shapeFromTypeText(part.trim())) };
  }
  return unknownShape;
}

function splitTopLevelComma(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function typeDescriptor(shape: ValueShape): string {
  switch (shape.kind) {
    case "array":
      return `array(${typeDescriptor(shape.elem)})`;
    case "list":
      return `list(${typeDescriptor(shape.elem)})`;
    case "set":
      return `set(${typeDescriptor(shape.elem)})`;
    case "tuple":
      return `tuple(${shape.items.map(typeDescriptor).join(",")})`;
    case "map":
      return `map(${typeDescriptor(shape.key)},${typeDescriptor(shape.value)})`;
    case "fn":
      return "fn";
    default:
      return shape.kind;
  }
}

function spanKey(expr: Expr): string {
  return `${expr.span.start}:${expr.span.end}`;
}

function functionValueName(name: string, shape: ValueShape): string {
  if (shape.kind !== "fn" || shape.result.kind !== "float") return name;
  const variants = topLevelSpecializations.get(name);
  return variants?.values().next().value ?? name;
}

function collectLocalTypesFromExpr(expr: Expr, types: Map<string, ValueShape>): Map<string, ValueShape> {
  walkTypes(expr, types);
  return types;
}

function collectGlobalTypes(program: Program, checkedGlobals = new Map<string, ValueShape>()): Map<string, ValueShape> {
  const types = new Map<string, ValueShape>([["print", unitShape], ...checkedGlobals]);
  for (const [name] of builtinArities()) types.set(name, builtinReturnShape(name));
  for (const declaration of program.declarations) {
    if (types.has(declaration.name)) continue;
    if (declaration.params.length === 0) {
      types.set(declaration.name, inferSimpleType(declaration.value, types));
    } else {
      types.set(declaration.name, { kind: "fn", result: inferSimpleType(declaration.value, new Map(declaration.params.map((param) => [param, unknownShape]))) });
    }
  }
  return types;
}

function collectTopLevelCallHints(program: Program, globalTypes: Map<string, ValueShape>): Map<string, ValueShape[]> {
  const declarations = new Map(program.declarations.map((declaration) => [declaration.name, declaration]));
  const hints = new Map<string, ValueShape[]>();
  const visit = (expr: Expr, localTypes: Map<string, ValueShape>) => {
    if (expr.kind === "Call" && expr.callee.kind === "Var" && declarations.has(expr.callee.name)) {
      const existing = hints.get(expr.callee.name) ?? [];
      expr.args.forEach((arg, index) => {
        const shape = inferSimpleType(arg, new Map([...globalTypes, ...localTypes]));
        if (shape.kind === "float") existing[index] = floatShape;
        if (shape.kind === "int" && !existing[index]) existing[index] = intShape;
      });
      hints.set(expr.callee.name, existing);
    }
    switch (expr.kind) {
      case "LetIn": {
        const nested = new Map(localTypes);
        nested.set(expr.name, inferSimpleType(expr.value, new Map([...globalTypes, ...localTypes])));
        visit(expr.value, localTypes);
        visit(expr.body, nested);
        break;
      }
      case "Binary":
        visit(expr.left, localTypes);
        visit(expr.right, localTypes);
        break;
      case "Unary":
        visit(expr.expr, localTypes);
        break;
      case "If":
        visit(expr.condition, localTypes);
        visit(expr.thenBranch, localTypes);
        visit(expr.elseBranch, localTypes);
        break;
      case "Call":
        visit(expr.callee, localTypes);
        expr.args.forEach((arg) => visit(arg, localTypes));
        break;
      case "Fun":
        visit(expr.body, localTypes);
        break;
      case "Match":
        visit(expr.expr, localTypes);
        expr.arms.forEach((arm) => visit(arm.body, localTypes));
        break;
    }
  };
  for (const declaration of program.declarations) {
    visit(declaration.value, new Map(declaration.params.map((param): [string, ValueShape] => [param, unknownShape])));
  }
  return hints;
}

function collectTopLevelSpecializations(program: Program, hints: Map<string, ValueShape[]>, tokens: CheckedToken[] = []): Map<string, Map<string, string>> {
  const declarations = new Map(program.declarations.map((declaration) => [declaration.name, declaration]));
  const specializations = new Map<string, Map<string, string>>();
  const addSpecialization = (name: string, shapes: ValueShape[]): void => {
    const declaration = declarations.get(name);
    if (!declaration || !shapes.some((shape) => shape?.kind === "float")) return;
    const key = callShapeKey(declaration.params.map((_, index) => shapes[index] ?? intShape));
    const variants = specializations.get(name) ?? new Map<string, string>();
    variants.set(key, `${name}__${key.replaceAll(",", "_")}`);
    specializations.set(name, variants);
  };
  for (const [name, shapes] of hints) {
    addSpecialization(name, shapes);
  }
  for (const token of tokens) {
    if (!declarations.has(token.name)) continue;
    const shape = shapeFromDetail(token.detail);
    if (shape?.kind === "fn" && shape.result.kind === "float") {
      addSpecialization(token.name, declarations.get(token.name)!.params.map(() => floatShape));
    }
  }
  return specializations;
}

function emitTopLevelSpecializations(
  program: Program,
  globals: Map<string, number>,
  globalTypes: Map<string, ValueShape>,
  strings: StringPool,
  tokenTypes = new Map<string, ValueShape>(),
): string {
  const declarations = new Map(program.declarations.map((declaration) => [declaration.name, declaration]));
  const emitted: string[] = [];
  for (const [name, variants] of topLevelSpecializations) {
    const declaration = declarations.get(name);
    if (!declaration) continue;
    for (const [key, specializedName] of variants) {
      const shapes = key.split(",").map((shape) => shape === "float" ? floatShape : intShape);
      const checkedLocals = new Map(declaration.params.map((param, index): [string, ValueShape] => [param, shapes[index] ?? intShape]));
      emitted.push(emitDeclaration(declaration, globals, globalTypes, strings, checkedLocals, tokenTypes, specializedName));
    }
  }
  return emitted.join("\n\n");
}

function callShapeKey(shapes: ValueShape[]): string {
  return shapes.map((shape) => shape.kind === "float" ? "float" : "int").join(",");
}

function applyCallHintsToGlobalTypes(program: Program, globalTypes: Map<string, ValueShape>, hints: Map<string, ValueShape[]>): void {
  for (const declaration of program.declarations) {
    const params = hints.get(declaration.name);
    if (!params?.some((shape) => shape?.kind === "float")) continue;
    const paramTypes = new Map(declaration.params.map((param, index): [string, ValueShape] => [param, params[index] ?? unknownShape]));
    const result = inferSimpleType(declaration.value, new Map([...globalTypes, ...paramTypes]));
    globalTypes.set(declaration.name, { kind: "fn", result: result.kind === "int" || result.kind === "unknown" ? floatShape : result });
  }
}

function walkTypes(expr: Expr, types: Map<string, ValueShape>): void {
  switch (expr.kind) {
    case "LetIn":
      types.set(expr.name, inferSimpleType(expr.value, types));
      walkTypes(expr.value, types);
      walkTypes(expr.body, types);
      break;
    case "Binary":
      walkTypes(expr.left, types);
      walkTypes(expr.right, types);
      break;
    case "Tuple":
      expr.items.forEach((item) => walkTypes(item, types));
      break;
    case "Unary":
      walkTypes(expr.expr, types);
      break;
    case "If":
      walkTypes(expr.condition, types);
      walkTypes(expr.thenBranch, types);
      walkTypes(expr.elseBranch, types);
      break;
    case "Call":
      walkTypes(expr.callee, types);
      expr.args.forEach((arg) => walkTypes(arg, types));
      break;
    case "Fun":
      walkTypes(expr.body, types);
      break;
    case "Match":
      walkTypes(expr.expr, types);
      expr.arms.forEach((arm) => walkTypes(arm.body, types));
      break;
  }
}

function inferSimpleType(expr: Expr, types: Map<string, ValueShape>): ValueShape {
  switch (expr.kind) {
    case "String":
      return stringShape;
    case "Float":
      return floatShape;
    case "Bool":
      return boolShape;
    case "Unit":
      return unitShape;
    case "Tuple":
      return { kind: "tuple", items: expr.items.map((item) => inferSimpleType(item, types)) };
    case "Var":
      return types.get(expr.name) ?? intShape;
    case "If":
      return inferSimpleType(expr.thenBranch, types);
    case "LetIn":
      return inferSimpleType(expr.body, types);
    case "Call":
      return inferCallShape(expr, types);
    case "Match":
      return inferSimpleType(expr.arms[0].body, types);
    case "Binary":
      if (["=", "<>", "<", "<=", ">", ">=", "&&", "||"].includes(expr.op)) return boolShape;
      return inferSimpleType(expr.left, types).kind === "float" || inferSimpleType(expr.right, types).kind === "float" ? floatShape : intShape;
    case "Fun":
      return { kind: "fn", result: inferSimpleType(expr.body, new Map([...types, ...expr.params.map((param): [string, ValueShape] => [param, unknownShape])])) };
    case "Unary":
      return inferSimpleType(expr.expr, types).kind === "float" ? floatShape : intShape;
    case "Int":
      return intShape;
  }
}

function inferCallShape(expr: Extract<Expr, { kind: "Call" }>, types: Map<string, ValueShape>): ValueShape {
  if (expr.callee.kind !== "Var") return intShape;
  const name = expr.callee.name;
  if (name === "print" || name === "println" || name === "Array.set") return unitShape;
  if (name === "Float.of_int") return floatShape;
  if (name === "Float.to_int") return intShape;
  if (name === "to_string") return stringShape;
  if (name === "String.concat") return stringShape;
  if (name === "String.length") return intShape;
  if (name === "String.split") return { kind: "list", elem: stringShape };
  if (name === "Array.make") return { kind: "array", elem: inferSimpleType(expr.args[1], types) };
  if (name === "Array.map") {
    const mapped = inferFunctionResultShape(inferSimpleType(expr.args[0], types));
    return { kind: "array", elem: mapped };
  }
  if (name === "Array.get") {
    const array = inferSimpleType(expr.args[0], types);
    return array.kind === "array" ? array.elem : unknownShape;
  }
  if (name === "Array.length") return intShape;
  if (name === "Array.iter") return unitShape;
  if (name === "Array.fold_left") return inferSimpleType(expr.args[1], types);
  if (name === "List.empty") return { kind: "list", elem: unknownShape };
  if (name === "List.cons") return { kind: "list", elem: inferSimpleType(expr.args[0], types) };
  if (name === "List.map") {
    const mapped = inferFunctionResultShape(inferSimpleType(expr.args[0], types));
    return { kind: "list", elem: mapped };
  }
  if (name === "List.head") {
    const list = inferSimpleType(expr.args[0], types);
    return list.kind === "list" ? list.elem : unknownShape;
  }
  if (name === "List.tail") {
    const list = inferSimpleType(expr.args[0], types);
    return list.kind === "list" ? list : { kind: "list", elem: unknownShape };
  }
  if (name === "List.length" || name === "List.is_empty") return intShape;
  if (name === "List.iter") return unitShape;
  if (name === "List.fold_left") return inferSimpleType(expr.args[1], types);
  if (name === "Set.empty") return { kind: "set", elem: unknownShape };
  if (name === "Set.add") return { kind: "set", elem: inferSimpleType(expr.args[1], types) };
  if (name === "Set.has" || name === "Set.length") return intShape;
  if (name === "Map.empty") return { kind: "map", key: unknownShape, value: unknownShape };
  if (name === "Map.set") return { kind: "map", key: inferSimpleType(expr.args[1], types), value: inferSimpleType(expr.args[2], types) };
  if (name === "Map.get") {
    const map = inferSimpleType(expr.args[0], types);
    return map.kind === "map" ? map.value : unknownShape;
  }
  if (name === "Map.has") return intShape;
  const callee = types.get(name);
  if (callee?.kind === "fn" && (callee.result.kind === "int" || callee.result.kind === "unknown")) {
    const argShapes = expr.args.map((arg) => inferSimpleType(arg, types));
    if (argShapes.some((shape) => shape.kind === "float")) return floatShape;
    if (argShapes.length > 0 && argShapes.every((shape) => shape.kind === "int")) return intShape;
  }
  return callee?.kind === "fn" ? callee.result : callee ?? intShape;
}

function inferFunctionResultShape(shape: ValueShape): ValueShape {
  return shape.kind === "fn" ? shape.result : unknownShape;
}

function walk(expr: Expr, locals: Set<string>, state: { matchId: number }): void {
  switch (expr.kind) {
    case "LetIn":
      locals.add(expr.name);
      walk(expr.value, locals, state);
      walk(expr.body, locals, state);
      break;
    case "String":
    case "Float":
      break;
    case "Binary":
      walk(expr.left, locals, state);
      walk(expr.right, locals, state);
      break;
    case "Tuple":
      expr.items.forEach((item) => walk(item, locals, state));
      break;
    case "Unary":
      walk(expr.expr, locals, state);
      break;
    case "If":
      walk(expr.condition, locals, state);
      walk(expr.thenBranch, locals, state);
      walk(expr.elseBranch, locals, state);
      break;
    case "Call":
      walk(expr.callee, locals, state);
      expr.args.forEach((arg) => walk(arg, locals, state));
      break;
    case "Fun":
      locals.add("__closure");
      break;
    case "Match":
      locals.add(`__match${state.matchId++}`);
      walk(expr.expr, locals, state);
      for (const arm of expr.arms) {
        if (arm.pattern.kind === "PVar") locals.add(arm.pattern.name);
        walk(arm.body, locals, state);
      }
      break;
  }
}

function freeVars(expr: Expr, bound: Set<string>): Set<string> {
  const result = new Set<string>();
  const addAll = (items: Set<string>) => items.forEach((item) => result.add(item));
  switch (expr.kind) {
    case "Var":
      if (!bound.has(expr.name)) result.add(expr.name);
      break;
    case "Unary":
      addAll(freeVars(expr.expr, bound));
      break;
    case "Binary":
      addAll(freeVars(expr.left, bound));
      addAll(freeVars(expr.right, bound));
      break;
    case "Tuple":
      expr.items.forEach((item) => addAll(freeVars(item, bound)));
      break;
    case "If":
      addAll(freeVars(expr.condition, bound));
      addAll(freeVars(expr.thenBranch, bound));
      addAll(freeVars(expr.elseBranch, bound));
      break;
    case "LetIn": {
      addAll(freeVars(expr.value, bound));
      const nested = new Set(bound);
      nested.add(expr.name);
      addAll(freeVars(expr.body, nested));
      break;
    }
    case "Call":
      addAll(freeVars(expr.callee, bound));
      expr.args.forEach((arg) => addAll(freeVars(arg, bound)));
      break;
    case "Fun": {
      const nested = new Set(bound);
      expr.params.forEach((param) => nested.add(param));
      addAll(freeVars(expr.body, nested));
      break;
    }
    case "Match":
      addAll(freeVars(expr.expr, bound));
      expr.arms.forEach((arm) => addAll(freeVars(arm.body, bound)));
      break;
  }
  return result;
}

function builtinArities(): Array<[string, number]> {
  return [
    ["print", 1],
    ["println", 1],
    ["Float.of_int", 1],
    ["Float.to_int", 1],
    ["to_string", 1],
    ["String.concat", 2],
    ["String.length", 1],
    ["String.split", 2],
    ["Array.make", 2],
    ["Array.length", 1],
    ["Array.get", 2],
    ["Array.set", 3],
    ["Array.map", 2],
    ["Array.iter", 2],
    ["Array.fold_left", 3],
    ["List.empty", 1],
    ["List.cons", 2],
    ["List.head", 1],
    ["List.tail", 1],
    ["List.is_empty", 1],
    ["List.length", 1],
    ["List.map", 2],
    ["List.iter", 2],
    ["List.fold_left", 3],
    ["Set.empty", 1],
    ["Set.add", 2],
    ["Set.has", 2],
    ["Set.length", 1],
    ["Map.empty", 1],
    ["Map.set", 3],
    ["Map.get", 2],
    ["Map.has", 2],
  ];
}

function builtinReturnShape(name: string): ValueShape {
  if (name === "print" || name === "println" || name === "Array.set") return unitShape;
  if (name === "Float.of_int") return floatShape;
  if (name === "Float.to_int") return intShape;
  if (name === "to_string") return stringShape;
  if (name === "String.concat") return stringShape;
  if (name === "String.length") return intShape;
  if (name === "String.split") return { kind: "list", elem: stringShape };
  if (name === "Array.make") return { kind: "array", elem: unknownShape };
  if (name === "Array.map") return { kind: "array", elem: unknownShape };
  if (name === "List.empty" || name === "List.cons" || name === "List.tail") return { kind: "list", elem: unknownShape };
  if (name === "List.map") return { kind: "list", elem: unknownShape };
  if (name === "List.iter") return unitShape;
  if (name === "Set.empty" || name === "Set.add") return { kind: "set", elem: unknownShape };
  if (name === "Map.empty" || name === "Map.set") return { kind: "map", key: unknownShape, value: unknownShape };
  return intShape;
}

function emitStdlibWat(): string {
  return `(func $alloc (param $bytes i32) (result i32)
  (local $ptr i32)
  (local.set $ptr (global.get $heap))
  (global.set $heap (i32.add (global.get $heap) (local.get $bytes)))
  (local.get $ptr)
)

(func $box_float (param $value f64) (result i32)
  (local $ptr i32)
  (local.set $ptr (call $alloc (i32.const 8)))
  (f64.store (local.get $ptr) (local.get $value))
  (local.get $ptr)
)

(func $unbox_float (param $ptr i32) (result f64)
  (f64.load (local.get $ptr))
)

(func $Float_of_int (param $value i32) (result i32)
  (call $box_float (f64.convert_i32_s (local.get $value)))
)

(func $Float_to_int (param $value i32) (result i32)
  (i32.trunc_f64_s (call $unbox_float (local.get $value)))
)

(func $pow_i32 (param $base i32) (param $exponent i32) (result i32)
  (i32.trunc_f64_s
    (call $host_pow_f64
      (f64.convert_i32_s (local.get $base))
      (f64.convert_i32_s (local.get $exponent))))
)

(func $String_concat (param $left i32) (param $right i32) (result i32)
  (call $host_string_concat (local.get $left) (local.get $right))
)

(func $String_length (param $value i32) (result i32)
  (call $host_string_length (local.get $value))
)

(func $String_split (param $value i32) (param $separator i32) (result i32)
  (call $host_string_split (local.get $value) (local.get $separator))
)

(func $Array_make (param $length i32) (param $value i32) (result i32)
  (local $ptr i32)
  (local $i i32)
  (if (i32.lt_s (local.get $length) (i32.const 0))
    (then unreachable)
  )
  (local.set $ptr (call $alloc (i32.add (i32.const 4) (i32.mul (local.get $length) (i32.const 4)))))
  (i32.store (local.get $ptr) (local.get $length))
  (local.set $i (i32.const 0))
  (loop $loop
    (if (i32.lt_s (local.get $i) (local.get $length))
      (then
        (i32.store
          (i32.add (i32.add (local.get $ptr) (i32.const 4)) (i32.mul (local.get $i) (i32.const 4)))
          (local.get $value))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
  )
  (local.get $ptr)
)

(func $Array_length (param $array i32) (result i32)
  (if (i32.eqz (local.get $array))
    (then unreachable)
  )
  (i32.load (local.get $array))
)

(func $Array_get (param $array i32) (param $index i32) (result i32)
  (if (i32.eqz (local.get $array))
    (then unreachable)
  )
  (if (i32.lt_s (local.get $index) (i32.const 0))
    (then unreachable)
  )
  (if (i32.ge_s (local.get $index) (i32.load (local.get $array)))
    (then unreachable)
  )
  (i32.load (i32.add (i32.add (local.get $array) (i32.const 4)) (i32.mul (local.get $index) (i32.const 4))))
)

(func $Array_set (param $array i32) (param $index i32) (param $value i32) (result i32)
  (if (i32.eqz (local.get $array))
    (then unreachable)
  )
  (if (i32.lt_s (local.get $index) (i32.const 0))
    (then unreachable)
  )
  (if (i32.ge_s (local.get $index) (i32.load (local.get $array)))
    (then unreachable)
  )
  (i32.store (i32.add (i32.add (local.get $array) (i32.const 4)) (i32.mul (local.get $index) (i32.const 4))) (local.get $value))
  (i32.const 0)
)

(func $Array_map (param $f i32) (param $array i32) (result i32)
  (local $length i32)
  (local $result i32)
  (local $i i32)
  (local.set $length (call $Array_length (local.get $array)))
  (local.set $result (call $Array_make (local.get $length) (i32.const 0)))
  (loop $loop
    (if (i32.lt_s (local.get $i) (local.get $length))
      (then
        (drop (call $Array_set
          (local.get $result)
          (local.get $i)
          (call_indirect (type $fn_1)
            (local.get $f)
            (call $Array_get (local.get $array) (local.get $i))
            (i32.load (local.get $f)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
  )
  (local.get $result)
)

(func $Array_iter (param $f i32) (param $array i32) (result i32)
  (local $length i32)
  (local $i i32)
  (local.set $length (call $Array_length (local.get $array)))
  (loop $loop
    (if (i32.lt_s (local.get $i) (local.get $length))
      (then
        (drop (call_indirect (type $fn_1)
          (local.get $f)
          (call $Array_get (local.get $array) (local.get $i))
          (i32.load (local.get $f))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
  )
  (i32.const 0)
)

(func $Array_fold_left (param $f i32) (param $acc i32) (param $array i32) (result i32)
  (local $length i32)
  (local $i i32)
  (local.set $length (call $Array_length (local.get $array)))
  (loop $loop
    (if (i32.lt_s (local.get $i) (local.get $length))
      (then
        (local.set $acc (call_indirect (type $fn_2)
          (local.get $f)
          (local.get $acc)
          (call $Array_get (local.get $array) (local.get $i))
          (i32.load (local.get $f))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
  )
  (local.get $acc)
)

(func $List_empty (param $unit i32) (result i32)
  (i32.const 0)
)

(func $List_cons (param $value i32) (param $tail i32) (result i32)
  (local $ptr i32)
  (local.set $ptr (call $alloc (i32.const 8)))
  (i32.store (local.get $ptr) (local.get $value))
  (i32.store (i32.add (local.get $ptr) (i32.const 4)) (local.get $tail))
  (local.get $ptr)
)

(func $List_head (param $list i32) (result i32)
  (if (i32.eqz (local.get $list))
    (then unreachable)
  )
  (i32.load (local.get $list))
)

(func $List_tail (param $list i32) (result i32)
  (if (i32.eqz (local.get $list))
    (then unreachable)
  )
  (i32.load (i32.add (local.get $list) (i32.const 4)))
)

(func $List_is_empty (param $list i32) (result i32)
  (i32.eqz (local.get $list))
)

(func $List_length (param $list i32) (result i32)
  (local $count i32)
  (local $cursor i32)
  (local.set $cursor (local.get $list))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        (local.set $cursor (i32.load (i32.add (local.get $cursor) (i32.const 4))))
        (br $loop)
      )
    )
  )
  (local.get $count)
)

(func $List_map (param $f i32) (param $list i32) (result i32)
  (if (result i32) (i32.eqz (local.get $list))
    (then (i32.const 0))
    (else
      (call $List_cons
        (call_indirect (type $fn_1)
          (local.get $f)
          (call $List_head (local.get $list))
          (i32.load (local.get $f)))
        (call $List_map (local.get $f) (call $List_tail (local.get $list)))))
  )
)

(func $List_iter (param $f i32) (param $list i32) (result i32)
  (local $cursor i32)
  (local.set $cursor (local.get $list))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (drop (call_indirect (type $fn_1)
          (local.get $f)
          (call $List_head (local.get $cursor))
          (i32.load (local.get $f))))
        (local.set $cursor (call $List_tail (local.get $cursor)))
        (br $loop)
      )
    )
  )
  (i32.const 0)
)

(func $List_fold_left (param $f i32) (param $acc i32) (param $list i32) (result i32)
  (local $cursor i32)
  (local.set $cursor (local.get $list))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (local.set $acc (call_indirect (type $fn_2)
          (local.get $f)
          (local.get $acc)
          (call $List_head (local.get $cursor))
          (i32.load (local.get $f))))
        (local.set $cursor (call $List_tail (local.get $cursor)))
        (br $loop)
      )
    )
  )
  (local.get $acc)
)

(func $Set_empty (param $unit i32) (result i32)
  (i32.const 0)
)

(func $Set_has (param $set i32) (param $value i32) (result i32)
  (local $cursor i32)
  (local.set $cursor (local.get $set))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (if (i32.eq (i32.load (local.get $cursor)) (local.get $value))
          (then (return (i32.const 1)))
        )
        (local.set $cursor (i32.load (i32.add (local.get $cursor) (i32.const 4))))
        (br $loop)
      )
    )
  )
  (i32.const 0)
)

(func $Set_has_float (param $set i32) (param $value i32) (result i32)
  (local $cursor i32)
  (local.set $cursor (local.get $set))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (if (f64.eq
          (call $unbox_float (i32.load (local.get $cursor)))
          (call $unbox_float (local.get $value)))
          (then (return (i32.const 1)))
        )
        (local.set $cursor (i32.load (i32.add (local.get $cursor) (i32.const 4))))
        (br $loop)
      )
    )
  )
  (i32.const 0)
)

(func $Set_add (param $set i32) (param $value i32) (result i32)
  (local $ptr i32)
  (if (call $Set_has (local.get $set) (local.get $value))
    (then (return (local.get $set)))
  )
  (local.set $ptr (call $alloc (i32.const 8)))
  (i32.store (local.get $ptr) (local.get $value))
  (i32.store (i32.add (local.get $ptr) (i32.const 4)) (local.get $set))
  (local.get $ptr)
)

(func $Set_add_float (param $set i32) (param $value i32) (result i32)
  (local $ptr i32)
  (if (call $Set_has_float (local.get $set) (local.get $value))
    (then (return (local.get $set)))
  )
  (local.set $ptr (call $alloc (i32.const 8)))
  (i32.store (local.get $ptr) (local.get $value))
  (i32.store (i32.add (local.get $ptr) (i32.const 4)) (local.get $set))
  (local.get $ptr)
)

(func $Set_length (param $set i32) (result i32)
  (local $count i32)
  (local $cursor i32)
  (local.set $cursor (local.get $set))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        (local.set $cursor (i32.load (i32.add (local.get $cursor) (i32.const 4))))
        (br $loop)
      )
    )
  )
  (local.get $count)
)

(func $Map_empty (param $unit i32) (result i32)
  (i32.const 0)
)

(func $Map_set (param $map i32) (param $key i32) (param $value i32) (result i32)
  (local $ptr i32)
  (local.set $ptr (call $alloc (i32.const 12)))
  (i32.store (local.get $ptr) (local.get $key))
  (i32.store (i32.add (local.get $ptr) (i32.const 4)) (local.get $value))
  (i32.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $map))
  (local.get $ptr)
)

(func $Map_get (param $map i32) (param $key i32) (result i32)
  (local $cursor i32)
  (local.set $cursor (local.get $map))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (if (i32.eq (i32.load (local.get $cursor)) (local.get $key))
          (then (return (i32.load (i32.add (local.get $cursor) (i32.const 4)))))
        )
        (local.set $cursor (i32.load (i32.add (local.get $cursor) (i32.const 8))))
        (br $loop)
      )
    )
  )
  unreachable
)

(func $Map_has (param $map i32) (param $key i32) (result i32)
  (local $cursor i32)
  (local.set $cursor (local.get $map))
  (loop $loop
    (if (i32.ne (local.get $cursor) (i32.const 0))
      (then
        (if (i32.eq (i32.load (local.get $cursor)) (local.get $key))
          (then (return (i32.const 1)))
        )
        (local.set $cursor (i32.load (i32.add (local.get $cursor) (i32.const 8))))
        (br $loop)
      )
    )
  )
  (i32.const 0)
)`;
}

class StringPool {
  private readonly offsets = new Map<string, number>();
  private nextOffset = 1024;

  intern(value: string): number {
    const existing = this.offsets.get(value);
    if (existing !== undefined) return existing;
    const bytes = new TextEncoder().encode(value);
    const offset = this.nextOffset;
    this.offsets.set(value, offset);
    this.nextOffset += bytes.length + 1;
    return offset;
  }

  emitDataSegments(): string {
    return [...this.offsets.entries()]
      .map(([value, offset]) => `(data (i32.const ${offset}) "${watBytes(value)}\\00")`)
      .join("\n");
  }
}

function watBytes(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => `\\${byte.toString(16).padStart(2, "0")}`)
    .join("");
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((line) => (line ? pad + line : line)).join("\n");
}
