import assert from "node:assert/strict";
import test from "node:test";
import { check } from "../src/check";
import { compile } from "../src/compiler";
import { getOJamlHoverInfo, getOJamlSyntaxMarkers } from "../src/monacoOJaml";
import { ojamlExamples } from "../src/ojamlExamples";
import { parse } from "../src/parser";
import { runOJaml } from "../src/runtime";

function asLet(declaration: ReturnType<typeof parse>["declarations"][number]) {
  assert.equal(declaration.kind, "Let");
  return declaration;
}

function asModule(declaration: ReturnType<typeof parse>["declarations"][number]) {
  assert.equal(declaration.kind, "Module");
  return declaration;
}

test("parses comments, semicolon separators, and module-style identifiers", () => {
  const ast = parse(`(* nested (* comment *) works *)
let make = Array.make;;
  let main = Array.length (make 2 0)`);

  assert.equal(ast.declarations.length, 2);
  assert.equal(asLet(ast.declarations[0]).name, "make");
});

test("parses open declarations", () => {
  const ast = parse(`open List

let main = length (cons 1 (empty ()))`);

  assert.equal(ast.declarations[0].kind, "Open");
  assert.equal(ast.declarations[0].kind === "Open" ? ast.declarations[0].module : undefined, "List");
  assert.equal(asLet(ast.declarations[1]).name, "main");
});

test("parses top-level value modules", () => {
  const ast = parse(`module Math = struct
  let double x = x * 2
  let triple x = x * 3
end

let main = Math.double 4 + Math.triple 5`);
  const moduleDeclaration = asModule(ast.declarations[0]);

  assert.equal(moduleDeclaration.name, "Math");
  assert.equal(moduleDeclaration.declarations.length, 2);
  assert.equal(moduleDeclaration.declarations[0].name, "Math.double");
  assert.equal(moduleDeclaration.declarations[1].name, "Math.triple");
  assert.equal(asLet(ast.declarations[1]).name, "main");
});

test("parses nested value modules as qualified namespaces", () => {
  const ast = parse(`module Outer = struct
  module Inner = struct
    let value = 7
  end
end

let main = Outer.Inner.value`);
  const outer = asModule(ast.declarations[0]);
  const inner = asModule(outer.declarations[0]);

  assert.equal(outer.name, "Outer");
  assert.equal(inner.name, "Outer.Inner");
  assert.equal(inner.declarations.length, 1);
  assert.equal(inner.declarations[0].name, "Outer.Inner.value");
});

test("parses module type declarations and module signature ascription", () => {
  const ast = parse(`module type ARITH = sig
  type counter
  val add : int -> int -> int
  val label : string
end

module Math : ARITH = struct
  let add a b = a + b
  let label = "math"
end

let main = Math.add 1 2`);
  const signature = ast.declarations[0];
  const moduleDeclaration = asModule(ast.declarations[1]);

  assert.equal(signature.kind, "ModuleType");
  assert.equal(signature.kind === "ModuleType" ? signature.name : undefined, "ARITH");
  assert.equal(signature.kind === "ModuleType" ? signature.entries.length : undefined, 3);
  assert.equal(moduleDeclaration.signature?.name, "ARITH");
});

test("parses sequence expressions without stealing record field separators", () => {
  const ast = parse(`let main =
  print "start";
  let person = { name = "Ada"; year = 1815 } in
  (println person.name; person.year)`);
  const main = asLet(ast.declarations[0]).value;

  assert.equal(main.kind, "Sequence");
  assert.equal(main.first.kind, "Call");
  assert.equal(main.second.kind, "LetIn");
  assert.equal(main.second.value.kind, "Record");
  assert.equal(main.second.value.fields.length, 2);
  assert.equal(main.second.body.kind, "Sequence");
});

test("parses pipeline as a low-precedence left-associative operator", () => {
  const ast = parse(`let main = 3 |> inc |> double + 1`);
  const main = asLet(ast.declarations[0]).value;

  assert.equal(main.kind, "Binary");
  assert.equal(main.op, "|>");
  assert.equal(main.left.kind, "Binary");
  assert.equal(main.left.op, "|>");
  assert.equal(main.right.kind, "Binary");
  assert.equal(main.right.op, "+");
});

test("parses not as a unary boolean operator", () => {
  const ast = parse(`let main = not false && not (1 = 2)`);
  const main = asLet(ast.declarations[0]).value;

  assert.equal(main.kind, "Binary");
  assert.equal(main.op, "&&");
  assert.equal(main.left.kind, "Unary");
  assert.equal(main.left.op, "not");
  assert.equal(main.right.kind, "Unary");
  assert.equal(main.right.op, "not");
});

test("parses top-level recursive function", () => {
  const ast = parse(`let rec fact n = if n <= 1 then 1 else n * fact (n - 1)\nlet main = fact 5`);
  const fact = asLet(ast.declarations[0]);
  assert.equal(ast.declarations.length, 2);
  assert.equal(fact.name, "fact");
  assert.deepEqual(fact.params, ["n"]);
});

test("parses tuple expressions without changing grouped expressions or unit", () => {
  const ast = parse(`let main =
  let grouped = (1 + 2) in
  let pair = (grouped, "three") in
  let nested = (pair, (true, ())) in
  0`);
  const main = asLet(ast.declarations[0]).value;

  assert.equal(main.kind, "LetIn");
  assert.equal(main.value.kind, "Binary");
  assert.equal(main.body.kind, "LetIn");
  assert.equal(main.body.value.kind, "Tuple");
  assert.equal(main.body.value.items.length, 2);
  assert.equal(main.body.body.kind, "LetIn");
  assert.equal(main.body.body.value.kind, "Tuple");
});

test("parses zero-based tuple projection as postfix access", () => {
  const ast = parse(`let main =
  let triple = (1, "two", true) in
  if triple.2 then String.length triple.1 else triple.0`);
  const body = asLet(ast.declarations[0]).value;

  assert.equal(body.kind, "LetIn");
  assert.equal(body.body.kind, "If");
  assert.equal(body.body.condition.kind, "TupleAccess");
  assert.equal(body.body.condition.index, 2);
  assert.equal(body.body.thenBranch.kind, "Call");
  assert.equal(body.body.elseBranch.kind, "TupleAccess");
  assert.equal(body.body.elseBranch.index, 0);
});

test("parses tuple patterns without changing grouped patterns or unit patterns", () => {
  const ast = parse(`let main =
  match (1, "one") with
  | (n, ("nested")) -> n
  | _ -> 0`);
  const match = asLet(ast.declarations[0]).value;

  assert.equal(match.kind, "Match");
  assert.equal(match.arms[0].pattern.kind, "PTuple");
  assert.equal(match.arms[0].pattern.items.length, 2);
  assert.equal(match.arms[0].pattern.items[1].kind, "PString");
});

test("parses record expressions, field access, and record patterns", () => {
  const ast = parse(`let main =
  let person = { name = "Ada"; year = 1815 } in
  match person with
  | { year = y; name = n } -> person.year`);
  const main = asLet(ast.declarations[0]).value;

  assert.equal(main.kind, "LetIn");
  assert.equal(main.value.kind, "Record");
  assert.deepEqual(main.value.fields.map((field) => field.name), ["name", "year"]);
  assert.equal(main.body.kind, "Match");
  assert.equal(main.body.arms[0].pattern.kind, "PRecord");
  assert.equal(main.body.arms[0].body.kind, "FieldAccess");
});

test("parses record type declarations and annotated let bindings", () => {
  const ast = parse(`type person = { name: string; year: int }
let ada : person = { name = "Ada"; year = 1815 }
let describe (person : person) = person.name
let main = ada.year`);

  assert.equal(ast.declarations[0].kind, "Type");
  assert.equal(ast.declarations[0].name, "person");
  assert.equal(asLet(ast.declarations[1]).annotation?.kind, "TName");
  assert.equal(asLet(ast.declarations[2]).paramAnnotations[0]?.kind, "TName");
});

test("parses algebraic data type declarations and constructor patterns", () => {
  const ast = parse(`type status = Pending | Done of int | Failed of string

let main =
  match Done 42 with
  | Pending -> 0
  | Done value -> value
  | Failed message -> String.length message`);
  const typeDeclaration = ast.declarations[0];
  const main = asLet(ast.declarations[1]);

  assert.equal(typeDeclaration.kind, "Type");
  assert.equal(typeDeclaration.body.kind, "Variant");
  assert.equal(typeDeclaration.body.constructors.length, 3);
  assert.equal(typeDeclaration.body.constructors[1].payload?.kind, "TName");
  assert.equal(main.value.kind, "Match");
  assert.equal(main.value.arms[1].pattern.kind, "PConstructor");
});

test("parses polymorphic algebraic data type declarations and applications", () => {
  const ast = parse(`type ('a, 'b) result = Ok of 'a | Error of 'b

let main =
  match Ok 42 with
  | Ok value -> value
  | Error message -> String.length message`);
  const typeDeclaration = ast.declarations[0];

  assert.equal(typeDeclaration.kind, "Type");
  if (typeDeclaration.kind !== "Type") return;
  assert.deepEqual(typeDeclaration.params.map((param) => param.name), ["'a", "'b"]);
  assert.equal(typeDeclaration.body.kind, "Variant");
  assert.equal(typeDeclaration.body.kind === "Variant" ? typeDeclaration.body.constructors[0].payload?.kind : undefined, "TVar");
});

test("parses empty and cons list patterns as right-associative patterns", () => {
  const ast = parse(`let main =
  match List.empty () with
  | [] -> 0
  | head :: second :: tail -> head`);
  const match = asLet(ast.declarations[0]).value;

  assert.equal(match.kind, "Match");
  assert.equal(match.arms[0].pattern.kind, "PListNil");
  assert.equal(match.arms[1].pattern.kind, "PListCons");
  assert.equal(match.arms[1].pattern.tail.kind, "PListCons");
});

test("parses fixed-length array patterns", () => {
  const ast = parse(`let main =
  let values = Array.make 2 0 in
  match values with
  | [| first; 2 |] -> first
  | [||] -> 0
  | _ -> -1`);
  const match = asLet(ast.declarations[0]).value;

  assert.equal(match.kind, "LetIn");
  assert.equal(match.body.kind, "Match");
  assert.equal(match.body.arms[0].pattern.kind, "PArray");
  assert.equal(match.body.arms[0].pattern.items.length, 2);
  assert.equal(match.body.arms[1].pattern.kind, "PArray");
  assert.equal(match.body.arms[1].pattern.items.length, 0);
});

test("parses set and map patterns", () => {
  const ast = parse(`let main =
  match Set.add (Set.empty ()) "Ada" with
  | {| "Ada" |} -> 1
  | _ -> 0

let other =
  match Map.set (Map.empty ()) "Ada" 1815 with
  | {| "Ada": year |} -> year
  | {| : |} -> 0
  | _ -> 1`);

  const main = asLet(ast.declarations[0]);
  const other = asLet(ast.declarations[1]);
  assert.equal(main.value.kind, "Match");
  assert.equal(main.value.arms[0].pattern.kind, "PSet");
  assert.equal(other.value.kind, "Match");
  assert.equal(other.value.arms[0].pattern.kind, "PMap");
  assert.equal(other.value.arms[1].pattern.kind, "PMap");
});

test("emits wasm text for scalar program", () => {
  const { wat } = compile(`let main = 40 + 2`);
  assert.match(wat, /export "main"/);
  assert.match(wat, /i32.add/);
});

test("runs factorial through wasm", async () => {
  const result = await runOJaml(`let rec fact n =
  match n with
  | 0 -> 1
  | 1 -> 1
  | _ -> n * fact (n - 1)

let main = fact 6`);
  assert.equal(result.value, 720);
});

test("runs local let and conditionals through wasm", async () => {
  const result = await runOJaml(`let main =
  let x = 10 in
  if x > 3 then x * 2 else 0`);
  assert.equal(result.value, 20);
});

test("runs local function bindings and local let rec through wasm", async () => {
  const result = await runOJaml(`let main =
  let double x = x * 2 in
  let rec sum xs =
    match xs with
    | [] -> 0
    | head :: tail -> head + sum tail
  in
  let xs = List.cons 1 (List.cons 2 (List.cons 3 (List.empty ()))) in
  double (sum xs)`);

  assert.equal(result.value, 12);
});

test("local let rec closures capture outer locals and themselves", async () => {
  const result = await runOJaml(`let main =
  let scale = 3 in
  let rec pow n =
    match n with
    | 0 -> 1
    | _ -> scale * pow (n - 1)
  in
  pow 4`);

  assert.equal(result.value, 81);
});

test("local let rec rejects non-function bindings", () => {
  const markers = getOJamlSyntaxMarkers(`let main =
  let rec x = 1 in
  x`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /must bind a function/);
});

