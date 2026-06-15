import type { Declaration, Expr, Pattern, Program, SourceSpan } from "./ast";
import { OJamlError } from "./errors";

export type OJamlType = "int" | "bool" | "string" | "unit" | "array" | "list" | "map" | "fn";
export type RuntimeMainType = "int" | "bool" | "unit";

type Type =
  | { kind: "prim"; name: Exclude<OJamlType, "array" | "list" | "map" | "fn"> }
  | { kind: "var"; id: number; instance?: Type }
  | { kind: "app"; name: "array" | "list"; args: [Type] }
  | { kind: "app"; name: "map"; args: [Type, Type] }
  | { kind: "fn"; params: Type[]; result: Type };

type Binding = {
  type: Type;
  builtinDetail?: string;
};

export type CheckResult = {
  mainType: RuntimeMainType;
  symbols: CheckedSymbol[];
};

export type CheckedSymbol = {
  name: string;
  detail: string;
  kind: "function" | "value" | "builtin";
  span?: SourceSpan;
  params?: Array<{ name: string; detail: string; span?: SourceSpan }>;
  locals?: Array<{ name: string; detail: string; span: SourceSpan }>;
};

let nextTypeVar = 0;

const intType = prim("int");
const boolType = prim("bool");
const stringType = prim("string");
const unitType = prim("unit");

export function check(program: Program): CheckResult {
  nextTypeVar = 0;
  const globals = builtins();

  for (const declaration of program.declarations) {
    if (globals.has(declaration.name)) throw new OJamlError(`Duplicate binding '${declaration.name}'`, declaration.span.start, declaration.span.end);
    globals.set(declaration.name, { type: makeDeclarationStub(declaration) });
  }

  const main = globals.get("main");
  if (!main) throw new OJamlError("Program must define 'main'", 0, 0);
  if (prune(main.type).kind === "fn") throw new OJamlError("Program 'main' must not take arguments", 0, 0);

  for (const declaration of program.declarations) checkDeclaration(declaration, globals);

  const mainType = prune(globals.get("main")!.type);
  if (!isRuntimeMainType(mainType)) {
    throw new OJamlError(`Program 'main' cannot return ${showType(mainType)} directly; print it or return int, bool, or unit`, 0, 0);
  }
  return { mainType: mainType.name, symbols: collectCheckedSymbols(program, globals) };
}

