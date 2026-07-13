import type { Declaration, Expr, ModuleDeclaration, ModuleSignatureEntry, ModuleTypeDeclaration, OpenDeclaration, Pattern, Program, SourceSpan, TypeDeclaration, TypeExpr } from "./ast";
import { OJamlError } from "./errors";

export type OJamlType = "int" | "float" | "bool" | "string" | "unit" | "tuple" | "record" | "array" | "list" | "set" | "map" | "fn";
export type RuntimeMainType = "int" | "float" | "bool" | "unit";

type Type =
  | { kind: "prim"; name: Exclude<OJamlType, "tuple" | "record" | "array" | "list" | "set" | "map" | "fn"> }
  | { kind: "var"; id: number; instance?: Type; numeric?: boolean }
  | { kind: "app"; name: "array" | "list" | "set"; args: [Type] }
  | { kind: "app"; name: "tuple"; args: Type[] }
  | { kind: "app"; name: "record"; fields: Array<{ name: string; type: Type }> }
  | { kind: "app"; name: "map"; args: [Type, Type] }
  | { kind: "variant"; name: string; args: Type[] }
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
  types: TypeEnvironment;
  constructors: Map<string, ConstructorBinding>;
  openAliases: Map<string, string>;
  openTypeAliases: Map<string, string>;
  openConstructorAliases: Map<string, string>;
  scopedAliases: Map<string, string>;
  scopedTypeAliases: Map<string, string>;
  scopedConstructorAliases: Map<string, string>;
};

type ConstructorBinding = {
  name: string;
  typeName: string;
  type: Type;
  payload?: Type;
  tag: number;
};

type ModuleSignature = {
  declaration: ModuleTypeDeclaration;
  entries: ModuleSignatureEntry[];
};

type TypeBinding =
  | { kind: "primitive"; type: Type }
  | { kind: "declared"; declaration: TypeDeclaration };

type TypeEnvironment = Map<string, TypeBinding>;

const stdlibModules = new Set(["Array", "Float", "List", "Map", "Set", "String"]);

let nextTypeVar = 0;

const intType = prim("int");
const floatType = prim("float");
const boolType = prim("bool");
const stringType = prim("string");
const unitType = prim("unit");

export function check(program: Program): CheckResult {
  nextTypeVar = 0;
  const globals = builtins();
  const typeDeclarations = collectTypeDeclarationsFromProgram(program);
  const letDeclarations = collectLetDeclarations(program);
  const moduleDeclarations = collectModuleDeclarations(program);
  ensureUniqueModules(moduleDeclarations);
  const moduleSignatures = collectModuleSignatures(program);
  const openAliases = collectOpenAliases(program.declarations.filter((declaration): declaration is OpenDeclaration => declaration.kind === "Open"), moduleDeclarations);
  const typeEnv = collectTypeDeclarations(typeDeclarations);
  const constructors = collectConstructors(typeDeclarations, typeEnv);
  const openTypeAliases = collectOpenTypeAliases(program.declarations.filter((declaration): declaration is OpenDeclaration => declaration.kind === "Open"), moduleDeclarations, typeEnv);
  const openConstructorAliases = collectOpenConstructorAliases(program.declarations.filter((declaration): declaration is OpenDeclaration => declaration.kind === "Open"), moduleDeclarations, constructors);
  for (const constructor of constructors.values()) {
    if (globals.has(constructor.name)) throw new OJamlError(`Duplicate constructor '${constructor.name}'`, 0, 0);
    const instance = instantiateConstructor(constructor);
    globals.set(constructor.name, { type: instance.payload ? fn([instance.payload], instance.type) : instance.type });
  }
  const context: CheckContext = { tokens: [], types: typeEnv, constructors, openAliases, openTypeAliases, openConstructorAliases, scopedAliases: new Map(), scopedTypeAliases: new Map(), scopedConstructorAliases: new Map() };

  for (const declaration of letDeclarations) {
    if (globals.has(declaration.name)) throw new OJamlError(`Duplicate binding '${declaration.name}'`, declaration.span.start, declaration.span.end);
    globals.set(declaration.name, { type: makeDeclarationStub(declaration, typeEnv, openTypeAliases) });
  }

  const main = globals.get("main");
  if (!main) throw new OJamlError("Program must define 'main'", 0, 0);
  if (prune(main.type).kind === "fn") throw new OJamlError("Program 'main' must not take arguments", 0, 0);

  for (const declaration of letDeclarations) checkDeclaration(declaration, globals, context);
  checkModuleSignatureAscriptions(moduleDeclarations, moduleSignatures, globals, context);

  const mainType = prune(globals.get("main")!.type);
  if (!isRuntimeMainType(mainType)) {
    throw new OJamlError(`Program 'main' cannot return ${showType(mainType)} directly; print it or return int, float, bool, or unit`, 0, 0);
  }
  return { mainType: mainType.name, symbols: collectCheckedSymbols(program, globals, openAliases), tokens: finalizeTokens(context.tokens) };
}

function collectOpenAliases(declarations: OpenDeclaration[], modules: ModuleDeclaration[] = []): Map<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const moduleNames = new Set(modules.map((moduleDeclaration) => moduleDeclaration.name));
  for (const declaration of declarations) {
    if (!stdlibModules.has(declaration.module) && !moduleNames.has(declaration.module)) {
      throw new OJamlError(`Unknown module '${declaration.module}'`, declaration.moduleSpan.start, declaration.moduleSpan.end);
    }
    for (const signature of stdlibSignatures) {
      const prefix = `${declaration.module}.`;
      if (!signature.name.startsWith(prefix)) continue;
      const alias = signature.name.slice(prefix.length);
      if (aliases.has(alias) && aliases.get(alias) !== signature.name) ambiguous.add(alias);
      else if (!ambiguous.has(alias)) aliases.set(alias, signature.name);
    }
    const moduleDeclaration = modules.find((item) => item.name === declaration.module);
    for (const member of moduleDeclaration?.declarations ?? []) {
      if (member.kind !== "Let") continue;
      const alias = member.name.slice(declaration.module.length + 1);
      if (aliases.has(alias) && aliases.get(alias) !== member.name) ambiguous.add(alias);
      else if (!ambiguous.has(alias)) aliases.set(alias, member.name);
    }
  }
  for (const alias of ambiguous) aliases.set(alias, "");
  return aliases;
}

function collectOpenTypeAliases(declarations: OpenDeclaration[], modules: ModuleDeclaration[], types: TypeEnvironment): Map<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const moduleNames = new Set(modules.map((moduleDeclaration) => moduleDeclaration.name));
  for (const declaration of declarations) {
    if (!moduleNames.has(declaration.module)) continue;
    const prefix = `${declaration.module}.`;
    for (const name of types.keys()) {
      if (!name.startsWith(prefix)) continue;
      const alias = name.slice(prefix.length);
      if (alias.includes(".")) continue;
      if (aliases.has(alias) && aliases.get(alias) !== name) ambiguous.add(alias);
      else if (!ambiguous.has(alias)) aliases.set(alias, name);
    }
  }
  for (const alias of ambiguous) aliases.set(alias, "");
  return aliases;
}

