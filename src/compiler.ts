import type { Declaration, Expr, Pattern, Program } from "./ast";
import { check, type OJamlType, type RuntimeMainType } from "./check";
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

export function compile(source: string): CompileResult {
  const ast = parse(source);
  const checked = check(ast);
  return { ast, wat: emitWat(ast), mainType: checked.mainType };
}

export function emitWat(program: Program): string {
  lambdaInfos = [];
  nextLambdaId = 0;
  nextTableIndex = 0;
  topLevelClosureIndices = new Map(program.declarations
    .filter((declaration) => declaration.params.length > 0)
    .map((declaration) => [declaration.name, nextTableIndex++]));
  const strings = new StringPool();
  const globals = new Map<string, number>([
    ...builtinArities(),
    ...program.declarations.map((declaration): [string, number] => [declaration.name, declaration.params.length]),
  ]);
  const globalTypes = collectGlobalTypes(program);
  const declarations = program.declarations.map((declaration) => emitDeclaration(declaration, globals, globalTypes, strings)).join("\n\n");
  const lambdas = emitPendingLambdas(globals, globalTypes, strings);
  const dataSegments = strings.emitDataSegments();
  const tableEntries = [
    ...program.declarations.filter((declaration) => declaration.params.length > 0).map((declaration) => `$__closure_${safe(declaration.name)}`),
    ...lambdaInfos.sort((left, right) => left.index - right.index).map((lambda) => `$__lambda_${lambda.id}`),
  ];
  return `(module
  (type $fn_1 (func (param i32 i32) (result i32)))
  (type $fn_2 (func (param i32 i32 i32) (result i32)))
  (type $fn_3 (func (param i32 i32 i32 i32) (result i32)))
  (import "env" "print_i32" (func $print_i32 (param i32)))
  (import "env" "print_string" (func $print_string (param i32)))
  (memory (export "memory") 1)
  (table ${Math.max(1, tableEntries.length)} funcref)
  (global $heap (mut i32) (i32.const 8192))

${indent(emitStdlibWat(), 2)}

${indent(emitTopLevelClosureWrappers(program), 2)}

${indent(declarations, 2)}
${lambdas ? `\n${indent(lambdas, 2)}\n` : ""}
${dataSegments ? `\n${indent(dataSegments, 2)}\n` : ""}
${tableEntries.length ? `\n  (elem (i32.const 0) ${tableEntries.join(" ")})\n` : ""}

  (export "main" (func $main))
)`;
}

function emitDeclaration(declaration: Declaration, globals: Map<string, number>, globalTypes: Map<string, ValueShape>, strings: StringPool): string {
  const params = declaration.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
  const locals = collectLocals(declaration);
  for (const param of declaration.params) locals.add(param);
  const localTypes = collectLocalTypes(declaration);
  const localLines = [...locals].filter((name) => !declaration.params.includes(name)).map((name) => `  (local $${safe(name)} i32)`);
  const body = emitExpr(declaration.value, new EmitContext(globals, locals, localTypes, globalTypes, strings));
  const head = `(func $${safe(declaration.name)} ${params}${params ? " " : ""}(result i32)`;
  return [head, ...localLines, indent(body, 2), ")"].join("\n");
}

class EmitContext {
  private matchId = 0;
  private callId = 0;

  constructor(
    readonly globals: Map<string, number>,
    readonly locals: Set<string>,
    readonly localTypes: Map<string, ValueShape>,
    readonly globalTypes: Map<string, ValueShape>,
    readonly strings: StringPool,
    readonly captured = new Map<string, number>(),
  ) {}

  nextMatchLocal(): string {
    return `__match${this.matchId++}`;
  }

  nextCallLocal(): string {
    return `__callee${this.callId++}`;
  }

  exprType(expr: Expr): ValueShape {
    return inferSimpleType(expr, new Map([...this.globalTypes, ...this.localTypes]));
  }
}