test("first-class functions support arities above three", async () => {
  const result = await runOJaml(`let apply8 f =
  f 1 2 3 4 5 6 7 8

let main =
  let sum8 a b c d e f g h =
    a + b + c + d + e + f + g + h
  in
  apply8 sum8`);

  assert.equal(result.value, 36);
});

test("first-class functions support large arities without falling back to numeric-only arguments", async () => {
  const result = await runOJaml(`type person = { name: string; year: int }

let apply16 f =
  f 1 "two" 3.0 true (List.cons 5 (List.empty ())) { name = "Ada"; year = 1815 } (fun x -> x + 7) "pair" 10 11 12 13 14 15 16 17

let main =
  let combine a b c d e (person : person) inc pair j k l m n o p q =
    let flag = if d then 100 else 0 in
    a + String.length b + Float.to_int c + flag + List.head e + person.year + inc 1 + String.length pair + j + k + l + m + n + o + p + q
  in
  apply16 combine`);

  assert.equal(result.value, 2047);
});

test("returned closures support arities above three", async () => {
  const result = await runOJaml(`let make_offset a b c =
  fun d e f g h -> a + b + c + d + e + f + g + h

let main =
  let add_more = make_offset 1 2 3 in
  add_more 4 5 6 7 8`);

  assert.equal(result.value, 36);
});

test("staged closures can curry into another high-arity function", async () => {
  const result = await runOJaml(`let make_stage a b c =
  fun d e f g h i j k l -> a + b + c + d + e + f + g + h + i + j + k + l

let main =
  let f = make_stage 1 2 3 in
  f 4 5 6 7 8 9 10 11 12`);

  assert.equal(result.value, 78);
});

test("local recursive closures support arities above three", async () => {
  const result = await runOJaml(`let main =
  let rec weighted a b c d =
    match a with
    | 0 -> b + c + d
    | _ -> weighted (a - 1) (b + 1) (c + 2) (d + 3)
  in
  weighted 4 10 20 30`);

  assert.equal(result.value, 84);
});

test("high-arity calls pass heap values, floats, bools, and functions", async () => {
  const result = await runOJaml(`type person = { name: string; year: int }

let apply8 f =
  f "Ada" 1815 2.5 true (List.cons 4 (List.empty ())) { name = "Grace"; year = 1906 } (fun x -> x + 1) 3

let main =
  let combine name (year : int) (scale : float) active (values : int list) (person : person) inc seed =
    let flag = if active then 10 else 0 in
    String.length name + year + Float.to_int scale + flag + List.head values + person.year + inc seed
  in
  apply8 combine`);

  assert.equal(result.value, 3744);
});

test("first-class calls allocate scratch locals beyond the old fixed pool", async () => {
  const result = await runOJaml(`let main =
  let add a b c d = a + b + c + d in
  let f = add in
  let a0 = f 1 2 3 4 in
  let a1 = f 1 2 3 4 in
  let a2 = f 1 2 3 4 in
  let a3 = f 1 2 3 4 in
  let a4 = f 1 2 3 4 in
  let a5 = f 1 2 3 4 in
  let a6 = f 1 2 3 4 in
  let a7 = f 1 2 3 4 in
  let a8 = f 1 2 3 4 in
  let a9 = f 1 2 3 4 in
  let a10 = f 1 2 3 4 in
  let a11 = f 1 2 3 4 in
  let a12 = f 1 2 3 4 in
  let a13 = f 1 2 3 4 in
  let a14 = f 1 2 3 4 in
  let a15 = f 1 2 3 4 in
  let a16 = f 1 2 3 4 in
  a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9 + a10 + a11 + a12 + a13 + a14 + a15 + a16`);

  assert.equal(result.value, 170);
});

test("emits indirect function table types for the maximum program arity", () => {
  const wat = compile(`let apply5 f = f 1 2 3 4 5

let main =
  let sum5 a b c d e = a + b + c + d + e in
  apply5 sum5`).wat;

  assert.match(wat, /\(type \$fn_5 \(func \(param i32 i32 i32 i32 i32 i32\) \(result i32\)\)/);
  assert.doesNotMatch(wat, /\(type \$fn_6 /);
});

test("runs every arithmetic, comparison, boolean, and unary operator", async () => {
  const result = await runOJaml(`let main =
  let a = 20 / 5 in
  let b = 17 mod 5 in
  let c = -3 in
  if (a = 4) && (b <> 1) && (c < 0) && (a <= 4) && (b > 1) && (b >= 2) && not false || false
  then a + b * 10 - c
  else 0`);

  assert.equal(result.value, 27);
});

test("not works with booleans, comparisons, conditionals, and double negation", async () => {
  const result = await runOJaml(`let main =
  let closed = false in
  let count = 3 in
  let ready = not closed && not (count = 0) in
  if not (not ready) then 1 else 0`);

  assert.equal(result.mainType, "int");
  assert.equal(result.value, 1);
});

test("boolean conjunction and disjunction short-circuit right-hand effects", async () => {
  const result = await runOJaml(`let mark (text : string) (value : bool) =
  print text;
  value

let main =
  let a = false && mark "bad-and" true in
  let b = true || mark "bad-or" false in
  let c = true && mark "good-and" true in
  let d = false || mark "good-or" true in
  if (not a) && b && c && d then 1 else 0`);

  assert.equal(result.value, 1);
  assert.equal(result.output, "good-andgood-or");
});

test("boolean short-circuiting skips runtime traps in unreachable operands", async () => {
  const result = await runOJaml(`let main =
  let m = Map.empty () in
  let missing_map = false && (Map.get m "missing" = 1) in
  let missing_array = true || (Array.get (Array.make 0 1) 0 = 1) in
  if missing_map || missing_array then 7 else 0`);

  assert.equal(result.value, 7);
});

test("boolean short-circuiting still typechecks skipped operands", () => {
  const cases = [
    `let main = false && 1`,
    `let main = true || "wrong"`,
    `let main = false && (fun x -> x)`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch/, source);
  }
});

test("not rejects non-boolean operands", () => {
  const cases = [
    `let main = not 1`,
    `let main = not "ready"`,
    `let main = not (List.empty ())`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch/, source);
  }
});

test("numeric operators cover int, float, and mixed operand combinations", async () => {
  const result = await runOJaml(`let main =
  let int_ops = (8 + 2) + (8 - 2) + (8 * 2) + (8 / 2) + (8 mod 3) + (2 ** 3) in
  let float_float = (8.0 + 2.0) + (8.0 - 2.0) + (8.0 * 2.0) + (8.0 / 2.0) + (2.0 ** 3.0) in
  let int_float = (8 + 2.0) + (8 - 2.0) + (8 * 2.0) + (8 / 2.0) + (2 ** 3.0) in
  let float_int = (8.0 + 2) + (8.0 - 2) + (8.0 * 2) + (8.0 / 2) + (2.0 ** 3) in
  int_ops + Float.to_int float_float + Float.to_int int_float + Float.to_int float_int`);

  assert.equal(result.value, 178);
});

test("power operator supports int, float, mixed operands, precedence, and right associativity", async () => {
  const result = await runOJaml(`let main =
  let int_power = 2 ** 3 in
  let right_assoc = 2 ** 3 ** 2 in
  let precedence = 2 + 3 ** 2 * 4 in
  let float_base = 2.5 ** 2 in
  let float_exponent = 9 ** 0.5 in
  let mixed = 4.0 ** 3 in
  let negative_int_exponent = 2 ** -1 in
  let _ = println (String.concat "float_base = " (to_string float_base)) in
  let _ = println (String.concat "float_exponent = " (to_string float_exponent)) in
  let _ = println (String.concat "mixed = " (to_string mixed)) in
  int_power + right_assoc + precedence + Float.to_int float_base + Float.to_int float_exponent + Float.to_int mixed + negative_int_exponent`);

  assert.equal(result.value, 631);
  assert.equal(result.output, "float_base = 6.25\nfloat_exponent = 3\nmixed = 64\n");
});

test("power operator covers zero, negative bases, fractional exponents, and unary grouping", async () => {
  const result = await runOJaml(`let main =
  let zero_exp = 9 ** 0 in
  let zero_base = 0 ** 3 in
  let negative_base = (-2) ** 3 in
  let unary_precedence = -2 ** 2 in
  let grouped_unary = (-2) ** 2 in
  let fractional = 27.0 ** (1.0 / 3.0) in
  let _ = println (String.concat "fractional = " (to_string fractional)) in
  zero_exp + zero_base + negative_base + unary_precedence + grouped_unary + Float.to_int fractional`);

  assert.equal(result.value, -4);
  assert.equal(result.output, "fractional = 3\n");
});

test("unary minus parses as the first function argument without stealing binary subtraction", async () => {
  const result = await runOJaml(`let id x = x
let sub a b = a - b

let main =
  let a = id -27 in
  let b = id -2.5 in
  let c = sub 10 3 - 2 in
  let d = (fun x -> x + 1) -4 in
  let _ = println (String.concat "b = " (to_string b)) in
  a + Float.to_int b + c + d`);

  assert.equal(result.value, -27);
  assert.equal(result.output, "b = -2.5\n");
});

test("negative values work as direct stdlib and collection arguments", async () => {
  const result = await runOJaml(`let main =
  let first = Float.to_int -2.5 in
  let ints = Array.make 2 (-1) in
  let _ = Array.set ints 1 (-5) in
  let floats = List.cons -2.5 (List.cons (-3.5) (List.empty ())) in
  let set = Set.add (Set.add (Set.empty ()) (-4)) (-4) in
  let map = Map.set (Map.empty ()) (-7) "seven" in
  let _ = println (to_string ints) in
  let _ = println (to_string floats) in
  let _ = println (to_string set) in
  let _ = println (Map.get map (-7)) in
  first + Array.get ints 0 + Array.get ints 1 + Float.to_int (List.head floats) + Set.length set`);

  assert.equal(result.value, -9);
  assert.equal(result.output, "[-1, -5]\n[-2.5, -3.5]\n{ -4 }\nseven\n");
});

test("negative literals work in int and float match patterns", async () => {
  const result = await runOJaml(`let classify_int n =
  match n with
  | -1 -> "minus one"
  | 0 -> "zero"
  | _ -> "other"

let classify_float n =
  match n with
  | -2.5 -> "minus two point five"
  | 0.0 -> "zero"
  | _ -> "other"

let main =
  let _ = println (classify_int -1) in
  let _ = println (classify_float -2.5) in
  0`);

  assert.equal(result.value, 0);
  assert.equal(result.output, "minus one\nminus two point five\n");
});

test("negative float base with fractional exponent produces NaN", async () => {
  const result = await runOJaml(`let main =
  let value = (-4.0) ** 0.5 in
  let _ = println (to_string value) in
  value`);

  assert.equal(result.mainType, "float");
  assert.ok(Number.isNaN(result.value));
  assert.equal(result.output, "NaN\n");
});

test("power operator works inside polymorphic functions", async () => {
  const result = await runOJaml(`let square x = x ** 2
let raise base exponent = base ** exponent

let main =
  let int_square = square 4 in
  let float_square = square 2.5 in
  let root = raise 16 0.5 in
  let _ = println (String.concat "float_square = " (to_string float_square)) in
  let _ = println (String.concat "root = " (to_string root)) in
  int_square + Float.to_int float_square + Float.to_int root`);

  assert.equal(result.value, 26);
  assert.equal(result.output, "float_square = 6.25\nroot = 4\n");
});

test("numeric comparisons cover int, float, mixed equality, and mixed ordering", async () => {
  const result = await runOJaml(`let score ok value = if ok then value else 0

let main =
  score (4 = 4) 1 +
  score (4 <> 5) 2 +
  score (3 < 4) 4 +
  score (3 <= 3) 8 +
  score (5 > 4) 16 +
  score (5 >= 5) 32 +
  score (4.0 = 4.0) 64 +
  score (4.0 <> 5.0) 128 +
  score (3.0 < 4.0) 256 +
  score (3.0 <= 3.0) 512 +
  score (5.0 > 4.0) 1024 +
  score (5.0 >= 5.0) 2048 +
  score (4 = 4.0) 4096 +
  score (4.0 = 4) 8192 +
  score (3 < 4.0) 16384 +
  score (5.0 >= 5) 32768`);

  assert.equal(result.value, 65535);
});

test("unary minus works for ints and floats", async () => {
  const result = await runOJaml(`let main =
  let int_value = -3 in
  let float_value = -2.5 in
  if int_value < 0 && float_value < 0.0 then Float.to_int (float_value * -2.0) + (0 - int_value) else 0`);

  assert.equal(result.value, 8);
});

