import assert from "node:assert/strict";
import test from "node:test";
import { check } from "../src/check";
import { compile } from "../src/compiler";
import { getOJamlSyntaxMarkers } from "../src/monacoOJaml";
import { parse } from "../src/parser";
import { runOJaml } from "../src/runtime";

test("parses comments, semicolon separators, and module-style identifiers", () => {
  const ast = parse(`(* nested (* comment *) works *)
let make = Array.make;;
let main = Array.length (make 2 0)`);

  assert.equal(ast.declarations.length, 2);
  assert.equal(ast.declarations[0].name, "make");
});

test("parses top-level recursive function", () => {
  const ast = parse(`let rec fact n = if n <= 1 then 1 else n * fact (n - 1)\nlet main = fact 5`);
  assert.equal(ast.declarations.length, 2);
  assert.equal(ast.declarations[0].name, "fact");
  assert.deepEqual(ast.declarations[0].params, ["n"]);
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

test("runs every arithmetic, comparison, boolean, and unary operator", async () => {
  const result = await runOJaml(`let main =
  let a = 20 / 5 in
  let b = 17 mod 5 in
  let c = -3 in
  if (a = 4) && (b <> 1) && (c < 0) && (a <= 4) && (b > 1) && (b >= 2) || false
  then a + b * 10 - c
  else 0`);

  assert.equal(result.value, 27);
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
});

test("monaco diagnostics include type errors", () => {
  const markers = getOJamlSyntaxMarkers(`let main = print ()`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /print expects int or string/);
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

test("arrays expose length, set, get, map, iter, and fold_left", async () => {
  const result = await runOJaml(`let main =
  let xs = Array.make 3 2 in
  let _ = Array.set xs 1 4 in
  let ys = Array.map (fun x -> x + 1) xs in
  let _ = Array.iter (fun x -> print x) ys in
  Array.length ys + Array.fold_left (fun acc x -> acc + x) 0 ys`);

  assert.equal(result.value, 14);
  assert.deepEqual(result.prints, [3, 5, 3]);
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

test("lists expose empty, cons, head, tail, is_empty, length, map, iter, and fold_left", async () => {
  const result = await runOJaml(`let main =
  let xs = List.cons 2 (List.cons 1 (List.empty ())) in
  let tail = List.tail xs in
  let ys = List.map (fun x -> x * 3) xs in
  let _ = List.iter (fun x -> print x) ys in
  if List.is_empty tail then 0 else List.length ys + List.fold_left (fun acc x -> acc + x) 0 ys`);

  assert.equal(result.value, 11);
  assert.deepEqual(result.prints, [6, 3]);
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

test("match supports int, string, bool, unit, wildcard, and variable patterns", async () => {
  const result = await runOJaml(`let classify n =
  match n with
  | 0 -> "zero"
  | value -> "nonzero"

let main =
  let a = match "ok" with | "ok" -> 1 | _ -> 0 in
  let b = match true with | true -> 2 | false -> 0 | _ -> 0 in
  let c = match () with | () -> 3 | _ -> 0 in
  let _ = print (classify 7) in
  a + b + c`);

  assert.equal(result.value, 6);
  assert.deepEqual(result.prints, ["nonzero"]);
});

test("polymorphic arrays reject mixed element writes", () => {
  const markers = getOJamlSyntaxMarkers(`let main =
  let xs = Array.make 1 0 in
  let _ = Array.set xs 0 "nope" in
  0`, 8);

  assert.equal(markers.length, 1);
  assert.match(markers[0].message, /Type mismatch/);
});

test("diagnostics cover undefined names, arity, branch mismatch, and non-exhaustive matches", () => {
  assert.match(getOJamlSyntaxMarkers(`let main = missing`, 8)[0].message, /Undefined name/);
  assert.match(getOJamlSyntaxMarkers(`let f x = x\nlet main = f 1 2`, 8)[0].message, /expects 1 argument/);
  assert.match(getOJamlSyntaxMarkers(`let main = if true then 1 else "no"`, 8)[0].message, /Type mismatch/);
  assert.match(getOJamlSyntaxMarkers(`let main = match 1 with | 1 -> 10`, 8)[0].message, /catch-all/);
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
  assert.equal(symbols.get("inc")?.detail, "inc : int -> int");
  assert.equal(symbols.get("make_adder")?.detail, "make_adder : int -> int -> int");
  assert.equal(symbols.get("main")?.detail, "main : int");
  const mainLocals = new Map(symbols.get("main")?.locals?.map((symbol) => [symbol.name, symbol.detail]));
  assert.equal(mainLocals.get("greeting"), "greeting : string");
  assert.equal(mainLocals.get("nums"), "nums : int array");
  assert.equal(mainLocals.get("names"), "names : (string, int) map");
  assert.equal(mainLocals.get("add10"), "add10 : int -> int");
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