function collectOpenConstructorAliases(declarations: OpenDeclaration[], modules: ModuleDeclaration[], constructors: Map<string, ConstructorBinding>): Map<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const moduleNames = new Set(modules.map((moduleDeclaration) => moduleDeclaration.name));
  for (const declaration of declarations) {
    if (!moduleNames.has(declaration.module)) continue;
    const prefix = `${declaration.module}.`;
    for (const name of constructors.keys()) {
      if (!name.startsWith(prefix)) continue;
      const alias = name.slice(prefix.length);
      if (alias.includes(".")) continue;
      if (aliases.has(alias) && aliases.get(alias) !== name) ambiguous.add(alias);
      else if (!ambiguous.has(alias)) aliases.set(alias, name);
    }
  }
  for (const alias of ambiguous) aliases.set(alias, "");
  return aliases;
}

function collectLetDeclarations(program: Program): Declaration[] {
  return program.declarations.flatMap((declaration) => {
    if (declaration.kind === "Let") return [declaration];
    if (declaration.kind === "Module") return collectModuleLetDeclarations(declaration);
    return [];
  });
}

function collectTypeDeclarationsFromProgram(program: Program): TypeDeclaration[] {
  return program.declarations.flatMap((declaration) => {
    if (declaration.kind === "Type") return [declaration];
    if (declaration.kind === "Module") return collectModuleTypeDeclarations(declaration);
    return [];
  });
}

function collectModuleDeclarations(program: Program): ModuleDeclaration[] {
  return program.declarations.flatMap((declaration) => declaration.kind === "Module" ? collectModules(declaration) : []);
}

function collectModuleSignatures(program: Program): Map<string, ModuleSignature> {
  const signatures = new Map<string, ModuleSignature>();
  for (const declaration of program.declarations) {
    if (declaration.kind !== "ModuleType") continue;
    if (signatures.has(declaration.name)) {
      throw new OJamlError(`Duplicate module type '${declaration.name}'`, declaration.nameSpan.start, declaration.nameSpan.end);
    }
    signatures.set(declaration.name, { declaration, entries: declaration.entries });
  }
  return signatures;
}

function collectModules(declaration: ModuleDeclaration): ModuleDeclaration[] {
  return [
    declaration,
    ...declaration.declarations.flatMap((member) => member.kind === "Module" ? collectModules(member) : []),
  ];
}

function collectModuleLetDeclarations(declaration: ModuleDeclaration): Declaration[] {
  return declaration.declarations.flatMap((member) => {
    if (member.kind === "Let") return [member];
    if (member.kind === "Module") return collectModuleLetDeclarations(member);
    return [];
  });
}

function collectModuleTypeDeclarations(declaration: ModuleDeclaration): TypeDeclaration[] {
  return declaration.declarations.flatMap((member) => {
    if (member.kind === "Type") return [member];
    if (member.kind === "Module") return collectModuleTypeDeclarations(member);
    return [];
  });
}

function ensureUniqueModules(modules: ModuleDeclaration[]): void {
  const seen = new Set<string>();
  for (const moduleDeclaration of modules) {
    if (!moduleDeclaration.name.includes(".") && stdlibModules.has(moduleDeclaration.name)) {
      throw new OJamlError(`Module '${moduleDeclaration.name}' conflicts with a built-in module`, moduleDeclaration.nameSpan.start, moduleDeclaration.nameSpan.end);
    }
    if (seen.has(moduleDeclaration.name)) {
      throw new OJamlError(`Duplicate module '${moduleDeclaration.name}'`, moduleDeclaration.nameSpan.start, moduleDeclaration.nameSpan.end);
    }
    seen.add(moduleDeclaration.name);
  }
}

function checkModuleSignatureAscriptions(
  modules: ModuleDeclaration[],
  signatures: Map<string, ModuleSignature>,
  globals: Map<string, Binding>,
  context: CheckContext,
): void {
  for (const moduleDeclaration of modules) {
    if (!moduleDeclaration.signature) continue;
    const signature = signatures.get(moduleDeclaration.signature.name);
    if (!signature) {
      throw new OJamlError(`Unknown module type '${moduleDeclaration.signature.name}'`, moduleDeclaration.signature.span.start, moduleDeclaration.signature.span.end);
    }
    const localTypeAliases = moduleTypeAliases(moduleDeclaration.name, context.types);
    for (const entry of signature.entries) {
      if (entry.kind !== "Type") continue;
      const typeName = `${moduleDeclaration.name}.${entry.name}`;
      const binding = context.types.get(typeName);
      if (!binding || binding.kind !== "declared") {
        throw new OJamlError(`Module '${moduleDeclaration.name}' does not provide type '${entry.name}' required by '${signature.declaration.name}'`, entry.nameSpan.start, entry.nameSpan.end);
      }
      if (binding.declaration.params.length !== entry.params.length) {
        throw new OJamlError(`Type '${entry.name}' expects ${entry.params.length} type parameter(s) in module signature`, entry.nameSpan.start, entry.nameSpan.end);
      }
      localTypeAliases.set(entry.name, typeName);
      if (entry.body) checkSignatureTypeManifest(entry, binding.declaration, context, localTypeAliases);
    }
    for (const entry of signature.entries) {
      if (entry.kind !== "Val") continue;
      const memberName = `${moduleDeclaration.name}.${entry.name}`;
      const binding = globals.get(memberName);
      if (!binding) {
        throw new OJamlError(`Module '${moduleDeclaration.name}' does not provide value '${entry.name}' required by '${signature.declaration.name}'`, entry.nameSpan.start, entry.nameSpan.end);
      }
      const expected = resolveTypeExpr(entry.type, context.types, typeExprVars(entry.type), localTypeAliases, context.openTypeAliases);
      unify(binding.type, expected, entry.type.span);
    }
  }
}

function checkSignatureTypeManifest(
  entry: Extract<ModuleSignatureEntry, { kind: "Type" }>,
  declaration: TypeDeclaration,
  context: CheckContext,
  localTypeAliases: Map<string, string>,
): void {
  const body = entry.body;
  if (!body) return;
  if (body.kind !== declaration.body.kind) {
    throw new OJamlError(`Type '${entry.name}' does not match its signature manifest`, entry.nameSpan.start, entry.nameSpan.end);
  }
  const typeVars = new Map<string, Type>();
  entry.params.forEach((param) => typeVars.set(param.name, typeVar()));
  const declarationTypeVars = typeParamVars(declaration);
  if (body.kind === "Record" && declaration.body.kind === "Record") {
    const expectedFields = sortedSignatureFields(body.fields);
    const actualFields = sortedFields(declaration.body.fields);
    if (expectedFields.length !== actualFields.length) {
      throw new OJamlError(`Type '${entry.name}' does not match its signature manifest`, entry.nameSpan.start, entry.nameSpan.end);
    }
    expectedFields.forEach((expected, index) => {
      const actual = actualFields[index];
      if (expected.name !== actual.name) {
        throw new OJamlError(`Type '${entry.name}' does not match its signature manifest`, expected.nameSpan.start, expected.nameSpan.end);
      }
      const expectedType = resolveTypeExpr(expected.type, context.types, typeVars, localTypeAliases, context.openTypeAliases);
      const actualType = resolveTypeExpr(actual.type, context.types, declarationTypeVars, moduleTypeAliases(declaration.name, context.types), context.openTypeAliases);
      unify(actualType, expectedType, expected.type.span);
    });
    return;
  }
  if (body.kind === "Variant" && declaration.body.kind === "Variant") {
    if (body.constructors.length !== declaration.body.constructors.length) {
      throw new OJamlError(`Type '${entry.name}' does not match its signature manifest`, entry.nameSpan.start, entry.nameSpan.end);
    }
    body.constructors.forEach((expected, index) => {
      const actual = declaration.body.kind === "Variant" ? declaration.body.constructors[index] : undefined;
      if (!actual || expected.name !== actual.name.split(".").at(-1)) {
        throw new OJamlError(`Type '${entry.name}' does not match its signature manifest`, expected.nameSpan.start, expected.nameSpan.end);
      }
      if (Boolean(expected.payload) !== Boolean(actual.payload)) {
        throw new OJamlError(`Constructor '${expected.name}' does not match its signature payload`, expected.nameSpan.start, expected.nameSpan.end);
      }
      if (expected.payload && actual.payload) {
        const expectedType = resolveTypeExpr(expected.payload, context.types, typeVars, localTypeAliases, context.openTypeAliases);
        const actualType = resolveTypeExpr(actual.payload, context.types, declarationTypeVars, moduleTypeAliases(declaration.name, context.types), context.openTypeAliases);
        unify(actualType, expectedType, expected.payload.span);
      }
    });
  }
}