test("main can return bool", async () => {
  const result = await runOJaml(`let main = 3 < 4`);

  assert.equal(result.mainType, "bool");
  assert.equal(result.value, 1);
});

test("print returns unit and records output", async () => {
  const result = await runOJaml(`let main =
  let _ = print 7 in
  let _ = print 11 in
  18`);

  assert.equal(result.value, 18);
  assert.deepEqual(result.prints, [7, 11]);
  assert.equal(result.output, "711");
});

test("sequence expressions run side effects in order and return the final expression", async () => {
  const result = await runOJaml(`let main =
  print "a";
  println "b";
  print "c";
  42`);

  assert.equal(result.mainType, "int");
  assert.equal(result.value, 42);
  assert.equal(result.output, "ab\nc");
});

test("sequence expressions work inside functions, matches, and closures", async () => {
  const result = await runOJaml(`let apply f x = f x

let main =
  let seen = apply (fun x -> print (to_string x); x + 1) 4 in
  match seen with
  | 5 -> println "five"; seen
  | _ -> println "other"; 0`);

  assert.equal(result.value, 5);
  assert.equal(result.output, "4five\n");
});

test("sequence expressions require unit on the left side", () => {
  const cases = [
    `let main = 1; 2`,
    `let main = (if true then 1 else 2); 3`,
    `let main = { name = "Ada"; year = 1815 }.year; 0`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch/, source);
  }
});

test("pipeline operator applies values to direct functions and stdlib functions", async () => {
  const result = await runOJaml(`let inc x = x + 1
let double x = x * 2
let square x = x * x

let main =
  let int_result = 3 |> inc |> double in
  let float_result = 2.5 |> square |> Float.to_int in
  int_result + float_result`);

  assert.equal(result.value, 14);
});

test("pipeline operator works with returned closures and opened stdlib names", async () => {
  const result = await runOJaml(`open List
open String

let make_adder x = fun y -> x + y

let main =
  let words = split "typed pipelines work" " " in
  let first_size = words |> head |> String.length in
  let total = 5 |> make_adder 10 in
  first_size + total + List.length words`);

  assert.equal(result.value, 23);
});

test("pipeline operator rejects non-functions and wrong-arity targets", () => {
  const cases = [
    [`let main = 1 |> 2`, /Type mismatch/],
    [`let pair a b = a + b\nlet main = 1 |> pair`, /Pipeline target expects 2 argument/],
    [`let main = "x" |> Float.to_int`, /Type mismatch/],
  ] as const;

  for (const [source, message] of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, message, source);
  }
});

test("unit can be the main result", async () => {
  const result = await runOJaml(`let main = print 99`);

  assert.equal(result.value, 0);
  assert.deepEqual(result.prints, [99]);
});

test("prints string literals and string locals", async () => {
  const result = await runOJaml(`let main =
  let greeting = "Hello,\\nOJaml!" in
  let _ = print greeting in
  print "done\\t\\""`);

  assert.equal(result.mainType, "unit");
  assert.deepEqual(result.prints, ["Hello,\nOJaml!", "done\t\""]);
  assert.equal(result.output, "Hello,\nOJaml!done\t\"");
});

test("print appends plain text output without list formatting", async () => {
  const result = await runOJaml(`let main =
  let _ = print "a\\n" in
  let _ = print 7 in
  let _ = print "\\n" in
  print "done"`);

  assert.equal(result.mainType, "unit");
  assert.deepEqual(result.prints, ["a\n", 7, "\n", "done"]);
  assert.equal(result.output, "a\n7\ndone");
});

test("println appends a newline after printable values", async () => {
  const result = await runOJaml(`let main =
  let _ = println "first" in
  let _ = println 2 in
  let _ = println 3.5 in
  print "done"`);

  assert.equal(result.mainType, "unit");
  assert.deepEqual(result.prints, ["first", "\n", 2, "\n", 3.5, "\n", "done"]);
  assert.equal(result.output, "first\n2\n3.5\ndone");
});

test("to_string formats primitives and collection values", async () => {
  const result = await runOJaml(`let main =
  let xs = List.cons 1 (List.cons 2 (List.empty ())) in
  let words = Array.make 2 "x" in
  let _ = Array.set words 1 "y" in
  let years = Map.set (Map.set (Map.empty ()) "Ada" 1815) "Grace" 1906 in
  let _ = print (String.concat (to_string 42) "\\n") in
  let _ = print (String.concat (to_string 3.5) "\\n") in
  let _ = print (String.concat (to_string true) "\\n") in
  let _ = print (String.concat (to_string "ok") "\\n") in
  let _ = print (String.concat (to_string ()) "\\n") in
  let _ = print (String.concat (to_string xs) "\\n") in
  let _ = print (String.concat (to_string words) "\\n") in
  print (to_string years)`);

  assert.equal(result.mainType, "unit");
  assert.equal(result.output, "42\n3.5\ntrue\nok\n()\n[1, 2]\n[x, y]\n{ Grace: 1906, Ada: 1815 }");
});

test("monaco diagnostics include type errors", () => {
  const markers = getOJamlSyntaxMarkers(`let main = print ()`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /print expects int, float, or string/);
});

test("println rejects non-printable values", () => {
  const markers = getOJamlSyntaxMarkers(`let main = println ()`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /println expects int, float, or string/);
});

test("runs float arithmetic, comparisons, conversion, and printing", async () => {
  const result = await runOJaml(`let square x = x * x

let main =
  let total = square 3.0 + square 4.0 in
  let _ = print total in
  if total >= 25.0 then total / Float.of_int 5 else 0.0`);

  assert.equal(result.mainType, "float");
  assert.equal(result.value, 5);
  assert.deepEqual(result.prints, [25]);
});

test("recursive numeric functions can be called with floats without rewriting integer literals", async () => {
  const result = await runOJaml(`let rec cube_root_search n guess =
  let cubed = guess * guess * guess in
  if cubed = n then guess else
  if cubed > n then guess - 1 else cube_root_search n (guess + 1)

let main = cube_root_search 512.0 1.0`);

  assert.equal(result.mainType, "float");
  assert.equal(result.value, 8);
});

test("cube root wrapper infers search bounds for positive and negative floats", async () => {
  const result = await runOJaml(`let rec cube_root_between n low high steps =
  if steps = 0.0 then (low + high) / 2.0 else
  let mid = (low + high) / 2.0 in
  let cubed = mid ** 3 in
  if cubed > n then cube_root_between n low mid (steps - 1.0) else
  cube_root_between n mid high (steps - 1.0)

let cube_root n =
  if n < 0.0
  then cube_root_between n n 0.0 40.0
  else cube_root_between n 0.0 n 40.0

let main =
  let positive = cube_root 512.0 in
  let negative = cube_root -27.0 in
  let _ = println (to_string positive) in
  let _ = println (to_string negative) in
  positive + negative`);

  assert.equal(result.mainType, "float");
  assert.equal(result.value, 5.000000000239652);
  assert.equal(result.output, "8.00000000023283\n-2.999999999993179\n");
});

test("polymorphic collections store floats", async () => {
  const result = await runOJaml(`let main =
  let xs = Array.make 2 0.5 in
  let _ = Array.set xs 1 1.5 in
  let ys = List.cons (Array.get xs 0) (List.cons (Array.get xs 1) (List.empty ())) in
  let _ = print (Array.get xs 1) in
  let _ = print (List.head ys) in
  Float.to_int (Array.get xs 0 + List.head (List.tail ys))`);

  assert.equal(result.value, 2);
  assert.deepEqual(result.prints, [1.5, 0.5]);
});

test("strings expose concat, length, and split primitives", async () => {
  const result = await runOJaml(`let main =
  let greeting = String.concat "hello" " world" in
  let parts = String.split greeting " " in
  let _ = print (List.head parts) in
  let _ = print (List.head (List.tail parts)) in
  String.length greeting + List.length parts`);

  assert.equal(result.value, 13);
  assert.deepEqual(result.prints, ["hello", "world"]);
});

test("string split handles missing separators and repeated separators", async () => {
  const result = await runOJaml(`let main =
  let one = String.split "abc" "," in
  let repeated = String.split "a,,b" "," in
  let _ = print (List.head one) in
  let _ = print (List.head repeated) in
  let _ = print (List.head (List.tail repeated)) in
  let _ = print (List.head (List.tail (List.tail repeated))) in
  List.length one + List.length repeated`);

  assert.equal(result.value, 4);
  assert.deepEqual(result.prints, ["abc", "a", "", "b"]);
});

test("open declarations expose stdlib module members by short name", async () => {
  const result = await runOJaml(`open List
open String
open Float

let main =
  let words = split (concat "hello" " world") " " in
  let nums = cons 1 (cons 2 (empty ())) in
  let _ = println (head words) in
  String.length (head words) + List.length nums + to_int (of_int 3)`);

  assert.equal(result.value, 10);
  assert.equal(result.output, "hello\n");
});

test("open declarations preserve local and top-level shadowing", async () => {
  const result = await runOJaml(`open List

let length xs = 99

let main =
  let cons value tail = tail in
  let xs = List.cons 1 (List.empty ()) in
  length xs + List.length (cons 2 xs)`);

  assert.equal(result.value, 100);
});

