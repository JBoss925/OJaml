import type { Declaration, Expr, Pattern, Program, SourceSpan } from "./ast";
import { OJamlError } from "./errors";

export type OJamlType = "int" | "float" | "bool" | "string" | "unit" | "array" | "list" | "set" | "map" | "fn";
export type RuntimeMainType = "int" | "float" | "bool" | "unit";

type Type =
  | { kind: "prim"; name: Exclude<OJamlType, "array" | "list" | "set" | "map" | "fn"> }
  | { kind: "var"; id: number; instance?: Type; numeric?: boolean }
  | { kind: "app"; name: "array" | "list" | "set"; args: [Type] }
  | { kind: "app"; name: "map"; args: [Type, Type] }
  | { kind: "fn"; params: Type[]; result: Type };

type Binding = {
  type: Type;
  builtinDetail?: string;
  documentation?: string;
};

export type CheckResult = {
  mainType: RuntimeMainType;
  symbols: CheckedSymbol[];
  tokens: CheckedToken[];
};

export type CheckedSymbol = {
  name: string;
  detail: string;
  kind: "function" | "value" | "builtin";
  span?: SourceSpan;
  params?: Array<{ name: string; detail: string; span?: SourceSpan }>;
  locals?: Array<{ name: string; detail: string; span: SourceSpan }>;
};

export type CheckedToken = {
  name: string;
  detail: string;
  kind: "function" | "value" | "builtin" | "keyword" | "literal" | "operator" | "delimiter";
  span: SourceSpan;
  documentation?: string;
};

export type StdlibSignature = {
  name: string;
  detail: string;
  documentation: string;
};

type BuiltinSignature = StdlibSignature & {
  createType: () => Type;
};

type PendingToken = Omit<CheckedToken, "detail"> & {
  detail?: string;
  type?: Type;
};

type CheckContext = {
  tokens: PendingToken[];
};

let nextTypeVar = 0;

const intType = prim("int");
const floatType = prim("float");
const boolType = prim("bool");
const stringType = prim("string");
const unitType = prim("unit");

export function check(program: Program): CheckResult {
  nextTypeVar = 0;
  const globals = builtins();
  const context: CheckContext = { tokens: [] };

  for (const declaration of program.declarations) {
    if (globals.has(declaration.name)) throw new OJamlError(`Duplicate binding '${declaration.name}'`, declaration.span.start, declaration.span.end);
    globals.set(declaration.name, { type: makeDeclarationStub(declaration) });
  }

  const main = globals.get("main");
  if (!main) throw new OJamlError("Program must define 'main'", 0, 0);
  if (prune(main.type).kind === "fn") throw new OJamlError("Program 'main' must not take arguments", 0, 0);

  for (const declaration of program.declarations) checkDeclaration(declaration, globals, context);

  const mainType = prune(globals.get("main")!.type);
  if (!isRuntimeMainType(mainType)) {
    throw new OJamlError(`Program 'main' cannot return ${showType(mainType)} directly; print it or return int, bool, or unit`, 0, 0);
  }
  return { mainType: mainType.name, symbols: collectCheckedSymbols(program, globals), tokens: finalizeTokens(context.tokens) };
}

export function getStdlibSignatures(): StdlibSignature[] {
  return stdlibSignatures.map(({ name, detail, documentation }) => ({ name, detail, documentation }));
}

function builtins(): Map<string, Binding> {
  return new Map<string, Binding>(stdlibSignatures.map((signature) => [
    signature.name,
    { type: signature.createType(), builtinDetail: signature.detail, documentation: signature.documentation },
  ]));
}

