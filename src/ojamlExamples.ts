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
  let _ = print "Hello, OJaml!" in
  ()`,
  },
  {
    id: "basics",
    title: "Basics",
    source: `let square x = x * x

let main =
  let a = square 9 in
  if a >= 81 then a + 1 else 0`,
  },
  {
    id: "factorial",
    title: "Factorial",
    source: `let rec fact n =
  match n with
  | 0 -> 1
  | 1 -> 1
  | _ -> n * fact (n - 1)

let main = fact 6`,
  },
  {
    id: "fibonacci",
    title: "Fibonacci",
    source: `let rec fib n =
  if n <= 1 then n else fib (n - 1) + fib (n - 2)

let main = fib 10`,
  },
  {
    id: "fizzbuzz",
    title: "FizzBuzz",
    source: `let fizzbuzz n =
  if n mod 15 = 0 then print "FizzBuzz" else
  if n mod 3 = 0 then print "Fizz" else
  if n mod 5 = 0 then print "Buzz" else
  print n

let rec loop n =
  match n with
  | 0 -> ()
  | _ ->
    let _ = loop (n - 1) in
    fizzbuzz n

let main = loop 30`,
  },
  {
    id: "cube-root",
    title: "Cube Root",
    source: `let abs x = if x < 0 then 0 - x else x

let rec cube_root_search n guess =
  let cubed = guess * guess * guess in
  if cubed = n then guess else
  if cubed > n then guess - 1 else cube_root_search n (guess + 1)

let main = cube_root_search 512 1`,
  },
  {
    id: "gcd",
    title: "GCD",
    source: `let rec gcd a b =
  match b with
  | 0 -> a
  | _ -> gcd b (a mod b)

let main = gcd 252 105`,
  },
  {
    id: "collections",
    title: "Collections",
    source: `let main =
  let nums = Array.make 3 0 in
  let _ = Array.set nums 0 10 in
  let _ = Array.set nums 1 20 in
  let words = List.cons "world" (List.empty ()) in
  let words = List.cons "hello" words in
  let names = Map.empty () in
  let names = Map.set names 1 "Ada" in
  let _ = print (List.head words) in
  let _ = print (Map.get names 1) in
  Array.get nums 0 + Array.get nums 1 + List.length words`,
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
  let _ = List.iter (fun x -> print x) bumped in
  List.fold_left (fun acc x -> acc + x) 0 bumped`,
  },
  {
    id: "language-tour",
    title: "Language Tour",
    source: `(* A compact tour of current OJaml features. *)
let compose f g =
  fun x -> f (g x)

let describe n =
  match n with
  | 0 -> "zero"
  | 1 -> "one"
  | value -> "many"

let main =
  let _ = print "OJaml tour" in
  let arithmetic = (20 / 5) + (17 mod 5) * 10 - -3 in
  let flag = (arithmetic >= 27) && true || false in
  let _ = print (describe 2) in
  let nums = Array.make 3 1 in
  let _ = Array.set nums 1 4 in
  let doubled = Array.map (fun x -> x * 2) nums in
  let from_array = Array.fold_left (fun acc x -> acc + x) 0 doubled in
  let words = List.cons "tail" (List.cons "head" (List.empty ())) in
  let _ = print (List.head words) in
  let _ = Array.iter (fun x -> print x) doubled in
  let names = Map.set (Map.empty ()) "ada" 1815 in
  let lookup = if Map.has names "ada" then Map.get names "ada" else 0 in
  let add2 = compose (fun x -> x + 1) (fun x -> x + 1) in
  let unit_score = match () with | () -> 1 | _ -> 0 in
  if flag then add2 (from_array + lookup + List.length words + unit_score) else 0`,
  },
];

export const defaultExampleId = "factorial";

export function getExample(id: string): OJamlExample {
  return ojamlExamples.find((example) => example.id === id) ?? ojamlExamples[0];
}