test("open declarations reject unknown modules and ambiguous names", () => {
  const cases = [
    `open Missing\nlet main = 0`,
    `open List\nopen Map\nlet main = empty ()`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("user-defined modules expose qualified values and functions", async () => {
  const result = await runOJaml(`module Math = struct
  let bias = 7
  let affine x scale = x * scale + bias
end

module Words = struct
  let shout value = String.concat value "!"
  let size value = String.length (shout value)
end

let main =
  Math.affine 5 3 + Words.size "go"`);

  assert.equal(result.value, 25);
});

test("open declarations expose user-defined module members and preserve shadowing", async () => {
  const result = await runOJaml(`module Math = struct
  let value = 10
  let bump x = x + value
end

open Math

let value = 3

let main =
  let bump x = x * 2 in
  bump value + Math.bump value`);

  assert.equal(result.value, 19);
});

test("module member closures resolve sibling module values", async () => {
  const result = await runOJaml(`module Offsets = struct
  let base = 4
  let make scale =
    fun value -> value * scale + base
end

let main =
  let f = Offsets.make 3 in
  f 5`);

  assert.equal(result.value, 19);
});

test("nested user-defined modules expose qualified and opened values", async () => {
  const result = await runOJaml(`module Outer = struct
  let base = 2
  module Inner = struct
    let scale x = x * base
    let offset x = scale x + 5
  end
end

open Outer.Inner

let main =
  Outer.Inner.offset 4 + scale 3`);

  assert.equal(result.value, 19);
});

test("user-defined modules reject duplicates, unknown opens, and invalid nested declarations", () => {
  const cases = [
    `module Math = struct let value = 1 end\nlet Math.value = 2\nlet main = 0`,
    `module Math = struct let value = 1 let value = 2 end\nlet main = 0`,
    `module Math = struct let value = 1 end\nopen Missing\nlet main = 0`,
    `module Outer = struct module Inner = struct let value = 1 end module Inner = struct let value = 2 end end\nlet main = 0`,
    `module Outer = struct open List end\nlet main = 0`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("polymorphic arrays store ints and strings through one API", async () => {
  const result = await runOJaml(`let main =
  let ints = Array.make 2 0 in
  let _ = Array.set ints 0 41 in
  let _ = Array.set ints 1 1 in
  let words = Array.make 1 "array" in
  let _ = print (Array.get words 0) in
  Array.get ints 0 + Array.get ints 1`);

  assert.equal(result.value, 42);
  assert.deepEqual(result.prints, ["array"]);
});

test("arrays expose length, set, get, map, filter, iter, and fold_left", async () => {
  const result = await runOJaml(`let main =
  let xs = Array.make 3 2 in
  let _ = Array.set xs 1 4 in
  let ys = Array.map (fun x -> x + 1) xs in
  let kept = Array.filter (fun x -> x > 3) ys in
  let _ = Array.iter (fun x -> print x) kept in
  Array.length ys + Array.length kept + Array.fold_left (fun acc x -> acc + x) 0 kept`);

  assert.equal(result.value, 9);
  assert.deepEqual(result.prints, [5]);
});

test("array filter covers empty, all, none, closures, and polymorphic element values", async () => {
  const result = await runOJaml(`let main =
  let empty = Array.filter (fun x -> x > 0) (Array.make 0 1) in
  let xs = Array.make 4 1 in
  let _ = Array.set xs 1 2 in
  let _ = Array.set xs 2 3 in
  let _ = Array.set xs 3 4 in
  let threshold = 2 in
  let evens = Array.filter (fun x -> x > threshold && x mod 2 = 0) xs in
  let all = Array.filter (fun x -> x >= 1) xs in
  let none = Array.filter (fun x -> x > 10) xs in
  let words = Array.make 3 "a" in
  let _ = Array.set words 1 "tool" in
  let _ = Array.set words 2 "lang" in
  let long = Array.filter (fun word -> String.length word > 1) words in
  let _ = println (to_string evens) in
  let _ = println (to_string long) in
  Array.length empty + Array.length evens + Array.length all + Array.length none + Array.length long + Array.get evens 0`);

  assert.equal(result.value, 11);
  assert.equal(result.output, "[4]\n[tool, lang]\n");
});

test("runtime checks reject invalid array access", async () => {
  await assert.rejects(
    () => runOJaml(`let main =
  let xs = Array.make -1 0 in
  Array.length xs`),
    WebAssembly.RuntimeError,
  );
  await assert.rejects(
    () => runOJaml(`let main =
  let xs = Array.make 0 42 in
  Array.get xs 0`),
    WebAssembly.RuntimeError,
  );
  await assert.rejects(
    () => runOJaml(`let main =
  let xs = Array.make 1 42 in
  Array.get xs (-1)`),
    WebAssembly.RuntimeError,
  );
  await assert.rejects(
    () => runOJaml(`let main =
  let xs = Array.make 1 42 in
  Array.get xs 1`),
    WebAssembly.RuntimeError,
  );
  await assert.rejects(
    () => runOJaml(`let main =
  let xs = Array.make 1 42 in
  Array.set xs 1 99`),
    WebAssembly.RuntimeError,
  );

  const result = await runOJaml(`let main =
  let empty = Array.make 0 42 in
  let xs = Array.make 1 7 in
  let _ = Array.set xs 0 8 in
  Array.length empty + Array.get xs 0`);

  assert.equal(result.value, 8);
});

test("polymorphic lists store strings", async () => {
  const result = await runOJaml(`let main =
  let xs = List.cons "tail" (List.empty ()) in
  let xs = List.cons "head" xs in
  let _ = print (List.head xs) in
  List.length xs`);

  assert.equal(result.value, 2);
  assert.deepEqual(result.prints, ["head"]);
});

test("lists expose empty, cons, head, tail, is_empty, length, map, filter, iter, and fold_left", async () => {
  const result = await runOJaml(`let main =
  let xs = List.cons 2 (List.cons 1 (List.empty ())) in
  let tail = List.tail xs in
  let ys = List.map (fun x -> x * 3) xs in
  let kept = List.filter (fun x -> x > 3) ys in
  let _ = List.iter (fun x -> print x) kept in
  if List.is_empty tail then 0 else List.length ys + List.length kept + List.fold_left (fun acc x -> acc + x) 0 kept`);

  assert.equal(result.value, 9);
  assert.deepEqual(result.prints, [6]);
});

test("list filter covers empty, all, none, closures, and polymorphic element values", async () => {
  const result = await runOJaml(`let main =
  let empty = List.filter (fun x -> x > 0) (List.empty ()) in
  let xs = List.cons 1 (List.cons 2 (List.cons 3 (List.cons 4 (List.empty ())))) in
  let threshold = 2 in
  let evens = List.filter (fun x -> x > threshold && x mod 2 = 0) xs in
  let all = List.filter (fun x -> x >= 1) xs in
  let none = List.filter (fun x -> x > 10) xs in
  let words = List.cons "a" (List.cons "tool" (List.cons "lang" (List.empty ()))) in
  let long = List.filter (fun word -> String.length word > 1) words in
  let _ = println (to_string evens) in
  let _ = println (to_string long) in
  List.length empty + List.length evens + List.length all + List.length none + List.length long + List.head evens`);

  assert.equal(result.value, 11);
  assert.equal(result.output, "[4]\n[tool, lang]\n");
});

test("runtime checks reject empty list head and tail", async () => {
  await assert.rejects(
    () => runOJaml(`let main =
  let empty = List.tail (List.cons 1 (List.empty ())) in
  List.head empty`),
    WebAssembly.RuntimeError,
  );
  await assert.rejects(
    () => runOJaml(`let main =
  let empty = List.tail (List.cons 1 (List.empty ())) in
  List.length (List.tail empty)`),
    WebAssembly.RuntimeError,
  );

  const result = await runOJaml(`let main =
  let xs = List.cons 2 (List.cons 1 (List.empty ())) in
  List.head xs + List.head (List.tail xs)`);

  assert.equal(result.value, 3);
});

test("polymorphic maps store string values", async () => {
  const result = await runOJaml(`let main =
  let m = Map.empty () in
  let m = Map.set m 1 "one" in
  let m = Map.set m 2 "two" in
  let _ = print (Map.get m 2) in
  if Map.has m 1 then 1 else 0`);

  assert.equal(result.value, 1);
  assert.deepEqual(result.prints, ["two"]);
});

test("maps expose empty, set, get, has true, and has false", async () => {
  const result = await runOJaml(`let main =
  let m = Map.empty () in
  let m = Map.set m "one" 1 in
  let m = Map.set m "two" 2 in
  if Map.has m "one" && (Map.has m "missing" = false)
  then Map.get m "two"
  else 0`);

  assert.equal(result.value, 2);
});

test("maps use latest value for duplicate keys and support float values", async () => {
  const result = await runOJaml(`let main =
  let m = Map.empty () in
  let m = Map.set m "score" 1.5 in
  let m = Map.set m "score" 2.5 in
  Float.to_int (Map.get m "score" + 0.5)`);

  assert.equal(result.value, 3);
});

test("runtime checks reject missing map keys", async () => {
  await assert.rejects(
    () => runOJaml(`let main =
  let m = Map.set (Map.empty ()) "present" 1 in
  Map.get m "missing" + 1`),
    WebAssembly.RuntimeError,
  );

  const result = await runOJaml(`let main =
  let m = Map.set (Map.empty ()) "present" 1 in
  if Map.has m "missing" then 0 else Map.get m "present"`);

  assert.equal(result.value, 1);
});

test("polymorphic sets store strings and expose membership", async () => {
  const result = await runOJaml(`let main =
  let names = Set.empty () in
  let names = Set.add names "Ada" in
  let names = Set.add names "Grace" in
  let _ = println (String.concat "names = " (to_string names)) in
  if Set.has names "Ada" && Set.has names "Grace" && (Set.has names "Katherine" = false)
  then Set.length names
  else 0`);

  assert.equal(result.value, 2);
  assert.equal(result.output, "names = { Grace, Ada }\n");
});

test("sets ignore duplicate values and keep the latest unique insertion first", async () => {
  const result = await runOJaml(`let main =
  let values = Set.empty () in
  let values = Set.add values 1 in
  let values = Set.add values 2 in
  let values = Set.add values 1 in
  let _ = println (to_string values) in
  if Set.has values 1 && Set.has values 2 then Set.length values else 0`);

  assert.equal(result.value, 2);
  assert.equal(result.output, "{ 2, 1 }\n");
});

test("sets support float values", async () => {
  const result = await runOJaml(`let main =
  let values = Set.empty () in
  let values = Set.add values 1.5 in
  let values = Set.add values 2.5 in
  if Set.has values 1.5 && (Set.has values 3.5 = false)
  then Float.to_int (Float.of_int (Set.length values) + 0.5)
  else 0`);

  assert.equal(result.value, 2);
});

test("sets cover empty, bool, unit, nested values, and to_string formatting", async () => {
  const result = await runOJaml(`let main =
  let empty = Set.empty () in
  let flags = Set.add (Set.add (Set.empty ()) true) false in
  let units = Set.add (Set.empty ()) () in
  let first = List.cons 1 (List.empty ()) in
  let second = List.cons 2 (List.empty ()) in
  let nested = Set.add (Set.add (Set.empty ()) first) second in
  let _ = println (String.concat "empty = " (to_string empty)) in
  let _ = println (String.concat "flags = " (to_string flags)) in
  let _ = println (String.concat "units = " (to_string units)) in
  let _ = println (String.concat "nested = " (to_string nested)) in
  Set.length empty + Set.length flags + Set.length units + Set.length nested`);

  assert.equal(result.value, 5);
  assert.equal(result.output, "empty = {  }\nflags = { false, true }\nunits = { () }\nnested = { [2], [1] }\n");
});

test("sets deduplicate boxed floats by numeric value", async () => {
  const result = await runOJaml(`let main =
  let values = Set.empty () in
  let values = Set.add values 1.5 in
  let values = Set.add values (3.0 / 2.0) in
  let _ = println (to_string values) in
  if Set.has values 1.5 then Set.length values else 0`);

  assert.equal(result.value, 1);
  assert.equal(result.output, "{ 1.5 }\n");
});

test("set add is persistent and leaves earlier set values unchanged", async () => {
  const result = await runOJaml(`let main =
  let empty = Set.empty () in
  let one = Set.add empty "Ada" in
  let two = Set.add one "Grace" in
  let _ = println (String.concat "empty = " (to_string empty)) in
  let _ = println (String.concat "one = " (to_string one)) in
  let _ = println (String.concat "two = " (to_string two)) in
  if Set.has one "Grace" then 0 else Set.length empty + Set.length one + Set.length two`);

  assert.equal(result.value, 3);
  assert.equal(result.output, "empty = {  }\none = { Ada }\ntwo = { Grace, Ada }\n");
});

test("tuples format primitives and nested tuple values", async () => {
  const result = await runOJaml(`let main =
  let pair = (1, "one") in
  let nested = (pair, true, (2.5, ())) in
  let _ = println (to_string pair) in
  let _ = println (to_string nested) in
  0`);

  assert.equal(result.value, 0);
  assert.equal(result.output, "(1, one)\n((1, one), true, (2.5, ()))\n");
});

test("tuples work inside arrays, lists, maps, and sets", async () => {
  const result = await runOJaml(`let main =
  let point = (3, 4) in
  let points = Array.make 2 point in
  let _ = Array.set points 1 (5, 6) in
  let labels = List.cons ("origin", point) (List.cons ("next", Array.get points 1) (List.empty ())) in
  let lookup = Map.set (Map.empty ()) "points" points in
  let seen = Set.add (Set.empty ()) point in
  let _ = println (to_string points) in
  let _ = println (to_string labels) in
  let _ = println (to_string lookup) in
  let _ = println (to_string seen) in
  Array.length points + List.length labels + Set.length seen`);

  assert.equal(result.value, 5);
  assert.equal(result.output, "[(3, 4), (5, 6)]\n[(origin, (3, 4)), (next, (5, 6))]\n{ points: [(3, 4), (5, 6)] }\n{ (3, 4) }\n");
});

test("records access fields, format labels, and use deterministic field order", async () => {
  const result = await runOJaml(`let main =
  let person = { year = 1815; name = "Ada"; active = true } in
  let _ = println (to_string person) in
  let _ = println person.name in
  if person.active then person.year else 0`);

  assert.equal(result.value, 1815);
  assert.equal(result.output, "{ active = true; name = Ada; year = 1815 }\nAda\n");
});

test("records nest inside tuples, arrays, lists, maps, and sets", async () => {
  const result = await runOJaml(`let main =
  let ada = { name = "Ada"; year = 1815 } in
  let grace = { name = "Grace"; year = 1906 } in
  let pair = (ada, grace) in
  let people = List.cons ada (List.cons grace (List.empty ())) in
  let table = Map.set (Map.empty ()) "first" ada in
  let seen = Set.add (Set.empty ()) grace in
  let _ = println (to_string pair) in
  let _ = println (to_string people) in
  let _ = println (to_string table) in
  let _ = println (to_string seen) in
  (fst pair).year + List.length people + (Map.get table "first").year + Set.length seen`);

  assert.equal(result.value, 3633);
  assert.equal(result.output, "({ name = Ada; year = 1815 }, { name = Grace; year = 1906 })\n[{ name = Ada; year = 1815 }, { name = Grace; year = 1906 }]\n{ first: { name = Ada; year = 1815 } }\n{ { name = Grace; year = 1906 } }\n");
});

test("record patterns destructure fields independent of source order", async () => {
  const result = await runOJaml(`let main =
  let person = { name = "Ada"; year = 1815; active = true } in
  match person with
  | { active = true; year = y; name = "Ada" } -> y
  | _ -> 0`);

  assert.equal(result.value, 1815);
});

test("record patterns bind fields inside closures", async () => {
  const result = await runOJaml(`let main =
  let suffix = 10 in
  let score person =
    match person with
    | { name = _; year = y } -> y + suffix
  in
  score { year = 1815; name = "Ada" }`);

  assert.equal(result.value, 1825);
});

test("records reject missing fields, mismatched fields, and duplicate labels", () => {
  const invalid = [
    `let main = { name = "Ada" }.year`,
    `let main = if true then { name = "Ada" } else { year = 1815 }`,
    `let main = match { name = "Ada" } with | { year = y } -> y | _ -> 0`,
    `let main = { name = "Ada"; name = "Grace" }`,
  ];

  for (const source of invalid) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("record type declarations validate annotated bindings and locals", async () => {
  const result = await runOJaml(`type person = { name: string; year: int }

let ada : person = { year = 1815; name = "Ada" }

let main =
  let grace : person = { name = "Grace"; year = 1906 } in
  let people = List.cons ada (List.cons grace (List.empty ())) in
  let _ = println (String.concat ada.name (String.concat " " (to_string ada.year))) in
  let _ = println (to_string people) in
  ada.year + grace.year`);

  assert.equal(result.value, 3721);
  assert.equal(result.output, "Ada 1815\n[{ name = Ada; year = 1815 }, { name = Grace; year = 1906 }]\n");
});

test("function parameter annotations constrain top-level, local, and anonymous functions", async () => {
  const result = await runOJaml(`type person = { name: string; year: int }

let describe (person : person) : string =
  String.concat person.name (String.concat " " (to_string person.year))

let main =
  let age (person : person) = 2026 - person.year in
  let label = fun (person : person) -> describe person in
  let ada : person = { year = 1815; name = "Ada" } in
  let _ = println (label ada) in
  age ada`);

  assert.equal(result.value, 211);
  assert.equal(result.output, "Ada 1815\n");
});

test("function parameter annotations reject unknown types and bad call shapes", () => {
  const cases = [
    `let f (x : missing) = x\nlet main = 0`,
    `type person = { name: string; year: int }\nlet f (person : person) = person.year\nlet main = f { name = "Ada" }`,
    `let f (x : int) = x + 1\nlet main = f "one"`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.ok(markers.length > 0, source);
  }
});

test("module-local record types support qualified and scoped annotations", async () => {
  const result = await runOJaml(`module Geometry = struct
  type point = { x: int; y: int }

  let origin : point = { x = 0; y = 0 }
  let move (point : point) dx dy : point =
    { x = point.x + dx; y = point.y + dy }

  module Labels = struct
    type labeled = { label: string; point: point }

    let describe (item : labeled) =
      String.concat item.label (String.concat ":" (to_string item.point.x))
  end
end

let main =
  let moved : Geometry.point = Geometry.move Geometry.origin 3 4 in
  let labeled : Geometry.Labels.labeled = { label = "p"; point = moved } in
  let _ = println (Geometry.Labels.describe labeled) in
  moved.x + moved.y`);

  assert.equal(result.value, 7);
  assert.equal(result.output, "p:3\n");
});

test("module-local variant types support qualified constructors and pattern matching", async () => {
  const result = await runOJaml(`module Json = struct
  type value = Null | Number of int | Text of string

  let length (value : value) =
    match value with
    | Null -> 0
    | Number number -> number
    | Text text -> String.length text
end

let main =
  Json.length Json.Null + Json.length (Json.Number 10) + Json.length (Json.Text "ojaml")`);

  assert.equal(result.value, 15);
});

test("open declarations expose module-local types and constructors", async () => {
  const result = await runOJaml(`module Geometry = struct
  type point = { x: int; y: int }
  type label = Origin | Named of string

  let describe (label : label) =
    match label with
    | Origin -> 0
    | Named name -> String.length name
end

open Geometry

let main =
  let point : point = { x = 3; y = 4 } in
  let label : label = Named "corner" in
  let _ = println (to_string point) in
  point.x + point.y + describe label + describe Origin`);

  assert.equal(result.value, 13);
  assert.equal(result.output, "{ x = 3; y = 4 }\n");
});

test("opened module constructors work in closures and patterns", async () => {
  const result = await runOJaml(`module Result = struct
  type value = Ok of int | Error of string

  let fold value =
    match value with
    | Ok number -> number
    | Error message -> String.length message
end

open Result

let main =
  let choose ok =
    if ok then Ok 21 else Error "oops"
  in
  match choose false with
  | Error message -> String.length message + fold (choose true)
  | Ok number -> number`);

  assert.equal(result.value, 25);
});

test("opened module type and constructor names reject ambiguities", () => {
  const cases = [
    `module A = struct type point = { x: int } end
module B = struct type point = { y: int } end
open A
open B
let main = let p : point = { x = 0 } in p.x`,
    `module A = struct type value = Tag of int end
module B = struct type value = Tag of string end
open A
open B
let main = Tag 1`,
    `module A = struct type value = Done end
module B = struct type value = Done end
open A
open B
let main = match A.Done with | Done -> 1`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("module signatures check exported value shapes", async () => {
  const result = await runOJaml(`module type GEOMETRY = sig
  type point
  type label
  val origin : point
  val move : point -> int -> int -> point
  val describe : label -> string
end

module Geometry : GEOMETRY = struct
  type point = { x: int; y: int }
  type label = Origin | Named of string

  let origin : point = { x = 0; y = 0 }
  let move (point : point) dx dy = { x = point.x + dx; y = point.y + dy }
  let describe label =
    match label with
    | Origin -> "origin"
    | Named name -> name
end

let main =
  let point = Geometry.move Geometry.origin 3 4 in
  let label = Geometry.Named "corner" in
  let _ = println (Geometry.describe label) in
  point.x + point.y`);

  assert.equal(result.value, 7);
  assert.equal(result.output, "corner\n");
});

test("module signature type entries support polymorphic module-local types", async () => {
  const result = await runOJaml(`module type BOXES = sig
  type 'a box
  val wrap : 'a -> 'a box
  val unwrap : 'a box -> 'a
end

module Boxes : BOXES = struct
  type 'a box = Box of 'a

  let wrap value = Box value
  let unwrap box =
    match box with
    | Box value -> value
end

let main =
  let number = Boxes.unwrap (Boxes.wrap 40) in
  let text = Boxes.unwrap (Boxes.wrap "ok") in
  number + String.length text`);

  assert.equal(result.value, 42);
});

test("module signature type manifests check record and variant structure", async () => {
  const result = await runOJaml(`module type SHAPES = sig
  type point = { x: int; y: int }
  type label = Origin | Named of string
  val origin : point
  val named : string -> label
  val score : point -> label -> int
end

module Shapes : SHAPES = struct
  type point = { y: int; x: int }
  type label = Origin | Named of string

  let origin : point = { x = 3; y = 4 }
  let named text = Named text
  let score (point : point) label =
    let label_score =
      match label with
      | Origin -> 0
      | Named text -> String.length text
    in
    point.x + point.y + label_score
end

let main = Shapes.score Shapes.origin (Shapes.named "edge")`);

  assert.equal(result.value, 11);
});

test("function type annotations constrain higher-order values", async () => {
  const result = await runOJaml(`let apply_twice (f : int -> int) x =
  f (f x)

let main =
  let inc : int -> int = fun x -> x + 1 in
  apply_twice inc 40`);

  assert.equal(result.value, 42);
});

test("module signatures reject missing values, wrong value types, missing types, duplicate entries, and unknown signatures", () => {
  const cases = [
    `module type NEEDS_VALUE = sig val total : int end
module Scores : NEEDS_VALUE = struct let other = 1 end
let main = 0`,
    `module type NEEDS_INT = sig val total : int end
module Scores : NEEDS_INT = struct let total = "wrong" end
let main = 0`,
    `module type DUP = sig val x : int end
module type DUP = sig val y : int end
let main = 0`,
    `module Scores : MISSING = struct let total = 1 end
let main = 0`,
    `module type BAD = sig val x : missing end
module Scores : BAD = struct let x = 1 end
let main = 0`,
    `module type BAD = sig val x : int val x : int end
let main = 0`,
    `module type BAD = sig type item val make : item end
module Items : BAD = struct let make = 1 end
let main = 0`,
    `module type BAD = sig type 'a item val make : int item end
module Items : BAD = struct type item = Item of int let make = Item 1 end
let main = 0`,
    `module type BAD = sig type item = { id: int; label: string } end
module Items : BAD = struct type item = { id: int } let item = { id = 1 } end
let main = 0`,
    `module type BAD = sig type item = A | B of string end
module Items : BAD = struct type item = A | B of int let item = A end
let main = 0`,
    `module type BAD = sig type item = A | B end
module Items : BAD = struct type item = B | A let item = A end
let main = 0`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("module-local type declarations reject duplicates, unknown references, and bad constructor use", () => {
  const cases = [
    `module Geometry = struct type point = { x: int } type point = { y: int } end\nlet main = 0`,
    `module Geometry = struct type point = { x: missing } end\nlet main = 0`,
    `module Geometry = struct type point = { x: int } end\nlet main = let p : point = { x = 0 } in p.x`,
    `module Json = struct type value = Null | Number of int end\nlet main = Number 1`,
    `module Json = struct type value = Null | Number of int end\nlet main = Json.Number "one"`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("record type declarations reject duplicate, unknown, and mismatched shapes", () => {
  const cases = [
    `type person = { name: string; name: int }\nlet main = 0`,
    `type person = { name: missing }\nlet main = 0`,
    `type person = { name: string; year: int }\nlet main = let ada : person = { name = "Ada" } in ada.name`,
    `type person = { name: string; year: int }\nlet main = let ada : person = { name = "Ada"; year = "1815" } in 0`,
    `type person = { name: string }\ntype person = { year: int }\nlet main = 0`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.ok(markers.length > 0, source);
  }
});

test("algebraic data types construct and match nullary and payload constructors", async () => {
  const result = await runOJaml(`type status = Pending | Done of int | Failed of string

let score status =
  match status with
  | Pending -> 0
  | Done value -> value
  | Failed message -> String.length message

let main =
  let _ = println (score Pending) in
  let _ = println (score (Failed "oops")) in
  score (Done 42)`);

  assert.equal(result.value, 42);
  assert.equal(result.output, "0\n4\n");
});

test("algebraic data type payloads support records, tuples, collections, and closures", async () => {
  const result = await runOJaml(`type person = { name: string; year: int }
type event = Empty | Person of person | Pair of (string, int) | Scores of int list

let describe event =
  match event with
  | Empty -> 0
  | Person person -> person.year
  | Pair (_, value) -> value
  | Scores scores ->
      let add = fun offset -> List.length scores + offset in
      add 10

let main =
  let ada : person = { name = "Ada"; year = 1815 } in
  let scores = List.cons 1 (List.cons 2 (List.empty ())) in
  describe (Person ada) + describe (Pair ("x", 5)) + describe (Scores scores)`);

  assert.equal(result.value, 1832);
});

test("algebraic data type constructor coverage can make a match exhaustive", async () => {
  const exhaustive = await runOJaml(`type light = Red | Yellow | Green

let main =
  match Yellow with
  | Red -> 1
  | Yellow -> 2
  | Green -> 3`);
  const nonExhaustive = getOJamlSyntaxMarkers(`type light = Red | Yellow | Green

let main =
  match Yellow with
  | Red -> 1
  | Yellow -> 2`, 8);

  assert.equal(exhaustive.value, 2);
  assert.equal(nonExhaustive.length, 1);
  assert.match(nonExhaustive[0].message, /catch-all/);
});

test("algebraic data types reject bad constructors and payload mismatches", () => {
  const cases = [
    `type status = Pending | Done of int\ntype other = Pending\nlet main = 0`,
    `type status = pending | Done\nlet main = 0`,
    `type status = Pending | Done of int\nlet main = Done "forty"`,
    `type status = Pending | Done of int\nlet main = Done`,
    `type status = Pending | Done of int\nlet main = Done 1 2`,
    `type status = Pending | Done of int\nlet main = match Done 1 with | Done -> 1 | _ -> 0`,
    `type status = Pending | Done of int\nlet main = match Pending with | Pending value -> value | _ -> 0`,
    `type status = Pending | Done of int\nlet main = match Pending with | Missing -> 0 | _ -> 1`,
    `type status = Pending | Done of int\ntype other = Other\nlet main = match Pending with | Other -> 0 | _ -> 1`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("polymorphic algebraic data types instantiate constructors per use", async () => {
  const result = await runOJaml(`type 'a option = None | Some of 'a
type ('ok, 'err) result = Ok of 'ok | Error of 'err

let score maybe =
  match maybe with
  | None -> 0
  | Some value -> value

let label result =
  match result with
  | Ok name -> String.length name
  | Error code -> code

let main =
  let number : int option = Some 42 in
  let missing : string option = None in
  let named : (string, int) result = Ok "Ada" in
  let failed : (string, int) result = Error 5 in
  score number + label named + label failed + (match missing with | None -> 1 | Some text -> String.length text)`);

  assert.equal(result.value, 51);
});

test("polymorphic record type declarations preserve their field parameter types", async () => {
  const result = await runOJaml(`type 'a box = { value: 'a }
type 'a option = None | Some of 'a

let main =
  let number : int box = { value = 7 } in
  let word : string box = { value = "ojaml" } in
  let maybe : int option box = { value = Some 4 } in
  let nested = match maybe.value with | Some value -> value | None -> 0 in
  number.value + String.length word.value + nested`);

  assert.equal(result.value, 16);
});

test("polymorphic algebraic data types reject bad arities and mismatched parameters", () => {
  const cases = [
    `type 'a option = None | Some of 'a\nlet main = let value : option = Some 1 in 0`,
    `type 'a option = None | Some of 'a\nlet main = let value : (int, string) option = Some 1 in 0`,
    `type 'a option = None | Some of 'a\nlet main = let value : int option = Some "one" in 0`,
    `type 'a option = None | Some of 'b\nlet main = 0`,
    `type ('a, 'a) pair = Pair of ('a, 'a)\nlet main = 0`,
    `type 'a option = None | Some of 'a\nlet main = match Some 1 with | Some "one" -> 1 | _ -> 0`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("fst and snd project pair elements with precise types", async () => {
  const result = await runOJaml(`let main =
  let point = (3, 4) in
  let label = ("x", fst point) in
  let nested = (label, (2.5, "two")) in
  let _ = println (String.concat "fst point = " (to_string (fst point))) in
  let _ = println (String.concat "snd point = " (to_string (snd point))) in
  let _ = println (String.concat "fst label = " (fst label)) in
  let _ = println (String.concat "snd nested = " (to_string (snd nested))) in
  fst point + snd point + snd label`);

  assert.equal(result.value, 10);
  assert.equal(result.output, "fst point = 3\nsnd point = 4\nfst label = x\nsnd nested = (2.5, two)\n");
});

test("tuple projection accesses any element with precise types", async () => {
  const result = await runOJaml(`let main =
  let triple = ("Ada", 1815, true) in
  let nested = (triple, (2.5, "two"), (10, 20, 30, 40)) in
  let _ = println (String.concat "name = " triple.0) in
  let _ = println (String.concat "year = " (to_string triple.1)) in
  let _ = println (String.concat "float = " (to_string nested.1.0)) in
  let _ = println (String.concat "fourth = " (to_string nested.2.3)) in
  if triple.2 then triple.1 + nested.2.3 else 0`);

  assert.equal(result.value, 1855);
  assert.equal(result.output, "name = Ada\nyear = 1815\nfloat = 2.5\nfourth = 40\n");
});

test("tuple projection works inside closures, records, and collection values", async () => {
  const result = await runOJaml(`let main =
  let record = { label = "scores"; values = (4, 5, 6) } in
  let choose index =
    if index = 0 then record.values.0 else record.values.2
  in
  let rows = List.cons record (List.empty ()) in
  let first = List.head rows in
  choose 1 + first.values.0 + choose 0`);

  assert.equal(result.value, 14);
});

test("tuple element types and arity are checked structurally", () => {
  const cases = [
    `let main = if true then (1, "ok") else (2, 3)`,
    `let main = if true then (1, 2) else (1, 2, 3)`,
    `let main =
  let xs = Array.make 1 (1, "ok") in
  Array.set xs 0 (1, 2)`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch/, source);
  }
});

test("tuple projection rejects non-tuples and out-of-bounds indexes", () => {
  const cases = [
    [`let main = (1 + 2).0`, /Tuple access expects a tuple/],
    [`let main = (1, 2).2`, /Tuple index 2 is out of bounds/],
    [`let main =
  let nested = ((1, 2), "done") in
  nested.1.0`, /Tuple access expects a tuple/],
  ] as const;

  for (const [source, pattern] of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, pattern, source);
  }
});

test("fst and snd reject non-pairs and arity mismatches", () => {
  const cases = [
    `let main = fst 1`,
    `let main = snd (1, 2, 3)`,
    `let main =
  let pair = (1, "one") in
  fst pair + snd pair`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch|Operator expects/, source);
  }
});

test("tuple patterns destructure pairs and nested tuples", async () => {
  const result = await runOJaml(`let main =
  let point = (3, 4) in
  let labeled = ("point", (point, true)) in
  match labeled with
  | (name, ((x, y), true)) ->
      let _ = println (String.concat name (String.concat " = " (to_string (x, y)))) in
      x * 10 + y
  | _ -> 0`);

  assert.equal(result.value, 34);
  assert.equal(result.output, "point = (3, 4)\n");
});

test("tuple patterns support literal arms and fallback matching", async () => {
  const result = await runOJaml(`let classify point =
  match point with
  | (0, 0) -> "origin"
  | (0, y) -> String.concat "y-axis " (to_string y)
  | (x, 0) -> String.concat "x-axis " (to_string x)
  | _ -> "other"

let main =
  let _ = println (classify (0, 0)) in
  let _ = println (classify (0, 5)) in
  let _ = println (classify (7, 0)) in
  println (classify (2, 3))`);

  assert.equal(result.output, "origin\ny-axis 5\nx-axis 7\nother\n");
});

test("tuple pattern bindings work inside closures", async () => {
  const result = await runOJaml(`let main =
  match (2, 5) with
  | (x, y) ->
      let f = fun z -> x * z + y in
      f 10`);

  assert.equal(result.value, 25);
});

test("tuple patterns reject arity and element type mismatches", () => {
  const cases = [
    `let main = match (1, 2) with | (x, y, z) -> x | _ -> 0`,
    `let main = match (1, "one") with | (1, 2) -> 1 | _ -> 0`,
    `let main = match 1 with | (x, y) -> x | _ -> 0`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch/, source);
  }
});

test("tuple patterns participate in conservative exhaustiveness", () => {
  const exhaustive = getOJamlSyntaxMarkers(`let main =
  match (1, 2) with
  | (x, y) -> x + y`, 8);
  const nonExhaustive = getOJamlSyntaxMarkers(`let main =
  match (1, 2) with
  | (1, y) -> y`, 8);

  assert.equal(exhaustive.length, 0);
  assert.equal(nonExhaustive.length, 1);
  assert.match(nonExhaustive[0].message, /catch-all/);
});

test("list patterns match empty, cons, nested cons, and fallback arms", async () => {
  const result = await runOJaml(`let rec sum xs =
  match xs with
  | [] -> 0
  | head :: tail -> head + sum tail

let describe xs =
  match xs with
  | [] -> "empty"
  | 1 :: 2 :: _ -> "starts one two"
  | head :: _ -> String.concat "head " (to_string head)

let main =
  let xs = List.cons 1 (List.cons 2 (List.cons 3 (List.empty ()))) in
  let _ = println (describe (List.empty ())) in
  let _ = println (describe xs) in
  let _ = println (describe (List.cons 9 (List.empty ()))) in
  sum xs`);

  assert.equal(result.value, 6);
  assert.equal(result.output, "empty\nstarts one two\nhead 9\n");
});

test("list patterns bind tails and work inside closures", async () => {
  const result = await runOJaml(`let main =
  let xs = List.cons 4 (List.cons 5 (List.empty ())) in
  match xs with
  | head :: tail ->
      let f = fun scale -> head * scale + List.length tail in
      f 10
  | [] -> 0`);

  assert.equal(result.value, 41);
});

test("list patterns reject element and scrutinee mismatches", () => {
  const cases = [
    `let main = match List.cons 1 (List.empty ()) with | "one" :: tail -> 1 | _ -> 0`,
    `let main = match 1 with | [] -> 0 | _ -> 1`,
    `let main = match List.cons "x" (List.empty ()) with | head :: tail -> head + List.length tail | _ -> 0`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch|Operator expects/, source);
  }
});

test("list patterns keep conservative exhaustiveness", () => {
  const exhaustiveEmpty = getOJamlSyntaxMarkers(`let main =
  match List.empty () with
  | _ -> 0`, 8);
  const nonExhaustiveEmptyOnly = getOJamlSyntaxMarkers(`let main =
  match List.empty () with
  | [] -> 0`, 8);
  const nonExhaustiveConsOnly = getOJamlSyntaxMarkers(`let main =
  match List.cons 1 (List.empty ()) with
  | head :: tail -> head`, 8);

  assert.equal(exhaustiveEmpty.length, 0);
  assert.equal(nonExhaustiveEmptyOnly.length, 1);
  assert.match(nonExhaustiveEmptyOnly[0].message, /catch-all/);
  assert.equal(nonExhaustiveConsOnly.length, 1);
  assert.match(nonExhaustiveConsOnly[0].message, /catch-all/);
});

test("array patterns match fixed lengths and nested element patterns", async () => {
  const result = await runOJaml(`let describe values =
  match values with
  | [||] -> "empty"
  | [| (name, { name = _; year = 1815 }); (_, { name = _; year = y }) |] ->
      String.concat name (String.concat " then " (to_string y))
  | [| _ |] -> "one"
  | _ -> "other"

let main =
  let ada = { name = "Ada"; year = 1815 } in
  let grace = { name = "Grace"; year = 1906 } in
  let values = Array.make 2 ("", ada) in
  let _ = Array.set values 0 (ada.name, ada) in
  let _ = Array.set values 1 (grace.name, grace) in
  let _ = println (describe (Array.make 0 ("", ada))) in
  let _ = println (describe values) in
  String.length (describe values)`);

  assert.equal(result.value, 13);
  assert.equal(result.output, "empty\nAda then 1906\n");
});

test("array pattern bindings work inside closures", async () => {
  const result = await runOJaml(`let main =
  let offset = 10 in
  let score values =
    match values with
    | [| first; second; third |] -> first + second + third + offset
    | _ -> 0
  in
  let values = Array.make 3 0 in
  let _ = Array.set values 0 4 in
  let _ = Array.set values 1 5 in
  let _ = Array.set values 2 6 in
  score values`);

  assert.equal(result.value, 25);
});

test("array patterns reject element and scrutinee mismatches", () => {
  const cases = [
    `let main = match Array.make 2 1 with | [| "one"; x |] -> x | _ -> 0`,
    `let main = match 1 with | [||] -> 0 | _ -> 1`,
    `let main = match Array.make 1 "x" with | [| head |] -> head + 1 | _ -> 0`,
  ];

  for (const source of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, /Type mismatch|Operator expects/, source);
  }
});

test("array patterns keep conservative exhaustiveness", () => {
  const exhaustive = getOJamlSyntaxMarkers(`let main =
  match Array.make 1 0 with
  | _ -> 0`, 8);
  const nonExhaustive = getOJamlSyntaxMarkers(`let main =
  match Array.make 1 0 with
  | [| x |] -> x`, 8);

  assert.equal(exhaustive.length, 0);
  assert.equal(nonExhaustive.length, 1);
  assert.match(nonExhaustive[0].message, /catch-all/);
});

test("set patterns match exact stored order and bind nested values", async () => {
  const result = await runOJaml(`let main =
  let values = Set.add (Set.add (Set.empty ()) ("Ada", 1815)) ("Grace", 1906) in
  match values with
  | {| (name, year); ("Ada", 1815) |} ->
      let _ = println (String.concat name (String.concat " " (to_string year))) in
      year
  | _ -> 0`);

  assert.equal(result.value, 1906);
  assert.equal(result.output, "Grace 1906\n");
});

test("set patterns cover empty, length mismatch, and nested element mismatch", async () => {
  const empty = await runOJaml(`let main =
  match Set.empty () with
  | {| |} -> 1
  | _ -> 0`);
  const tooShort = await runOJaml(`let main =
  let values = Set.add (Set.empty ()) 1 in
  match values with
  | {| 1; 2 |} -> 0
  | {| 1 |} -> 2
  | _ -> 3`);
  const mismatch = await runOJaml(`let main =
  let values = Set.add (Set.add (Set.empty ()) 1) 2 in
  match values with
  | {| 2; 3 |} -> 0
  | {| 2; 1 |} -> 4
  | _ -> 5`);

  assert.equal(empty.value, 1);
  assert.equal(tooShort.value, 2);
  assert.equal(mismatch.value, 4);
});

test("map patterns match exact entry order and bind keys and values", async () => {
  const result = await runOJaml(`let main =
  let scores = Map.set (Map.set (Map.empty ()) "Ada" 1815) "Grace" 1906 in
  match scores with
  | {| winner: year; "Ada": first |} ->
      let _ = println (String.concat winner (String.concat " " (to_string year))) in
      year - first
  | _ -> 0`);

  assert.equal(result.value, 91);
  assert.equal(result.output, "Grace 1906\n");
});

test("map patterns cover empty maps, length mismatch, and value mismatch", async () => {
  const empty = await runOJaml(`let main =
  match Map.empty () with
  | {| : |} -> 1
  | _ -> 0`);
  const tooShort = await runOJaml(`let main =
  let scores = Map.set (Map.empty ()) "Ada" 1815 in
  match scores with
  | {| "Ada": 1815; "Grace": 1906 |} -> 0
  | {| "Ada": year |} -> year
  | _ -> 3`);
  const mismatch = await runOJaml(`let main =
  let scores = Map.set (Map.set (Map.empty ()) "Ada" 1815) "Grace" 1906 in
  match scores with
  | {| "Grace": 1907; "Ada": 1815 |} -> 0
  | {| "Grace": 1906; "Ada": year |} -> year
  | _ -> 5`);

  assert.equal(empty.value, 1);
  assert.equal(tooShort.value, 1815);
  assert.equal(mismatch.value, 1815);
});

test("set and map patterns reject element, key, value, and scrutinee mismatches", () => {
  const cases = [
    `let main =
  let values = Set.add (Set.empty ()) 1 in
  match values with
  | {| "one" |} -> 1
  | _ -> 0`,
    `let main =
  let scores = Map.set (Map.empty ()) "Ada" 1815 in
  match scores with
  | {| 1: 1815 |} -> 1
  | _ -> 0`,
    `let main =
  let scores = Map.set (Map.empty ()) "Ada" 1815 in
  match scores with
  | {| "Ada": "old" |} -> 1
  | _ -> 0`,
    `let main =
  match 1 with
  | {| 1 |} -> 1
  | _ -> 0`,
    `let main =
  match 1 with
  | {| 1: 2 |} -> 1
  | _ -> 0`,
  ];

  for (const source of cases) {
    assert.ok(getOJamlSyntaxMarkers(source, 8).length > 0, source);
  }
});

test("set and map patterns keep conservative exhaustiveness", () => {
  const setMarkers = getOJamlSyntaxMarkers(`let main =
  let values = Set.add (Set.empty ()) 1 in
  match values with
  | {| 1 |} -> 1`, 8);
  const mapMarkers = getOJamlSyntaxMarkers(`let main =
  let scores = Map.set (Map.empty ()) "Ada" 1815 in
  match scores with
  | {| "Ada": 1815 |} -> 1`, 8);

  assert.match(setMarkers[0].message, /catch-all/);
  assert.match(mapMarkers[0].message, /catch-all/);
});

test("main cannot return tuples directly", () => {
  const markers = getOJamlSyntaxMarkers(`let main = (1, 2)`, 8);
  const recordMarkers = getOJamlSyntaxMarkers(`let main = { name = "Ada" }`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /cannot return \(int, int\) directly/);
  assert.equal(recordMarkers.length, 1);
  assert.match(recordMarkers[0].message, /cannot return \{ name: string \} directly/);
});

test("match supports int, float, string, bool, unit, tuple, record, list, array, set, map, wildcard, and variable patterns", async () => {
  const result = await runOJaml(`let classify n =
  match n with
  | 0 -> "zero"
  | value -> "nonzero"

let main =
  let a = match "ok" with | "ok" -> 1 | _ -> 0 in
  let b = match true with | true -> 2 | false -> 0 | _ -> 0 in
  let c = match () with | () -> 3 | _ -> 0 in
  let d = match 1.5 with | 1.5 -> 4 | _ -> 0 in
  let e = match (2, 3) with | (x, y) -> x + y in
  let f = match List.cons 5 (List.empty ()) with | head :: [] -> head | _ -> 0 in
  let g = match { name = "Ada"; year = 1815 } with | { year = y; name = "Ada" } -> y | _ -> 0 in
  let h = match Array.make 2 3 with | [| x; y |] -> x + y | _ -> 0 in
  let _ = print (classify 7) in
  a + b + c + d + e + f + g + h`);

  assert.equal(result.value, 1841);
  assert.deepEqual(result.prints, ["nonzero"]);
});

const expectedExampleResults: Map<string, { mainType: string; value: number; output: string }> = new Map([
  ["hello", { mainType: "unit", value: 0, output: "Hello, OJaml!\n" }],
  ["bindings", { mainType: "int", value: 1815, output: "name = Ada\nyear = 1815\nactive = true\n" }],
  ["integer-operators", { mainType: "int", value: 30, output: "10 + 4 = 14\nsum - 3 = 11\ndifference * 2 = 22\nproduct / 5 = 4\nproduct mod 5 = 2\n2 ** 3 = 8\n" }],
  ["float-operators", { mainType: "float", value: 14, output: "7.5 + 2.5 = 10\na - 1 = 9\nb * 2.0 = 18\nc / 3 = 6\n2.0 ** 3 = 8\n" }],
  ["boolean-logic", { mainType: "int", value: 3, output: "closed = false\nready = true\nskipped = false\n" }],
  ["strings", { mainType: "int", value: 11, output: "greeting = hello world\nwords = [hello, world]\nlength = 11\n" }],
  ["open-modules", { mainType: "int", value: 10, output: "words = [hello, OJaml]\nhead = hello\nnums = [1, 2]\n" }],
  ["user-modules", { mainType: "int", value: 95, output: "Scores.total 10 20 = 34\ntotal 5 6 = 15\noffset 7 = 25\nqualified 8 = 20\nlocal bonus = 1\n" }],
  ["module-types", { mainType: "int", value: 13, output: "point = { x = 3; y = 4 }\nlabel length = 6\n" }],
  ["module-signatures", { mainType: "int", value: 11, output: "count = 11\n" }],
  ["sequencing", { mainType: "int", value: 3, output: "first\nsecond\nitems = [1, 2, 3]\n" }],
  ["pipeline", { mainType: "int", value: 12, output: "nums = [1, 2, 3]\ntotal = 12\n" }],
  ["arrays", { mainType: "int", value: 60, output: "scores = [10, 20, 30]\nhigh_scores = [20, 30]\nlength = 3\ntotal = 60\n" }],
  ["lists", { mainType: "int", value: 3, output: "items = [first, second, third]\nlong_items = [second]\nfirst = first\nrest = [second, third]\nlength = 3\n" }],
  ["maps", { mainType: "int", value: 1906, output: "years = { Grace: 1906, Ada: 1815 }\nAda = 1815\nGrace = found\n" }],
  ["sets", { mainType: "int", value: 2, output: "names = { Grace, Ada }\nhas Ada = true\n" }],
  ["tuples", { mainType: "int", value: 9, output: "point = (3, 4, 5)\nx = 3\ny = 4\nz = 5\nx + y = 7\nlabeled = (origin, (3, 4, 5))\npoints = [(3, 4, 5), (0, 0, 0)]\n" }],
  ["records", { mainType: "int", value: 1817, output: "ada = { active = true; name = Ada; year = 1815 }\nada.name = Ada\nlabel = Ada 1815\npeople = [{ active = true; name = Ada; year = 1815 }, { active = true; name = Grace; year = 1906 }]\n" }],
  ["variants", { mainType: "int", value: 50, output: "score number = 42\nmissing = none\nlabel ok = 3\nlabel error = 5\n" }],
  ["type-inference", { mainType: "int", value: 87, output: "square 9 = 81\nsquare 2.5 = 6.25\n" }],
  ["local-recursion", { mainType: "int", value: 15, output: "values = [4, 5, 6]\nsum = 15\n" }],
  ["high-arity-functions", { mainType: "int", value: 3744, output: "values = [4]\nperson = { name = Grace; year = 1906 }\nresult = 3744\n" }],
  ["pattern-matching", { mainType: "unit", value: 0, output: "many\none\none point five\nother\n3,4\nfirst Ada\nset has Grace then Ada\nGrace born 1906\n" }],
  ["factorial", { mainType: "int", value: 720, output: "720\n" }],
  ["fibonacci", { mainType: "int", value: 55, output: "55\n" }],
  ["gcd", { mainType: "int", value: 21, output: "21\n" }],
  ["cube-root", { mainType: "float", value: 5.000000000239652, output: "cube_root 512 = 8.00000000023283\ncube_root -27 = -2.999999999993179\n" }],
  ["higher-order", { mainType: "int", value: 36, output: "13\n12\n11\n" }],
  ["language-tour", { mainType: "int", value: 1892, output: "OJaml tour\ntyped\n" }],
] as const);

test("all bundled editor examples produce their expected behavior", async () => {
  for (const example of ojamlExamples) {
    const expected = expectedExampleResults.get(example.id);
    if (!expected) assert.fail(`${example.id} has an expected transcript`);
    const result = await runOJaml(example.source);
    assert.equal(result.mainType, expected.mainType, `${example.id} main type`);
    assert.equal(result.output, expected.output, `${example.id} output`);
    if (result.mainType === "float") {
      assert.ok(Math.abs(result.value - expected.value) < 1e-9, `${example.id} value`);
    } else {
      assert.equal(result.value, expected.value, `${example.id} value`);
    }
  }
  assert.equal(expectedExampleResults.size, ojamlExamples.length);
});

test("polymorphic arrays reject mixed element writes", () => {
  const markers = getOJamlSyntaxMarkers(`let main =
  let xs = Array.make 1 0 in
  let _ = Array.set xs 0 "nope" in
  0`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /Type mismatch/);
});

test("polymorphic maps reject mismatched keys and values", () => {
  const badKey = getOJamlSyntaxMarkers(`let main =
  let m = Map.set (Map.empty ()) "one" 1 in
  Map.get m 2`, 8);

  const badValue = getOJamlSyntaxMarkers(`let main =
  let m = Map.set (Map.empty ()) "one" 1 in
  let m = Map.set m "two" "nope" in
  Map.get m "one"`, 8);

  assert.equal(badKey.length, 1);
  assert.match(badKey[0].message, /Type mismatch/);
  assert.equal(badValue.length, 1);
  assert.match(badValue[0].message, /Type mismatch/);
});

test("polymorphic sets reject mismatched element values", () => {
  const markers = getOJamlSyntaxMarkers(`let main =
  let values = Set.add (Set.empty ()) 1 in
  let values = Set.add values "nope" in
  Set.length values`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /Type mismatch/);
});

test("set membership rejects mismatched element values", () => {
  const markers = getOJamlSyntaxMarkers(`let main =
  let values = Set.add (Set.empty ()) "Ada" in
  Set.has values 1815`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /Type mismatch/);
});

test("diagnostics cover undefined names, arity, branch mismatch, and non-exhaustive matches", () => {
  assert.match(getOJamlSyntaxMarkers(`let main = missing`, 8)[0].message, /Undefined name/);
  assert.match(getOJamlSyntaxMarkers(`let f x = x\nlet main = f 1 2`, 8)[0].message, /expects 1 argument/);
  assert.match(getOJamlSyntaxMarkers(`let main = if true then 1 else "no"`, 8)[0].message, /Type mismatch/);
  assert.match(getOJamlSyntaxMarkers(`let main = match 1 with | 1 -> 10`, 8)[0].message, /catch-all/);
});

test("negative diagnostics cover invalid primitive and stdlib combinations", () => {
  const cases: Array<[string, RegExp]> = [
    [`let main = 5.0 mod 2`, /Type mismatch: float vs int/],
    [`let main = true + 1`, /Operator expects int or float; got bool/],
    [`let main = true ** 2`, /Operator expects int or float; got bool/],
    [`let main = 2 ** "nope"`, /Operator expects int or float; got string/],
    [`let main = print (List.empty ())`, /print expects int, float, or string/],
    [`let main = "no"`, /cannot return string directly/],
    [`let main = Float.of_int 1.5`, /Type mismatch: int vs float/],
    [`let main = String.length 1`, /Type mismatch: string vs int/],
    [`let main = Array.get 1 0`, /Type mismatch/],
    [`let main = List.head 1`, /Type mismatch/],
    [`let main = Map.has (Map.set (Map.empty ()) "x" 1) 1`, /Type mismatch/],
  ];

  for (const [source, pattern] of cases) {
    const markers = getOJamlSyntaxMarkers(source, 8);
    assert.equal(markers.length, 1, source);
    assert.match(markers[0].message, pattern, source);
  }
});

test("checker exposes real inferred types for editor hovers", () => {
  const checked = check(parse(`let inc x = x + 1
let make_adder x = fun y -> x + y
let main =
  let greeting = "hi" in
  let nums = Array.make 2 0 in
  let names = Map.set (Map.empty ()) "ada" 1815 in
  let add10 = make_adder 10 in
  let _ = print greeting in
  add10 (Array.get nums 0 + Map.get names "ada")`));

  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  assert.equal(symbols.get("greeting")?.detail, undefined);
  assert.equal(symbols.get("inc")?.detail, "inc : number -> number");
  assert.equal(symbols.get("make_adder")?.detail, "make_adder : number -> number -> number");
  assert.equal(symbols.get("main")?.detail, "main : int");
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));
  assert.equal(mainLocals.get("greeting"), "greeting : string");
  assert.equal(mainLocals.get("nums"), "nums : int array");
  assert.equal(mainLocals.get("names"), "names : (string, int) map");
  assert.equal(mainLocals.get("add10"), "add10 : int -> int");
});

test("checker exposes instantiated stdlib token types for hovers", () => {
  const source = `let main =
  let names = Map.set (Map.empty ()) "ada" 1815 in
  Map.get names "ada"`;
  const checked = check(parse(source));
  const mapGet = checked.tokens.find((token) => token.name === "Map.get");
  const namesUse = checked.tokens.find((token) => token.name === "names" && token.span.start > source.indexOf("Map.get"));

  assert.equal(mapGet?.detail, "Map.get : (string, int) map -> string -> int");
  assert.equal(namesUse?.detail, "names : (string, int) map");
});

test("checker exposes instantiated set token types for hovers", () => {
  const source = `let main =
  let names = Set.add (Set.empty ()) "Ada" in
  Set.has names "Ada"`;
  const checked = check(parse(source));
  const setAdd = checked.tokens.find((token) => token.name === "Set.add");
  const setHas = checked.tokens.find((token) => token.name === "Set.has");
  const namesUse = checked.tokens.find((token) => token.name === "names" && token.span.start > source.indexOf("Set.has"));

  assert.equal(setAdd?.detail, "Set.add : string set -> string -> string set");
  assert.equal(setHas?.detail, "Set.has : string set -> string -> bool");
  assert.equal(namesUse?.detail, "names : string set");
});

test("checker exposes tuple token and local types for hovers", () => {
  const source = `let main =
  let pair = (1, "one") in
  let nested = (pair, true) in
  println (to_string nested)`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));
  const tupleToken = checked.tokens.find((token) => token.name === "tuple" && token.span.start === source.indexOf("(1,"));

  assert.equal(mainLocals.get("pair"), "pair : (int, string)");
  assert.equal(mainLocals.get("nested"), "nested : ((int, string), bool)");
  assert.equal(tupleToken?.detail, "tuple : (int, string)");
});

test("checker exposes tuple pattern locals for hovers", () => {
  const source = `let main =
  match ("Ada", (1815, true)) with
  | (name, (year, active)) -> if active then year else 0`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));

  assert.equal(mainLocals.get("name"), "name : string");
  assert.equal(mainLocals.get("year"), "year : int");
  assert.equal(mainLocals.get("active"), "active : bool");
});

test("checker exposes record token, field, and pattern local types for hovers", () => {
  const source = `let main =
  let person = { year = 1815; name = "Ada"; active = true } in
  match person with
  | { name = n; year = y; active = true } -> y + String.length person.name
  | _ -> 0`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));
  const recordToken = checked.tokens.find((token) => token.name === "record");
  const nameFieldToken = checked.tokens.find((token) => token.name === "name" && token.span.start === source.lastIndexOf("name"));

  assert.equal(mainLocals.get("person"), "person : { active: bool; name: string; year: int }");
  assert.equal(mainLocals.get("n"), "n : string");
  assert.equal(mainLocals.get("y"), "y : int");
  assert.equal(recordToken?.detail, "record : { active: bool; name: string; year: int }");
  assert.equal(nameFieldToken?.detail, "name : string");
});

test("checker exposes list pattern locals for hovers", () => {
  const source = `let main =
  match List.cons "Ada" (List.empty ()) with
  | head :: tail -> String.length head + List.length tail
  | [] -> 0`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));

  assert.equal(mainLocals.get("head"), "head : string");
  assert.equal(mainLocals.get("tail"), "tail : string list");
});

test("checker exposes array pattern locals for hovers", () => {
  const source = `let main =
  let values = Array.make 2 "Ada" in
  match values with
  | [| first; second |] -> String.length first + String.length second
  | _ -> 0`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));

  assert.equal(mainLocals.get("first"), "first : string");
  assert.equal(mainLocals.get("second"), "second : string");
});

test("checker exposes set and map pattern locals for hovers", () => {
  const source = `let main =
  let values = Set.add (Set.empty ()) 1 in
  let scores = Map.set (Map.empty ()) "Ada" 1815 in
  match (values, scores) with
  | ({| first |}, {| name: year |}) -> first + year + String.length name
  | _ -> 0`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));

  assert.equal(mainLocals.get("first"), "first : int");
  assert.equal(mainLocals.get("name"), "name : string");
  assert.equal(mainLocals.get("year"), "year : int");
});

test("checker exposes algebraic data type constructor and payload types for hovers", () => {
  const source = `type status = Pending | Done of int | Failed of string

let main =
  match Done 42 with
  | Pending -> 0
  | Done value -> value
  | Failed message -> String.length message`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol.detail]));
  const mainLocals = new Map(checked.symbols.find((symbol) => symbol.name === "main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));
  const doneToken = checked.tokens.find((token) => token.name === "Done");

  assert.equal(symbols.get("Pending"), "Pending : status");
  assert.equal(symbols.get("Done"), "Done : int -> status");
  assert.equal(symbols.get("Failed"), "Failed : string -> status");
  assert.equal(doneToken?.detail, "Done : int -> status");
  assert.equal(mainLocals.get("value"), "value : int");
  assert.equal(mainLocals.get("message"), "message : string");
});

test("checker exposes polymorphic algebraic data type constructor hovers", () => {
  const source = `type 'a option = None | Some of 'a

let main =
  match Some "Ada" with
  | None -> 0
  | Some name -> String.length name`;
  const checked = check(parse(source));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol.detail]));
  const mainLocals = new Map(checked.symbols.find((symbol) => symbol.name === "main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));
  const someToken = checked.tokens.find((token) => token.name === "Some");

  assert.match(symbols.get("None") ?? "", /None : '.* option/);
  assert.match(symbols.get("Some") ?? "", /Some : '.* -> '.* option/);
  assert.equal(someToken?.detail, "Some : string -> string option");
  assert.equal(mainLocals.get("name"), "name : string");
});

test("checker exposes local let rec function types for hovers", () => {
  const checked = check(parse(`let main =
  let rec countdown n =
    match n with
    | 0 -> 0
    | _ -> countdown (n - 1)
  in
  countdown 3`));
  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));

  assert.equal(mainLocals.get("countdown"), "countdown : int -> int");
});