const stdlibSignatures: BuiltinSignature[] = [
  builtin("print", "print : int|float|string -> unit", () => fn([typeVar()], unitType), "Prints an integer, float, or string and returns unit."),
  builtin("println", "println : int|float|string -> unit", () => fn([typeVar()], unitType), "Prints an integer, float, or string followed by a newline and returns unit."),
  builtin("Float.of_int", "Float.of_int : int -> float", () => fn([intType], floatType)),
  builtin("Float.to_int", "Float.to_int : float -> int", () => fn([floatType], intType)),
  builtin("to_string", "to_string : 'a -> string", () => fn([typeVar()], stringType), "Converts any OJaml value into a printable string."),
  builtin("String.concat", "String.concat : string -> string -> string", () => fn([stringType, stringType], stringType)),
  builtin("String.length", "String.length : string -> int", () => fn([stringType], intType)),
  builtin("String.split", "String.split : string -> string -> string list", () => fn([stringType, stringType], app("list", [stringType]))),
  builtin("Array.make", "Array.make : int -> 'a -> 'a array", () => {
    const a = typeVar();
    return fn([intType, a], app("array", [a]));
  }),
  builtin("Array.length", "Array.length : 'a array -> int", () => fn([app("array", [typeVar()])], intType)),
  builtin("Array.get", "Array.get : 'a array -> int -> 'a", () => {
    const a = typeVar();
    return fn([app("array", [a]), intType], a);
  }),
  builtin("Array.set", "Array.set : 'a array -> int -> 'a -> unit", () => {
    const a = typeVar();
    return fn([app("array", [a]), intType, a], unitType);
  }),
  builtin("Array.map", "Array.map : ('a -> 'b) -> 'a array -> 'b array", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([fn([a], b), app("array", [a])], app("array", [b]));
  }),
  builtin("Array.iter", "Array.iter : ('a -> unit) -> 'a array -> unit", () => {
    const a = typeVar();
    return fn([fn([a], unitType), app("array", [a])], unitType);
  }),
  builtin("Array.fold_left", "Array.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a array -> 'b", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([fn([b, a], b), b, app("array", [a])], b);
  }),
  builtin("List.empty", "List.empty : unit -> 'a list", () => fn([unitType], app("list", [typeVar()]))),
  builtin("List.cons", "List.cons : 'a -> 'a list -> 'a list", () => {
    const a = typeVar();
    return fn([a, app("list", [a])], app("list", [a]));
  }),
  builtin("List.head", "List.head : 'a list -> 'a", () => {
    const a = typeVar();
    return fn([app("list", [a])], a);
  }),
  builtin("List.tail", "List.tail : 'a list -> 'a list", () => {
    const a = typeVar();
    return fn([app("list", [a])], app("list", [a]));
  }),
  builtin("List.is_empty", "List.is_empty : 'a list -> bool", () => fn([app("list", [typeVar()])], boolType)),
  builtin("List.length", "List.length : 'a list -> int", () => fn([app("list", [typeVar()])], intType)),
  builtin("List.map", "List.map : ('a -> 'b) -> 'a list -> 'b list", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([fn([a], b), app("list", [a])], app("list", [b]));
  }),
  builtin("List.iter", "List.iter : ('a -> unit) -> 'a list -> unit", () => {
    const a = typeVar();
    return fn([fn([a], unitType), app("list", [a])], unitType);
  }),
  builtin("List.fold_left", "List.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a list -> 'b", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([fn([b, a], b), b, app("list", [a])], b);
  }),
  builtin("Set.empty", "Set.empty : unit -> 'a set", () => fn([unitType], app("set", [typeVar()]))),
  builtin("Set.add", "Set.add : 'a set -> 'a -> 'a set", () => {
    const a = typeVar();
    return fn([app("set", [a]), a], app("set", [a]));
  }),
  builtin("Set.has", "Set.has : 'a set -> 'a -> bool", () => {
    const a = typeVar();
    return fn([app("set", [a]), a], boolType);
  }),
  builtin("Set.length", "Set.length : 'a set -> int", () => fn([app("set", [typeVar()])], intType)),
  builtin("Map.empty", "Map.empty : unit -> ('k, 'v) map", () => fn([unitType], app("map", [typeVar(), typeVar()]))),
  builtin("Map.set", "Map.set : ('k, 'v) map -> 'k -> 'v -> ('k, 'v) map", () => {
    const k = typeVar();
    const v = typeVar();
    return fn([app("map", [k, v]), k, v], app("map", [k, v]));
  }),
  builtin("Map.get", "Map.get : ('k, 'v) map -> 'k -> 'v", () => {
    const k = typeVar();
    const v = typeVar();
    return fn([app("map", [k, v]), k], v);
  }),
  builtin("Map.has", "Map.has : ('k, 'v) map -> 'k -> bool", () => {
    const k = typeVar();
    const v = typeVar();
    return fn([app("map", [k, v]), k], boolType);
  }),
];