function builtins(): Map<string, Binding> {
  const a = typeVar();
  const b = typeVar();
  const k = typeVar();
  const v = typeVar();
  return new Map<string, Binding>([
    ["print", { type: fn([typeVar()], unitType), builtinDetail: "print : int|string -> unit" }],
    ["Array.make", { type: fn([intType, a], app("array", [a])), builtinDetail: "Array.make : int -> 'a -> 'a array" }],
    ["Array.length", { type: fn([app("array", [typeVar()])], intType), builtinDetail: "Array.length : 'a array -> int" }],
    ["Array.get", { type: fn([app("array", [a]), intType], a), builtinDetail: "Array.get : 'a array -> int -> 'a" }],
    ["Array.set", { type: fn([app("array", [a]), intType, a], unitType), builtinDetail: "Array.set : 'a array -> int -> 'a -> unit" }],
    ["Array.map", { type: fn([fn([a], b), app("array", [a])], app("array", [b])), builtinDetail: "Array.map : ('a -> 'b) -> 'a array -> 'b array" }],
    ["Array.iter", { type: fn([fn([a], unitType), app("array", [a])], unitType), builtinDetail: "Array.iter : ('a -> unit) -> 'a array -> unit" }],
    ["Array.fold_left", { type: fn([fn([b, a], b), b, app("array", [a])], b), builtinDetail: "Array.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a array -> 'b" }],
    ["List.empty", { type: fn([unitType], app("list", [typeVar()])), builtinDetail: "List.empty : unit -> 'a list" }],
    ["List.cons", { type: fn([a, app("list", [a])], app("list", [a])), builtinDetail: "List.cons : 'a -> 'a list -> 'a list" }],
    ["List.head", { type: fn([app("list", [a])], a), builtinDetail: "List.head : 'a list -> 'a" }],
    ["List.tail", { type: fn([app("list", [a])], app("list", [a])), builtinDetail: "List.tail : 'a list -> 'a list" }],
    ["List.is_empty", { type: fn([app("list", [typeVar()])], boolType), builtinDetail: "List.is_empty : 'a list -> bool" }],
    ["List.length", { type: fn([app("list", [typeVar()])], intType), builtinDetail: "List.length : 'a list -> int" }],
    ["List.map", { type: fn([fn([a], b), app("list", [a])], app("list", [b])), builtinDetail: "List.map : ('a -> 'b) -> 'a list -> 'b list" }],
    ["List.iter", { type: fn([fn([a], unitType), app("list", [a])], unitType), builtinDetail: "List.iter : ('a -> unit) -> 'a list -> unit" }],
    ["List.fold_left", { type: fn([fn([b, a], b), b, app("list", [a])], b), builtinDetail: "List.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a list -> 'b" }],
    ["Map.empty", { type: fn([unitType], app("map", [typeVar(), typeVar()])), builtinDetail: "Map.empty : unit -> ('k, 'v) map" }],
    ["Map.set", { type: fn([app("map", [k, v]), k, v], app("map", [k, v])), builtinDetail: "Map.set : ('k, 'v) map -> 'k -> 'v -> ('k, 'v) map" }],
    ["Map.get", { type: fn([app("map", [k, v]), k], v), builtinDetail: "Map.get : ('k, 'v) map -> 'k -> 'v" }],
    ["Map.has", { type: fn([app("map", [k, typeVar()]), k], boolType), builtinDetail: "Map.has : ('k, 'v) map -> 'k -> bool" }],
  ]);
}

function makeDeclarationStub(declaration: Declaration): Type {
  if (declaration.params.length === 0) return typeVar();
  return fn(declaration.params.map(() => typeVar()), typeVar());
}

function checkDeclaration(declaration: Declaration, globals: Map<string, Binding>): Type {
  const binding = globals.get(declaration.name)!;
  const locals = new Map<string, Type>();
  let expectedResult = binding.type;
  if (declaration.params.length > 0) {
    const type = prune(binding.type);
    if (type.kind !== "fn") throw new OJamlError("Internal function type mismatch", declaration.span.start, declaration.span.end);
    declaration.params.forEach((param, index) => locals.set(param, type.params[index]));
    expectedResult = type.result;
  }
  const bodyType = checkExpr(declaration.value, globals, locals);
  unify(expectedResult, bodyType, declaration.value.span);
  return prune(binding.type);
}