test("checker exposes fst and snd instantiated tuple types for hovers", () => {
  const source = `let main =
  let pair = ("Ada", 1815) in
  snd pair`;
  const checked = check(parse(source));
  const fstSig = checked.symbols.find((symbol) => symbol.name === "fst");
  const sndToken = checked.tokens.find((token) => token.name === "snd");

  assert.equal(fstSig?.detail, "fst : ('a, 'b) -> 'a");
  assert.equal(sndToken?.detail, "snd : (string, int) -> int");
});

test("checker exposes tuple projection result types for hovers", () => {
  const source = `let main =
  let triple = ("Ada", 1815, true) in
  if triple.2 then triple.1 else 0`;
  const checked = check(parse(source));
  const boolProjection = checked.tokens.find((token) => token.name === ".2");
  const intProjection = checked.tokens.find((token) => token.name === ".1");

  assert.equal(boolProjection?.detail, ".2 : bool");
  assert.equal(intProjection?.detail, ".1 : int");
});

test("monaco hover describes typed and lexical tokens", () => {
  const source = `let main = if true then 1 + 2 else 0`;
  const main = getOJamlHoverInfo(source, source.indexOf("main"));
  const keyword = getOJamlHoverInfo(source, source.indexOf("if"));
  const operator = getOJamlHoverInfo(source, source.indexOf("+"));

  assert.equal(main?.detail, "main : int");
  assert.equal(keyword?.detail, "if keyword");
  assert.equal(operator?.detail, "+ operator");
});

