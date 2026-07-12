export type OJamlExample = {
  id: string;
  title: string;
  source: string;
};

export const ojamlExamples: OJamlExample[] = [
  {
    id: "hello",
    title: "Hello",
    source: `let main =
  println "Hello, OJaml!"`,
  },
  {
    id: "bindings",
    title: "Bindings",
    source: `let main =
  let name = "Ada" in
  let year = 1815 in
  let active = true in
  let _ = println (String.concat "name = " name) in
  let _ = println (String.concat "year = " (to_string year)) in
  let _ = if active then println "active = true" else println "active = false" in
  if active then year else 0`,
  },
  {
    id: "integer-operators",
    title: "Integer Operators",
    source: `let main =
  let sum = 10 + 4 in
  let difference = sum - 3 in
  let product = difference * 2 in
  let quotient = product / 5 in
  let remainder = product mod 5 in
  let _ = println (String.concat "10 + 4 = " (to_string sum)) in
  let _ = println (String.concat "sum - 3 = " (to_string difference)) in
  let _ = println (String.concat "difference * 2 = " (to_string product)) in
  let _ = println (String.concat "product / 5 = " (to_string quotient)) in
  let _ = println (String.concat "product mod 5 = " (to_string remainder)) in
  if quotient >= 4 && remainder = 2 then product else 0`,
  },
  {
    id: "float-operators",
    title: "Float Operators",
    source: `let main =
  let a = 7.5 + 2.5 in
  let b = a - 1 in
  let c = b * 2.0 in
  let d = c / Float.of_int 3 in
  let _ = println (String.concat "7.5 + 2.5 = " (to_string a)) in
  let _ = println (String.concat "a - 1 = " (to_string b)) in
  let _ = println (String.concat "b * 2.0 = " (to_string c)) in
  let _ = println (String.concat "c / 3 = " (to_string d)) in
  if d > 5.0 && d <> 0.0 then d else 0.0`,
  },
  {
    id: "strings",
    title: "Strings",
    source: `let main =
  let greeting = String.concat "hello" " world" in
  let words = String.split greeting " " in
  let length = String.length greeting in
  let _ = println (String.concat "greeting = " greeting) in
  let _ = println (String.concat "words = " (to_string words)) in
  let _ = println (String.concat "length = " (to_string length)) in
  length`,
  },
  {
    id: "arrays",
    title: "Arrays",
    source: `let main =
  let scores = Array.make 3 0 in
  let _ = Array.set scores 0 10 in
  let _ = Array.set scores 1 20 in
  let _ = Array.set scores 2 30 in
  let _ = println (String.concat "scores = " (to_string scores)) in
  let _ = println (String.concat "length = " (to_string (Array.length scores))) in
  Array.get scores 0 + Array.get scores 1 + Array.get scores 2`,
  },
  {
    id: "lists",
    title: "Lists",
    source: `let main =
  let items = List.empty () in
  let items = List.cons "third" items in
  let items = List.cons "second" items in
  let items = List.cons "first" items in
  let rest = List.tail items in
  let _ = println (String.concat "items = " (to_string items)) in
  let _ = println (String.concat "rest = " (to_string rest)) in
  let _ = println (String.concat "length = " (to_string (List.length items))) in
  if List.is_empty rest then 0 else List.length items`,
  },
  {
    id: "maps",
    title: "Maps",
    source: `let main =
  let years = Map.empty () in
  let years = Map.set years "Ada" 1815 in
  let years = Map.set years "Grace" 1906 in
  let _ = println (String.concat "years = " (to_string years)) in
  let _ = println (String.concat "Ada = " (to_string (Map.get years "Ada"))) in
  let _ = if Map.has years "Grace" then println "Grace = found" else println "Grace = missing" in
  if Map.has years "Grace" then Map.get years "Grace" else 0`,
  },
  {
    id: "type-inference",
    title: "Type Inference",
    source: `let square x = x * x

let main =
  let int_square = square 9 in
  let float_square = square 2.5 in
  let _ = println (String.concat "square 9 = " (to_string int_square)) in
  let _ = println (String.concat "square 2.5 = " (to_string float_square)) in
  int_square + Float.to_int float_square`,
  },
  {
    id: "pattern-matching",
    title: "Pattern Matching",
    source: `let describe_count n =
  match n with
  | 0 -> "none"
  | 1 -> "one"
  | _ -> "many"

let describe_float x =
  match x with
  | 0.0 -> "zero"
  | 1.5 -> "one point five"
  | _ -> "other"

let main =
  let _ = println (describe_count 3) in
  let _ = println (describe_count 1) in
  let _ = println (describe_float 1.5) in
  println (describe_float 2.0)`,
  },
  {
    id: "factorial",
    title: "Factorial",
    source: `let rec fact n =
  match n with
  | 0 -> 1
  | 1 -> 1
  | _ -> n * fact (n - 1)

let main =
  let result = fact 6 in
  let _ = println result in
  result`,
  },
  {
    id: "fibonacci",
    title: "Fibonacci",
    source: `let rec fib n =
  if n <= 1 then n else fib (n - 1) + fib (n - 2)

let main =
  let result = fib 10 in
  let _ = println result in
  result`,
  },
  {
    id: "gcd",
    title: "GCD",
    source: `let rec gcd a b =
  match b with
  | 0 -> a
  | _ -> gcd b (a mod b)

let main =
  let result = gcd 252 105 in
  let _ = println result in
  result`,
  },
  {
    id: "cube-root",
    title: "Cube Root",
    source: `let rec cube_root_between n low high steps =
  if steps = 0 then (low + high) / 2.0 else
  let mid = (low + high) / 2.0 in
  let cubed = mid * mid * mid in
  if cubed > n then cube_root_between n low mid (steps - 1) else
  cube_root_between n mid high (steps - 1)

let main =
  let result = cube_root_between 512.0 0.0 512.0 40 in
  let _ = println result in
  result`,
  },
  {
    id: "higher-order",
    title: "Higher Order",
    source: `let make_adder x =
  fun y -> x + y

let main =
  let add10 = make_adder 10 in
  let nums = List.cons 3 (List.cons 2 (List.cons 1 (List.empty ()))) in
  let bumped = List.map add10 nums in
  let _ = List.iter (fun x -> println x) bumped in
  List.fold_left (fun acc x -> acc + x) 0 bumped`,
  },
  {
    id: "language-tour",
    title: "Language Tour",
    source: `let square x = x * x

let compose f g =
  fun x -> f (g x)

let describe n =
  match n with
  | 0 -> "zero"
  | 1 -> "one"
  | _ -> "many"

let main =
  let _ = println "OJaml tour" in
  let int_score = square 5 in
  let float_score = square 2.5 + Float.of_int int_score in
  let words = String.split (String.concat "typed " "runtime") " " in
  let _ = println (List.head words) in
  let nums = Array.make 3 1 in
  let _ = Array.set nums 1 4 in
  let doubled = Array.map (fun x -> x * 2) nums in
  let total = Array.fold_left (fun acc x -> acc + x) 0 doubled in
  let names = Map.set (Map.empty ()) "ada" 1815 in
  let lookup = if Map.has names "ada" then Map.get names "ada" else 0 in
  let add2 = compose (fun x -> x + 1) (fun x -> x + 1) in
  add2 (int_score + Float.to_int float_score + total + lookup + String.length (List.head (List.tail words)))`,
  },
];

export const defaultExampleId = "hello";

export function getExample(id: string): OJamlExample {
  return ojamlExamples.find((example) => example.id === id) ?? ojamlExamples[0];
}
