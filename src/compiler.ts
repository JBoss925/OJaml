import type { Declaration, Expr, OpenDeclaration, Pattern, Program } from "./ast";
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

type ConstructorInfo = {
  name: string;
  typeName: string;
  tag: number;
  hasPayload: boolean;
};

let lambdaInfos: LambdaInfo[] = [];
let nextLambdaId = 0;
let nextTableIndex = 0;
let topLevelClosureIndices = new Map<string, number>();
let topLevelSpecializations = new Map<string, Map<string, string>>();

const openableModules = new Set(["Array", "Float", "List", "Map", "Set", "String"]);

export function compile(source: string): CompileResult {
  const ast = parse(source);
  const checked = check(ast);
  return { ast, wat: emitWat(ast, checked.symbols, checked.tokens), mainType: checked.mainType };
}

export function emitWat(program: Program, checkedSymbols: CheckedSymbol[] = [], checkedTokens: CheckedToken[] = []): string {
  const declarations = letDeclarations(program);
  const constructors = collectConstructorInfos(program);
  const openAliases = collectOpenAliases(program);
  lambdaInfos = [];
  nextLambdaId = 0;
  nextTableIndex = 0;
  topLevelSpecializations = new Map();
  topLevelClosureIndices = new Map(declarations
    .filter((declaration) => declaration.params.length > 0)
    .map((declaration) => [declaration.name, nextTableIndex++]));
  const strings = new StringPool();
  const globals = new Map<string, number>([
    ...builtinArities(),
    ...declarations.map((declaration): [string, number] => [declaration.name, declaration.params.length]),
  ]);
  const symbolTypes = collectSymbolTypes(checkedSymbols);
  const tokenTypes = collectTokenTypes(checkedTokens);
  const globalTypes = collectGlobalTypes(program, symbolTypes.globals, openAliases);
  const callHints = collectTopLevelCallHints(program, globalTypes, openAliases);
  topLevelSpecializations = collectTopLevelSpecializations(program, callHints, checkedTokens);
  const topLevelWrapperNames = [
    ...declarations.filter((declaration) => declaration.params.length > 0).map((declaration) => declaration.name),
    ...[...topLevelSpecializations.values()].flatMap((variants) => [...variants.values()]),
  ];
  for (const name of topLevelWrapperNames) {
    if (!topLevelClosureIndices.has(name)) topLevelClosureIndices.set(name, nextTableIndex++);
  }
  const emittedDeclarations = declarations.map((declaration) => {
    const checkedLocals = new Map(symbolTypes.locals.get(declaration.name));
    return emitDeclaration(declaration, globals, globalTypes, strings, checkedLocals, tokenTypes, constructors, declaration.name, openAliases);
  }).join("\n\n");
  const specializedDeclarations = emitTopLevelSpecializations(program, globals, globalTypes, strings, tokenTypes, constructors, openAliases);
  const lambdas = emitPendingLambdas(globals, globalTypes, strings, tokenTypes, constructors, openAliases);
  const dataSegments = strings.emitDataSegments();
  const tableEntries = [
    ...topLevelWrapperNames.map((name) => `$__closure_${safe(name)}`),
    ...lambdaInfos.sort((left, right) => left.index - right.index).map((lambda) => `$__lambda_${lambda.id}`),
  ];
  const functionTypes = emitFunctionTypes(maxIndirectArity(program, lambdaInfos));
  return `(module
${indent(functionTypes, 2)}
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

${indent([emittedDeclarations, specializedDeclarations].filter(Boolean).join("\n\n"), 2)}
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
  constructors = new Map<string, ConstructorInfo>(),
  nameOverride = declaration.name,
  openAliases = new Map<string, string>(),
): string {
  const params = declaration.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
  const locals = collectLocals(declaration);
  for (const param of declaration.params) locals.add(param);
  const localTypes = collectLocalTypes(declaration, globalTypes, checkedLocals, openAliases);
  const localLines = [...locals].filter((name) => !declaration.params.includes(name)).map((name) => `  (local $${safe(name)} i32)`);
  const body = emitExpr(declaration.value, new EmitContext(globals, locals, localTypes, globalTypes, strings, tokenTypes, constructors, openAliases));
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
    readonly constructors = new Map<string, ConstructorInfo>(),
    readonly openAliases = new Map<string, string>(),
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
    return inferSimpleType(expr, new Map([...this.globalTypes, ...this.localTypes]), this.openAliases);
  }

  resolveName(name: string): string {
    if (this.locals.has(name) || this.captured.has(name) || this.globals.has(name)) return name;
    return this.openAliases.get(name) || name;
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
    case "TupleAccess": {
      const shape = context.exprType(expr.tuple);
      if (shape.kind !== "tuple") throw new Error(`Tuple access expects a tuple shape for index ${expr.index}`);
      if (expr.index < 0 || expr.index >= shape.items.length) throw new Error(`Tuple index ${expr.index} is out of bounds`);
      return tupleItem(emitExpr(expr.tuple, context), expr.index);
    }
    case "Record":
      return emitRecord(expr, context);
    case "FieldAccess": {
      const shape = context.exprType(expr.record);
      if (shape.kind !== "record") throw new Error(`Field access expects a record shape for ${expr.field}`);
      const index = shape.fields.findIndex((field) => field.name === expr.field);
      if (index < 0) throw new Error(`Record has no field ${expr.field}`);
      return recordField(emitExpr(expr.record, context), index);
    }
    case "Var":
      if (context.constructors.has(expr.name) && !context.constructors.get(expr.name)!.hasPayload) return emitVariantConstructor(context.constructors.get(expr.name)!);
      if (context.locals.has(expr.name)) return `(local.get $${safe(expr.name)})`;
      if (context.captured.has(expr.name)) return `(i32.load (i32.add (local.get $__env) (i32.const ${4 + context.captured.get(expr.name)! * 4})))`;
      if (context.globals.get(expr.name) === 0) return `(call $${safe(expr.name)})`;
      if (context.globals.has(expr.name)) return emitTopLevelClosure(functionValueName(expr.name, context.exprType(expr)));
      return `(local.get $${safe(expr.name)})`;
    case "Unary":
      if (expr.op === "not") return `(i32.eqz ${emitExpr(expr.expr, context)})`;
      if (context.exprType(expr.expr).kind === "float") return `(call $box_float (f64.neg (call $unbox_float ${emitExpr(expr.expr, context)})))`;
      return `(i32.sub (i32.const 0) ${emitExpr(expr.expr, context)})`;
    case "Binary":
      return emitBinary(expr, context);
    case "Sequence":
      return `(block (result i32)
  (drop ${emitExpr(expr.first, context)})
  ${emitExpr(expr.second, context)}
)`;
    case "If":
      return `(if (result i32) ${emitExpr(expr.condition, context)}
  (then ${emitExpr(expr.thenBranch, context)})
  (else ${emitExpr(expr.elseBranch, context)}))`;
    case "LetIn":
      if (expr.recursive && expr.value.kind === "Fun") {
        return `(block (result i32)
  (local.set $${safe(expr.name)} ${emitClosure(expr.value, context, expr.name)})
  ${emitExpr(expr.body, context)}
)`;
      }
      return `(block (result i32)
  (local.set $${safe(expr.name)} ${emitExpr(expr.value, context)})
  ${emitExpr(expr.body, context)}
)`;
    case "Call":
      return emitCall(expr.callee, expr.args, context);
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

function emitCall(callee: Expr, args: Expr[], context: EmitContext): string {
  if (callee.kind === "Var" && context.constructors.has(callee.name)) {
    return emitVariantConstructor(context.constructors.get(callee.name)!, args[0], context);
  }
  if (callee.kind === "Var" && (context.resolveName(callee.name) === "print" || context.resolveName(callee.name) === "println")) {
    const argShape = context.exprType(args[0]);
    const calleeName = context.resolveName(callee.name);
    const newline = calleeName === "println" ? `\n  (call $print_string (i32.const ${context.strings.intern("\n")}))` : "";
    if (argShape.kind === "string") {
      return `(block (result i32)
  (call $print_string ${emitExpr(args[0], context)})${newline}
  (i32.const 0)
)`;
    }
    if (argShape.kind === "float") {
      return `(block (result i32)
  (call $print_f64 (call $unbox_float ${emitExpr(args[0], context)}))${newline}
  (i32.const 0)
)`;
    }
    return `(block (result i32)
  (call $print_i32 ${emitExpr(args[0], context)})${newline}
  (i32.const 0)
)`;
  }
  if (callee.kind === "Var" && context.resolveName(callee.name) === "to_string") {
    const arg = args[0];
    return `(call $host_to_string ${emitExpr(arg, context)} (i32.const ${context.strings.intern(typeDescriptor(context.exprType(arg)))}))`;
  }
  if (callee.kind === "Var" && (context.resolveName(callee.name) === "fst" || context.resolveName(callee.name) === "snd")) {
    const offset = context.resolveName(callee.name) === "fst" ? 4 : 8;
    return `(i32.load (i32.add ${emitExpr(args[0], context)} (i32.const ${offset})))`;
  }
  if (callee.kind === "Var" && (context.resolveName(callee.name) === "Set.add" || context.resolveName(callee.name) === "Set.has")) {
    const calleeName = context.resolveName(callee.name);
    const elementShape = context.exprType(args[1]);
    const helper = elementShape.kind === "float"
      ? `${calleeName}.float`
      : calleeName;
    return `(call $${safe(helper)} ${args.map((arg) => emitExpr(arg, context)).join(" ")})`;
  }
  if (callee.kind === "Var" && (context.locals.has(callee.name) || context.captured.has(callee.name))) {
    return emitIndirectCall(callee, args, context);
  }
  if (callee.kind === "Var" && context.globals.has(context.resolveName(callee.name))) {
    const calleeName = context.resolveName(callee.name);
    const specialization = topLevelSpecializations.get(calleeName)?.get(callShapeKey(args.map((arg) => context.exprType(arg))));
    return `(call $${safe(specialization ?? calleeName)} ${args.map((arg) => emitExpr(arg, context)).join(" ")})`;
  }
  return emitIndirectCall(callee, args, context);
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

function emitRecord(expr: Extract<Expr, { kind: "Record" }>, context: EmitContext): string {
  const local = context.nextTupleLocal();
  const fields = sortedFields(expr.fields);
  const stores = fields.map((field, index) => `(i32.store (i32.add (local.get $${local}) (i32.const ${4 + index * 4})) ${emitExpr(field.value, context)})`).join("\n  ");
  return `(block (result i32)
  (local.set $${local} (call $alloc (i32.const ${4 + fields.length * 4})))
  (i32.store (local.get $${local}) (i32.const ${fields.length}))
  ${stores}
  (local.get $${local})
)`;
}

function emitVariantConstructor(constructor: ConstructorInfo, payload?: Expr, context?: EmitContext): string {
  if (constructor.hasPayload) {
    if (!payload || !context) throw new Error(`Constructor ${constructor.name} requires a payload`);
    const local = context.nextTupleLocal();
    return `(block (result i32)
  (local.set $${local} (call $alloc (i32.const 8)))
  (i32.store (local.get $${local}) (i32.const ${constructor.tag}))
  (i32.store (i32.add (local.get $${local}) (i32.const 4)) ${emitExpr(payload, context)})
  (local.get $${local})
)`;
  }
  return `(block (result i32)
  (local.set $__variant (call $alloc (i32.const 4)))
  (i32.store (local.get $__variant) (i32.const ${constructor.tag}))
  (local.get $__variant)
)`;
}

function emitBinary(expr: Extract<Expr, { kind: "Binary" }>, context: EmitContext): string {
  if (expr.op === "|>") return emitCall(expr.right, [expr.left], context);
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
  const test = emitPatternTest(arm.pattern, `(local.get $${local})`, context);
  const bindings = emitPatternBindings(arm.pattern, `(local.get $${local})`);
  return `(if (result i32) ${test}
  (then ${bindings ? `(block (result i32)\n  ${bindings}\n  ${emitExpr(arm.body, context)}\n)` : emitExpr(arm.body, context)})
  (else ${emitMatchArms(local, arms, context, index + 1)}))`;
}

function emitPatternTest(pattern: Pattern, value: string, context: EmitContext): string {
  switch (pattern.kind) {
    case "PInt":
      return `(i32.eq ${value} (i32.const ${pattern.value}))`;
    case "PFloat":
      return `(f64.eq (call $unbox_float ${value}) (f64.const ${pattern.value}))`;
    case "PString":
      return `(i32.eq ${value} (i32.const ${context.strings.intern(pattern.value)}))`;
    case "PBool":
      return `(i32.eq ${value} (i32.const ${pattern.value ? 1 : 0}))`;
    case "PUnit":
    case "PWildcard":
    case "PVar":
      return `(i32.const 1)`;
    case "PTuple": {
      const arityTest = `(i32.eq (i32.load ${value}) (i32.const ${pattern.items.length}))`;
      return pattern.items.reduce((test, item, index) => {
        const itemValue = tupleItem(value, index);
        return `(i32.and ${test} ${emitPatternTest(item, itemValue, context)})`;
      }, arityTest);
    }
    case "PRecord": {
      const fields = sortedFields(pattern.fields);
      const arityTest = `(i32.eq (i32.load ${value}) (i32.const ${fields.length}))`;
      return fields.reduce((test, field, index) => `(i32.and ${test} ${emitPatternTest(field.pattern, recordField(value, index), context)})`, arityTest);
    }
    case "PArray": {
      const lengthTest = `(i32.and (i32.ne ${value} (i32.const 0)) (i32.eq (i32.load ${value}) (i32.const ${pattern.items.length})))`;
      return pattern.items.reduce((test, item, index) => {
        const itemValue = arrayItem(value, index);
        return `(i32.and ${test} ${emitPatternTest(item, itemValue, context)})`;
      }, lengthTest);
    }
    case "PSet":
      return emitLinkedSetPatternTest(pattern.items, value, context);
    case "PMap":
      return emitLinkedMapPatternTest(pattern.entries, value, context);
    case "PConstructor": {
      const constructor = context.constructors.get(pattern.name);
      if (!constructor) return `(i32.const 0)`;
      const tagTest = `(i32.and (i32.ne ${value} (i32.const 0)) (i32.eq (i32.load ${value}) (i32.const ${constructor.tag})))`;
      return pattern.payload ? `(i32.and ${tagTest} ${emitPatternTest(pattern.payload, variantPayload(value), context)})` : tagTest;
    }
    case "PListNil":
      return `(i32.eqz ${value})`;
    case "PListCons":
      return `(i32.and (i32.ne ${value} (i32.const 0)) (i32.and ${emitPatternTest(pattern.head, listHead(value), context)} ${emitPatternTest(pattern.tail, listTail(value), context)}))`;
  }
}

function emitPatternBindings(pattern: Pattern, value: string): string {
  if (pattern.kind === "PVar") return `(local.set $${safe(pattern.name)} ${value})`;
  if (pattern.kind === "PTuple") {
    return pattern.items
      .map((item, index) => emitPatternBindings(item, tupleItem(value, index)))
      .filter(Boolean)
      .join("\n  ");
  }
  if (pattern.kind === "PRecord") {
    return sortedFields(pattern.fields)
      .map((field, index) => emitPatternBindings(field.pattern, recordField(value, index)))
      .filter(Boolean)
      .join("\n  ");
  }
  if (pattern.kind === "PArray") {
    return pattern.items
      .map((item, index) => emitPatternBindings(item, arrayItem(value, index)))
      .filter(Boolean)
      .join("\n  ");
  }
  if (pattern.kind === "PSet") {
    return pattern.items
      .map((item, index) => emitPatternBindings(item, linkedSetValue(linkedOffset(value, index))))
      .filter(Boolean)
      .join("\n  ");
  }
  if (pattern.kind === "PMap") {
    return pattern.entries
      .flatMap((entry, index) => [
        emitPatternBindings(entry.key, linkedMapKey(linkedMapOffset(value, index))),
        emitPatternBindings(entry.value, linkedMapValue(linkedMapOffset(value, index))),
      ])
      .filter(Boolean)
      .join("\n  ");
  }
  if (pattern.kind === "PConstructor" && pattern.payload) {
    return emitPatternBindings(pattern.payload, variantPayload(value));
  }
  if (pattern.kind === "PListCons") {
    return [
      emitPatternBindings(pattern.head, listHead(value)),
      emitPatternBindings(pattern.tail, listTail(value)),
    ].filter(Boolean).join("\n  ");
  }
  return "";
}

function emitLinkedSetPatternTest(items: Pattern[], value: string, context: EmitContext): string {
  let cursor = value;
  let test = items.length === 0 ? `(i32.eqz ${cursor})` : `(i32.const 1)`;
  for (const item of items) {
    test = `(i32.and ${test} (i32.and (i32.ne ${cursor} (i32.const 0)) ${emitPatternTest(item, linkedSetValue(cursor), context)}))`;
    cursor = linkedSetTail(cursor);
  }
  return `(i32.and ${test} (i32.eqz ${cursor}))`;
}

function emitLinkedMapPatternTest(entries: Array<{ key: Pattern; value: Pattern }>, value: string, context: EmitContext): string {
  let cursor = value;
  let test = entries.length === 0 ? `(i32.eqz ${cursor})` : `(i32.const 1)`;
  for (const entry of entries) {
    test = `(i32.and ${test} (i32.and (i32.ne ${cursor} (i32.const 0)) (i32.and ${emitPatternTest(entry.key, linkedMapKey(cursor), context)} ${emitPatternTest(entry.value, linkedMapValue(cursor), context)})))`;
    cursor = linkedMapTail(cursor);
  }
  return `(i32.and ${test} (i32.eqz ${cursor}))`;
}

function tupleItem(value: string, index: number): string {
  return `(i32.load (i32.add ${value} (i32.const ${4 + index * 4})))`;
}

function recordField(value: string, index: number): string {
  return `(i32.load (i32.add ${value} (i32.const ${4 + index * 4})))`;
}

function arrayItem(value: string, index: number): string {
  return `(i32.load (i32.add ${value} (i32.const ${4 + index * 4})))`;
}

function sortedFields<T extends { name: string }>(fields: T[]): T[] {
  return [...fields].sort((left, right) => left.name.localeCompare(right.name));
}

function listHead(value: string): string {
  return `(i32.load ${value})`;
}

function listTail(value: string): string {
  return `(i32.load (i32.add ${value} (i32.const 4)))`;
}

function linkedOffset(value: string, index: number): string {
  let cursor = value;
  for (let i = 0; i < index; i++) cursor = linkedSetTail(cursor);
  return cursor;
}

function linkedMapOffset(value: string, index: number): string {
  let cursor = value;
  for (let i = 0; i < index; i++) cursor = linkedMapTail(cursor);
  return cursor;
}

function linkedSetValue(value: string): string {
  return `(i32.load ${value})`;
}

function linkedSetTail(value: string): string {
  return `(i32.load (i32.add ${value} (i32.const 4)))`;
}

function linkedMapKey(value: string): string {
  return `(i32.load ${value})`;
}

function linkedMapValue(value: string): string {
  return `(i32.load (i32.add ${value} (i32.const 4)))`;
}

function linkedMapTail(value: string): string {
  return `(i32.load (i32.add ${value} (i32.const 8)))`;
}

function variantPayload(value: string): string {
  return `(i32.load (i32.add ${value} (i32.const 4)))`;
}

function emitIndirectCall(callee: Expr, args: Expr[], context: EmitContext): string {
  const arity = args.length;
  if (arity < 1) throw new Error(`Indirect calls with arity ${arity} are not implemented`);
  const calleeLocal = context.nextCallLocal();
  return `(block (result i32)
  (local.set $${calleeLocal} ${emitExpr(callee, context)})
  (call_indirect (type $fn_${arity})
    (local.get $${calleeLocal})
    ${args.map((arg) => emitExpr(arg, context)).join("\n    ")}
    (i32.load (local.get $${calleeLocal})))
)`;
}

function emitFunctionTypes(maxArity: number): string {
  const types: string[] = [];
  for (let arity = 1; arity <= maxArity; arity++) {
    types.push(`(type $fn_${arity} (func (param ${Array.from({ length: arity + 1 }, () => "i32").join(" ")}) (result i32)))`);
  }
  return types.join("\n");
}

function maxIndirectArity(program: Program, lambdas: LambdaInfo[]): number {
  const arities = [
    2,
    ...letDeclarations(program).filter((declaration) => declaration.params.length > 0).map((declaration) => declaration.params.length),
    ...lambdas.map((lambda) => lambda.params.length),
  ];
  return Math.max(...arities);
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

function emitClosure(expr: Extract<Expr, { kind: "Fun" }>, context: EmitContext, selfName?: string): string {
  const captures = [...freeVars(expr.body, new Set(expr.params))].filter((name) => context.locals.has(name) || context.captured.has(name));
  const id = nextLambdaId++;
  const index = nextTableIndex++;
  lambdaInfos.push({ id, index, params: expr.params, body: expr.body, captures });
  const stores = captures.map((name, captureIndex) => {
    const value = name === selfName
      ? `(local.get $__closure)`
      : context.captured.has(name)
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
  const declarations = letDeclarations(program);
  const baseWrappers = declarations
    .filter((declaration) => declaration.params.length > 0)
    .map((declaration) => {
      const params = declaration.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
      return `(func $__closure_${safe(declaration.name)} (param $__env i32) ${params} (result i32)
  (call $${safe(declaration.name)} ${declaration.params.map((param) => `(local.get $${safe(param)})`).join(" ")})
)`;
    });
  const declarationMap = new Map(declarations.map((declaration) => [declaration.name, declaration]));
  const specializedWrappers = [...topLevelSpecializations.entries()].flatMap(([name, variants]) => {
    const declaration = declarationMap.get(name);
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
  constructors = new Map<string, ConstructorInfo>(),
  openAliases = new Map<string, string>(),
): string {
  const emitted: string[] = [];
  let cursor = 0;
  while (cursor < lambdaInfos.length) {
    const lambda = lambdaInfos[cursor++];
    const locals = collectLocalsFromExpr(lambda.body);
    for (const param of lambda.params) locals.add(param);
    locals.add("__closure");
    const localTypes = collectLocalTypesFromExpr(lambda.body, new Map([...globalTypes, ...lambda.params.map((param): [string, ValueShape] => [param, unknownShape])]), openAliases);
    const captured = new Map(lambda.captures.map((name, index) => [name, index]));
    const localLines = [...locals]
      .filter((name) => !lambda.params.includes(name))
      .map((name) => `  (local $${safe(name)} i32)`);
    const params = lambda.params.map((param) => `(param $${safe(param)} i32)`).join(" ");
    const body = emitExpr(lambda.body, new EmitContext(globals, locals, localTypes, globalTypes, strings, tokenTypes, constructors, openAliases, captured));
    emitted.push([`(func $__lambda_${lambda.id} (param $__env i32) ${params} (result i32)`, ...localLines, indent(body, 2), ")"].join("\n"));
  }
  return emitted.join("\n\n");
}

function collectLocals(declaration: Declaration): Set<string> {
  const locals = new Set<string>();
  locals.add("__closure");
  locals.add("__variant");
  addCallScratchLocals(locals, countCalls(declaration.value));
  addTupleScratchLocals(locals);
  walk(declaration.value, locals, { matchId: 0 });
  return locals;
}

function collectLocalsFromExpr(expr: Expr): Set<string> {
  const locals = new Set<string>(["__closure", "__variant"]);
  addCallScratchLocals(locals, countCalls(expr));
  addTupleScratchLocals(locals);
  walk(expr, locals, { matchId: 0 });
  return locals;
}

function addCallScratchLocals(locals: Set<string>, count: number): void {
  for (let i = 0; i < count; i++) locals.add(`__callee${i}`);
}

function addTupleScratchLocals(locals: Set<string>): void {
  for (let i = 0; i < 16; i++) locals.add(`__tuple${i}`);
}

type ValueShape =
  | { kind: "int" | "float" | "bool" | "string" | "unit" | "unknown" }
  | { kind: "array" | "list" | "set"; elem: ValueShape }
  | { kind: "tuple"; items: ValueShape[] }
  | { kind: "record"; fields: Array<{ name: string; value: ValueShape }> }
  | { kind: "map"; key: ValueShape; value: ValueShape }
  | { kind: "fn"; result: ValueShape };

const intShape: ValueShape = { kind: "int" };
const floatShape: ValueShape = { kind: "float" };
const boolShape: ValueShape = { kind: "bool" };
const stringShape: ValueShape = { kind: "string" };
const unitShape: ValueShape = { kind: "unit" };
const unknownShape: ValueShape = { kind: "unknown" };

function letDeclarations(program: Program): Declaration[] {
  return program.declarations.filter((declaration): declaration is Declaration => declaration.kind === "Let");
}

function collectOpenAliases(program: Program): Map<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const openDeclarations = program.declarations.filter((declaration): declaration is OpenDeclaration => declaration.kind === "Open");
  for (const declaration of openDeclarations) {
    if (!openableModules.has(declaration.module)) continue;
    for (const [name] of builtinArities()) {
      const prefix = `${declaration.module}.`;
      if (!name.startsWith(prefix)) continue;
      const alias = name.slice(prefix.length);
      if (aliases.has(alias) && aliases.get(alias) !== name) ambiguous.add(alias);
      else if (!ambiguous.has(alias)) aliases.set(alias, name);
    }
  }
  for (const alias of ambiguous) aliases.delete(alias);
  return aliases;
}

function collectConstructorInfos(program: Program): Map<string, ConstructorInfo> {
  const constructors = new Map<string, ConstructorInfo>();
  for (const declaration of program.declarations) {
    if (declaration.kind !== "Type" || declaration.body.kind !== "Variant") continue;
    declaration.body.constructors.forEach((constructor, tag) => {
      constructors.set(constructor.name, {
        name: constructor.name,
        typeName: declaration.name,
        tag,
        hasPayload: constructor.payload !== undefined,
      });
    });
  }
  return constructors;
}

function collectLocalTypes(declaration: Declaration, globalTypes: Map<string, ValueShape>, checkedLocals = new Map<string, ValueShape>(), openAliases = new Map<string, string>()): Map<string, ValueShape> {
  const types = new Map<string, ValueShape>([...globalTypes, ...checkedLocals]);
  for (const param of declaration.params) {
    if (!types.has(param)) types.set(param, unknownShape);
  }
  walkTypes(declaration.value, types, openAliases);
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
  if (type.startsWith("{ ") && type.endsWith(" }")) {
    return {
      kind: "record",
      fields: splitTopLevelSemicolon(type.slice(2, -2)).map((part) => {
        const colon = part.indexOf(":");
        return { name: part.slice(0, colon).trim(), value: shapeFromTypeText(part.slice(colon + 1).trim()) };
      }),
    };
  }
  return unknownShape;
}

function splitTopLevelComma(value: string): string[] {
  return splitTopLevel(value, ",");
}

function splitTopLevelSemicolon(value: string): string[] {
  return splitTopLevel(value, ";");
}

function splitTopLevel(value: string, separator: "," | ";"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
    else if (ch === separator && depth === 0) {
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
    case "record":
      return `record(${shape.fields.map((field) => `${field.name}:${typeDescriptor(field.value)}`).join(";")})`;
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

function collectLocalTypesFromExpr(expr: Expr, types: Map<string, ValueShape>, openAliases = new Map<string, string>()): Map<string, ValueShape> {
  walkTypes(expr, types, openAliases);
  return types;
}

function collectGlobalTypes(program: Program, checkedGlobals = new Map<string, ValueShape>(), openAliases = new Map<string, string>()): Map<string, ValueShape> {
  const types = new Map<string, ValueShape>([["print", unitShape], ...checkedGlobals]);
  for (const [name] of builtinArities()) types.set(name, builtinReturnShape(name));
  for (const declaration of letDeclarations(program)) {
    if (types.has(declaration.name)) continue;
    if (declaration.params.length === 0) {
      types.set(declaration.name, inferSimpleType(declaration.value, types, openAliases));
    } else {
      types.set(declaration.name, { kind: "fn", result: inferSimpleType(declaration.value, new Map(declaration.params.map((param) => [param, unknownShape])), openAliases) });
    }
  }
  return types;
}

function collectTopLevelCallHints(program: Program, globalTypes: Map<string, ValueShape>, openAliases = new Map<string, string>()): Map<string, ValueShape[]> {
  const declarations = new Map(letDeclarations(program).map((declaration) => [declaration.name, declaration]));
  const hints = new Map<string, ValueShape[]>();
  const visit = (expr: Expr, localTypes: Map<string, ValueShape>) => {
    if (expr.kind === "Call" && expr.callee.kind === "Var" && declarations.has(expr.callee.name)) {
      const existing = hints.get(expr.callee.name) ?? [];
      expr.args.forEach((arg, index) => {
        const shape = inferSimpleType(arg, new Map([...globalTypes, ...localTypes]), openAliases);
        if (shape.kind === "float") existing[index] = floatShape;
        if (shape.kind === "int" && !existing[index]) existing[index] = intShape;
      });
      hints.set(expr.callee.name, existing);
    }
    if (expr.kind === "Binary" && expr.op === "|>" && expr.right.kind === "Var" && declarations.has(expr.right.name)) {
      const existing = hints.get(expr.right.name) ?? [];
      const shape = inferSimpleType(expr.left, new Map([...globalTypes, ...localTypes]), openAliases);
      if (shape.kind === "float") existing[0] = floatShape;
      if (shape.kind === "int" && !existing[0]) existing[0] = intShape;
      hints.set(expr.right.name, existing);
    }
    switch (expr.kind) {
      case "LetIn": {
        const nested = new Map(localTypes);
        nested.set(expr.name, inferSimpleType(expr.value, new Map([...globalTypes, ...localTypes]), openAliases));
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
      case "TupleAccess":
        visit(expr.tuple, localTypes);
        break;
      case "Record":
        expr.fields.forEach((field) => visit(field.value, localTypes));
        break;
      case "FieldAccess":
        visit(expr.record, localTypes);
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
  for (const declaration of letDeclarations(program)) {
    visit(declaration.value, new Map(declaration.params.map((param): [string, ValueShape] => [param, unknownShape])));
  }
  return hints;
}

function collectTopLevelSpecializations(program: Program, hints: Map<string, ValueShape[]>, tokens: CheckedToken[] = []): Map<string, Map<string, string>> {
  const declarations = new Map(letDeclarations(program).map((declaration) => [declaration.name, declaration]));
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
  constructors = new Map<string, ConstructorInfo>(),
  openAliases = new Map<string, string>(),
): string {
  const declarations = new Map(letDeclarations(program).map((declaration) => [declaration.name, declaration]));
  const emitted: string[] = [];
  for (const [name, variants] of topLevelSpecializations) {
    const declaration = declarations.get(name);
    if (!declaration) continue;
    for (const [key, specializedName] of variants) {
      const shapes = key.split(",").map((shape) => shape === "float" ? floatShape : intShape);
      const checkedLocals = new Map(declaration.params.map((param, index): [string, ValueShape] => [param, shapes[index] ?? intShape]));
      emitted.push(emitDeclaration(declaration, globals, globalTypes, strings, checkedLocals, tokenTypes, constructors, specializedName, openAliases));
    }
  }
  return emitted.join("\n\n");
}

function callShapeKey(shapes: ValueShape[]): string {
  return shapes.map((shape) => shape.kind === "float" ? "float" : "int").join(",");
}

function applyCallHintsToGlobalTypes(program: Program, globalTypes: Map<string, ValueShape>, hints: Map<string, ValueShape[]>, openAliases = new Map<string, string>()): void {
  for (const declaration of letDeclarations(program)) {
    const params = hints.get(declaration.name);
    if (!params?.some((shape) => shape?.kind === "float")) continue;
    const paramTypes = new Map(declaration.params.map((param, index): [string, ValueShape] => [param, params[index] ?? unknownShape]));
    const result = inferSimpleType(declaration.value, new Map([...globalTypes, ...paramTypes]), openAliases);
    globalTypes.set(declaration.name, { kind: "fn", result: result.kind === "int" || result.kind === "unknown" ? floatShape : result });
  }
}

function walkTypes(expr: Expr, types: Map<string, ValueShape>, openAliases = new Map<string, string>()): void {
  switch (expr.kind) {
    case "LetIn":
      types.set(expr.name, inferSimpleType(expr.value, types, openAliases));
      walkTypes(expr.value, types, openAliases);
      walkTypes(expr.body, types, openAliases);
      break;
    case "Sequence":
      walkTypes(expr.first, types, openAliases);
      walkTypes(expr.second, types, openAliases);
      break;
    case "Binary":
      walkTypes(expr.left, types, openAliases);
      walkTypes(expr.right, types, openAliases);
      break;
    case "Tuple":
      expr.items.forEach((item) => walkTypes(item, types, openAliases));
      break;
    case "TupleAccess":
      walkTypes(expr.tuple, types, openAliases);
      break;
    case "Record":
      expr.fields.forEach((field) => walkTypes(field.value, types, openAliases));
      break;
    case "FieldAccess":
      walkTypes(expr.record, types, openAliases);
      break;
    case "Unary":
      walkTypes(expr.expr, types, openAliases);
      break;
    case "If":
      walkTypes(expr.condition, types, openAliases);
      walkTypes(expr.thenBranch, types, openAliases);
      walkTypes(expr.elseBranch, types, openAliases);
      break;
    case "Call":
      walkTypes(expr.callee, types, openAliases);
      expr.args.forEach((arg) => walkTypes(arg, types, openAliases));
      break;
    case "Fun":
      walkTypes(expr.body, types, openAliases);
      break;
    case "Match":
      walkTypes(expr.expr, types, openAliases);
      expr.arms.forEach((arm) => walkTypes(arm.body, types, openAliases));
      break;
  }
}

function inferSimpleType(expr: Expr, types: Map<string, ValueShape>, openAliases = new Map<string, string>()): ValueShape {
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
      return { kind: "tuple", items: expr.items.map((item) => inferSimpleType(item, types, openAliases)) };
    case "TupleAccess": {
      const tuple = inferSimpleType(expr.tuple, types, openAliases);
      return tuple.kind === "tuple" ? tuple.items[expr.index] ?? unknownShape : unknownShape;
    }
    case "Record":
      return { kind: "record", fields: sortedFields(expr.fields).map((field) => ({ name: field.name, value: inferSimpleType(field.value, types, openAliases) })) };
    case "FieldAccess": {
      const record = inferSimpleType(expr.record, types, openAliases);
      return record.kind === "record" ? record.fields.find((field) => field.name === expr.field)?.value ?? unknownShape : unknownShape;
    }
    case "Var":
      return types.get(expr.name) ?? types.get(openAliases.get(expr.name) ?? "") ?? intShape;
    case "If":
      return inferSimpleType(expr.thenBranch, types, openAliases);
    case "LetIn":
      return inferSimpleType(expr.body, types, openAliases);
    case "Sequence":
      return inferSimpleType(expr.second, types, openAliases);
    case "Call":
      return inferCallShape(expr, types, openAliases);
    case "Match":
      return inferSimpleType(expr.arms[0].body, types, openAliases);
    case "Binary":
      if (["=", "<>", "<", "<=", ">", ">=", "&&", "||"].includes(expr.op)) return boolShape;
      if (expr.op === "|>") return inferFunctionResultShape(inferSimpleType(expr.right, types, openAliases));
      return inferSimpleType(expr.left, types, openAliases).kind === "float" || inferSimpleType(expr.right, types, openAliases).kind === "float" ? floatShape : intShape;
    case "Fun":
      return { kind: "fn", result: inferSimpleType(expr.body, new Map([...types, ...expr.params.map((param): [string, ValueShape] => [param, unknownShape])]), openAliases) };
    case "Unary":
      if (expr.op === "not") return boolShape;
      return inferSimpleType(expr.expr, types, openAliases).kind === "float" ? floatShape : intShape;
    case "Int":
      return intShape;
  }
}

function inferCallShape(expr: Extract<Expr, { kind: "Call" }>, types: Map<string, ValueShape>, openAliases = new Map<string, string>()): ValueShape {
  if (expr.callee.kind !== "Var") return intShape;
  const name = types.has(expr.callee.name) ? expr.callee.name : openAliases.get(expr.callee.name) ?? expr.callee.name;
  if (name === "print" || name === "println" || name === "Array.set") return unitShape;
  if (name === "Float.of_int") return floatShape;
  if (name === "Float.to_int") return intShape;
  if (name === "to_string") return stringShape;
  if (name === "fst") {
    const tuple = inferSimpleType(expr.args[0], types, openAliases);
    return tuple.kind === "tuple" ? tuple.items[0] ?? unknownShape : unknownShape;
  }
  if (name === "snd") {
    const tuple = inferSimpleType(expr.args[0], types, openAliases);
    return tuple.kind === "tuple" ? tuple.items[1] ?? unknownShape : unknownShape;
  }
  if (name === "String.concat") return stringShape;
  if (name === "String.length") return intShape;
  if (name === "String.split") return { kind: "list", elem: stringShape };
  if (name === "Array.make") return { kind: "array", elem: inferSimpleType(expr.args[1], types, openAliases) };
  if (name === "Array.map") {
    const mapped = inferFunctionResultShape(inferSimpleType(expr.args[0], types, openAliases));
    return { kind: "array", elem: mapped };
  }
  if (name === "Array.get") {
    const array = inferSimpleType(expr.args[0], types, openAliases);
    return array.kind === "array" ? array.elem : unknownShape;
  }
  if (name === "Array.length") return intShape;
  if (name === "Array.iter") return unitShape;
  if (name === "Array.fold_left") return inferSimpleType(expr.args[1], types, openAliases);
  if (name === "List.empty") return { kind: "list", elem: unknownShape };
  if (name === "List.cons") return { kind: "list", elem: inferSimpleType(expr.args[0], types, openAliases) };
  if (name === "List.map") {
    const mapped = inferFunctionResultShape(inferSimpleType(expr.args[0], types, openAliases));
    return { kind: "list", elem: mapped };
  }
  if (name === "List.head") {
    const list = inferSimpleType(expr.args[0], types, openAliases);
    return list.kind === "list" ? list.elem : unknownShape;
  }
  if (name === "List.tail") {
    const list = inferSimpleType(expr.args[0], types, openAliases);
    return list.kind === "list" ? list : { kind: "list", elem: unknownShape };
  }
  if (name === "List.length" || name === "List.is_empty") return intShape;
  if (name === "List.iter") return unitShape;
  if (name === "List.fold_left") return inferSimpleType(expr.args[1], types, openAliases);
  if (name === "Set.empty") return { kind: "set", elem: unknownShape };
  if (name === "Set.add") return { kind: "set", elem: inferSimpleType(expr.args[1], types, openAliases) };
  if (name === "Set.has" || name === "Set.length") return intShape;
  if (name === "Map.empty") return { kind: "map", key: unknownShape, value: unknownShape };
  if (name === "Map.set") return { kind: "map", key: inferSimpleType(expr.args[1], types, openAliases), value: inferSimpleType(expr.args[2], types, openAliases) };
  if (name === "Map.get") {
    const map = inferSimpleType(expr.args[0], types, openAliases);
    return map.kind === "map" ? map.value : unknownShape;
  }
  if (name === "Map.has") return intShape;
  const callee = types.get(name);
  if (callee?.kind === "fn" && (callee.result.kind === "int" || callee.result.kind === "unknown")) {
    const argShapes = expr.args.map((arg) => inferSimpleType(arg, types, openAliases));
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
    case "Sequence":
      walk(expr.first, locals, state);
      walk(expr.second, locals, state);
      break;
    case "Tuple":
      expr.items.forEach((item) => walk(item, locals, state));
      break;
    case "TupleAccess":
      walk(expr.tuple, locals, state);
      break;
    case "Record":
      expr.fields.forEach((field) => walk(field.value, locals, state));
      break;
    case "FieldAccess":
      walk(expr.record, locals, state);
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
        addPatternLocals(arm.pattern, locals);
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
    case "Sequence":
      addAll(freeVars(expr.first, bound));
      addAll(freeVars(expr.second, bound));
      break;
    case "Tuple":
      expr.items.forEach((item) => addAll(freeVars(item, bound)));
      break;
    case "TupleAccess":
      addAll(freeVars(expr.tuple, bound));
      break;
    case "Record":
      expr.fields.forEach((field) => addAll(freeVars(field.value, bound)));
      break;
    case "FieldAccess":
      addAll(freeVars(expr.record, bound));
      break;
    case "If":
      addAll(freeVars(expr.condition, bound));
      addAll(freeVars(expr.thenBranch, bound));
      addAll(freeVars(expr.elseBranch, bound));
      break;
    case "LetIn": {
      const nested = new Set(bound);
      nested.add(expr.name);
      addAll(freeVars(expr.value, expr.recursive ? nested : bound));
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
      expr.arms.forEach((arm) => {
        const nested = new Set(bound);
        addPatternBoundNames(arm.pattern, nested);
        addAll(freeVars(arm.body, nested));
      });
      break;
  }
  return result;
}

function countCalls(expr: Expr): number {
  switch (expr.kind) {
    case "Call":
      return 1 + countCalls(expr.callee) + expr.args.reduce((sum, arg) => sum + countCalls(arg), 0);
    case "Unary":
      return countCalls(expr.expr);
    case "Binary":
      if (expr.op === "|>") return 1 + countCalls(expr.left) + countCalls(expr.right);
      return countCalls(expr.left) + countCalls(expr.right);
    case "Sequence":
      return countCalls(expr.first) + countCalls(expr.second);
    case "Tuple":
      return expr.items.reduce((sum, item) => sum + countCalls(item), 0);
    case "TupleAccess":
      return countCalls(expr.tuple);
    case "Record":
      return expr.fields.reduce((sum, field) => sum + countCalls(field.value), 0);
    case "FieldAccess":
      return countCalls(expr.record);
    case "If":
      return countCalls(expr.condition) + countCalls(expr.thenBranch) + countCalls(expr.elseBranch);
    case "LetIn":
      return countCalls(expr.value) + countCalls(expr.body);
    case "Fun":
      return countCalls(expr.body);
    case "Match":
      return countCalls(expr.expr) + expr.arms.reduce((sum, arm) => sum + countCalls(arm.body), 0);
    case "Int":
    case "Float":
    case "String":
    case "Bool":
    case "Unit":
    case "Var":
      return 0;
  }
}

function addPatternLocals(pattern: Pattern, locals: Set<string>): void {
  if (pattern.kind === "PVar") {
    locals.add(pattern.name);
    return;
  }
  if (pattern.kind === "PTuple") pattern.items.forEach((item) => addPatternLocals(item, locals));
  if (pattern.kind === "PRecord") pattern.fields.forEach((field) => addPatternLocals(field.pattern, locals));
  if (pattern.kind === "PArray") pattern.items.forEach((item) => addPatternLocals(item, locals));
  if (pattern.kind === "PSet") pattern.items.forEach((item) => addPatternLocals(item, locals));
  if (pattern.kind === "PMap") {
    pattern.entries.forEach((entry) => {
      addPatternLocals(entry.key, locals);
      addPatternLocals(entry.value, locals);
    });
  }
  if (pattern.kind === "PConstructor" && pattern.payload) addPatternLocals(pattern.payload, locals);
  if (pattern.kind === "PListCons") {
    addPatternLocals(pattern.head, locals);
    addPatternLocals(pattern.tail, locals);
  }
}

function addPatternBoundNames(pattern: Pattern, bound: Set<string>): void {
  if (pattern.kind === "PVar") {
    bound.add(pattern.name);
    return;
  }
  if (pattern.kind === "PTuple") pattern.items.forEach((item) => addPatternBoundNames(item, bound));
  if (pattern.kind === "PRecord") pattern.fields.forEach((field) => addPatternBoundNames(field.pattern, bound));
  if (pattern.kind === "PArray") pattern.items.forEach((item) => addPatternBoundNames(item, bound));
  if (pattern.kind === "PSet") pattern.items.forEach((item) => addPatternBoundNames(item, bound));
  if (pattern.kind === "PMap") {
    pattern.entries.forEach((entry) => {
      addPatternBoundNames(entry.key, bound);
      addPatternBoundNames(entry.value, bound);
    });
  }
  if (pattern.kind === "PConstructor" && pattern.payload) addPatternBoundNames(pattern.payload, bound);
  if (pattern.kind === "PListCons") {
    addPatternBoundNames(pattern.head, bound);
    addPatternBoundNames(pattern.tail, bound);
  }
}

function builtinArities(): Array<[string, number]> {
  return [
    ["print", 1],
    ["println", 1],
    ["Float.of_int", 1],
    ["Float.to_int", 1],
    ["to_string", 1],
    ["fst", 1],
    ["snd", 1],
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
  if (name === "fst" || name === "snd") return unknownShape;
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