test("lexer, parser, and hover treat power as a single right-associative operator", () => {
  const source = `let main = 2 ** 3 ** 2`;
  const ast = parse(source);
  const main = asLet(ast.declarations[0]).value;
  const hover = getOJamlHoverInfo(source, source.indexOf("**"));

  assert.equal(main.kind, "Binary");
  assert.equal(main.op, "**");
  assert.equal(main.right.kind, "Binary");
  assert.equal(main.right.op, "**");
  assert.equal(hover?.detail, "** operator");
});

test("polymorphic functions expose constrained numeric signatures in editor metadata", () => {
  const checked = check(parse(`let square x = x ** 2

let main =
  let int_square = square 9 in
  let float_square = square 2.5 in
  int_square + Float.to_int float_square`));

  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  assert.equal(symbols.get("square")?.detail, "square : number -> number");
  assert.equal(symbols.get("square")?.params?.[0]?.detail, "x : number");
});

test("polymorphic functions execute correctly at int and float call sites", async () => {
  const result = await runOJaml(`let square x = x ** 2

let main =
  let int_square = square 9 in
  let float_square = square 2.5 in
  let _ = println (String.concat "square 9 = " (to_string int_square)) in
  let _ = println (String.concat "square 2.5 = " (to_string float_square)) in
  int_square + Float.to_int float_square`);

  assert.equal(result.value, 87);
  assert.equal(result.output, "square 9 = 81\nsquare 2.5 = 6.25\n");
});