function builtin(name: string, detail: string, createType: () => Type, documentation = "OJaml standard library builtin."): BuiltinSignature {
  return { name, detail, documentation, createType };
}

function makeDeclarationStub(declaration: Declaration): Type {
  if (declaration.params.length === 0) return typeVar();
  return fn(declaration.params.map(() => typeVar()), typeVar());
}

function checkDeclaration(declaration: Declaration, globals: Map<string, Binding>, context: CheckContext): Type {
  const binding = globals.get(declaration.name)!;
  const locals = new Map<string, Type>();
  let expectedResult = binding.type;
  if (declaration.params.length > 0) {
    const type = prune(binding.type);
    if (type.kind !== "fn") throw new OJamlError("Internal function type mismatch", declaration.span.start, declaration.span.end);
    declaration.params.forEach((param, index) => locals.set(param, type.params[index]));
    expectedResult = type.result;
  }
  const bodyType = checkExpr(declaration.value, globals, locals, context);
  unify(expectedResult, bodyType, declaration.value.span);
  const type = prune(binding.type);
  context.tokens.push({
    name: declaration.name,
    kind: type.kind === "fn" ? "function" : "value",
    type: binding.type,
    span: declaration.nameSpan,
  });
  declaration.params.forEach((param, index) => {
    context.tokens.push({
      name: param,
      kind: "value",
      type: type.kind === "fn" ? type.params[index] : typeVar(),
      span: declaration.paramSpans[index],
    });
  });
  return prune(binding.type);
}

