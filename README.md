# OJaml

OJaml is an OCaml-inspired language implemented in TypeScript and compiled to WebAssembly for browser-native execution. The project owns the full language path: lexing, parsing, static checks, Hindley-Milner-style inference, typed standard-library schemes, closure lowering, WebAssembly text emission, WABT compilation, runtime execution, and Monaco editor tooling.

## What Is Included

- Lexer and recursive-descent parser for an OCaml-like syntax.
- Static checks for bindings, calls, branches, pattern matches, and standard-library usage.
- Polymorphic type inference for functions and collection builtins.
- First-class functions and closures with captured locals.
- WebAssembly text backend using a uniform `i32` value representation.
- Browser editor/playground with Monaco completions, diagnostics, and hover metadata.
- Node CLI for local compile/run workflows.
- Test suite covering parser, checker, runtime, stdlib, closures, and examples.

## Language Snapshot

```ocaml
let rec fact n =
  match n with
  | 0 -> 1
  | 1 -> 1
  | _ -> n * fact (n - 1)

let main =
  print "Hello, OJaml!";
  fact 6
```

Supported language features:

- `let` and `let rec` top-level bindings
- Local `let ... in ...`
- Anonymous functions and first-class function values
- Integers, booleans, strings, and unit
- Arithmetic, comparison, equality, boolean, and `mod` operators
- `if ... then ... else`
- OCaml-style `match ... with | pat -> expr`
- Wildcard, int, string, bool, unit, and variable patterns
- Polymorphic arrays, lists, maps, and higher-order collection functions
- `print : int -> unit` and `print : string -> unit`

## Standard Library Surface

- `Array.make`, `Array.length`, `Array.get`, `Array.set`
- `Array.map`, `Array.iter`, `Array.fold_left`
- `List.empty`, `List.cons`, `List.head`, `List.tail`, `List.is_empty`, `List.length`
- `List.map`, `List.iter`, `List.fold_left`
- `Map.empty`, `Map.set`, `Map.get`, `Map.has`

All standard-library functions have explicit type schemes so editor hovers, type errors, and autocomplete remain statically meaningful.

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
  cli.ts              Node CLI entrypoint
  components/         OJaml editor UI
  compiler/           Lexer, parser, checker, emitter, runtime helpers
  examples/           Built-in editor examples
  language/           Monaco language service integration
tests/                Node test suite
examples/             CLI-friendly source examples
```

## Runtime Model

The WebAssembly backend uses a uniform `i32` representation. Integers and booleans are immediate values; heap-backed values such as strings, arrays, lists, maps, and closures are represented as pointers. The checker is responsible for rejecting invalid programs before emission.

## Troubleshooting

- If WABT-related execution fails, reinstall dependencies with `npm install`.
- If Monaco types or editor assets fail during local development, restart the Vite dev server.
- If a CLI command does not run, make sure arguments after the npm script are passed after `--`.
