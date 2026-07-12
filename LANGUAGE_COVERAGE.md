# OJaml Language Coverage

This matrix tracks features currently implemented by the parser, checker, WASM backend, tests, and examples.

| Feature | Tests | Example |
| --- | --- | --- |
| Comments and `;;` separators | yes | Language Tour |
| Top-level `let` and `let rec` | yes | Factorial, Fibonacci |
| Local `let ... in ...` | yes | Basics, Language Tour |
| Integers, floats, booleans, strings, unit | yes | Hello, Language Tour |
| String escapes | yes | test suite |
| Integer and float arithmetic, power, comparison, boolean, unary operators | yes | Language Tour |
| Polymorphic functions and int/float specialization | yes | Type Inference |
| Function application | yes | all nontrivial examples |
| First-class functions | yes | Higher Order |
| Closures with captured locals | yes | Higher Order |
| Top-level functions passed as values | yes | test suite |
| `if ... then ... else ...` | yes | Basics |
| `match ... with` | yes | Factorial, Language Tour |
| Int/float/string/bool/unit/wildcard/variable patterns | yes | Language Tour |
| `print : int|float|string -> unit` | yes | test suite |
| `println : int|float|string -> unit` | yes | examples |
| `to_string : 'a -> string` | yes | examples |
| Recursive `to_string` formatting for arrays/lists/sets/maps/functions | yes | test suite |
| `Float.of_int` and `Float.to_int` | yes | test suite |
| `String.concat/length/split` | yes | test suite |
| Polymorphic arrays | yes | Collections, Language Tour |
| `Array.make/get/set/length/map/iter/fold_left` | yes | Language Tour |
| Polymorphic lists | yes | Collections, Higher Order |
| `List.empty/cons/head/tail/is_empty/length/map/iter/fold_left` | yes | Higher Order |
| Polymorphic sets | yes | Sets |
| `Set.empty/add/has/length` | yes | Sets |
| Polymorphic maps | yes | Collections, Language Tour |
| `Map.empty/set/get/has` | yes | Collections |
| Monaco parser/type diagnostics | yes | editor |
| Negative type diagnostics across primitives and stdlib calls | yes | test suite |
| Exact editor-example output transcripts | yes | all examples |

Not yet implemented: algebraic data type declarations, records, tuples, modules/import syntax, exceptions, pattern matching over list/array/set/map structure, garbage collection, and general runtime bounds checks.