function sortedFields<T extends { name: string }>(fields: T[]): T[] {
  return [...fields].sort((left, right) => left.name.localeCompare(right.name));
}

function sortedSignatureFields(fields: Extract<TypeDeclaration["body"], { kind: "Record" }>["fields"]): Extract<TypeDeclaration["body"], { kind: "Record" }>["fields"] {
  return sortedFields(fields);
}

function typeExprVars(typeExpr: TypeExpr, vars = new Map<string, Type>()): Map<string, Type> {
  switch (typeExpr.kind) {
    case "TVar":
      if (!vars.has(typeExpr.name)) vars.set(typeExpr.name, typeVar());
      break;
    case "TFn":
      typeExpr.params.forEach((param) => typeExprVars(param, vars));
      typeExprVars(typeExpr.result, vars);
      break;
    case "TTuple":
      typeExpr.items.forEach((item) => typeExprVars(item, vars));
      break;
    case "TApp":
      typeExpr.args.forEach((arg) => typeExprVars(arg, vars));
      break;
    case "TRecord":
      typeExpr.fields.forEach((field) => typeExprVars(field.type, vars));
      break;
  }
  return vars;
}

function resolveOpenAlias(name: string, aliases: Map<string, string>, span: SourceSpan): string | undefined {
  const resolved = aliases.get(name);
  if (resolved === "") throw new OJamlError(`Ambiguous open name '${name}'`, span.start, span.end);
  return resolved;
}

function resolveOpenTypeAlias(name: string, aliases: Map<string, string>, span: SourceSpan): string | undefined {
  const resolved = aliases.get(name);
  if (resolved === "") throw new OJamlError(`Ambiguous open type '${name}'`, span.start, span.end);
  return resolved;
}

function resolveOpenConstructorAlias(name: string, aliases: Map<string, string>, span: SourceSpan): string | undefined {
  const resolved = aliases.get(name);
  if (resolved === "") throw new OJamlError(`Ambiguous open constructor '${name}'`, span.start, span.end);
  return resolved;
}

function collectTypeDeclarations(declarations: TypeDeclaration[]): TypeEnvironment {
  const types = new Map<string, TypeBinding>([
    ["int", { kind: "primitive", type: intType }],
    ["float", { kind: "primitive", type: floatType }],
    ["bool", { kind: "primitive", type: boolType }],
    ["string", { kind: "primitive", type: stringType }],
    ["unit", { kind: "primitive", type: unitType }],
  ]);
  for (const declaration of declarations) {
    if (types.has(declaration.name)) throw new OJamlError(`Duplicate type '${declaration.name}'`, declaration.nameSpan.start, declaration.nameSpan.end);
    ensureUniqueTypeParams(declaration);
    types.set(declaration.name, { kind: "declared", declaration });
  }
  for (const declaration of declarations) {
    const typeVars = typeParamVars(declaration);
    const aliases = moduleTypeAliases(declaration.name, types);
    if (declaration.body.kind === "Record") {
      declaration.body.fields.forEach((field) => resolveTypeExpr(field.type, types, typeVars, aliases));
    } else {
      declaration.body.constructors.forEach((constructor) => {
        if (constructor.payload) resolveTypeExpr(constructor.payload, types, typeVars, aliases);
      });
    }
  }
  return types;
}

function collectConstructors(declarations: TypeDeclaration[], types: TypeEnvironment): Map<string, ConstructorBinding> {
  const constructors = new Map<string, ConstructorBinding>();
  for (const declaration of declarations) {
    if (declaration.body.kind !== "Variant") continue;
    const typeVars = typeParamVars(declaration);
    const type = variantType(declaration.name, declaration.params.map((param) => typeVars.get(param.name)!));
    declaration.body.constructors.forEach((constructor, tag) => {
      if (constructors.has(constructor.name)) throw new OJamlError(`Duplicate constructor '${constructor.name}'`, constructor.nameSpan.start, constructor.nameSpan.end);
      constructors.set(constructor.name, {
        name: constructor.name,
        typeName: declaration.name,
        type,
        payload: constructor.payload ? resolveTypeExpr(constructor.payload, types, typeVars, moduleTypeAliases(declaration.name, types)) : undefined,
        tag,
      });
    });
  }
  return constructors;
}

function resolveTypeExpr(typeExpr: TypeExpr, types: TypeEnvironment, typeVars = new Map<string, Type>(), aliases = new Map<string, string>(), openAliases = new Map<string, string>()): Type {
  if (typeExpr.kind === "TVar") {
    const type = typeVars.get(typeExpr.name);
    if (!type) throw new OJamlError(`Unknown type parameter '${typeExpr.name}'`, typeExpr.span.start, typeExpr.span.end);
    return type;
  }
  if (typeExpr.kind === "TName") {
    return resolveNamedType(resolveTypeName(typeExpr.name, typeExpr.span, aliases, openAliases), [], types, typeExpr.span, typeVars, openAliases);
  }
  if (typeExpr.kind === "TFn") {
    return fn(typeExpr.params.map((param) => resolveTypeExpr(param, types, typeVars, aliases, openAliases)), resolveTypeExpr(typeExpr.result, types, typeVars, aliases, openAliases));
  }
  if (typeExpr.kind === "TTuple") return app("tuple", typeExpr.items.map((item) => resolveTypeExpr(item, types, typeVars, aliases, openAliases)));
  if (typeExpr.kind === "TApp") {
    if (typeExpr.name === "map") {
      if (typeExpr.args.length !== 2) throw new OJamlError("Map type expects two type arguments", typeExpr.span.start, typeExpr.span.end);
      return app("map", [resolveTypeExpr(typeExpr.args[0], types, typeVars, aliases, openAliases), resolveTypeExpr(typeExpr.args[1], types, typeVars, aliases, openAliases)]);
    }
    const args = typeExpr.args.map((arg) => resolveTypeExpr(arg, types, typeVars, aliases, openAliases));
    if (typeExpr.name === "array" || typeExpr.name === "list" || typeExpr.name === "set") {
      if (args.length !== 1) throw new OJamlError(`${typeExpr.name} type expects one type argument`, typeExpr.span.start, typeExpr.span.end);
      return app(typeExpr.name, [args[0]]);
    }
    return resolveNamedType(resolveTypeName(typeExpr.name, typeExpr.span, aliases, openAliases), args, types, typeExpr.span, typeVars, openAliases);
  }
  return recordType(typeExpr.fields.map((field) => ({ name: field.name, type: resolveTypeExpr(field.type, types, typeVars, aliases, openAliases) })));
}

