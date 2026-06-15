import wabtFactory from "wabt";
import { compile } from "./compiler";
import type { OJamlType } from "./check";

export type RunResult = {
  value: number;
  mainType: Exclude<OJamlType, "fn">;
  wat: string;
  prints: Array<number | string>;
};

export type RunOptions = {
  onPrint?: (value: number | string) => void;
};

export async function compileWatToWasm(wat: string): Promise<Uint8Array> {
  const wabt = await wabtFactory();
  const parsed = wabt.parseWat("ojaml.wat", wat);
  parsed.resolveNames();
  parsed.validate();
  const { buffer } = parsed.toBinary({ log: false, write_debug_names: true });
  parsed.destroy();
  return buffer;
}

export async function runOJaml(source: string, options: RunOptions = {}): Promise<RunResult> {
  const { wat, mainType } = compile(source);
  const wasm = await compileWatToWasm(wat);
  const prints: Array<number | string> = [];
  let memory: WebAssembly.Memory | undefined;
  const instantiated: any = await WebAssembly.instantiate(wasm, {
    env: {
      print_i32(value: number) {
        prints.push(value);
        options.onPrint?.(value);
      },
      print_string(pointer: number) {
        if (!memory) throw new Error("WASM memory was not initialized");
        const value = readNullTerminatedString(memory, pointer);
        prints.push(value);
        options.onPrint?.(value);
      },
    },
  });
  const exports = instantiated instanceof WebAssembly.Instance ? instantiated.exports : instantiated.instance.exports;
  memory = exports.memory as WebAssembly.Memory | undefined;
  const main = exports.main;
  if (typeof main !== "function") throw new Error("Compiled module did not export main");
  return { value: main() as number, mainType, wat, prints };
}

function readNullTerminatedString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}
