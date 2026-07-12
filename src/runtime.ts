import wabtFactory from "wabt";
import { compile } from "./compiler";
import type { OJamlType } from "./check";

export type RunResult = {
  value: number;
  mainType: Exclude<OJamlType, "fn">;
  wat: string;
  prints: Array<number | string>;
  output: string;
};

export type RunOptions = {
  onPrint?: (value: string) => void;
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
  let output = "";
  let memory: WebAssembly.Memory | undefined;
  let hostHeap = 32768;
  const readString = (pointer: number) => {
    if (!memory) throw new Error("WASM memory was not initialized");
    return readNullTerminatedString(memory, pointer);
  };
  const allocHostBytes = (bytes: Uint8Array): number => {
    if (!memory) throw new Error("WASM memory was not initialized");
    const pointer = hostHeap;
    const view = new Uint8Array(memory.buffer);
    view.set(bytes, pointer);
    view[pointer + bytes.length] = 0;
    hostHeap += bytes.length + 1;
    return pointer;
  };
  const allocHostString = (value: string): number => allocHostBytes(new TextEncoder().encode(value));
  const allocHostList = (items: number[]): number => {
    if (!memory) throw new Error("WASM memory was not initialized");
    const view = new DataView(memory.buffer);
    let list = 0;
    for (let index = items.length - 1; index >= 0; index--) {
      const pointer = hostHeap;
      hostHeap += 8;
      view.setInt32(pointer, items[index], true);
      view.setInt32(pointer + 4, list, true);
      list = pointer;
    }
    return list;
  };
  const appendOutput = (value: number | string): void => {
    const text = String(value);
    prints.push(value);
    output += text;
    options.onPrint?.(text);
  };
  const instantiated: any = await WebAssembly.instantiate(wasm, {
    env: {
      print_i32(value: number) {
        appendOutput(value);
      },
      print_f64(value: number) {
        appendOutput(value);
      },
      print_string(pointer: number) {
        appendOutput(readString(pointer));
      },
      string_concat(left: number, right: number) {
        return allocHostString(readString(left) + readString(right));
      },
      string_length(pointer: number) {
        return readString(pointer).length;
      },
      string_split(value: number, separator: number) {
        const parts = readString(value).split(readString(separator));
        return allocHostList(parts.map(allocHostString));
      },
      to_string(value: number, descriptor: number) {
        return allocHostString(formatValue(memoryOrThrow(memory), value, readString(descriptor)));
      },
    },
  });
  const exports = instantiated instanceof WebAssembly.Instance ? instantiated.exports : instantiated.instance.exports;
  memory = exports.memory as WebAssembly.Memory | undefined;
  const main = exports.main;
  if (typeof main !== "function") throw new Error("Compiled module did not export main");
  const rawValue = main() as number;
  const value = mainType === "float" && memory ? readFloat(memory, rawValue) : rawValue;
  return { value, mainType, wat, prints, output };
}

function memoryOrThrow(memory: WebAssembly.Memory | undefined): WebAssembly.Memory {
  if (!memory) throw new Error("WASM memory was not initialized");
  return memory;
}

function readNullTerminatedString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

function readFloat(memory: WebAssembly.Memory, pointer: number): number {
  return new DataView(memory.buffer).getFloat64(pointer, true);
}

function formatValue(memory: WebAssembly.Memory, value: number, descriptor: string): string {
  if (descriptor === "int") return String(value);
  if (descriptor === "float") return String(readFloat(memory, value));
  if (descriptor === "bool") return value === 0 ? "false" : "true";
  if (descriptor === "string") return readNullTerminatedString(memory, value);
  if (descriptor === "unit") return "()";
  if (descriptor === "fn") return `Function ${value}`;
  if (descriptor === "unknown") return `Object ${value}`;
  if (descriptor.startsWith("array(") && descriptor.endsWith(")")) {
    const elementDescriptor = descriptor.slice("array(".length, -1);
    const view = new DataView(memory.buffer);
    const length = view.getInt32(value, true);
    const items: string[] = [];
    for (let index = 0; index < length; index++) {
      const item = view.getInt32(value + 4 + index * 4, true);
      items.push(formatValue(memory, item, elementDescriptor));
    }
    return `[${items.join(", ")}]`;
  }
  if (descriptor.startsWith("list(") && descriptor.endsWith(")")) {
    const elementDescriptor = descriptor.slice("list(".length, -1);
    const view = new DataView(memory.buffer);
    const items: string[] = [];
    let cursor = value;
    while (cursor !== 0) {
      items.push(formatValue(memory, view.getInt32(cursor, true), elementDescriptor));
      cursor = view.getInt32(cursor + 4, true);
    }
    return `[${items.join(", ")}]`;
  }
  if (descriptor.startsWith("map(") && descriptor.endsWith(")")) {
    const [keyDescriptor, valueDescriptor] = splitMapDescriptor(descriptor.slice("map(".length, -1));
    const view = new DataView(memory.buffer);
    const items: string[] = [];
    let cursor = value;
    while (cursor !== 0) {
      const key = view.getInt32(cursor, true);
      const item = view.getInt32(cursor + 4, true);
      items.push(`${formatValue(memory, key, keyDescriptor)}: ${formatValue(memory, item, valueDescriptor)}`);
      cursor = view.getInt32(cursor + 8, true);
    }
    return `{ ${items.join(", ")} }`;
  }
  return `Object ${value}`;
}

function splitMapDescriptor(value: string): [string, string] {
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return [value.slice(0, index), value.slice(index + 1)];
  }
  return [value, "unknown"];
}
