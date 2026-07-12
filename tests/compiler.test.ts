import assert from "node:assert/strict";
import test from "node:test";
import { check } from "../src/check";
import { compile } from "../src/compiler";
import { getOJamlHoverInfo, getOJamlSyntaxMarkers } from "../src/monacoOJaml";
import { ojamlExamples } from "../src/ojamlExamples";
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
  let negative_base = (0 - 2) ** 3 in
  let unary_precedence = -2 ** 2 in
  let grouped_unary = (-2) ** 2 in
  let fractional = 27.0 ** (1.0 / 3.0) in
  let _ = println (String.concat "fractional = " (to_string fractional)) in
  zero_exp + zero_base + negative_base + unary_precedence + grouped_unary + Float.to_int fractional`);

  assert.equal(result.value, -4);
  assert.equal(result.output, "fractional = 3\n");
});

test("negative float base with fractional exponent produces NaN", async () => {
  const result = await runOJaml(`let main =
  let value = (0.0 - 4.0) ** 0.5 in
  let _ = println (to_string value) in
  value`);

  assert.equal(result.mainType, "float");
  assert.ok(Number.isNaN(result.value));
  assert.equal(result.output, "NaN\n");
});

test("power operator works inside numeric-polymorphic functions", async () => {
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

test("maps use latest value for duplicate keys and support float values", async () => {
  const result = await runOJaml(`let main =
  let m = Map.empty () in
  let m = Map.set m "score" 1.5 in
  let m = Map.set m "score" 2.5 in
  Float.to_int (Map.get m "score" + 0.5)`);

  assert.equal(result.value, 3);
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

test("match supports int, float, string, bool, unit, wildcard, and variable patterns", async () => {
  const result = await runOJaml(`let classify n =
  match n with
  | 0 -> "zero"
  | value -> "nonzero"

let main =
  let a = match "ok" with | "ok" -> 1 | _ -> 0 in
  let b = match true with | true -> 2 | false -> 0 | _ -> 0 in
  let c = match () with | () -> 3 | _ -> 0 in
  let d = match 1.5 with | 1.5 -> 4 | _ -> 0 in
  let _ = print (classify 7) in
  a + b + c + d`);

  assert.equal(result.value, 10);
  assert.deepEqual(result.prints, ["nonzero"]);
});

const expectedExampleResults: Map<string, { mainType: string; value: number; output: string }> = new Map([
  ["hello", { mainType: "unit", value: 0, output: "Hello, OJaml!\n" }],
  ["bindings", { mainType: "int", value: 1815, output: "name = Ada\nyear = 1815\nactive = true\n" }],
  ["integer-operators", { mainType: "int", value: 30, output: "10 + 4 = 14\nsum - 3 = 11\ndifference * 2 = 22\nproduct / 5 = 4\nproduct mod 5 = 2\n2 ** 3 = 8\n" }],
  ["float-operators", { mainType: "float", value: 14, output: "7.5 + 2.5 = 10\na - 1 = 9\nb * 2.0 = 18\nc / 3 = 6\n2.0 ** 3 = 8\n" }],
  ["strings", { mainType: "int", value: 11, output: "greeting = hello world\nwords = [hello, world]\nlength = 11\n" }],
  ["arrays", { mainType: "int", value: 60, output: "scores = [10, 20, 30]\nlength = 3\n" }],
  ["lists", { mainType: "int", value: 3, output: "items = [first, second, third]\nrest = [second, third]\nlength = 3\n" }],
  ["maps", { mainType: "int", value: 1906, output: "years = { Grace: 1906, Ada: 1815 }\nAda = 1815\nGrace = found\n" }],
  ["sets", { mainType: "int", value: 2, output: "names = { Grace, Ada }\nhas Ada = true\n" }],
  ["type-inference", { mainType: "int", value: 87, output: "square 9 = 81\nsquare 2.5 = 6.25\n" }],
  ["pattern-matching", { mainType: "unit", value: 0, output: "many\none\none point five\nother\n" }],
  ["factorial", { mainType: "int", value: 720, output: "720\n" }],
  ["fibonacci", { mainType: "int", value: 55, output: "55\n" }],
  ["gcd", { mainType: "int", value: 21, output: "21\n" }],
  ["cube-root", { mainType: "float", value: 8.00000000023283, output: "8.00000000023283\n" }],
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
  const main = ast.declarations[0].value;
  const hover = getOJamlHoverInfo(source, source.indexOf("**"));

  assert.equal(main.kind, "Binary");
  assert.equal(main.op, "**");
  assert.equal(main.right.kind, "Binary");
  assert.equal(main.right.op, "**");
  assert.equal(hover?.detail, "** operator");
});

test("numeric polymorphic functions expose numeric signatures in editor metadata", () => {
  const checked = check(parse(`let square x = x ** 2

let main =
  let int_square = square 9 in
  let float_square = square 2.5 in
  int_square + Float.to_int float_square`));

  const symbols = new Map(checked.symbols.map((symbol) => [symbol.name, symbol]));
  assert.equal(symbols.get("square")?.detail, "square : number -> number");
  assert.equal(symbols.get("square")?.params?.[0]?.detail, "x : number");
});

test("numeric polymorphic functions execute correctly at int and float call sites", async () => {
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

test("numeric specialization works for mixed arities and higher-order top-level functions", async () => {
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

test("to_string recursively formats nested arrays, lists, maps, and function values", async () => {
  const result = await runOJaml(`let inc x = x + 1

let main =
  let rows = Array.make 2 (List.empty ()) in
  let _ = Array.set rows 0 (List.cons 1 (List.cons 2 (List.empty ()))) in
  let _ = Array.set rows 1 (List.cons 3 (List.empty ())) in
  let lookup = Map.set (Map.empty ()) "rows" rows in
  let _ = println (to_string rows) in
  let _ = println (to_string lookup) in
  println (to_string inc)`);

  assert.match(result.output, /^\[\[1, 2\], \[3\]\]\n\{ rows: \[\[1, 2\], \[3\]\] \}\nFunction \d+\n$/);
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