function checkExpr(expr: Expr, globals: Map<string, Binding>, locals: Map<string, Type>): Type {
  switch (expr.kind) {
    case "Int":
      return intType;
    case "String":
      return stringType;
    case "Bool":
      return boolType;
    case "Unit":
      return unitType;
    case "Var": {
      const local = locals.get(expr.name);
      if (local) return local;
      const global = globals.get(expr.name);
      if (!global) throw new OJamlError(`Undefined name '${expr.name}'`, expr.span.start, expr.span.end);
      return fresh(global.type);
    }
    case "Unary":
      unify(checkExpr(expr.expr, globals, locals), intType, expr.span);
      return intType;
    case "Binary":
      return checkBinary(expr, globals, locals);
    case "If":
      unify(checkExpr(expr.condition, globals, locals), boolType, expr.condition.span);
      return sameBranches(checkExpr(expr.thenBranch, globals, locals), checkExpr(expr.elseBranch, globals, locals), expr.span);
    case "LetIn": {
      const valueType = checkExpr(expr.value, globals, locals);
      const nested = new Map(locals);
      nested.set(expr.name, valueType);
      return checkExpr(expr.body, globals, nested);
    }
    case "Call": {
      const isPrint = expr.callee.kind === "Var" && expr.callee.name === "print";
      const targetType = expr.callee.kind === "Var" && globals.has(expr.callee.name)
        ? fresh(globals.get(expr.callee.name)!.type)
        : checkExpr(expr.callee, globals, locals);
      if (isPrint) {
        const argType = checkExpr(expr.args[0], globals, locals);
        const arg = prune(argType);
        if (arg.kind !== "var" && !(arg.kind === "prim" && (arg.name === "int" || arg.name === "string"))) {
          throw new OJamlError(`print expects int or string; got ${showType(arg)}`, expr.args[0].span.start, expr.args[0].span.end);
        }
        return unitType;
      }
      const argTypes = expr.args.map((arg) => checkExpr(arg, globals, locals));
      const resultType = typeVar();
      const pruned = prune(targetType);
      if (pruned.kind === "fn" && pruned.params.length !== expr.args.length) {
        throw new OJamlError(`Function expects ${pruned.params.length} argument(s), got ${expr.args.length}`, expr.span.start, expr.span.end);
      }
      unify(targetType, fn(argTypes, resultType), expr.span);
      return resultType;
    }
    case "Fun": {
      const nested = new Map(locals);
      const params = expr.params.map((param) => {
        const paramType = typeVar();
        nested.set(param, paramType);
        return paramType;
      });
      return fn(params, checkExpr(expr.body, globals, nested));
    }
    case "Match": {
      const scrutineeType = checkExpr(expr.expr, globals, locals);
      let resultType: Type | undefined;
      let hasCatchAll = false;
      for (const arm of expr.arms) {
        const nested = new Map(locals);
        hasCatchAll ||= checkPattern(arm.pattern, scrutineeType, nested);
        const armType = checkExpr(arm.body, globals, nested);
        resultType = resultType ? sameBranches(resultType, armType, arm.span) : armType;
      }
      if (!hasCatchAll) throw new OJamlError("Match must include a wildcard or variable catch-all arm", expr.span.start, expr.span.end);
      return resultType ?? unitType;
    }
  }
}

function checkBinary(expr: Extract<Expr, { kind: "Binary" }>, globals: Map<string, Binding>, locals: Map<string, Type>): Type {
  if (expr.op === "&&" || expr.op === "||") {
    unify(checkExpr(expr.left, globals, locals), boolType, expr.left.span);
    unify(checkExpr(expr.right, globals, locals), boolType, expr.right.span);
    return boolType;
  }
  if (expr.op === "=" || expr.op === "<>") {
    unify(checkExpr(expr.left, globals, locals), checkExpr(expr.right, globals, locals), expr.span);
    return boolType;
  }
  unify(checkExpr(expr.left, globals, locals), intType, expr.left.span);
  unify(checkExpr(expr.right, globals, locals), intType, expr.right.span);
  return ["<", "<=", ">", ">="].includes(expr.op) ? boolType : intType;
}

function checkPattern(pattern: Pattern, scrutinee: Type, locals: Map<string, Type>): boolean {
  switch (pattern.kind) {
    case "PInt":
      unify(scrutinee, intType, pattern.span);
      return false;
    case "PString":
      unify(scrutinee, stringType, pattern.span);
      return false;
    case "PBool":
      unify(scrutinee, boolType, pattern.span);
      return false;
    case "PUnit":
      unify(scrutinee, unitType, pattern.span);
      return false;
    case "PWildcard":
      return true;
    case "PVar":
      locals.set(pattern.name, scrutinee);
      return true;
  }
}

function sameBranches(left: Type, right: Type, span: SourceSpan): Type {
  unify(left, right, span);
  return left;
}

function prim(name: Exclude<OJamlType, "array" | "list" | "map" | "fn">): Type {
  return { kind: "prim", name };
}

function app(name: "array" | "list", args: [Type]): Type;
function app(name: "map", args: [Type, Type]): Type;
function app(name: "array" | "list" | "map", args: Type[]): Type {
  return name === "map"
    ? { kind: "app", name, args: args as [Type, Type] }
    : { kind: "app", name, args: args as [Type] };
}

