import type { Monaco } from "@monaco-editor/react";
import type { editor, languages, Position } from "monaco-editor";
import { check } from "./check";
import { OJamlError } from "./errors";
import { parse } from "./parser";

export const ojamlLanguageId = "ojaml";
export const markerOwner = "ojaml-language-service";

let providersRegistered = false;

const keywords = ["let", "rec", "in", "if", "then", "else", "true", "false", "fun", "match", "with", "mod"];
const stdlibCompletions = [
  ["Array.make", "Array.make : int -> 'a -> 'a array"],
  ["Array.length", "Array.length : 'a array -> int"],
  ["Array.get", "Array.get : 'a array -> int -> 'a"],
  ["Array.set", "Array.set : 'a array -> int -> 'a -> unit"],
  ["Array.map", "Array.map : ('a -> 'b) -> 'a array -> 'b array"],
  ["Array.iter", "Array.iter : ('a -> unit) -> 'a array -> unit"],
  ["Array.fold_left", "Array.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a array -> 'b"],
  ["List.empty", "List.empty : unit -> 'a list"],
  ["List.cons", "List.cons : 'a -> 'a list -> 'a list"],
  ["List.head", "List.head : 'a list -> 'a"],
  ["List.tail", "List.tail : 'a list -> 'a list"],
  ["List.is_empty", "List.is_empty : 'a list -> bool"],
  ["List.length", "List.length : 'a list -> int"],
  ["List.map", "List.map : ('a -> 'b) -> 'a list -> 'b list"],
  ["List.iter", "List.iter : ('a -> unit) -> 'a list -> unit"],
  ["List.fold_left", "List.fold_left : ('b -> 'a -> 'b) -> 'b -> 'a list -> 'b"],
  ["Map.empty", "Map.empty : unit -> ('k, 'v) map"],
  ["Map.set", "Map.set : ('k, 'v) map -> 'k -> 'v -> ('k, 'v) map"],
  ["Map.get", "Map.get : ('k, 'v) map -> 'k -> 'v"],
  ["Map.has", "Map.has : ('k, 'v) map -> 'k -> bool"],
] as const;