function checkExpr(expr: Expr, globals: Map<string, Binding>, locals: Map<string, Type>, context: CheckContext): Type {
  switch (expr.kind) {
    case "Int":
      context.tokens.push({ name: String(expr.value), kind: "literal", type: intType, span: expr.span });
      return intType;
    case "Float":
      context.tokens.push({ name: String(expr.value), kind: "literal", type: floatType, span: expr.span });
      return floatType;
    case "String":
      context.tokens.push({ name: "string literal", kind: "literal", type: stringType, span: expr.span });
      return stringType;
    case "Bool":
      context.tokens.push({ name: String(expr.value), kind: "literal", type: boolType, span: expr.span });
      return boolType;
    case "Unit":
      context.tokens.push({ name: "()", kind: "literal", type: unitType, span: expr.span });
      return unitType;
    case "Var": {
      const local = locals.get(expr.name);
      if (local) {
        context.tokens.push({ name: expr.name, kind: "value", type: local, span: expr.span });
        return local;
      }
      const global = globals.get(expr.name);
      if (!global) throw new OJamlError(`Undefined name '${expr.name}'`, expr.span.start, expr.span.end);
      const type = fresh(global.type);
      const pruned = prune(type);
      context.tokens.push({
        name: expr.name,
        kind: global.builtinDetail ? "builtin" : pruned.kind === "fn" ? "function" : "value",
        type,
        span: expr.span,
        documentation: global.documentation,
      });
      return type;
    }
    case "Unary":
      return requireNumeric(checkExpr(expr.expr, globals, locals, context), expr.span);
    case "Binary":
      return checkBinary(expr, globals, locals, context);
    case "If":
      unify(checkExpr(expr.condition, globals, locals, context), boolType, expr.condition.span);
      return sameBranches(checkExpr(expr.thenBranch, globals, locals, context), checkExpr(expr.elseBranch, globals, locals, context), expr.span);
    case "LetIn": {
      const valueType = checkExpr(expr.value, globals, locals, context);
      context.tokens.push({ name: expr.name, kind: "value", type: valueType, span: expr.nameSpan });
      const nested = new Map(locals);
      nested.set(expr.name, valueType);
      return checkExpr(expr.body, globals, nested, context);
    }
    case "Call": {
      if (expr.callee.kind === "Var") {
        const binding = globals.get(expr.callee.name);
        const targetType = resolveVarType(expr.callee, globals, locals);
        if (expr.callee.name === "print" || expr.callee.name === "println") {
          if (expr.args.length !== 1) {
            throw new OJamlError(`Function expects 1 argument(s), got ${expr.args.length}`, expr.span.start, expr.span.end);
          }
          const argType = checkExpr(expr.args[0], globals, locals, context);
          const arg = prune(argType);
          if (arg.kind !== "var" && !(arg.kind === "prim" && (arg.name === "int" || arg.name === "float" || arg.name === "string"))) {
            throw new OJamlError(`${expr.callee.name} expects int, float, or string; got ${showType(arg)}`, expr.args[0].span.start, expr.args[0].span.end);
          }
          context.tokens.push({
            name: expr.callee.name,
            kind: "builtin",
            detail: arg.kind === "var" ? `${expr.callee.name} : int|float|string -> unit` : `${expr.callee.name} : ${showType(arg)} -> unit`,
            span: expr.callee.span,
            documentation: binding?.documentation,
          });
          return unitType;
        }
        const argTypes = expr.args.map((arg) => checkExpr(arg, globals, locals, context));
        const resultType = typeVar();
        const pruned = prune(targetType);
        if (pruned.kind === "fn" && pruned.params.length !== expr.args.length) {
          throw new OJamlError(`Function expects ${pruned.params.length} argument(s), got ${expr.args.length}`, expr.span.start, expr.span.end);
        }
        unify(targetType, fn(argTypes, resultType), expr.span);
        const resolved = prune(targetType);
        context.tokens.push({
          name: expr.callee.name,
          kind: binding?.builtinDetail ? "builtin" : resolved.kind === "fn" ? "function" : "value",
          type: targetType,
          span: expr.callee.span,
          documentation: binding?.documentation,
        });
        return resultType;
      }
      const targetType = checkExpr(expr.callee, globals, locals, context);
      const argTypes = expr.args.map((arg) => checkExpr(arg, globals, locals, context));
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
      const result = checkExpr(expr.body, globals, nested, context);
      expr.params.forEach((param, index) => {
        context.tokens.push({ name: param, kind: "value", type: params[index], span: expr.paramSpans[index] });
      });
      return fn(params, result);
    }
    case "Match": {
      const scrutineeType = checkExpr(expr.expr, globals, locals, context);
      let resultType: Type | undefined;
      let hasCatchAll = false;
      for (const arm of expr.arms) {
        const nested = new Map(locals);
        hasCatchAll ||= checkPattern(arm.pattern, scrutineeType, nested, context);
        const armType = checkExpr(arm.body, globals, nested, context);
        resultType = resultType ? sameBranches(resultType, armType, arm.span) : armType;
      }
      if (!hasCatchAll) throw new OJamlError("Match must include a wildcard or variable catch-all arm", expr.span.start, expr.span.end);
      return resultType ?? unitType;
    }
  }
}

function resolveVarType(expr: Extract<Expr, { kind: "Var" }>, globals: Map<string, Binding>, locals: Map<string, Type>): Type {
  const local = locals.get(expr.name);
  if (local) return local;
  const global = globals.get(expr.name);
  if (!global) throw new OJamlError(`Undefined name '${expr.name}'`, expr.span.start, expr.span.end);
  return fresh(global.type);
}

