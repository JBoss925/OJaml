# OJaml Language Coverage

This matrix tracks features currently implemented by the parser, checker, WASM backend, tests, and examples.

| Feature | Tests | Example |
| --- | --- | --- |
| Comments and `;;` separators | yes | Language Tour |
| Top-level `let` and `let rec` | yes | Factorial, Fibonacci |
| Local `let ... in ...` | yes | Basics, Language Tour |
| Integers, booleans, strings, unit | yes | Hello, Language Tour |
| String escapes | yes | test suite |
| Arithmetic, comparison, boolean, unary operators | yes | Language Tour |
| Function application | yes | all nontrivial examples |
| First-class functions | yes | Higher Order |
| Closures with captured locals | yes | Higher Order |
| Top-level functions passed as values | yes | test suite |
| `if ... then ... else ...` | yes | Basics |
| `match ... with` | yes | Factorial, Language Tour |
| Int/string/bool/unit/wildcard/variable patterns | yes | Language Tour |
| `print : int|string -> unit` | yes | Hello, FizzBuzz |
| Polymorphic arrays | yes | Collections, Language Tour |
| `Array.make/get/set/length/map/iter/fold_left` | yes | Language Tour |
| Polymorphic lists | yes | Collections, Higher Order |
| `List.empty/cons/head/tail/is_empty/length/map/iter/fold_left` | yes | Higher Order |
| Polymorphic maps | yes | Collections, Language Tour |
| `Map.empty/set/get/has` | yes | Collections |
| Monaco parser/type diagnostics | yes | editor |
| Negative type diagnostics | yes | test suite |

Not yet implemented: algebraic data type declarations, records, tuples, modules/import syntax, exceptions, pattern matching over list/array/map structure, garbage collection, and general runtime bounds checks.
