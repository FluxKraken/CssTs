/// <reference types="node" />
import { promises as fs } from "node:fs";
import path from "node:path";

type Mode = "deno" | "npm";
type DenoGlobal = {
  args: string[];
  cwd: () => string;
  exit: (code: number) => never;
};

const DENO_ALIAS_TARGET = "@jsr/kt-tools__css-ts";
const DENO_IMPORT_TARGET = "npm:@jsr/kt-tools__css-ts@^0.1.3";

const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
const isDeno = typeof deno !== "undefined";
const args: string[] = isDeno ? deno.args : process.argv.slice(2);
const cwd: string = isDeno ? deno.cwd() : process.cwd();

function exit(code: number): never {
  if (isDeno) {
    deno.exit(code);
  }
  process.exit(code);
}

function logInfo(message: string) {
  console.log(message);
}

function logWarn(message: string) {
  console.warn(message);
}

function logError(message: string) {
  console.error(message);
}

function usage() {
  logInfo(`css-ts setup tool

Usage:
  css-ts sveltekit --deno
  css-ts sveltekit --npm

Options:
  --deno   Configure a SvelteKit + Deno + Vite project.
  --npm    Configure a SvelteKit + NPM + Vite project.
  --help   Show this help message.
`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function writeFile(filePath: string, content: string) {
  await fs.writeFile(filePath, content);
}

function detectMode(flags: Set<string>): Mode | null {
  if (flags.has("--deno")) return "deno";
  if (flags.has("--npm")) return "npm";
  return null;
}

function ensureImport(source: string, importStatement: string): { updated: string; changed: boolean } {
  if (source.includes(importStatement)) {
    return { updated: source, changed: false };
  }
  const lines = source.split("\n");
  let insertIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("import ")) {
      insertIndex = i;
    }
  }
  if (insertIndex === -1) {
    return { updated: `${importStatement}\n${source}`, changed: true };
  }
  lines.splice(insertIndex + 1, 0, importStatement);
  return { updated: lines.join("\n"), changed: true };
}

