# OJaml

OJaml is an OCaml-inspired language implemented in TypeScript and compiled to WebAssembly for browser-native execution. The project owns the full language path: lexing, parsing, static checks, Hindley-Milner-style inference, typed standard-library schemes, closure lowering, WebAssembly text emission, WABT compilation, runtime execution, and Monaco editor tooling.

## What Is Included

- Lexer and recursive-descent parser for an OCaml-like syntax.
- Static checks for bindings, calls, branches, pattern matches, and standard-library usage.
- Top-level and nested modules with qualified access, module-local type declarations, and `open` support.
- Polymorphic type inference for functions and collection builtins.
- First-class functions and closures with captured locals and generated indirect-call types for every arity used by the program.
- WebAssembly text backend using a uniform `i32` value representation plus concrete int/float specializations for polymorphic functions.
- Browser editor/playground with Monaco completions, diagnostics, and hover metadata.
- Node CLI for local compile/run workflows.
- Reusable package exports for the editor component, examples, compiler, and runtime helpers.
- Test suite covering parser, checker, runtime, stdlib, modules, sequencing, pipelines, closures, high-arity calls, tuples, records, algebraic data types, sets, maps, structural patterns, power, runtime access checks, exact editor-example transcripts, and compiler specialization regressions.

## Language Snapshot

```ocaml
let rec fact n =
  match n with
  | 0 -> 1
  | 1 -> 1
  | _ -> n * fact (n - 1)

let main =
  println "Hello, OJaml!";
  fact 6
```

Supported language features:

- `let` and `let rec` top-level bindings
- Top-level and nested modules with `module Name = struct ... end`
- Top-level `open` declarations for built-in standard-library namespaces and user-defined modules
- Local `let ... in ...`, local function bindings, and local `let rec` function bindings
- Anonymous functions and first-class function values, including high-arity function values and staged closures that return more high-arity functions
- Integers, floats, booleans, strings, unit, tuples, structural records, and algebraic data types
- Record and algebraic data type declarations, including type parameters, plus value and function parameter annotations such as `let ada : person = ...` and `let describe (person : person) = ...`
- Integer and float arithmetic, right-associative power `**`, comparison, equality, boolean, and integer `mod` operators
- Sequencing with `expr; expr`; the left side must return `unit`, and the whole sequence has the right side's type
- Forward pipelines with `value |> f`, equivalent to `f value`, including top-level functions, local closures, returned closures, and one-argument standard-library functions
- Polymorphic functions, including constrained numeric variables displayed as `number -> number` and emitted with concrete int/float call-site specializations
- `if ... then ... else`
- OCaml-style `match ... with | pat -> expr`
- Wildcard, int, float, string, bool, unit, tuple, record, list, fixed-length array, set, map, constructor, and variable patterns
- Zero-based tuple projection with `.0`, `.1`, ... plus pair helpers `fst` and `snd`
- Polymorphic arrays, lists, sets, maps, algebraic data types, tuples, and records in heap-backed values, and higher-order collection functions
- `print : int|float|string -> unit`
- `println : int|float|string -> unit`
- `to_string : 'a -> string`, including recursive formatting for tuples, records, arrays, lists, sets, maps, and functions
- `main` must be a zero-argument value and may return `int`, `float`, `bool`, or `unit` directly. Strings and heap values should be printed, converted with `to_string`, or reduced to a direct result type.

## Standard Library Surface

```text
print : int|float|string -> unit
println : int|float|string -> unit
to_string : 'a -> string
fst : ('a, 'b) -> 'a
snd : ('a, 'b) -> 'b

Float.of_int : int -> float
Float.to_int : float -> int

String.concat : string -> string -> string
String.length : string -> int
String.split : string -> string -> string list

Array.make : int -> 'a -> 'a array
Array.length : 'a array -> int
Array.get : 'a array -> int -> 'a
Array.set : 'a array -> int -> 'a -> unit
Array.map : ('a -> 'b) -> 'a array -> 'b array
Array.iter : ('a -> unit) -> 'a array -> unit
Array.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a array -> 'b

List.empty : unit -> 'a list
List.cons : 'a -> 'a list -> 'a list
List.head : 'a list -> 'a
List.tail : 'a list -> 'a list
List.is_empty : 'a list -> bool
List.length : 'a list -> int
List.map : ('a -> 'b) -> 'a list -> 'b list
List.iter : ('a -> unit) -> 'a list -> unit
List.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a list -> 'b

Set.empty : unit -> 'a set
Set.add : 'a set -> 'a -> 'a set
Set.has : 'a set -> 'a -> bool
Set.length : 'a set -> int

Map.empty : unit -> ('k, 'v) map
Map.set : ('k, 'v) map -> 'k -> 'v -> ('k, 'v) map
Map.get : ('k, 'v) map -> 'k -> 'v
Map.has : ('k, 'v) map -> 'k -> bool
```

All standard-library functions have explicit type schemes so editor hovers, type errors, and autocomplete remain statically meaningful.

Modules group related `let`, `let rec`, record type, and algebraic data type declarations under a qualified namespace. Module members can refer to sibling values, types, and constructors by short name inside the module; nested modules can refer to values and types from enclosing modules; members can be called through qualified names such as `Scores.total` or `Scores.Offsets.make`; and user modules can be opened so their immediate values, types, and constructors are available by short name. User modules currently contain values, nested modules, and type declarations; module signatures and functors are not implemented yet.

```ocaml
module Scores = struct
  type entry = { first: int; second: int }
  let bonus = 4
  let total (entry : entry) = entry.first + entry.second + bonus

  module Offsets = struct
    let make scale =
      fun value -> value * scale + bonus
  end
end

open Scores
open Scores.Offsets

let main =
  Scores.total { first = 10; second = 20 } + total { first = 5; second = 6 } + make 3 7
```