function checkBinary(expr: Extract<Expr, { kind: "Binary" }>, globals: Map<string, Binding>, locals: Map<string, Type>, context: CheckContext): Type {
  if (expr.op === "&&" || expr.op === "||") {
    unify(checkExpr(expr.left, globals, locals, context), boolType, expr.left.span);
    unify(checkExpr(expr.right, globals, locals, context), boolType, expr.right.span);
    return boolType;
  }
  const leftType = checkExpr(expr.left, globals, locals, context);
  const rightType = checkExpr(expr.right, globals, locals, context);
  if (expr.op === "=" || expr.op === "<>") {
    if (!allowNumericPair(leftType, rightType)) unify(leftType, rightType, expr.span);
    return boolType;
  }
  if (expr.op === "mod") {
    unify(leftType, intType, expr.left.span);
    unify(rightType, intType, expr.right.span);
    return intType;
  }
  if (expr.op === "**") {
    const left = requireNumeric(leftType, expr.left.span);
    const right = requireNumeric(rightType, expr.right.span);
    if (isConcreteFloat(left) || isConcreteFloat(right)) return floatType;
    if (isConcreteInt(left) && isConcreteInt(right)) return intType;
    if (left.kind === "var" && isConcreteInt(right)) return left;
    if (right.kind === "var" && isConcreteInt(left)) return right;
    const result: Type = { kind: "var", id: nextTypeVar++, numeric: true };
    return result;
  }
  const result = numericResultType(leftType, rightType, expr.span);
  return ["<", "<=", ">", ">="].includes(expr.op) ? boolType : result;
}

function allowNumericPair(left: Type, right: Type): boolean {
  const leftPruned = prune(left);
  const rightPruned = prune(right);
  return (isConcreteInt(leftPruned) && isConcreteFloat(rightPruned))
    || (isConcreteFloat(leftPruned) && isConcreteInt(rightPruned));
}

function numericResultType(leftRaw: Type, rightRaw: Type, span: SourceSpan): Type {
  const left = requireNumeric(leftRaw, span);
  const right = requireNumeric(rightRaw, span);
  if (isConcreteFloat(left) || isConcreteFloat(right)) return floatType;
  if (isConcreteInt(left) && isConcreteInt(right)) return intType;
  if (left.kind === "var" && right.kind === "var") {
    unify(left, right, span);
    const unified = prune(left);
    if (unified.kind === "var") unified.numeric = true;
    return unified;
  }
  if (left.kind === "var") return left;
  if (right.kind === "var") return right;
  return intType;
}

function requireNumeric(type: Type, span: SourceSpan): Type {
  const pruned = prune(type);
  if (pruned.kind === "var") {
    pruned.numeric = true;
    return pruned;
  }
  if (pruned.kind === "prim" && (pruned.name === "int" || pruned.name === "float")) return pruned;
  throw new OJamlError(`Operator expects int or float; got ${showType(pruned)}`, span.start, span.end);
}

function isNumericLike(type: Type): boolean {
  const pruned = prune(type);
  return (pruned.kind === "var" && pruned.numeric === true) || isConcreteInt(pruned) || isConcreteFloat(pruned);
}

function isConcreteInt(type: Type): boolean {
  const pruned = prune(type);
  return pruned.kind === "prim" && pruned.name === "int";
}

function isConcreteFloat(type: Type): boolean {
  const pruned = prune(type);
  return pruned.kind === "prim" && pruned.name === "float";
}

function checkPattern(pattern: Pattern, scrutinee: Type, locals: Map<string, Type>, context: CheckContext): boolean {
  switch (pattern.kind) {
    case "PInt":
      unify(scrutinee, intType, pattern.span);
      context.tokens.push({ name: String(pattern.value), kind: "literal", type: intType, span: pattern.span });
      return false;
    case "PFloat":
      unify(scrutinee, floatType, pattern.span);
      context.tokens.push({ name: String(pattern.value), kind: "literal", type: floatType, span: pattern.span });
      return false;
    case "PString":
      unify(scrutinee, stringType, pattern.span);
      context.tokens.push({ name: "string literal", kind: "literal", type: stringType, span: pattern.span });
      return false;
    case "PBool":
      unify(scrutinee, boolType, pattern.span);
      context.tokens.push({ name: String(pattern.value), kind: "literal", type: boolType, span: pattern.span });
      return false;
    case "PUnit":
      unify(scrutinee, unitType, pattern.span);
      context.tokens.push({ name: "()", kind: "literal", type: unitType, span: pattern.span });
      return false;
    case "PWildcard":
      return true;
    case "PVar":
      locals.set(pattern.name, scrutinee);
      context.tokens.push({ name: pattern.name, kind: "value", type: scrutinee, span: pattern.span });
      return true;
  }
}

