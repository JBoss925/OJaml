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
  let power = 2 ** 3 in
  let _ = println (String.concat "10 + 4 = " (to_string sum)) in
  let _ = println (String.concat "sum - 3 = " (to_string difference)) in
  let _ = println (String.concat "difference * 2 = " (to_string product)) in
  let _ = println (String.concat "product / 5 = " (to_string quotient)) in
  let _ = println (String.concat "product mod 5 = " (to_string remainder)) in
  let _ = println (String.concat "2 ** 3 = " (to_string power)) in
  if quotient >= 4 && remainder = 2 then product + power else 0`,
  },
  {
    id: "float-operators",
    title: "Float Operators",
    source: `let main =
  let a = 7.5 + 2.5 in
  let b = a - 1 in
  let c = b * 2.0 in
  let d = c / Float.of_int 3 in
  let e = 2.0 ** 3 in
  let _ = println (String.concat "7.5 + 2.5 = " (to_string a)) in
  let _ = println (String.concat "a - 1 = " (to_string b)) in
  let _ = println (String.concat "b * 2.0 = " (to_string c)) in
  let _ = println (String.concat "c / 3 = " (to_string d)) in
  let _ = println (String.concat "2.0 ** 3 = " (to_string e)) in
  if d > 5.0 && e <> 0.0 then d + e else 0.0`,
  },
  {
    id: "boolean-logic",
    title: "Boolean Logic",
    source: `let main =
  let closed = false in
  let count = 3 in
  let ready = not closed && not (count = 0) in
  let skipped = false && (println "skipped"; true) in
  println (String.concat "closed = " (to_string closed));
  println (String.concat "ready = " (to_string ready));
  println (String.concat "skipped = " (to_string skipped));
  if ready || not closed then count else 0`,
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
    id: "open-modules",
    title: "Open Modules",
    source: `open List
open String
open Float

let main =
  let words = split (concat "hello" " OJaml") " " in
  let nums = cons 1 (cons 2 (empty ())) in
  let _ = println (concat "words = " (to_string words)) in
  let _ = println (concat "head = " (head words)) in
  let _ = println (concat "nums = " (to_string nums)) in
  String.length (head words) + List.length nums + to_int (of_int 3)`,
  },
  {
    id: "user-modules",
    title: "User Modules",
    source: `module Scores = struct
  let bonus = 4
  let total first second = first + second + bonus

  module Offsets = struct
    let make scale =
      fun value -> value * scale + bonus
  end
end

open Scores
open Scores.Offsets

let bonus = 1

let main =
  let offset = make 3 in
  let direct = Scores.total 10 20 in
  let opened = total 5 6 in
  let qualified = Scores.Offsets.make 2 in
  let local = bonus in
  let _ = println (String.concat "Scores.total 10 20 = " (to_string direct)) in
  let _ = println (String.concat "total 5 6 = " (to_string opened)) in
  let _ = println (String.concat "offset 7 = " (to_string (offset 7))) in
  let _ = println (String.concat "qualified 8 = " (to_string (qualified 8))) in
  let _ = println (String.concat "local bonus = " (to_string local)) in
  direct + opened + offset 7 + qualified 8 + local`,
  },
  {
    id: "module-types",
    title: "Module Types",
    source: `module Geometry = struct
  type point = { x: int; y: int }
  type label = Origin | Named of string

  let origin : point = { x = 0; y = 0 }

  let move (point : point) dx dy : point =
    { x = point.x + dx; y = point.y + dy }

  let label_length label =
    match label with
    | Origin -> 0
    | Named name -> String.length name
end

open Geometry

let main =
  let point : point = move origin 3 4 in
  let label : label = Named "corner" in
  let _ = println (String.concat "point = " (to_string point)) in
  let _ = println (String.concat "label length = " (to_string (label_length label))) in
  point.x + point.y + label_length label`,
  },
  {
    id: "module-signatures",
    title: "Module Signatures",
    source: `module type COUNTER = sig
  type counter = Counter of int
  val start : counter
  val step : counter -> counter
  val value : counter -> int
  val format : counter -> string