test("int/float specialization works for mixed arities and higher-order top-level functions", async () => {
  const result = await runOJaml(`let square x = x * x
let apply f x = f x
let affine a b = a * 2 + b

let main =
  let direct_int = square 9 in
  let direct_float = square 2.5 in
  let applied_float = apply square 3.5 in
  let affine_int = affine 2 1 in
  let affine_float = affine 2.5 1.5 in
  let _ = println (String.concat "direct_int = " (to_string direct_int)) in
  let _ = println (String.concat "direct_float = " (to_string direct_float)) in
  let _ = println (String.concat "applied_float = " (to_string applied_float)) in
  let _ = println (String.concat "affine_int = " (to_string affine_int)) in
  let _ = println (String.concat "affine_float = " (to_string affine_float)) in
  direct_int + Float.to_int direct_float + Float.to_int applied_float + affine_int + Float.to_int affine_float`);

  assert.equal(result.value, 110);
  assert.equal(result.output, [
    "direct_int = 81",
    "direct_float = 6.25",
    "applied_float = 12.25",
    "affine_int = 5",
    "affine_float = 6.5",
    "",
  ].join("\n"));
});

test("to_string recursively formats nested arrays, lists, maps, tuples, records, and function values", async () => {
  const result = await runOJaml(`let inc x = x + 1

let main =
  let rows = Array.make 2 (List.empty ()) in
  let _ = Array.set rows 0 (List.cons 1 (List.cons 2 (List.empty ()))) in
  let _ = Array.set rows 1 (List.cons 3 (List.empty ())) in
  let lookup = Map.set (Map.empty ()) "rows" { data = rows; label = "matrix" } in
  let _ = println (to_string rows) in
  let _ = println (to_string lookup) in
  println (to_string inc)`);

  assert.match(result.output, /^\[\[1, 2\], \[3\]\]\n\{ rows: \{ data = \[\[1, 2\], \[3\]\]; label = matrix \} \}\nFunction \d+\n$/);
});

