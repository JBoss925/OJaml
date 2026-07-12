# OJaml

OJaml is an OCaml-inspired language implemented in TypeScript and compiled to WebAssembly for browser-native execution. The project owns the full language path: lexing, parsing, static checks, Hindley-Milner-style inference, typed standard-library schemes, closure lowering, WebAssembly text emission, WABT compilation, runtime execution, and Monaco editor tooling.

## What Is Included

- Lexer and recursive-descent parser for an OCaml-like syntax.
- Static checks for bindings, calls, branches, pattern matches, and standard-library usage.
- Polymorphic type inference for functions and collection builtins.
- First-class functions and closures with captured locals.
- WebAssembly text backend using a uniform `i32` value representation plus concrete int/float specializations for polymorphic functions.
- Browser editor/playground with Monaco completions, diagnostics, and hover metadata.
- Node CLI for local compile/run workflows.
- Reusable package exports for the editor component, examples, compiler, and runtime helpers.
- Test suite covering parser, checker, runtime, stdlib, closures, sets, power, runtime access checks, exact editor-example transcripts, and compiler specialization regressions.

## Language Snapshot

```ocaml
let rec fact n =
  match n with
  | 0 -> 1
  | 1 -> 1
  | _ -> n * fact (n - 1)

let main =
  let _ = println "Hello, OJaml!" in
  fact 6
```

Supported language features:

- `let` and `let rec` top-level bindings
- Local `let ... in ...`
- Anonymous functions and first-class function values
- Integers, floats, booleans, strings, and unit
- Integer and float arithmetic, right-associative power `**`, comparison, equality, boolean, and integer `mod` operators
- Polymorphic functions, including constrained numeric variables displayed as `number -> number` and emitted with concrete int/float call-site specializations
- `if ... then ... else`
- OCaml-style `match ... with | pat -> expr`
- Wildcard, int, float, string, bool, unit, and variable patterns
- Polymorphic arrays, lists, sets, maps, and higher-order collection functions
- `print : int|float|string -> unit`
- `println : int|float|string -> unit`
- `to_string : 'a -> string`, including recursive formatting for arrays, lists, sets, maps, and functions
- `main` must be a zero-argument value and may return `int`, `float`, `bool`, or `unit` directly. Strings and heap values should be printed, converted with `to_string`, or reduced to a direct result type.

## Standard Library Surface

```text
print : int|float|string -> unit
println : int|float|string -> unit
to_string : 'a -> string

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

`print` appends text directly to the captured output stream; `println` appends a trailing newline. `to_string` formats primitives, arrays, lists, sets, maps, and functions. Unknown heap-backed values fall back to `Object <ptr>`, and function values format as `Function <ptr>`.

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

The WebAssembly backend uses a uniform `i32` representation. Integers and booleans are immediate values; unit is zero; heap-backed values such as floats, strings, arrays, lists, sets, maps, and closures are represented as pointers. Float arithmetic and power unbox operands to `f64`; `int ** int` returns an int, while any float operand makes `**` return a boxed float. Polymorphic top-level functions receive concrete int/float specializations when call sites require different runtime representations. The checker is responsible for rejecting invalid programs before emission.

Runtime collection helpers trap invalid access: negative array lengths, out-of-bounds array reads/writes, empty-list head/tail, and missing `Map.get` keys do not silently read arbitrary memory. Current runtime limits are still intentional: allocation is bump-pointer based, there is no garbage collector, and traps are not yet recoverable language-level exceptions.

## Troubleshooting

- If WABT-related execution fails, reinstall dependencies with `npm install`.
- If Monaco types or editor assets fail during local development, restart the Vite dev server.
- If a CLI command does not run, make sure arguments after the npm script are passed after `--`.