function sameBranches(left: Type, right: Type, span: SourceSpan): Type {
  unify(left, right, span);
  return left;
}

function prim(name: Exclude<OJamlType, "array" | "list" | "set" | "map" | "fn">): Type {
  return { kind: "prim", name };
}

function app(name: "array" | "list" | "set", args: [Type]): Type;
function app(name: "map", args: [Type, Type]): Type;
function app(name: "array" | "list" | "set" | "map", args: Type[]): Type {
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
    if (left.numeric && right.kind !== "var" && !(right.kind === "prim" && (right.name === "int" || right.name === "float"))) {
      throw typeMismatch(left, right, span);
    }
    if (left.numeric && right.kind === "var") right.numeric = true;
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
  return pruned.kind === "prim" && (pruned.name === "int" || pruned.name === "float" || pruned.name === "bool" || pruned.name === "unit");
}

function showType(type: Type): string {
  const pruned = prune(type);
  if (pruned.kind === "prim") return pruned.name;
  if (pruned.kind === "var") {
    if (pruned.numeric) return "number";
    return `'${String.fromCharCode(97 + (pruned.id % 26))}${pruned.id >= 26 ? Math.floor(pruned.id / 26) : ""}`;
  }
  if (pruned.kind === "fn") return `${pruned.params.map(showType).join(" -> ")} -> ${showType(pruned.result)}`;
  if (pruned.name === "map") return `(${showType(pruned.args[0])}, ${showType(pruned.args[1])}) map`;
  return `${showType(pruned.args[0])} ${pruned.name}`;
}

function typeMismatch(left: Type, right: Type, span: SourceSpan): OJamlError {
  return new OJamlError(`Type mismatch: ${showType(left)} vs ${showType(right)}`, span.start, span.end);
}

function finalizeTokens(tokens: PendingToken[]): CheckedToken[] {
  return tokens
    .filter((token) => token.span !== undefined)
    .map((token) => ({
      name: token.name,
      kind: token.kind,
      span: token.span,
      documentation: token.documentation,
      detail: token.detail ?? (token.type ? `${token.name} : ${showType(token.type)}` : token.name),
    }));
}

function collectCheckedSymbols(program: Program, globals: Map<string, Binding>): CheckedSymbol[] {
  const symbols: CheckedSymbol[] = [];
  for (const [name, binding] of builtins()) {
    symbols.push({
      name,
      kind: "builtin",
      detail: binding.builtinDetail ?? `${name} : ${showType(binding.type)}`,
    });
  }
  for (const declaration of program.declarations) {
    const binding = globals.get(declaration.name);
    if (!binding) continue;
    const type = prune(binding.type);
    symbols.push({
      name: declaration.name,
      kind: type.kind === "fn" ? "function" : "value",
      detail: `${declaration.name} : ${showType(type)}`,
      span: declaration.nameSpan,
      params: declaration.params.map((param, index) => ({
        name: param,
        detail: type.kind === "fn" ? `${param} : ${showType(type.params[index])}` : `${param} : unknown`,
        span: declaration.paramSpans[index],
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
      const valueType = checkExpr(expr.value, globals, locals, { tokens: [] });
      symbols.push({ name: expr.name, detail: `${expr.name} : ${showType(valueType)}`, span: expr.nameSpan });
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
      const fnType = checkExpr(expr, globals, locals, { tokens: [] });
      const pruned = prune(fnType);
      expr.params.forEach((param, index) => {
        const paramType = pruned.kind === "fn" ? pruned.params[index] : typeVar();
        nested.set(param, paramType);
        symbols.push({ name: param, detail: `${param} : ${showType(paramType)}`, span: expr.paramSpans[index] });
      });
      collectLocalSymbolsInExpr(expr.body, globals, nested, symbols);
      return undefined;
    }
    case "Match":
      collectLocalSymbolsInExpr(expr.expr, globals, locals, symbols);
      expr.arms.forEach((arm) => {
        const nested = new Map(locals);
        if (arm.pattern.kind === "PVar") {
          const scrutineeType = checkExpr(expr.expr, globals, locals, { tokens: [] });
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