function fn(params: Type[], result: Type): Type {
  return { kind: "fn", params, result };
}

function typeVar(): Type {
  return { kind: "var", id: nextTypeVar++ };
}

function prune(type: Type): Type {
  if (type.kind === "var" && type.instance) {
    type.instance = prune(type.instance);
    return type.instance;
  }
  return type;
}

function unify(leftRaw: Type, rightRaw: Type, span: SourceSpan): void {
  const left = prune(leftRaw);
  const right = prune(rightRaw);
  if (left === right) return;
  if (left.kind === "var") {
    if (occurs(left, right)) throw new OJamlError(`Recursive type ${showType(left)} occurs in ${showType(right)}`, span.start, span.end);
    left.instance = right;
    return;
  }
  if (right.kind === "var") {
    unify(right, left, span);
    return;
  }
  if (left.kind !== right.kind) throw typeMismatch(left, right, span);
  if (left.kind === "prim" && right.kind === "prim") {
    if (left.name !== right.name) throw typeMismatch(left, right, span);
    return;
  }
  if (left.kind === "app" && right.kind === "app") {
    if (left.name !== right.name || left.args.length !== right.args.length) throw typeMismatch(left, right, span);
    left.args.forEach((arg, index) => unify(arg, right.args[index], span));
    return;
  }
  if (left.kind === "fn" && right.kind === "fn") {
    if (left.params.length !== right.params.length) throw typeMismatch(left, right, span);
    left.params.forEach((param, index) => unify(param, right.params[index], span));
    unify(left.result, right.result, span);
    return;
  }
  throw typeMismatch(left, right, span);
}

function fresh(type: Type, seen = new Map<number, Type>()): Type {
  const pruned = prune(type);
  if (pruned.kind === "var") {
    let mapped = seen.get(pruned.id);
    if (!mapped) {
      mapped = typeVar();
      seen.set(pruned.id, mapped);
    }
    return mapped;
  }
  if (pruned.kind === "prim") return pruned;
  if (pruned.kind === "fn") return fn(pruned.params.map((param) => fresh(param, seen)), fresh(pruned.result, seen));
  return pruned.name === "map"
    ? app("map", [fresh(pruned.args[0], seen), fresh(pruned.args[1], seen)])
    : app(pruned.name, [fresh(pruned.args[0], seen)]);
}

function occurs(variable: Type, type: Type): boolean {
  const pruned = prune(type);
  if (pruned === variable) return true;
  if (pruned.kind === "fn") return pruned.params.some((param) => occurs(variable, param)) || occurs(variable, pruned.result);
  if (pruned.kind === "app") return pruned.args.some((arg) => occurs(variable, arg));
  return false;
}

function isRuntimeMainType(type: Type): type is { kind: "prim"; name: RuntimeMainType } {
  const pruned = prune(type);
  return pruned.kind === "prim" && (pruned.name === "int" || pruned.name === "bool" || pruned.name === "unit");
}

function showType(type: Type): string {
  const pruned = prune(type);
  if (pruned.kind === "prim") return pruned.name;
  if (pruned.kind === "var") return `'${String.fromCharCode(97 + (pruned.id % 26))}${pruned.id >= 26 ? Math.floor(pruned.id / 26) : ""}`;
  if (pruned.kind === "fn") return `${pruned.params.map(showType).join(" -> ")} -> ${showType(pruned.result)}`;
  if (pruned.name === "map") return `(${showType(pruned.args[0])}, ${showType(pruned.args[1])}) map`;
  return `${showType(pruned.args[0])} ${pruned.name}`;
}

function typeMismatch(left: Type, right: Type, span: SourceSpan): OJamlError {
  return new OJamlError(`Type mismatch: ${showType(left)} vs ${showType(right)}`, span.start, span.end);
}