function findMatchingBracket(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function ensurePlugin(
  source: string,
  pluginCall: string,
): { updated: string; changed: boolean } {
  if (source.includes(pluginCall)) {
    return { updated: source, changed: false };
  }
  const match = source.match(/plugins\s*:\s*\[/);
  if (!match || match.index === undefined) {
    return { updated: source, changed: false };
  }
  const startIndex = match.index + match[0].length - 1;
  const endIndex = findMatchingBracket(source, startIndex, "[", "]");
  if (endIndex === -1) {
    return { updated: source, changed: false };
  }
  const before = source.slice(0, endIndex);
  const after = source.slice(endIndex);
  const indentMatch = source.slice(0, match.index).match(/(^|\n)([ \t]*)[^\n]*$/);
  const indent = indentMatch ? indentMatch[2] : "";
  const insertion = `\n${indent}  ${pluginCall},`;
  return { updated: `${before}${insertion}${after}`, changed: true };
}

function ensureResolveAlias(
  source: string,
  aliasKey: string,
  aliasValue: string,
): { updated: string; changed: boolean } {
  if (source.includes(`"${aliasKey}"`)) {
    return { updated: source, changed: false };
  }
  const resolveMatch = source.match(/resolve\s*:\s*\{/);
  if (resolveMatch && resolveMatch.index !== undefined) {
    const resolveStart = resolveMatch.index + resolveMatch[0].length - 1;
    const resolveEnd = findMatchingBracket(source, resolveStart, "{", "}");
    if (resolveEnd !== -1) {
      const resolveBlock = source.slice(resolveStart + 1, resolveEnd);
      if (resolveBlock.includes("alias")) {
        const aliasMatch = resolveBlock.match(/alias\s*:\s*\{/);
        if (aliasMatch && aliasMatch.index !== undefined) {
          const aliasStart = resolveStart + 1 + aliasMatch.index + aliasMatch[0].length - 1;
          const aliasEnd = findMatchingBracket(source, aliasStart, "{", "}");
          if (aliasEnd !== -1) {
            const indentMatch = source
              .slice(0, aliasStart)
              .match(/(^|\n)([ \t]*)[^\n]*$/);
            const indent = indentMatch ? indentMatch[2] : "";
            const insertion = `\n${indent}  "${aliasKey}": "${aliasValue}",`;
            return {
              updated: `${source.slice(0, aliasEnd)}${insertion}${source.slice(aliasEnd)}`,
              changed: true,
            };
          }
        }
      } else {
        const indentMatch = source
          .slice(0, resolveStart)
          .match(/(^|\n)([ \t]*)[^\n]*$/);
        const indent = indentMatch ? indentMatch[2] : "";
        const insertion = `\n${indent}  alias: {\n${indent}    "${aliasKey}": "${aliasValue}",\n${indent}  },`;
        return {
          updated: `${source.slice(0, resolveEnd)}${insertion}${source.slice(resolveEnd)}`,
          changed: true,
        };
      }
    }
  }
  const pluginsMatch = source.match(/plugins\s*:\s*\[/);
  if (pluginsMatch && pluginsMatch.index !== undefined) {
    const indentMatch = source
      .slice(0, pluginsMatch.index)
      .match(/(^|\n)([ \t]*)[^\n]*$/);
    const indent = indentMatch ? indentMatch[2] : "";
    const insertion = `${indent}resolve: {\n${indent}  alias: {\n${indent}    "${aliasKey}": "${aliasValue}",\n${indent}  },\n${indent}},\n`;
    return {
      updated: `${source.slice(0, pluginsMatch.index)}${insertion}${source.slice(
        pluginsMatch.index,
      )}`,
      changed: true,
    };
  }
  return { updated: source, changed: false };
}

async function updateViteConfig(mode: Mode) {
  const configNames = [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.mts",
    "vite.config.cjs",
  ];
  let configPath: string | null = null;
  for (const name of configNames) {
    const candidate = path.join(cwd, name);
    if (await exists(candidate)) {
      configPath = candidate;
      break;
    }
  }
  if (!configPath) {
    logWarn("No vite.config file found. Skipping Vite updates.");
    return;
  }
  let source = await readFile(configPath);
  let changed = false;

  const importResult = ensureImport(source, 'import ct from "@kt-tools/css-ts";');
  source = importResult.updated;
  changed = changed || importResult.changed;

  const pluginResult = ensurePlugin(source, "ct.vite()");
  source = pluginResult.updated;
  changed = changed || pluginResult.changed;

  if (mode === "deno") {
    const aliasResult = ensureResolveAlias(source, "@kt-tools/css-ts", DENO_ALIAS_TARGET);
    source = aliasResult.updated;
    changed = changed || aliasResult.changed;
  }

  if (changed) {
    await writeFile(configPath, source);
    logInfo(`Updated ${path.relative(cwd, configPath)}.`);
  } else {
    logInfo(`No changes needed in ${path.relative(cwd, configPath)}.`);
  }
}

async function updateDenoJson() {
  const denoPath = path.join(cwd, "deno.json");
  if (!(await exists(denoPath))) {
    logWarn("deno.json not found. Skipping Deno import map updates.");
    return;
  }
  const content = await readFile(denoPath);
  const data = JSON.parse(content) as Record<string, unknown>;
  if (!data.nodeModulesDir) {
    data.nodeModulesDir = "auto";
  }
  const imports = (data.imports as Record<string, string> | undefined) ?? {};
  if (!imports["@kt-tools/css-ts"]) {
    imports["@kt-tools/css-ts"] = DENO_IMPORT_TARGET;
  }
  data.imports = imports;
  await writeFile(denoPath, `${JSON.stringify(data, null, 2)}\n`);
  logInfo("Updated deno.json import map.");
}

async function run() {
  if (args.length === 0 || args.includes("--help")) {
    usage();
    exit(0);
  }

  const [command, ...rest] = args;
  const flags = new Set<string>(rest);
  if (command !== "sveltekit") {
    logError(`Unknown command: ${command}`);
    usage();
    exit(1);
  }

  let mode = detectMode(flags);
  if (!mode) {
    const denoJsonExists = await exists(path.join(cwd, "deno.json"));
    const packageJsonExists = await exists(path.join(cwd, "package.json"));
    if (denoJsonExists && !packageJsonExists) {
      mode = "deno";
    } else if (packageJsonExists) {
      mode = "npm";
    }
  }

  if (!mode) {
    logError("Unable to infer project type. Use --deno or --npm.");
    exit(1);
  }

  if (mode === "deno") {
    await updateDenoJson();
  }

  await updateViteConfig(mode);
}

const importMeta = import.meta as ImportMeta & { main?: boolean };
const shouldRun = isDeno ? importMeta.main === true : true;

if (shouldRun) {
  run().catch((error) => {
    logError(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