end

module Counter : COUNTER = struct
  type counter = Counter of int

  let start = Counter 10
  let step counter =
    match counter with
    | Counter value -> Counter (value + 1)
  let value counter =
    match counter with
    | Counter value -> value
  let format counter = String.concat "count = " (to_string (value counter))
end

let main =
  let next : Counter.counter -> Counter.counter = Counter.step in
  let value = next Counter.start in
  let _ = println (Counter.format value) in
  Counter.value value`,
  },
  {
    id: "sequencing",
    title: "Sequencing",
    source: `let main =
  println "first";
  println "second";
  let items = List.cons 1 (List.cons 2 (List.cons 3 (List.empty ()))) in
  println (String.concat "items = " (to_string items));
  List.length items`,
  },
  {
    id: "pipeline",
    title: "Pipeline",
    source: `let double_all xs =
  List.map (fun x -> x * 2) xs

let sum xs =
  List.fold_left (fun total x -> total + x) 0 xs

let main =
  let nums = List.cons 1 (List.cons 2 (List.cons 3 (List.empty ()))) in
  let total = nums |> double_all |> sum in
  println (String.concat "nums = " (to_string nums));
  println (String.concat "total = " (to_string total));
  total`,
  },
  {
    id: "arrays",
    title: "Arrays",
    source: `let main =
  let scores = Array.make 3 0 in
  let _ = Array.set scores 0 10 in
  let _ = Array.set scores 1 20 in
  let _ = Array.set scores 2 30 in
  let total =
    match scores with
    | [| first; second; third |] -> first + second + third
    | _ -> 0
  in
  let _ = println (String.concat "scores = " (to_string scores)) in
  let _ = println (String.concat "length = " (to_string (Array.length scores))) in
  let _ = println (String.concat "total = " (to_string total)) in
  total`,
  },
  {
    id: "lists",
    title: "Lists",
    source: `let main =
  let items = List.empty () in
  let items = List.cons "third" items in
  let items = List.cons "second" items in
  let items = List.cons "first" items in
  let rest =
    match items with
    | _ :: tail -> tail
    | [] -> List.empty ()
  in
  let first =
    match items with
    | head :: _ -> head
    | [] -> "none"
  in
  let _ = println (String.concat "items = " (to_string items)) in
  let _ = println (String.concat "first = " first) in
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
    id: "sets",
    title: "Sets",
    source: `let main =
  let names = Set.empty () in
  let names = Set.add names "Ada" in
  let names = Set.add names "Grace" in
  let names = Set.add names "Ada" in
  let _ = println (String.concat "names = " (to_string names)) in
  let _ = if Set.has names "Ada" then println "has Ada = true" else println "has Ada = false" in
  Set.length names`,
  },
  {
    id: "tuples",
    title: "Tuples",
    source: `let main =
  let point = (3, 4, 5) in
  let labeled = ("origin", point) in
  let sum =
    match point with
    | (x, y, _) -> x + y
  in
  let points = List.cons point (List.cons (0, 0, 0) (List.empty ())) in
  let _ = println (String.concat "point = " (to_string point)) in
  let _ = println (String.concat "x = " (to_string point.0)) in
  let _ = println (String.concat "y = " (to_string point.1)) in
  let _ = println (String.concat "z = " (to_string point.2)) in
  let _ = println (String.concat "x + y = " (to_string sum)) in
  let _ = println (String.concat "labeled = " (to_string labeled)) in
  let _ = println (String.concat "points = " (to_string points)) in
  sum + List.length points`,
  },
  {
    id: "records",
    title: "Records",
    source: `type person = { name: string; year: int; active: bool }

let ada : person = { name = "Ada"; year = 1815; active = true }

let display (person : person) =
  String.concat person.name (String.concat " " (to_string person.year))

let main =
  let grace = { name = "Grace"; year = 1906; active = true } in
  let label =
    match ada with
    | { active = true; name = _; year = _ } -> display ada
    | _ -> "inactive"
  in
  let people = List.cons ada (List.cons grace (List.empty ())) in
  let _ = println (String.concat "ada = " (to_string ada)) in
  let _ = println (String.concat "ada.name = " ada.name) in
  let _ = println (String.concat "label = " label) in
  let _ = println (String.concat "people = " (to_string people)) in
  ada.year + List.length people`,
  },
  {
    id: "variants",
    title: "Algebraic Data Types",
    source: `type 'a option = None | Some of 'a
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
  let ok : (string, int) result = Ok "Ada" in
  let error : (string, int) result = Error 5 in
  let _ = println (String.concat "score number = " (to_string (score number))) in
  let _ = println (match missing with | None -> "missing = none" | Some text -> String.concat "missing = " text) in
  let _ = println (String.concat "label ok = " (to_string (label ok))) in
  let _ = println (String.concat "label error = " (to_string (label error))) in
  score number + label ok + label error`,
  },
  {
    id: "type-inference",
    title: "Type Inference",
    source: `let square x = x ** 2

let main =
  let int_square = square 9 in
  let float_square = square 2.5 in
  let _ = println (String.concat "square 9 = " (to_string int_square)) in
  let _ = println (String.concat "square 2.5 = " (to_string float_square)) in
  int_square + Float.to_int float_square`,
  },
  {
    id: "local-recursion",
    title: "Local Recursion",
    source: `let main =
  let rec sum xs =
    match xs with
    | [] -> 0
    | head :: tail -> head + sum tail
  in
  let values = List.cons 4 (List.cons 5 (List.cons 6 (List.empty ()))) in
  let total = sum values in
  let _ = println (String.concat "values = " (to_string values)) in
  let _ = println (String.concat "sum = " (to_string total)) in
  total`,
  },
  {
    id: "high-arity-functions",
    title: "High-Arity Functions",
    source: `type person = { name: string; year: int }

let apply8 f =
  f "Ada" 1815 2.5 true (List.cons 4 (List.empty ())) { name = "Grace"; year = 1906 } (fun x -> x + 1) 3

let main =
  let combine name (year : int) (scale : float) active (values : int list) (person : person) inc seed =
    let flag = if active then 10 else 0 in
    String.length name + year + Float.to_int scale + flag + List.head values + person.year + inc seed
  in
  let result = apply8 combine in
  let _ = println (String.concat "values = " (to_string (List.cons 4 (List.empty ())))) in
  let _ = println (String.concat "person = " (to_string { name = "Grace"; year = 1906 })) in
  let _ = println (String.concat "result = " (to_string result)) in
  result`,
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

let describe_point point =
  match point with
  | (0, 0) -> "origin"
  | (x, y) -> String.concat (to_string x) (String.concat "," (to_string y))

let describe_names names =
  match names with
  | [] -> "none"
  | first :: _ -> String.concat "first " first

let describe_set names =
  match names with
  | {| "Grace"; "Ada" |} -> "set has Grace then Ada"
  | {| |} -> "empty set"
  | _ -> "other set"

let describe_map years =
  match years with
  | {| "Grace": year; "Ada": 1815 |} ->
      String.concat "Grace born " (to_string year)
  | {| : |} -> "empty map"
  | _ -> "other map"

let main =
  let names = Set.add (Set.add (Set.empty ()) "Ada") "Grace" in
  let years = Map.set (Map.set (Map.empty ()) "Ada" 1815) "Grace" 1906 in
  let _ = println (describe_count 3) in
  let _ = println (describe_count 1) in
  let _ = println (describe_float 1.5) in
  let _ = println (describe_float 2.0) in
  let _ = println (describe_point (3, 4)) in
  let _ = println (describe_names (List.cons "Ada" (List.cons "Grace" (List.empty ())))) in
  let _ = println (describe_set names) in
  println (describe_map years)`,
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
  let _ = println (String.concat "cube_root 512 = " (to_string positive)) in
  let _ = println (String.concat "cube_root -27 = " (to_string negative)) in
  positive + negative`,
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
