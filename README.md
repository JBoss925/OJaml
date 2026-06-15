# OJaml

OJaml is an OCaml-inspired language that compiles directly to WebAssembly and can run in the browser without a server-side compiler.

This repository contains:

- A lexer and recursive-descent parser for an OCaml-like syntax.
- Semantic checks for bindings, calls, branches, and pattern matches.
- A WebAssembly text backend.
- A browser playground that compiles OJaml source to WASM and instantiates it locally.
- A Node CLI for local compilation and execution.

## Current Language Core

```ocaml
let rec fact n =
  match n with
  | 0 -> 1
  | 1 -> 1
  | _ -> n * fact (n - 1)

let main = fact 6
```

Supported in the current core:

- `let` and `let rec` top-level bindings
- Curried-looking function declarations, compiled as direct WASM functions
- Local `let ... in ...`
- `if ... then ... else ...`
- Integers, booleans, and strings
- Unit value `()`
- Built-in `print : int -> unit` and `print : string -> unit`
- Polymorphic collection builtins:
  - `Array.make`, `Array.length`, `Array.get`, `Array.set`
  - `Array.map`, `Array.iter`, `Array.fold_left`
  - `List.empty`, `List.cons`, `List.head`, `List.tail`, `List.is_empty`, `List.length`
  - `List.map`, `List.iter`, `List.fold_left`
  - `Map.empty`, `Map.set`, `Map.get`, `Map.has`
- First-class functions and closures, including captured locals and top-level functions passed as values
- Arithmetic and comparison operators
- Function application
- OCaml-style `match ... with | pat -> expr`
- Wildcard, integer, string, boolean, unit, and variable patterns

The WASM backend uses a uniform `i32` value representation: integers and booleans are immediate values; strings, arrays, lists, maps, and closures are heap pointers. Algebraic data types, modules, records, exceptions, and garbage collection are still future work.

See `LANGUAGE_COVERAGE.md` for the current feature/test coverage matrix.

## Run

```bash
npm install
npm test
npm run cli examples/factorial.oj --run
npm run dev
```

Open the Vite URL to use the browser playground.
