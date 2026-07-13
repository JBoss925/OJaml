# OJaml Language Coverage

This matrix tracks features currently implemented by the parser, checker, WASM backend, tests, and examples.

| Feature | Tests | Example |
| --- | --- | --- |
| Comments and `;;` separators | yes | Language Tour |
| Top-level `let` and `let rec` | yes | Factorial, Fibonacci |
| Local `let ... in ...` | yes | Basics, Language Tour |
| Local function bindings and local `let rec` functions | yes | Local Recursion |
| Integers, floats, booleans, strings, unit | yes | Hello, Language Tour |
| Tuple expressions | yes | Tuples |
| Structural record expressions and field access | yes | Records |
| Record and algebraic data type declarations, including type parameters, plus value, function, and higher-order function annotations | yes | Records, Algebraic Data Types, Module Signatures |
| Top-level and nested modules, abstract/concrete type signatures, value signatures, module-local type declarations, opened types/constructors, and `open` declarations for built-in and user-defined namespaces | yes | Open Modules, User Modules, Module Types, Module Signatures |
| Tuple projection with `.0`, `.1`, ... plus pair helpers `fst`/`snd` | yes | Tuples |
| String escapes | yes | test suite |
| Integer and float arithmetic, power, comparison, short-circuit boolean, unary operators | yes | Language Tour, Boolean Logic |
| Sequencing with `expr; expr` and unit-checking for the left side | yes | Sequencing |
| Forward pipeline operator <code>&#124;&gt;</code> | yes | Pipeline |
| Polymorphic functions and int/float specialization | yes | Type Inference |
| Function application | yes | all nontrivial examples |
| First-class functions, including high-arity function values and staged closures | yes | Higher Order, High-Arity Functions |
| Closures with captured locals | yes | Higher Order |
| Top-level functions passed as values | yes | test suite |
| `if ... then ... else ...` | yes | Basics |
| `match ... with` | yes | Factorial, Language Tour |
| Int/float/string/bool/unit/tuple/record/list/array/set/map/constructor/wildcard/variable patterns | yes | Pattern Matching, Records, Arrays, Sets, Collections, Algebraic Data Types |
| `print : int|float|string -> unit` | yes | test suite |
| `println : int|float|string -> unit` | yes | examples |
| `to_string : 'a -> string` | yes | examples |
| Recursive `to_string` formatting for tuples/records/arrays/lists/sets/maps/functions | yes | test suite |
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
| Polymorphic algebraic data type parameters | yes | Algebraic Data Types |
| Runtime access checks for arrays/lists/maps | yes | test suite |
| Monaco parser/type diagnostics | yes | editor |
| Negative type diagnostics across primitives and stdlib calls | yes | test suite |
| Exact editor-example output transcripts | yes | all examples |

Not yet implemented: file imports, functors, exceptions, garbage collection, and recoverable language-level runtime exceptions.