export function configureOJamlMonaco(monaco: Monaco): void {
  if (!monaco.languages.getLanguages().some((language: { id: string }) => language.id === ojamlLanguageId)) {
    monaco.languages.register({
      id: ojamlLanguageId,
      extensions: [".oj", ".ojaml"],
      aliases: ["OJaml", "ojaml"],
    });
  }

  monaco.languages.setLanguageConfiguration(ojamlLanguageId, {
    comments: {
      blockComment: ["(*", "*)"],
    },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "(*", close: "*)" },
    ],
    surroundingPairs: [{ open: "(", close: ")" }],
    indentationRules: {
      increaseIndentPattern: /^\s*(?:let\b.*=\s*|let\s+rec\b.*=\s*|if\b.*\bthen\s*|else\s*|match\b.*\bwith\s*|\|.*->\s*|.*->\s*)$/,
      decreaseIndentPattern: /^\s*\|/,
    },
    onEnterRules: [
      {
        beforeText: /^\s*(?:let\b.*=\s*|let\s+rec\b.*=\s*|if\b.*\bthen\s*|else\s*|match\b.*\bwith\s*|\|.*->\s*|.*->\s*)$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
      {
        beforeText: /^\s*\|/,
        action: { indentAction: monaco.languages.IndentAction.None, removeText: 2 },
      },
    ],
  });

  monaco.languages.setMonarchTokensProvider(ojamlLanguageId, {
    defaultToken: "",
    keywords,
    operators: ["+", "-", "*", "/", "=", "<>", "<", "<=", ">", ">=", "&&", "||", "->"],
    tokenizer: {
      root: [
        [/\(\*/, "comment", "@comment"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string"],
        [/[a-zA-Z_][a-zA-Z0-9_'.]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/\d+/, "number"],
        [/->|<>|<=|>=|&&|\|\||[+\-*/=<>]/, "operator"],
        [/[()]/, "delimiter"],
        [/\|/, "operator"],
      ],
      comment: [
        [/[^(*)]+/, "comment"],
        [/\(\*/, "comment", "@push"],
        [/\*\)/, "comment", "@pop"],
        [/[(*)]/, "comment"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\[ntr"\\]/, "string.escape"],
        [/\\./, "string.invalid"],
        [/"/, "string", "@pop"],
      ],
    },
  });

  monaco.editor.defineTheme("ojaml-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "777777" },
      { token: "keyword", foreground: "8ee0ad" },
      { token: "number", foreground: "f3d084" },
      { token: "operator", foreground: "d8d8d3" },
      { token: "identifier", foreground: "f4f4f2" },
    ],
    colors: {
      "editor.background": "#101010",
      "editor.foreground": "#f4f4f2",
      "editorLineNumber.foreground": "#5f5f5b",
      "editorLineNumber.activeForeground": "#f4f4f2",
      "editor.selectionBackground": "#20382d",
      "editor.inactiveSelectionBackground": "#1a2a22",
      "editorCursor.foreground": "#f7faf6",
      "editorIndentGuide.background1": "#242424",
      "editorIndentGuide.activeBackground1": "#315642",
    },
  });

  monaco.editor.defineTheme("ojaml-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "66726a" },
      { token: "keyword", foreground: "20382d", fontStyle: "bold" },
      { token: "number", foreground: "8c5a14" },
      { token: "operator", foreground: "1e2420" },
    ],
    colors: {
      "editor.background": "#fbfdfb",
      "editor.foreground": "#1e2420",
      "editorLineNumber.foreground": "#8a948c",
      "editorLineNumber.activeForeground": "#20382d",
      "editor.selectionBackground": "#cddbd2",
      "editor.inactiveSelectionBackground": "#dde7e0",
      "editorCursor.foreground": "#20382d",
    },
  });

  if (!providersRegistered) {
    registerOJamlProviders(monaco);
    providersRegistered = true;
  }
}

export function getOJamlSyntaxMarkers(source: string, severity: number) {
  try {
    check(parse(source));
    return [];
  } catch (error) {
    if (!(error instanceof OJamlError)) throw error;
    const position = offsetToPosition(source, error.start ?? 0);
    const endPosition = offsetToPosition(source, error.end ?? error.start ?? 0);
    return [{
      severity,
      message: error.message,
      startLineNumber: position.line,
      startColumn: position.column,
      endLineNumber: Math.max(position.line, endPosition.line),
      endColumn: Math.max(position.column + 1, endPosition.column),
    }];
  }
}

function registerOJamlProviders(monaco: Monaco): void {
  monaco.languages.registerCompletionItemProvider(ojamlLanguageId, {
    triggerCharacters: ["."],
    provideCompletionItems(model: editor.ITextModel, position: Position, context: languages.CompletionContext) {
      const word = model.getWordUntilPosition(position);
      const previousColumn = Math.max(1, position.column - 1);
      const previousChar = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: previousColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      if (word.word.length === 0 && previousChar !== "." && context.triggerKind !== monaco.languages.CompletionTriggerKind.Invoke) {
        return { suggestions: [] };
      }
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const source = model.getValue();
      const symbols = collectSymbols(source);
      const suggestions: languages.CompletionItem[] = [
        ...keywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
        })),
        {
          label: "print",
          kind: monaco.languages.CompletionItemKind.Function,
          detail: "print : int|string -> unit",
          insertText: "print ${1:value}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: "Prints an integer or string and returns unit.",
          range,
        },
        ...stdlibCompletions.map(([label, detail]) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Function,
          detail,
          insertText: label,
          range,
        })),
        {
          label: "let main",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "Program entry point",
          insertText: "let main =\n  ${1:()}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        },
        {
          label: "match",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "Pattern match",
          insertText: "match ${1:value} with\n| ${2:0} -> ${3:()}\n| _ -> ${4:()}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        },
        {
          label: "if then else",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "Conditional expression",
          insertText: "if ${1:condition} then ${2:value} else ${3:other}",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        },
        ...symbols.map((symbol) => ({
          label: symbol.name,
          kind: symbol.kind === "function" ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Variable,
          detail: symbol.detail,
          insertText: symbol.name,
          range,
        })),
      ];
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider(ojamlLanguageId, {
    provideHover(model: editor.ITextModel, position: Position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const source = model.getValue();
      const symbol = findSymbolAt(source, model.getOffsetAt(position), word.word);
      if (!symbol) return null;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [
          { value: "```ocaml\n" + symbol.detail + "\n```" },
          ...(symbol.documentation ? [{ value: symbol.documentation }] : []),
        ],
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(ojamlLanguageId, {
    signatureHelpTriggerCharacters: [" ", "("],
    provideSignatureHelp(model: editor.ITextModel, position: Position) {
      const prefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - 24),
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      if (!/\bprint\s+[^ \n\t(]*$/.test(prefix) && !/\bprint\s+\($/.test(prefix)) return null;
      return {
        value: {
          activeParameter: 0,
          activeSignature: 0,
          signatures: [{
            label: "print value",
            documentation: "Prints an int or string and returns unit.",
            parameters: [{ label: "value: int | string" }],
          }],
        },
        dispose() {},
      };
    },
  });
}

type SymbolInfo = {
  name: string;
  kind: "function" | "value" | "builtin" | "keyword";
  detail: string;
  documentation?: string;
  span?: { start: number; end: number };
};

function collectSymbols(source: string): SymbolInfo[] {
  try {
    const checked = check(parse(source));
    return checked.symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      detail: symbol.detail,
      documentation: symbol.kind === "builtin" ? "OJaml standard library builtin." : undefined,
      span: symbol.span,
    }));
  } catch {
    return fallbackBuiltins();
  }
}

function findSymbolAt(source: string, offset: number, word: string): SymbolInfo | undefined {
  if (keywords.includes(word)) return { name: word, kind: "keyword", detail: `${word} keyword` };
  try {
    const checked = check(parse(source));
    for (const symbol of checked.symbols) {
      const local = symbol.locals?.find((item) => item.name === word && offset >= item.span.start && offset <= item.span.end);
      if (local) return { name: local.name, kind: "value", detail: local.detail, span: local.span };
      const param = symbol.params?.find((item) => item.name === word && (!symbol.span || (offset >= symbol.span.start && offset <= symbol.span.end)));
      if (param) return { name: param.name, kind: "value", detail: param.detail, span: param.span };
    }
    const global = checked.symbols.find((symbol) => symbol.name === word);
    if (global) {
      return {
        name: global.name,
        kind: global.kind,
        detail: global.detail,
        documentation: global.kind === "builtin" ? "OJaml standard library builtin." : undefined,
        span: global.span,
      };
    }
  } catch {
    return collectSymbols(source).find((symbol) => symbol.name === word);
  }
}

function fallbackBuiltins(): SymbolInfo[] {
  return [{
    name: "print",
    kind: "builtin",
    detail: "print : 'a -> unit",
    documentation: "Prints integers and strings.",
  }, ...stdlibCompletions.map(([name, detail]) => ({
    name,
    kind: "builtin" as const,
    detail,
    documentation: "OJaml standard library builtin.",
  }))];
}

function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  const parts = prefix.split("\n");
  return { line: parts.length, column: parts[parts.length - 1].length + 1 };
}