function emitExpr(expr: Expr, context: EmitContext): string {
  switch (expr.kind) {
    case "Int":
      return `(i32.const ${expr.value})`;
    case "String":
      return `(i32.const ${context.strings.intern(expr.value)})`;
    case "Bool":
      return `(i32.const ${expr.value ? 1 : 0})`;
    case "Unit":
      return `(i32.const 0)`;
    case "Var":
      if (context.locals.has(expr.name)) return `(local.get $${safe(expr.name)})`;
      if (context.captured.has(expr.name)) return `(i32.load (i32.add (local.get $__env) (i32.const ${4 + context.captured.get(expr.name)! * 4})))`;
      if (context.globals.get(expr.name) === 0) return `(call $${safe(expr.name)})`;
      if (context.globals.has(expr.name)) return emitTopLevelClosure(expr.name);
      return `(local.get $${safe(expr.name)})`;
    case "Unary":
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
      if (expr.callee.kind === "Var" && expr.callee.name === "print") {
        if (context.exprType(expr.args[0]).kind === "string") {
          return `(block (result i32)
  (call $print_string ${emitExpr(expr.args[0], context)})
  (i32.const 0)
)`;
        }
        return `(block (result i32)
  (call $print_i32 ${emitExpr(expr.args[0], context)})
  (i32.const 0)
)`;
      }
      if (expr.callee.kind === "Var" && (context.locals.has(expr.callee.name) || context.captured.has(expr.callee.name))) {
        return emitIndirectCall(expr.callee, expr.args, context);
      }
      if (expr.callee.kind === "Var" && context.globals.has(expr.callee.name)) {
        return `(call $${safe(expr.callee.name)} ${expr.args.map((arg) => emitExpr(arg, context)).join(" ")})`;
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

function emitBinary(expr: Extract<Expr, { kind: "Binary" }>, context: EmitContext): string {
  const left = emitExpr(expr.left, context);
  const right = emitExpr(expr.right, context);
  const op = {
    "+": "i32.add",
    "-": "i32.sub",
    "*": "i32.mul",
    "/": "i32.div_s",
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
  return `(${op} ${left} ${right})`;
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
  return program.declarations
    .filter((declaration) => declaration.params.length > 0)
    .map((declaration) => {
      const params = declaration.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
      return `(func $__closure_${safe(declaration.name)} (param $__env i32) ${params} (result i32)
  (call $${safe(declaration.name)} ${declaration.params.map((param) => `(local.get $${safe(param)})`).join(" ")})
)`;
    })
    .join("\n\n");
}

function emitPendingLambdas(globals: Map<string, number>, globalTypes: Map<string, ValueShape>, strings: StringPool): string {
  const emitted: string[] = [];
  let cursor = 0;
  while (cursor < lambdaInfos.length) {
    const lambda = lambdaInfos[cursor++];
    const locals = collectLocalsFromExpr(lambda.body);
    for (const param of lambda.params) locals.add(param);
    locals.add("__closure");
    const localTypes = collectLocalTypesFromExpr(lambda.body, new Map(lambda.params.map((param) => [param, intShape])));
    const captured = new Map(lambda.captures.map((name, index) => [name, index]));
    const localLines = [...locals]
      .filter((name) => !lambda.params.includes(name))
      .map((name) => `  (local $${safe(name)} i32)`);
    const params = lambda.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
    const body = emitExpr(lambda.body, new EmitContext(globals, locals, localTypes, globalTypes, strings, captured));
    emitted.push([`(func $__lambda_${lambda.id} (param $__env i32) ${params} (result i32)`, ...localLines, indent(body, 2), ")"].join("\n"));
  }
  return emitted.join("\n\n");
}

function collectLocals(declaration: Declaration): Set<string> {
  const locals = new Set<string>();
  locals.add("__closure");
  addCallScratchLocals(locals);
  walk(declaration.value, locals, { matchId: 0 });
  return locals;
}

function collectLocalsFromExpr(expr: Expr): Set<string> {
  const locals = new Set<string>(["__closure"]);
  addCallScratchLocals(locals);
  walk(expr, locals, { matchId: 0 });
  return locals;
}

function addCallScratchLocals(locals: Set<string>): void {
  for (let i = 0; i < 16; i++) locals.add(`__callee${i}`);
}

type ValueShape =
  | { kind: "int" | "bool" | "string" | "unit" | "unknown" }
  | { kind: "array" | "list"; elem: ValueShape }
  | { kind: "map"; key: ValueShape; value: ValueShape }
  | { kind: "fn"; result: ValueShape };

const intShape: ValueShape = { kind: "int" };
const boolShape: ValueShape = { kind: "bool" };
const stringShape: ValueShape = { kind: "string" };
const unitShape: ValueShape = { kind: "unit" };
const unknownShape: ValueShape = { kind: "unknown" };

function collectLocalTypes(declaration: Declaration): Map<string, ValueShape> {
  const types = new Map<string, ValueShape>();
  for (const param of declaration.params) types.set(param, intShape);
  walkTypes(declaration.value, types);
  return types;
}

function collectLocalTypesFromExpr(expr: Expr, types: Map<string, ValueShape>): Map<string, ValueShape> {
  walkTypes(expr, types);
  return types;
}

function collectGlobalTypes(program: Program): Map<string, ValueShape> {
  const types = new Map<string, ValueShape>([["print", unitShape]]);
  for (const [name] of builtinArities()) types.set(name, builtinReturnShape(name));
  for (const declaration of program.declarations) {
    if (declaration.params.length === 0) {
      types.set(declaration.name, inferSimpleType(declaration.value, types));
    } else {
      types.set(declaration.name, { kind: "fn", result: inferSimpleType(declaration.value, new Map(declaration.params.map((param) => [param, intShape]))) });
    }
  }
  return types;
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
    case "Bool":
      return boolShape;
    case "Unit":
      return unitShape;
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
      return ["=", "<>", "<", "<=", ">", ">=", "&&", "||"].includes(expr.op) ? boolShape : intShape;
    case "Fun":
      return { kind: "fn", result: inferSimpleType(expr.body, new Map([...types, ...expr.params.map((param): [string, ValueShape] => [param, intShape])])) };
    case "Int":
    case "Unary":
      return intShape;
  }
}

function inferCallShape(expr: Extract<Expr, { kind: "Call" }>, types: Map<string, ValueShape>): ValueShape {
  if (expr.callee.kind !== "Var") return intShape;
  const name = expr.callee.name;
  if (name === "print" || name === "Array.set") return unitShape;
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
  if (name === "Map.empty") return { kind: "map", key: unknownShape, value: unknownShape };
  if (name === "Map.set") return { kind: "map", key: inferSimpleType(expr.args[1], types), value: inferSimpleType(expr.args[2], types) };
  if (name === "Map.get") {
    const map = inferSimpleType(expr.args[0], types);
    return map.kind === "map" ? map.value : unknownShape;
  }
  if (name === "Map.has") return intShape;
  const callee = types.get(name);
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
      break;
    case "Binary":
      walk(expr.left, locals, state);
      walk(expr.right, locals, state);
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
    ["Map.empty", 1],
    ["Map.set", 3],
    ["Map.get", 2],
    ["Map.has", 2],
  ];
}

function builtinReturnShape(name: string): ValueShape {
  if (name === "print" || name === "Array.set") return unitShape;
  if (name === "Array.make") return { kind: "array", elem: unknownShape };
  if (name === "Array.map") return { kind: "array", elem: unknownShape };
  if (name === "List.empty" || name === "List.cons" || name === "List.tail") return { kind: "list", elem: unknownShape };
  if (name === "List.map") return { kind: "list", elem: unknownShape };
  if (name === "List.iter") return unitShape;
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

(func $Array_make (param $length i32) (param $value i32) (result i32)
  (local $ptr i32)
  (local $i i32)
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
  (i32.load (local.get $array))
)

(func $Array_get (param $array i32) (param $index i32) (result i32)
  (i32.load (i32.add (i32.add (local.get $array) (i32.const 4)) (i32.mul (local.get $index) (i32.const 4))))
)

(func $Array_set (param $array i32) (param $index i32) (param $value i32) (result i32)
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
  (i32.load (local.get $list))
)

(func $List_tail (param $list i32) (result i32)
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
  (i32.const 0)
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
