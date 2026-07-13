export type SourceSpan = {
  start: number;
  end: number;
};

export type Program = {
  declarations: TopLevelDeclaration[];
};

export type TopLevelDeclaration = Declaration | TypeDeclaration | OpenDeclaration | ModuleDeclaration;

export type OpenDeclaration = {
  kind: "Open";
  module: string;
  moduleSpan: SourceSpan;
  span: SourceSpan;
};

export type TypeDeclaration = {
  kind: "Type";
  name: string;
  nameSpan: SourceSpan;
  params: Array<{ name: string; span: SourceSpan }>;
  body:
    | { kind: "Record"; fields: Array<{ name: string; nameSpan: SourceSpan; type: TypeExpr }> }
    | { kind: "Variant"; constructors: Array<{ name: string; nameSpan: SourceSpan; payload?: TypeExpr }> };
  span: SourceSpan;
};

export type ModuleDeclaration = {
  kind: "Module";
  name: string;
  nameSpan: SourceSpan;
  declarations: Array<Declaration | TypeDeclaration | ModuleDeclaration>;
  span: SourceSpan;
};

export type TypeExpr =
  | { kind: "TName"; name: string; span: SourceSpan }
  | { kind: "TVar"; name: string; span: SourceSpan }
  | { kind: "TTuple"; items: TypeExpr[]; span: SourceSpan }
  | { kind: "TApp"; name: string; args: TypeExpr[]; span: SourceSpan }
  | { kind: "TRecord"; fields: Array<{ name: string; nameSpan: SourceSpan; type: TypeExpr }>; span: SourceSpan };

export type Declaration = {
  kind: "Let";
  recursive: boolean;
  name: string;
  nameSpan: SourceSpan;
  params: string[];
  paramSpans: SourceSpan[];
  paramAnnotations: Array<TypeExpr | undefined>;
  annotation?: TypeExpr;
  value: Expr;
  span: SourceSpan;
};

export type Expr =
  | { kind: "Int"; value: number; span: SourceSpan }
  | { kind: "Float"; value: number; span: SourceSpan }
  | { kind: "String"; value: string; span: SourceSpan }
  | { kind: "Bool"; value: boolean; span: SourceSpan }
  | { kind: "Unit"; span: SourceSpan }
  | { kind: "Tuple"; items: Expr[]; span: SourceSpan }
  | { kind: "TupleAccess"; tuple: Expr; index: number; indexSpan: SourceSpan; span: SourceSpan }
  | { kind: "Record"; fields: Array<{ name: string; nameSpan: SourceSpan; value: Expr }>; span: SourceSpan }
  | { kind: "FieldAccess"; record: Expr; field: string; fieldSpan: SourceSpan; span: SourceSpan }
  | { kind: "Var"; name: string; span: SourceSpan }
  | { kind: "Unary"; op: "-" | "not"; expr: Expr; span: SourceSpan }
  | { kind: "Binary"; op: BinaryOp; left: Expr; right: Expr; span: SourceSpan }
  | { kind: "Sequence"; first: Expr; second: Expr; span: SourceSpan }
  | { kind: "If"; condition: Expr; thenBranch: Expr; elseBranch: Expr; span: SourceSpan }
  | { kind: "LetIn"; recursive: boolean; name: string; nameSpan: SourceSpan; annotation?: TypeExpr; value: Expr; body: Expr; span: SourceSpan }
  | { kind: "Call"; callee: Expr; args: Expr[]; span: SourceSpan }
  | { kind: "Fun"; params: string[]; paramSpans: SourceSpan[]; paramAnnotations: Array<TypeExpr | undefined>; body: Expr; span: SourceSpan }
  | { kind: "Match"; expr: Expr; arms: MatchArm[]; span: SourceSpan };

export type BinaryOp = "+" | "-" | "*" | "/" | "**" | "mod" | "=" | "<>" | "<" | "<=" | ">" | ">=" | "&&" | "||" | "|>";

export type MatchArm = {
  pattern: Pattern;
  body: Expr;
  span: SourceSpan;
};

export type Pattern =
  | { kind: "PInt"; value: number; span: SourceSpan }
  | { kind: "PFloat"; value: number; span: SourceSpan }
  | { kind: "PString"; value: string; span: SourceSpan }
  | { kind: "PBool"; value: boolean; span: SourceSpan }
  | { kind: "PUnit"; span: SourceSpan }
  | { kind: "PTuple"; items: Pattern[]; span: SourceSpan }
  | { kind: "PRecord"; fields: Array<{ name: string; nameSpan: SourceSpan; pattern: Pattern }>; span: SourceSpan }
  | { kind: "PArray"; items: Pattern[]; span: SourceSpan }
  | { kind: "PSet"; items: Pattern[]; span: SourceSpan }
  | { kind: "PMap"; entries: Array<{ key: Pattern; value: Pattern }>; span: SourceSpan }
  | { kind: "PConstructor"; name: string; nameSpan: SourceSpan; payload?: Pattern; span: SourceSpan }
  | { kind: "PListNil"; span: SourceSpan }
  | { kind: "PListCons"; head: Pattern; tail: Pattern; span: SourceSpan }
  | { kind: "PWildcard"; span: SourceSpan }
  | { kind: "PVar"; name: string; span: SourceSpan };
