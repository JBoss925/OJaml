import Editor, { type Monaco } from "@monaco-editor/react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { compile } from "../compiler";
import { formatOJamlError } from "../errors";
import { compileWatToWasm, runOJaml } from "../runtime";
import { defaultExampleId, getExample, ojamlExamples, type OJamlExample } from "../ojamlExamples";
import { configureOJamlMonaco, getOJamlSyntaxMarkers, markerOwner, ojamlLanguageId } from "../monacoOJaml";

export type OJamlEditorProps = {
  initialSource?: string;
  initialExampleId?: string;
  examples?: OJamlExample[];
  className?: string;
};

type TerminalTab = "result" | "wasm";
type Theme = "dark" | "light";

export function OJamlEditor({
  initialSource,
  initialExampleId = defaultExampleId,
  examples = ojamlExamples,
  className,
}: OJamlEditorProps) {
  const initialExample = useMemo(() => getExample(initialExampleId), [initialExampleId]);
  const [source, setSource] = useState(initialSource ?? initialExample.source);
  const [selectedExampleId, setSelectedExampleId] = useState(initialExample.id);
  const [activeTab, setActiveTab] = useState<TerminalTab>("result");
  const [result, setResult] = useState(`Loaded ${initialExample.title}.`);
  const [wat, setWat] = useState("");
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const deferredWat = useDeferredValue(wat);
  const deferredResult = useDeferredValue(result);
  const editorMonacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("ojaml-theme", theme);
    editorMonacoRef.current?.editor.setTheme(theme === "dark" ? "ojaml-dark" : "ojaml-light");
  }, [theme]);

  useEffect(() => {
    if (!editorMonacoRef.current || !modelRef.current) return;
    const handle = window.setTimeout(() => {
      const monaco = editorMonacoRef.current;
      const model = modelRef.current;
      if (!monaco || !model) return;
      const markers = getOJamlSyntaxMarkers(source, monaco.MarkerSeverity.Error);
      monaco.editor.setModelMarkers(model, markerOwner, markers);
    }, 120);
    return () => window.clearTimeout(handle);
  }, [source]);

  function setTheme(nextTheme: Theme): void {
    setThemeState(nextTheme);
  }

  function handleEditorMount(instance: editor.IStandaloneCodeEditor, monaco: Monaco): void {
    editorRef.current = instance;
    editorMonacoRef.current = monaco;
    modelRef.current = instance.getModel();
    modelRef.current?.updateOptions({ tabSize: 2, insertSpaces: true });
    instance.addCommand(monaco.KeyCode.Tab, () => {
      instance.trigger("ojaml-tab", "type", { text: "  " });
    });
    monaco.editor.setTheme(theme === "dark" ? "ojaml-dark" : "ojaml-light");
    if (modelRef.current) {
      monaco.editor.setModelMarkers(modelRef.current, markerOwner, getOJamlSyntaxMarkers(source, monaco.MarkerSeverity.Error));
    }
  }

  function handleLoadExample(exampleId: string): void {
    const example = examples.find((item) => item.id === exampleId) ?? examples[0];
    setSelectedExampleId(example.id);
    setSource(example.source);
    setResult(`Loaded ${example.title}.`);
    setWat("");
    setActiveTab("result");
  }

  function handleCompile(): void {
    try {
      const output = compile(source);
      setWat(output.wat);
      setResult("Compiled successfully.");
      setActiveTab("wasm");
    } catch (error) {
      setResult(formatOJamlError(source, error));
      setActiveTab("result");
    }
  }

  async function handleRun(): Promise<void> {
    try {
      const output = compile(source);
      const wasm = await compileWatToWasm(output.wat);
      const run = await runOJaml(source);
      setWat(output.wat);
      setResult([
        `main = ${run.mainType === "unit" ? "()" : run.value}`,
        `wasm bytes = ${wasm.byteLength}`,
        run.output ? `output:\n${run.output}` : "",
      ].filter(Boolean).join("\n"));
      setActiveTab("result");
    } catch (error) {
      setResult(formatOJamlError(source, error));
      setActiveTab("result");
    }
  }

  return (
    <main className={className ? `ojaml-shell ${className}` : "ojaml-shell"}>
      <section className="ojaml-workspace">
        <header className="ojaml-header">
          <div className="ojaml-brand">
            <span className="ojaml-brand-mark" aria-hidden="true">OJ</span>
            <h1><span>O</span>Jaml</h1>
          </div>
          <div className="ojaml-controls">
            <label className="ojaml-select-label" htmlFor="example-select">Example</label>
            <select id="example-select" value={selectedExampleId} onChange={(event) => handleLoadExample(event.target.value)}>
              {examples.map((example) => (
                <option key={example.id} value={example.id}>{example.title}</option>
              ))}
            </select>
            <button type="button" className="ojaml-button ojaml-button--ghost" onClick={() => handleLoadExample(selectedExampleId)}>Reset</button>
            <button type="button" className="ojaml-button ojaml-button--ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button type="button" className="ojaml-button" onClick={handleCompile}>Compile</button>
            <button type="button" className="ojaml-button ojaml-button--primary" onClick={handleRun}>Run</button>
          </div>
        </header>

        <div className="ojaml-editor-frame">
          <Editor
            beforeMount={configureOJamlMonaco}
            onMount={handleEditorMount}
            language={ojamlLanguageId}
            theme={theme === "dark" ? "ojaml-dark" : "ojaml-light"}
            value={source}
            onChange={(value) => setSource(value ?? "")}
            options={{
              automaticLayout: true,
              fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
              fontSize: 14,
              lineHeight: 21,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbersMinChars: 3,
              wordWrap: "on",
              renderLineHighlight: "line",
              overviewRulerBorder: false,
              padding: { top: 10, bottom: 10 },
              tabSize: 2,
              insertSpaces: true,
              detectIndentation: false,
              autoIndent: "full",
              formatOnType: true,
              tabCompletion: "off",
              acceptSuggestionOnCommitCharacter: false,
              acceptSuggestionOnEnter: "smart",
              }}
          />
        </div>

        <section className="ojaml-terminal">
          <div className="ojaml-terminal__tabs" role="tablist" aria-label="Compilation details">
            <button type="button" className={activeTab === "result" ? "is-active" : ""} onClick={() => setActiveTab("result")}>Result</button>
            <button type="button" className={activeTab === "wasm" ? "is-active" : ""} onClick={() => setActiveTab("wasm")}>WebAssembly</button>
          </div>
          <pre className="ojaml-terminal__output">{activeTab === "result" ? deferredResult : deferredWat || "Compile or run to inspect WebAssembly text."}</pre>
        </section>
      </section>
    </main>
  );
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem("ojaml-theme") === "light" ? "light" : "dark";
}