function resolveTypeName(name: string, span: SourceSpan, aliases: Map<string, string>, openAliases: Map<string, string>): string {
  return aliases.get(name) ?? resolveOpenTypeAlias(name, openAliases, span) ?? name;
}

function resolveNamedType(name: string, args: Type[], types: TypeEnvironment, span: SourceSpan, outerTypeVars: Map<string, Type>, openAliases = new Map<string, string>()): Type {
  const binding = types.get(name);
  if (!binding) throw new OJamlError(`Unknown type '${name}'`, span.start, span.end);
  if (binding.kind === "primitive") {
    if (args.length !== 0) throw new OJamlError(`Type '${name}' expects 0 type argument(s), got ${args.length}`, span.start, span.end);
    return binding.type;
  }
  const { declaration } = binding;
  if (args.length !== declaration.params.length) {
    throw new OJamlError(`Type '${name}' expects ${declaration.params.length} type argument(s), got ${args.length}`, span.start, span.end);
  }
  const scoped = new Map(outerTypeVars);
  declaration.params.forEach((param, index) => scoped.set(param.name, args[index]));
  const aliases = moduleTypeAliases(declaration.name, types);
  return declaration.body.kind === "Record"
    ? recordType(declaration.body.fields.map((field) => ({ name: field.name, type: resolveTypeExpr(field.type, types, scoped, aliases, openAliases) })))
    : variantType(declaration.name, args);
}

function moduleTypeAliases(name: string, types: TypeEnvironment): Map<string, string> {
  const parts = name.split(".");
  const aliases = new Map<string, string>();
  for (let i = 1; i <= Math.max(1, parts.length - 1); i++) {
    const prefix = `${parts.slice(0, i).join(".")}.`;
    for (const key of types.keys()) {
      if (!key.startsWith(prefix)) continue;
      const alias = key.slice(prefix.length);
      if (!alias.includes(".")) aliases.set(alias, key);
    }
  }
  return aliases;
}

function moduleConstructorAliases(name: string, constructors: Map<string, ConstructorBinding>): Map<string, string> {
  const parts = name.split(".");
  if (parts.length < 2) return new Map();
  const aliases = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const prefix = `${parts.slice(0, i).join(".")}.`;
    for (const key of constructors.keys()) {
      if (!key.startsWith(prefix)) continue;
      const alias = key.slice(prefix.length);
      if (!alias.includes(".")) aliases.set(alias, key);
    }
  }
  return aliases;
}

function ensureUniqueTypeParams(declaration: TypeDeclaration): void {
  const seen = new Set<string>();
  for (const param of declaration.params) {
    if (seen.has(param.name)) throw new OJamlError(`Duplicate type parameter '${param.name}'`, param.span.start, param.span.end);
    seen.add(param.name);
  }
}