test("anonymous functions are first-class values", async () => {
  const result = await runOJaml(`let apply f x = f x

let main = apply (fun x -> x + 1) 41`);

  assert.equal(result.value, 42);
});

test("closures capture local values", async () => {
  const result = await runOJaml(`let make_adder x =
  fun y -> x + y

let main =
  let add10 = make_adder 10 in
  add10 32`);

  assert.equal(result.value, 42);
});

test("top-level functions can be passed as values", async () => {
  const result = await runOJaml(`let inc x = x + 1
let apply f x = f x

let main = apply inc 41`);

  assert.equal(result.value, 42);
});

test("higher-order list and array stdlib functions call closures", async () => {
  const result = await runOJaml(`let main =
  let xs = List.cons 3 (List.cons 2 (List.cons 1 (List.empty ()))) in
  let ys = List.map (fun x -> x + 1) xs in
  let total = List.fold_left (fun acc x -> acc + x) 0 ys in
  let arr = Array.make 2 10 in
  let arr2 = Array.map (fun x -> x * 2) arr in
  total + Array.fold_left (fun acc x -> acc + x) 0 arr2`);

  assert.equal(result.value, 49);
});

test("closures can capture multiple locals and chain through higher-order calls", async () => {
  const result = await runOJaml(`let compose f g =
  fun x -> f (g x)

let main =
  let offset = 5 in
  let scale = 2 in
  let f = compose (fun x -> x + offset) (fun x -> x * scale) in
  f 10`);

  assert.equal(result.value, 25);
});