function collectCheckedSymbols(program: Program, globals: Map<string, Binding>): CheckedSymbol[] {
  const symbols: CheckedSymbol[] = [];
  for (const [name, binding] of builtins()) {
    symbols.push({ name, kind: "builtin", detail: binding.builtinDetail ?? `${name} : ${showType(binding.type)}` });
  }
  for (const declaration of program.declarations) {
    const binding = globals.get(declaration.name);
    if (!binding) continue;
    const type = prune(binding.type);
    symbols.push({
      name: declaration.name,
      kind: type.kind === "fn" ? "function" : "value",
      detail: `${declaration.name} : ${showType(type)}`,
      span: declaration.span,
      params: declaration.params.map((param, index) => ({
        name: param,
        detail: type.kind === "fn" ? `${param} : ${showType(type.params[index])}` : `${param} : unknown`,
        span: declaration.span,
      })),
      locals: collectLocalSymbols(declaration, globals),
    });
  }
  return symbols;
}

function collectLocalSymbols(declaration: Declaration, globals: Map<string, Binding>): Array<{ name: string; detail: string; span: SourceSpan }> {
  const binding = globals.get(declaration.name);
  if (!binding) return [];
  const locals = new Map<string, Type>();
  const type = prune(binding.type);
  if (type.kind === "fn") {
    declaration.params.forEach((param, index) => locals.set(param, type.params[index]));
  }
  const symbols: Array<{ name: string; detail: string; span: SourceSpan }> = [];
  collectLocalSymbolsInExpr(declaration.value, globals, locals, symbols);
  return symbols;
}

function collectLocalSymbolsInExpr(
  expr: Expr,
  globals: Map<string, Binding>,
  locals: Map<string, Type>,
  symbols: Array<{ name: string; detail: string; span: SourceSpan }>,
): Type | undefined {
  switch (expr.kind) {
    case "LetIn": {
      const valueType = checkExpr(expr.value, globals, locals);
      symbols.push({ name: expr.name, detail: `${expr.name} : ${showType(valueType)}`, span: expr.span });
      const nested = new Map(locals);
      nested.set(expr.name, valueType);
      collectLocalSymbolsInExpr(expr.body, globals, nested, symbols);
      return undefined;
    }
    case "If":
      collectLocalSymbolsInExpr(expr.condition, globals, locals, symbols);
      collectLocalSymbolsInExpr(expr.thenBranch, globals, locals, symbols);
      collectLocalSymbolsInExpr(expr.elseBranch, globals, locals, symbols);
      return undefined;
    case "Binary":
      collectLocalSymbolsInExpr(expr.left, globals, locals, symbols);
      collectLocalSymbolsInExpr(expr.right, globals, locals, symbols);
      return undefined;
    case "Unary":
      collectLocalSymbolsInExpr(expr.expr, globals, locals, symbols);
      return undefined;
    case "Call":
      collectLocalSymbolsInExpr(expr.callee, globals, locals, symbols);
      expr.args.forEach((arg) => collectLocalSymbolsInExpr(arg, globals, locals, symbols));
      return undefined;
    case "Fun": {
      const nested = new Map(locals);
      const fnType = checkExpr(expr, globals, locals);
      const pruned = prune(fnType);
      expr.params.forEach((param, index) => {
        const paramType = pruned.kind === "fn" ? pruned.params[index] : typeVar();
        nested.set(param, paramType);
        symbols.push({ name: param, detail: `${param} : ${showType(paramType)}`, span: expr.span });
      });
      collectLocalSymbolsInExpr(expr.body, globals, nested, symbols);
      return undefined;
    }
    case "Match":
      collectLocalSymbolsInExpr(expr.expr, globals, locals, symbols);
      expr.arms.forEach((arm) => {
        const nested = new Map(locals);
        if (arm.pattern.kind === "PVar") {
          const scrutineeType = checkExpr(expr.expr, globals, locals);
          nested.set(arm.pattern.name, scrutineeType);
          symbols.push({ name: arm.pattern.name, detail: `${arm.pattern.name} : ${showType(scrutineeType)}`, span: arm.pattern.span });
        }
        collectLocalSymbolsInExpr(arm.body, globals, nested, symbols);
      });
      return undefined;
    default:
      return undefined;
  }
}