function typeParamVars(declaration: TypeDeclaration): Map<string, Type> {
  return new Map(declaration.params.map((param): [string, Type] => [param.name, typeVar()]));
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
  builtin("fst", "fst : ('a, 'b) -> 'a", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([app("tuple", [a, b])], a);
  }, "Returns the first element of a pair."),
  builtin("snd", "snd : ('a, 'b) -> 'b", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([app("tuple", [a, b])], b);
  }, "Returns the second element of a pair."),
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
  builtin("Array.append", "Array.append : 'a array -> 'a array -> 'a array", () => {
    const a = typeVar();
    return fn([app("array", [a]), app("array", [a])], app("array", [a]));
  }),
  builtin("Array.reverse", "Array.reverse : 'a array -> 'a array", () => {
    const a = typeVar();
    return fn([app("array", [a])], app("array", [a]));
  }),
  builtin("Array.map", "Array.map : ('a -> 'b) -> 'a array -> 'b array", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([fn([a], b), app("array", [a])], app("array", [b]));
  }),
  builtin("Array.filter", "Array.filter : ('a -> bool) -> 'a array -> 'a array", () => {
    const a = typeVar();
    return fn([fn([a], boolType), app("array", [a])], app("array", [a]));
  }),
  builtin("Array.exists", "Array.exists : ('a -> bool) -> 'a array -> bool", () => {
    const a = typeVar();
    return fn([fn([a], boolType), app("array", [a])], boolType);
  }),
  builtin("Array.for_all", "Array.for_all : ('a -> bool) -> 'a array -> bool", () => {
    const a = typeVar();
    return fn([fn([a], boolType), app("array", [a])], boolType);
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
  builtin("List.append", "List.append : 'a list -> 'a list -> 'a list", () => {
    const a = typeVar();
    return fn([app("list", [a]), app("list", [a])], app("list", [a]));
  }),
  builtin("List.reverse", "List.reverse : 'a list -> 'a list", () => {
    const a = typeVar();
    return fn([app("list", [a])], app("list", [a]));
  }),
  builtin("List.map", "List.map : ('a -> 'b) -> 'a list -> 'b list", () => {
    const a = typeVar();
    const b = typeVar();
    return fn([fn([a], b), app("list", [a])], app("list", [b]));
  }),
  builtin("List.filter", "List.filter : ('a -> bool) -> 'a list -> 'a list", () => {
    const a = typeVar();
    return fn([fn([a], boolType), app("list", [a])], app("list", [a]));
  }),
  builtin("List.exists", "List.exists : ('a -> bool) -> 'a list -> bool", () => {
    const a = typeVar();
    return fn([fn([a], boolType), app("list", [a])], boolType);
  }),
  builtin("List.for_all", "List.for_all : ('a -> bool) -> 'a list -> bool", () => {
    const a = typeVar();
    return fn([fn([a], boolType), app("list", [a])], boolType);
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

function makeDeclarationStub(declaration: Declaration, types: TypeEnvironment, openTypeAliases = new Map<string, string>()): Type {
  const aliases = moduleTypeAliases(declaration.name, types);
  if (declaration.params.length === 0) return typeVar();
  return fn(declaration.params.map((_, index) => declaration.paramAnnotations[index]
    ? resolveTypeExpr(declaration.paramAnnotations[index]!, types, new Map(), aliases, openTypeAliases)
    : typeVar()), typeVar());
}

function checkDeclaration(declaration: Declaration, globals: Map<string, Binding>, context: CheckContext): Type {
  const binding = globals.get(declaration.name)!;
  const locals = new Map<string, Type>();
  const scopedAliases = moduleMemberAliases(declaration.name, globals);
  const scopedTypeAliases = moduleTypeAliases(declaration.name, context.types);
  const scopedConstructorAliases = moduleConstructorAliases(declaration.name, context.constructors);
  const declarationContext = { ...context, scopedAliases, scopedTypeAliases, scopedConstructorAliases };
  let expectedResult = binding.type;
  if (declaration.params.length > 0) {
    const type = prune(binding.type);
    if (type.kind !== "fn") throw new OJamlError("Internal function type mismatch", declaration.span.start, declaration.span.end);
    declaration.params.forEach((param, index) => locals.set(param, type.params[index]));
    expectedResult = type.result;
  }
  if (declaration.annotation) unify(expectedResult, resolveTypeExpr(declaration.annotation, context.types, new Map(), scopedTypeAliases, context.openTypeAliases), declaration.annotation.span);
  const bodyType = checkExpr(declaration.value, globals, locals, declarationContext);
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
    case "Tuple": {
      const type = app("tuple", expr.items.map((item) => checkExpr(item, globals, locals, context)));
      context.tokens.push({ name: "tuple", kind: "literal", type, span: expr.span });
      return type;
    }
    case "TupleAccess": {
      const tuple = prune(checkExpr(expr.tuple, globals, locals, context));
      if (tuple.kind !== "app" || tuple.name !== "tuple") {
        throw new OJamlError(`Tuple access expects a tuple; got ${showType(tuple)}`, expr.tuple.span.start, expr.tuple.span.end);
      }
      if (expr.index < 0 || expr.index >= tuple.args.length) {
        throw new OJamlError(`Tuple index ${expr.index} is out of bounds for ${showType(tuple)}`, expr.indexSpan.start, expr.indexSpan.end);
      }
      const type = tuple.args[expr.index];
      context.tokens.push({ name: `.${expr.index}`, kind: "operator", type, span: { start: expr.indexSpan.start - 1, end: expr.indexSpan.end } });
      context.tokens.push({ name: "tuple access", kind: "value", type, span: expr.span });
      return type;
    }
    case "Record": {
      const type = recordType(expr.fields.map((field) => ({ name: field.name, type: checkExpr(field.value, globals, locals, context) })));
      context.tokens.push({ name: "record", kind: "literal", type, span: expr.span });
      return type;
    }
    case "FieldAccess": {
      const record = prune(checkExpr(expr.record, globals, locals, context));
      if (record.kind !== "app" || record.name !== "record") {
        throw new OJamlError(`Field access expects a record; got ${showType(record)}`, expr.record.span.start, expr.record.span.end);
      }
      const field = record.fields.find((item) => item.name === expr.field);
      if (!field) throw new OJamlError(`Record has no field '${expr.field}'`, expr.fieldSpan.start, expr.fieldSpan.end);
      context.tokens.push({ name: expr.field, kind: "value", type: field.type, span: expr.fieldSpan });
      context.tokens.push({ name: expr.field, kind: "value", type: field.type, span: expr.span });
      return field.type;
    }
    case "Var": {
      const local = locals.get(expr.name);
      if (local) {
        context.tokens.push({ name: expr.name, kind: "value", type: local, span: expr.span });
        return local;
      }
      const constructor = resolveConstructor(expr.name, expr.span, context);
      if (constructor) {
        const instance = instantiateConstructor(constructor);
        if (instance.payload) throw new OJamlError(`Constructor '${constructor.name}' expects a payload`, expr.span.start, expr.span.end);
        context.tokens.push({ name: expr.name, kind: "function", type: instance.type, span: expr.span });
        return instance.type;
      }
      const resolvedName = resolveGlobalName(expr.name, globals, context, expr.span);
      const global = globals.get(resolvedName);
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
      if (expr.op === "not") {
        unify(checkExpr(expr.expr, globals, locals, context), boolType, expr.expr.span);
        return boolType;
      }
      return requireNumeric(checkExpr(expr.expr, globals, locals, context), expr.span);
    case "Binary":
      return checkBinary(expr, globals, locals, context);
    case "Sequence":
      unify(checkExpr(expr.first, globals, locals, context), unitType, expr.first.span);
      return checkExpr(expr.second, globals, locals, context);
    case "If":
      unify(checkExpr(expr.condition, globals, locals, context), boolType, expr.condition.span);
      return sameBranches(checkExpr(expr.thenBranch, globals, locals, context), checkExpr(expr.elseBranch, globals, locals, context), expr.span);
    case "LetIn": {
      if (expr.recursive && expr.value.kind !== "Fun") {
        throw new OJamlError("Local let rec must bind a function", expr.nameSpan.start, expr.nameSpan.end);
      }
      if (expr.recursive) {
        const valueType = typeVar();
        const nested = new Map(locals);
        nested.set(expr.name, valueType);
        const checkedValue = checkExpr(expr.value, globals, nested, context);
        unify(valueType, checkedValue, expr.value.span);
        context.tokens.push({ name: expr.name, kind: "function", type: valueType, span: expr.nameSpan });
        return checkExpr(expr.body, globals, nested, context);
      }
      const valueType = checkExpr(expr.value, globals, locals, context);
      if (expr.annotation) unify(valueType, resolveTypeExpr(expr.annotation, context.types, new Map(), context.scopedTypeAliases, context.openTypeAliases), expr.annotation.span);
      context.tokens.push({ name: expr.name, kind: "value", type: valueType, span: expr.nameSpan });
      const nested = new Map(locals);
      nested.set(expr.name, valueType);
      return checkExpr(expr.body, globals, nested, context);
    }
    case "Call": {
      if (expr.callee.kind === "Var") {
        const constructor = resolveConstructor(expr.callee.name, expr.callee.span, context);
        if (constructor) {
          const instance = instantiateConstructor(constructor);
          if (!instance.payload) {
            throw new OJamlError(`Constructor '${constructor.name}' expects 0 argument(s), got ${expr.args.length}`, expr.span.start, expr.span.end);
          }
          if (expr.args.length !== 1) {
            throw new OJamlError(`Constructor '${constructor.name}' expects 1 argument(s), got ${expr.args.length}`, expr.span.start, expr.span.end);
          }
          unify(checkExpr(expr.args[0], globals, locals, context), instance.payload, expr.args[0].span);
          context.tokens.push({ name: constructor.name, kind: "function", type: fn([instance.payload], instance.type), span: expr.callee.span });
          return instance.type;
        }
        const resolvedCalleeName = resolveGlobalName(expr.callee.name, globals, context, expr.callee.span);
        const binding = globals.get(resolvedCalleeName);
        const targetType = resolveVarType(expr.callee, globals, locals, context);
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
      const params = expr.params.map((param, index) => {
        const paramType = expr.paramAnnotations[index]
          ? resolveTypeExpr(expr.paramAnnotations[index]!, context.types, new Map(), context.scopedTypeAliases, context.openTypeAliases)
          : typeVar();
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
      if (!hasCatchAll && !isStructurallyExhaustiveMatch(expr.arms.map((arm) => arm.pattern), scrutineeType, context)) {
        throw new OJamlError("Match must include a wildcard or variable catch-all arm", expr.span.start, expr.span.end);
      }
      return resultType ?? unitType;
    }
  }
}

function isStructurallyExhaustiveMatch(patterns: Pattern[], scrutineeType: Type, context: CheckContext): boolean {
  const pruned = prune(scrutineeType);
  if (pruned.kind === "app" && pruned.name === "list") {
    return patterns.some((pattern) => pattern.kind === "PListNil")
      && patterns.some((pattern) => pattern.kind === "PListCons" && isPatternCatchAllLike(pattern.head) && isPatternCatchAllLike(pattern.tail));
  }
  if (pruned.kind === "variant") {
    const constructors = [...context.constructors.values()].filter((constructor) => constructor.typeName === pruned.name);
    return constructors.length > 0 && constructors.every((constructor) => patterns.some((pattern) =>
      pattern.kind === "PConstructor"
      && resolveConstructorName(pattern.name, pattern.nameSpan, context) === constructor.name
      && (!constructor.payload || (pattern.payload ? isPatternCatchAllLike(pattern.payload) : false))));
  }
  return false;
}

function isPatternCatchAllLike(pattern: Pattern): boolean {
  if (pattern.kind === "PWildcard" || pattern.kind === "PVar") return true;
  if (pattern.kind === "PTuple") return pattern.items.every(isPatternCatchAllLike);
  if (pattern.kind === "PRecord") return pattern.fields.every((field) => isPatternCatchAllLike(field.pattern));
  if (pattern.kind === "PSet") return pattern.items.every(isPatternCatchAllLike);
  if (pattern.kind === "PMap") return pattern.entries.every((entry) => isPatternCatchAllLike(entry.key) && isPatternCatchAllLike(entry.value));
  if (pattern.kind === "PConstructor") return pattern.payload ? isPatternCatchAllLike(pattern.payload) : true;
  return false;
}

function resolveVarType(expr: Extract<Expr, { kind: "Var" }>, globals: Map<string, Binding>, locals: Map<string, Type>, context: CheckContext): Type {
  const local = locals.get(expr.name);
  if (local) return local;
  const resolvedName = resolveGlobalName(expr.name, globals, context, expr.span);
  const global = globals.get(resolvedName);
  if (!global) throw new OJamlError(`Undefined name '${expr.name}'`, expr.span.start, expr.span.end);
  return fresh(global.type);
}

function resolveGlobalName(name: string, globals: Map<string, Binding>, context: CheckContext, span: SourceSpan): string {
  if (context.scopedAliases.has(name)) return context.scopedAliases.get(name)!;
  if (globals.has(name)) return name;
  return resolveOpenAlias(name, context.openAliases, span) ?? name;
}

function resolveConstructorName(name: string, span: SourceSpan, context: CheckContext): string {
  return context.scopedConstructorAliases.get(name) ?? resolveOpenConstructorAlias(name, context.openConstructorAliases, span) ?? name;
}

function resolveConstructor(name: string, span: SourceSpan, context: CheckContext): ConstructorBinding | undefined {
  return context.constructors.get(resolveConstructorName(name, span, context));
}

function moduleMemberAliases(name: string, globals: Map<string, Binding>): Map<string, string> {
  const parts = name.split(".");
  if (parts.length < 2) return new Map();
  const aliases = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const prefix = `${parts.slice(0, i).join(".")}.`;
    for (const key of globals.keys()) {
      if (!key.startsWith(prefix)) continue;
      const alias = key.slice(prefix.length);
      if (!alias.includes(".")) aliases.set(alias, key);
    }
  }
  return aliases;
}

function checkBinary(expr: Extract<Expr, { kind: "Binary" }>, globals: Map<string, Binding>, locals: Map<string, Type>, context: CheckContext): Type {
  if (expr.op === "|>") {
    const valueType = checkExpr(expr.left, globals, locals, context);
    const targetType = checkExpr(expr.right, globals, locals, context);
    const resultType = typeVar();
    const pruned = prune(targetType);
    if (pruned.kind === "fn" && pruned.params.length !== 1) {
      throw new OJamlError(`Pipeline target expects ${pruned.params.length} argument(s), got 1`, expr.span.start, expr.span.end);
    }
    unify(targetType, fn([valueType], resultType), expr.span);
    return resultType;
  }
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
    case "PTuple": {
      const itemTypes = pattern.items.map(() => typeVar());
      unify(scrutinee, app("tuple", itemTypes), pattern.span);
      context.tokens.push({ name: "tuple pattern", kind: "literal", type: app("tuple", itemTypes), span: pattern.span });
      const exhaustiveItems = pattern.items.map((item, index) => checkPattern(item, itemTypes[index], locals, context));
      return exhaustiveItems.every(Boolean);
    }
    case "PRecord": {
      const fieldTypes = pattern.fields.map((field) => ({ name: field.name, type: typeVar() }));
      const record = recordType(fieldTypes);
      unify(scrutinee, record, pattern.span);
      context.tokens.push({ name: "record pattern", kind: "literal", type: record, span: pattern.span });
      const exhaustiveFields = pattern.fields.map((field) => {
        const fieldType = fieldTypes.find((item) => item.name === field.name)?.type ?? typeVar();
        return checkPattern(field.pattern, fieldType, locals, context);
      });
      return exhaustiveFields.every(Boolean);
    }
    case "PArray": {
      const elem = typeVar();
      const arrayType = app("array", [elem]);
      unify(scrutinee, arrayType, pattern.span);
      context.tokens.push({ name: "[| |]", kind: "literal", type: arrayType, span: pattern.span });
      pattern.items.forEach((item) => checkPattern(item, elem, locals, context));
      return false;
    }
    case "PSet": {
      const elem = typeVar();
      const setType = app("set", [elem]);
      unify(scrutinee, setType, pattern.span);
      context.tokens.push({ name: "{| |}", kind: "literal", type: setType, span: pattern.span });
      pattern.items.forEach((item) => checkPattern(item, elem, locals, context));
      return false;
    }
    case "PMap": {
      const key = typeVar();
      const value = typeVar();
      const mapType = app("map", [key, value]);
      unify(scrutinee, mapType, pattern.span);
      context.tokens.push({ name: "{| : |}", kind: "literal", type: mapType, span: pattern.span });
      pattern.entries.forEach((entry) => {
        checkPattern(entry.key, key, locals, context);
        checkPattern(entry.value, value, locals, context);
      });
      return false;
    }
    case "PConstructor": {
      const constructor = resolveConstructor(pattern.name, pattern.nameSpan, context);
      if (!constructor) {
        throw new OJamlError(`Unknown constructor '${pattern.name}'`, pattern.nameSpan.start, pattern.nameSpan.end);
      }
      const instance = instantiateConstructor(constructor);
      unify(scrutinee, instance.type, pattern.span);
      context.tokens.push({
        name: constructor.name,
        kind: "function",
        type: instance.payload ? fn([instance.payload], instance.type) : instance.type,
        span: pattern.nameSpan,
      });
      if (instance.payload) {
        if (!pattern.payload) throw new OJamlError(`Constructor '${constructor.name}' pattern expects a payload`, pattern.nameSpan.start, pattern.nameSpan.end);
        checkPattern(pattern.payload, instance.payload, locals, context);
      } else if (pattern.payload) {
        throw new OJamlError(`Constructor '${constructor.name}' pattern does not take a payload`, pattern.payload.span.start, pattern.payload.span.end);
      }
      return false;
    }
    case "PListNil": {
      const elem = typeVar();
      unify(scrutinee, app("list", [elem]), pattern.span);
      context.tokens.push({ name: "[]", kind: "literal", type: app("list", [elem]), span: pattern.span });
      return false;
    }
    case "PListCons": {
      const elem = typeVar();
      const listType = app("list", [elem]);
      unify(scrutinee, listType, pattern.span);
      checkPattern(pattern.head, elem, locals, context);
      checkPattern(pattern.tail, listType, locals, context);
      return false;
    }
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

function prim(name: Exclude<OJamlType, "tuple" | "record" | "array" | "list" | "set" | "map" | "fn">): Type {
  return { kind: "prim", name };
}

function app(name: "array" | "list" | "set", args: [Type]): Type;
function app(name: "tuple", args: Type[]): Type;
function app(name: "map", args: [Type, Type]): Type;
function app(name: "array" | "list" | "set" | "tuple" | "map", args: Type[]): Type {
  if (name === "map") return { kind: "app", name, args: args as [Type, Type] };
  if (name === "tuple") return { kind: "app", name, args };
  return { kind: "app", name, args: args as [Type] };
}

function recordType(fields: Array<{ name: string; type: Type }>): Type {
  return { kind: "app", name: "record", fields: [...fields].sort((left, right) => left.name.localeCompare(right.name)) };
}

function variantType(name: string, args: Type[] = []): Type {
  return { kind: "variant", name, args };
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
    if (left.name !== right.name) throw typeMismatch(left, right, span);
    if (left.name === "record" || right.name === "record") {
      if (left.name !== "record" || right.name !== "record") throw typeMismatch(left, right, span);
      if (left.fields.length !== right.fields.length) throw typeMismatch(left, right, span);
      left.fields.forEach((field, index) => {
        if (field.name !== right.fields[index].name) throw typeMismatch(left, right, span);
        unify(field.type, right.fields[index].type, span);
      });
      return;
    }
    if (left.args.length !== right.args.length) throw typeMismatch(left, right, span);
    left.args.forEach((arg, index) => unify(arg, right.args[index], span));
    return;
  }
  if (left.kind === "variant" && right.kind === "variant") {
    if (left.name !== right.name) throw typeMismatch(left, right, span);
    if (left.args.length !== right.args.length) throw typeMismatch(left, right, span);
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
  if (pruned.kind === "variant") return variantType(pruned.name, pruned.args.map((arg) => fresh(arg, seen)));
  if (pruned.name === "record") return recordType(pruned.fields.map((field) => ({ name: field.name, type: fresh(field.type, seen) })));
  if (pruned.name === "map") return app("map", [fresh(pruned.args[0], seen), fresh(pruned.args[1], seen)]);
  if (pruned.name === "tuple") return app("tuple", pruned.args.map((arg) => fresh(arg, seen)));
  return app(pruned.name, [fresh(pruned.args[0], seen)]);
}

function occurs(variable: Type, type: Type): boolean {
  const pruned = prune(type);
  if (pruned === variable) return true;
  if (pruned.kind === "fn") return pruned.params.some((param) => occurs(variable, param)) || occurs(variable, pruned.result);
  if (pruned.kind === "variant") return pruned.args.some((arg) => occurs(variable, arg));
  if (pruned.kind === "app" && pruned.name === "record") return pruned.fields.some((field) => occurs(variable, field.type));
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
  if (pruned.kind === "variant") {
    if (pruned.args.length === 0) return pruned.name;
    if (pruned.args.length === 1) return `${showType(pruned.args[0])} ${pruned.name}`;
    return `(${pruned.args.map(showType).join(", ")}) ${pruned.name}`;
  }
  if (pruned.name === "tuple") return `(${pruned.args.map(showType).join(", ")})`;
  if (pruned.name === "record") return `{ ${pruned.fields.map((field) => `${field.name}: ${showType(field.type)}`).join("; ")} }`;
  if (pruned.name === "map") return `(${showType(pruned.args[0])}, ${showType(pruned.args[1])}) map`;
  return `${showType(pruned.args[0])} ${pruned.name}`;
}

function typeMismatch(left: Type, right: Type, span: SourceSpan): OJamlError {
  return new OJamlError(`Type mismatch: ${showType(left)} vs ${showType(right)}`, span.start, span.end);
}

function instantiateConstructor(constructor: ConstructorBinding): { type: Type; payload?: Type } {
  const seen = new Map<number, Type>();
  return {
    type: fresh(constructor.type, seen),
    payload: constructor.payload ? fresh(constructor.payload, seen) : undefined,
  };
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

function collectCheckedSymbols(program: Program, globals: Map<string, Binding>, openAliases = new Map<string, string>()): CheckedSymbol[] {
  const symbols: CheckedSymbol[] = [];
  const typeDeclarations = collectTypeDeclarationsFromProgram(program);
  const types = collectTypeDeclarations(typeDeclarations);
  const constructors = collectConstructors(typeDeclarations, types);
  const moduleDeclarations = collectModuleDeclarations(program);
  const openDeclarations = program.declarations.filter((declaration): declaration is OpenDeclaration => declaration.kind === "Open");
  const openTypeAliases = collectOpenTypeAliases(openDeclarations, moduleDeclarations, types);
  const openConstructorAliases = collectOpenConstructorAliases(openDeclarations, moduleDeclarations, constructors);
  for (const [name, binding] of builtins()) {
    symbols.push({
      name,
      kind: "builtin",
      detail: binding.builtinDetail ?? `${name} : ${showType(binding.type)}`,
    });
  }
  for (const constructor of constructors.values()) {
    symbols.push({
      name: constructor.name,
      kind: "function",
      detail: `${constructor.name} : ${showType(constructor.payload ? fn([constructor.payload], constructor.type) : constructor.type)}`,
    });
  }
  for (const declaration of collectLetDeclarations(program)) {
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
      locals: collectLocalSymbols(declaration, globals, types, constructors, openAliases, openTypeAliases, openConstructorAliases),
    });
  }
  return symbols;
}

function collectLocalSymbols(
  declaration: Declaration,
  globals: Map<string, Binding>,
  types: TypeEnvironment,
  constructors: Map<string, ConstructorBinding>,
  openAliases = new Map<string, string>(),
  openTypeAliases = new Map<string, string>(),
  openConstructorAliases = new Map<string, string>(),
): Array<{ name: string; detail: string; span: SourceSpan }> {
  const binding = globals.get(declaration.name);
  if (!binding) return [];
  const locals = new Map<string, Type>();
  const scopedAliases = moduleMemberAliases(declaration.name, globals);
  const scopedTypeAliases = moduleTypeAliases(declaration.name, types);
  const scopedConstructorAliases = moduleConstructorAliases(declaration.name, constructors);
  const type = prune(binding.type);
  if (type.kind === "fn") {
    declaration.params.forEach((param, index) => locals.set(param, type.params[index]));
  }
  const symbols: Array<{ name: string; detail: string; span: SourceSpan }> = [];
  collectLocalSymbolsInExpr(declaration.value, globals, locals, symbols, types, constructors, openAliases, openTypeAliases, openConstructorAliases, scopedAliases, scopedTypeAliases, scopedConstructorAliases);
  return symbols;
}

function collectLocalSymbolsInExpr(
  expr: Expr,
  globals: Map<string, Binding>,
  locals: Map<string, Type>,
  symbols: Array<{ name: string; detail: string; span: SourceSpan }>,
  types: TypeEnvironment,
  constructors: Map<string, ConstructorBinding>,
  openAliases = new Map<string, string>(),
  openTypeAliases = new Map<string, string>(),
  openConstructorAliases = new Map<string, string>(),
  scopedAliases = new Map<string, string>(),
  scopedTypeAliases = new Map<string, string>(),
  scopedConstructorAliases = new Map<string, string>(),
): Type | undefined {
  const context = { tokens: [], types, constructors, openAliases, openTypeAliases, openConstructorAliases, scopedAliases, scopedTypeAliases, scopedConstructorAliases };
  const visit = (child: Expr, nextLocals = locals) =>
    collectLocalSymbolsInExpr(child, globals, nextLocals, symbols, types, constructors, openAliases, openTypeAliases, openConstructorAliases, scopedAliases, scopedTypeAliases, scopedConstructorAliases);
  switch (expr.kind) {
    case "LetIn": {
      if (expr.recursive) {
        const valueType = typeVar();
        const nested = new Map(locals);
        nested.set(expr.name, valueType);
        const checkedValue = checkExpr(expr.value, globals, nested, context);
        unify(valueType, checkedValue, expr.value.span);
        symbols.push({ name: expr.name, detail: `${expr.name} : ${showType(valueType)}`, span: expr.nameSpan });
        visit(expr.body, nested);
        return undefined;
      }
      const valueType = checkExpr(expr.value, globals, locals, context);
      symbols.push({ name: expr.name, detail: `${expr.name} : ${showType(valueType)}`, span: expr.nameSpan });
      const nested = new Map(locals);
      nested.set(expr.name, valueType);
      visit(expr.body, nested);
      return undefined;
    }
    case "If":
      visit(expr.condition);
      visit(expr.thenBranch);
      visit(expr.elseBranch);
      return undefined;
    case "Binary":
      visit(expr.left);
      visit(expr.right);
      return undefined;
    case "Sequence":
      visit(expr.first);
      visit(expr.second);
      return undefined;
    case "Unary":
      visit(expr.expr);
      return undefined;
    case "Tuple":
      expr.items.forEach((item) => visit(item));
      return undefined;
    case "TupleAccess":
      visit(expr.tuple);
      return undefined;
    case "Record":
      expr.fields.forEach((field) => visit(field.value));
      return undefined;
    case "FieldAccess":
      visit(expr.record);
      return undefined;
    case "Call":
      visit(expr.callee);
      expr.args.forEach((arg) => visit(arg));
      return undefined;
    case "Fun": {
      const nested = new Map(locals);
      const fnType = checkExpr(expr, globals, locals, context);
      const pruned = prune(fnType);
      expr.params.forEach((param, index) => {
        const paramType = pruned.kind === "fn" ? pruned.params[index] : typeVar();
        nested.set(param, paramType);
        symbols.push({ name: param, detail: `${param} : ${showType(paramType)}`, span: expr.paramSpans[index] });
      });
      visit(expr.body, nested);
      return undefined;
    }
    case "Match":
      visit(expr.expr);
      expr.arms.forEach((arm) => {
        const nested = new Map(locals);
        const scrutineeType = checkExpr(expr.expr, globals, locals, context);
        collectPatternSymbols(arm.pattern, scrutineeType, nested, symbols, constructors, scopedConstructorAliases);
        visit(arm.body, nested);
      });
      return undefined;
    default:
      return undefined;
  }
}

function collectPatternSymbols(
  pattern: Pattern,
  scrutineeType: Type,
  locals: Map<string, Type>,
  symbols: Array<{ name: string; detail: string; span: SourceSpan }>,
  constructors: Map<string, ConstructorBinding>,
  scopedConstructorAliases = new Map<string, string>(),
): void {
  const pruned = prune(scrutineeType);
  if (pattern.kind === "PVar") {
    locals.set(pattern.name, scrutineeType);
    symbols.push({ name: pattern.name, detail: `${pattern.name} : ${showType(scrutineeType)}`, span: pattern.span });
    return;
  }
  if (pattern.kind === "PTuple") {
    const itemTypes = pruned.kind === "app" && pruned.name === "tuple"
      ? pruned.args
      : pattern.items.map(() => typeVar());
    pattern.items.forEach((item, index) => collectPatternSymbols(item, itemTypes[index] ?? typeVar(), locals, symbols, constructors, scopedConstructorAliases));
    return;
  }
  if (pattern.kind === "PRecord") {
    const fields = pruned.kind === "app" && pruned.name === "record"
      ? pruned.fields
      : pattern.fields.map((field) => ({ name: field.name, type: typeVar() }));
    pattern.fields.forEach((field) => {
      const fieldType = fields.find((item) => item.name === field.name)?.type ?? typeVar();
      collectPatternSymbols(field.pattern, fieldType, locals, symbols, constructors, scopedConstructorAliases);
    });
    return;
  }
  if (pattern.kind === "PArray") {
    const elem = pruned.kind === "app" && pruned.name === "array" ? pruned.args[0] : typeVar();
    pattern.items.forEach((item) => collectPatternSymbols(item, elem, locals, symbols, constructors, scopedConstructorAliases));
    return;
  }
  if (pattern.kind === "PSet") {
    const elem = pruned.kind === "app" && pruned.name === "set" ? pruned.args[0] : typeVar();
    pattern.items.forEach((item) => collectPatternSymbols(item, elem, locals, symbols, constructors, scopedConstructorAliases));
    return;
  }
  if (pattern.kind === "PMap") {
    const key = pruned.kind === "app" && pruned.name === "map" ? pruned.args[0] : typeVar();
    const value = pruned.kind === "app" && pruned.name === "map" ? pruned.args[1] : typeVar();
    pattern.entries.forEach((entry) => {
      collectPatternSymbols(entry.key, key, locals, symbols, constructors, scopedConstructorAliases);
      collectPatternSymbols(entry.value, value, locals, symbols, constructors, scopedConstructorAliases);
    });
    return;
  }
  if (pattern.kind === "PConstructor") {
    if (!pattern.payload) return;
    const constructor = constructors.get(scopedConstructorAliases.get(pattern.name) ?? pattern.name);
    if (!constructor) {
      collectPatternSymbols(pattern.payload, typeVar(), locals, symbols, constructors, scopedConstructorAliases);
      return;
    }
    const instance = instantiateConstructor(constructor);
    unify(scrutineeType, instance.type, pattern.span);
    collectPatternSymbols(pattern.payload, instance.payload ?? typeVar(), locals, symbols, constructors, scopedConstructorAliases);
    return;
  }
  if (pattern.kind === "PListCons") {
    const elem = pruned.kind === "app" && pruned.name === "list" ? pruned.args[0] : typeVar();
    const listType = app("list", [elem]);
    collectPatternSymbols(pattern.head, elem, locals, symbols, constructors, scopedConstructorAliases);
    collectPatternSymbols(pattern.tail, listType, locals, symbols, constructors, scopedConstructorAliases);
  }
}