Top-level `open` declarations expose members of built-in or user-defined namespaces by short name. Built-in modules expose values; user modules expose immediate values, type names, and variant constructors:

```ocaml
open List
open String

let main =
  let words = split (concat "hello" " world") " " in
  List.length words
```

Local and top-level bindings still shadow opened value names, and ambiguous short names from multiple opened namespaces are rejected for values, types, and constructors. Use the qualified form, such as `String.length`, `List.length`, `Scores.total`, `Geometry.point`, or `Geometry.Named`, when two opened namespaces export the same member.

`print` appends text directly to the captured output stream; `println` appends a trailing newline. `to_string` formats primitives, tuples, records, arrays, lists, sets, maps, and functions. Unknown heap-backed values fall back to `Object <ptr>`, and function values format as `Function <ptr>`.

Tuple projection uses zero-based postfix indexes: `point.0`, `point.1`, and so on. The checker verifies the receiver is a tuple and rejects indexes outside the tuple arity before emission. `fst` and `snd` remain available as pair-specific helpers.

Record type declarations use `type person = { name: string; year: int }`. Algebraic data type declarations use forms such as `type status = Pending | Done of int | Failed of string`, and polymorphic declarations use type parameters such as `type 'a option = None | Some of 'a` or `type ('ok, 'err) result = Ok of 'ok | Error of 'err`. Annotated values such as `let ada : person = { name = "Ada"; year = 1815 }`, `let value : int option = Some 42`, and annotated function parameters such as `let describe (person : person) = person.name` are checked against the named type, then lower to the same runtime layouts as unannotated values. Type annotations support primitives, named record/variant types, tuples, inline records, and postfix forms such as `int list`, `person array`, `string set`, `int option`, and `(string, int) map`. Record field layout is sorted by label at compile time, so source field order does not affect access, matching, or formatting.

Pattern matching supports primitive literals, unit, wildcard/variable catch-alls, tuple structure, record structure, list structure with `[]` and `head :: tail`, fixed-length array structure with `[| ... |]`, set structure with `{| item; item |}`, map structure with `{| key: value; key: value |}`, and constructors such as `Done value`. Empty maps use `{| : |}` so they stay distinct from empty sets. Tuple, record, list, array, set, map, and constructor patterns may bind nested values and mix literals with binders. Array, set, and map patterns match exact stored lengths. List empty/cons coverage, complete constructor coverage, and catch-all patterns remain the conservative route for exhaustive matches.

## Prerequisites

- Node.js 20 or newer
- npm

## Setup

```bash
npm install
```

## Runbook

Start the browser playground:

```bash
npm run dev
```

Compile and run an example through the CLI:

```bash
npm run cli -- examples/factorial.oj --run
```

Compile an example to WebAssembly text without running it:

```bash
npm run cli -- examples/factorial.oj
```

Run the test suite:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run check
```

Build the browser bundle:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Project Structure

```text
src/
  ast.ts              Program, declaration, expression, and pattern types
  check.ts            Static checks, unification, stdlib schemes, hover metadata
  cli.ts              Node CLI entrypoint
  compiler.ts         WebAssembly text emission, stdlib helpers, closure lowering
  components/         OJaml editor UI
  lexer.ts            Tokenization, comments, literals, source spans
  monacoOJaml.ts      Monaco diagnostics, completions, hovers, signature help
  ojamlExamples.ts    Built-in editor examples and source programs
  parser.ts           Recursive-descent parser
  runtime.ts          WABT conversion, host imports, execution result
tests/                Node test suite
examples/             CLI-friendly source examples
```

## Package Exports

```ts
import {
  OJamlEditor,
  ojamlExamples,
  compile,
  emitWat,
  runOJaml,
  compileWatToWasm,
} from "ojaml";

import "ojaml/styles.css";
```

`compile(source)` parses, checks, and emits WebAssembly text. `runOJaml(source)` compiles, instantiates, runs `main`, and returns `{ value, mainType, wat, prints, output }`. `OJamlEditor` is the React/Monaco playground component used by the website.

## Runtime Model

The WebAssembly backend uses a uniform `i32` representation. Integers and booleans are immediate values; unit is zero; heap-backed values such as floats, strings, tuples, records, arrays, lists, sets, maps, and closures are represented as pointers. Tuple and record blocks store their element count followed by one `i32` slot per element or field; tuple projection and pair helpers lower to fixed slot loads after type checking, and record field labels are kept in the static type descriptor used by field access and `to_string`. Modules are erased before WebAssembly emission: values become qualified global function/value names, type declarations feed the checker and constructor table, and module namespaces are not runtime records. Closure values store a table index plus captured values; indirect calls generate the WebAssembly function type needed for each arity used by the program instead of imposing a fixed source-level argument ceiling. The same path handles direct calls, first-class function values, returned closures, and staged closures that accept more arguments later. Float arithmetic and power unbox operands to `f64`; `int ** int` returns an int, while any float operand makes `**` return a boxed float. Polymorphic top-level functions receive concrete int/float specializations when call sites require different runtime representations. The checker is responsible for rejecting invalid programs before emission.

Runtime collection helpers trap invalid access: negative array lengths, out-of-bounds array reads/writes, empty-list head/tail, and missing `Map.get` keys do not silently read arbitrary memory. Current runtime limits are still intentional: allocation is bump-pointer based, there is no garbage collector, and traps are not yet recoverable language-level exceptions.

## Troubleshooting

- If WABT-related execution fails, reinstall dependencies with `npm install`.
- If Monaco types or editor assets fail during local development, restart the Vite dev server.
- If a CLI command does not run, make sure arguments after the npm script are passed after `--`.
