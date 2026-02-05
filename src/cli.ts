#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const README_VERSIONS = {
  kit: "^2.50.2",
  vitePluginSvelte: "^6.2.4",
  svelte: "^5.49.2",
  vite: "^7.3.1",
} as const;

type Mode = "deno" | "npm";

type CliOptions = {
  mode?: Mode;
  install: boolean;
  cwd: string;
};

type UpdateResult = {
  changed: boolean;
  notes: string[];
  warnings: string[];
};

const args = process.argv.slice(2);
const options = parseArgs(args);

if (options === null) {
  process.exit(0);
} else {
  const root = options.cwd;
  run(root, options).catch((err) => {
    console.error("\ncss-ts: setup failed");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

async function run(root: string, options: CliOptions) {
  const hasDenoJson = existsSync(path.join(root, "deno.json")) || existsSync(path.join(root, "deno.jsonc"));
  const hasPackageJson = existsSync(path.join(root, "package.json"));

  let mode = options.mode;
  if (!mode) {
    if (hasDenoJson && !hasPackageJson) {
      mode = "deno";
    } else if (hasPackageJson) {
      mode = "npm";
    } else if (hasDenoJson) {
      mode = "deno";
    }
  }

  if (!mode) {
    console.error("css-ts: could not determine project type (no package.json or deno.json found). Use --npm or --deno.");
    process.exit(1);
  }

  const summary: string[] = [];
  const warnings: string[] = [];

  if (mode === "deno") {
    const denoResult = await updateDenoConfig(root);
    report(denoResult, summary, warnings);

    const svelteResult = await updateSvelteConfig(root, true);
    report(svelteResult, summary, warnings);

    const viteResult = await updateViteConfig(root, true);
    report(viteResult, summary, warnings);

    if (options.install) {
      const added = await runDenoAdd(root);
      if (added) {
        summary.push("Installed @kt-tools/css-ts via deno add.");
      }
    }
  } else {
    const pkgResult = await updatePackageJson(root);
    report(pkgResult, summary, warnings);

    const viteResult = await updateViteConfig(root, false);
    report(viteResult, summary, warnings);

    if (options.install) {
      const added = await runPackageInstall(root);
      if (added) {
        summary.push("Installed @kt-tools/css-ts using the detected package manager.");
      }
    }
  }

  console.log("\ncss-ts: setup complete");
  if (summary.length > 0) {
    for (const line of summary) {
      console.log(`- ${line}`);
    }
  }
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const line of warnings) {
      console.log(`- ${line}`);
    }
  }
}

function parseArgs(args: string[]): CliOptions | null {
  const options: CliOptions = {
    install: true,
    cwd: process.cwd(),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return null;
    }
    if (arg === "--deno") {
      options.mode = "deno";
      continue;
    }
    if (arg === "--npm") {
      options.mode = "npm";
      continue;
    }
    if (arg === "--no-install") {
      options.install = false;
      continue;
    }
    if (arg === "--cwd") {
      const next = args[i + 1];
      if (!next) {
        console.error("css-ts: --cwd expects a path");
        process.exit(1);
      }
      options.cwd = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    console.error(`css-ts: unknown argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  return options;
}

function printHelp() {
  console.log(`css-ts setup\n\nUsage:\n  css-ts [--deno|--npm] [--no-install] [--cwd <path>]\n\nOptions:\n  --deno        Configure for SvelteKit + Deno + Vite\n  --npm         Configure for SvelteKit + npm + Vite\n  --no-install  Skip installing @kt-tools/css-ts\n  --cwd <path>  Run in a specific directory\n`);
}

function report(result: UpdateResult, summary: string[], warnings: string[]) {
  if (result.changed) {
    summary.push(...result.notes);
  }
  warnings.push(...result.warnings);
}

async function updateDenoConfig(root: string): Promise<UpdateResult> {
  const notes: string[] = [];
  const warnings: string[] = [];

  const denoPath = findFirst(root, ["deno.json", "deno.jsonc"]);
  if (!denoPath) {
    warnings.push("No deno.json/deno.jsonc found. Skipped Deno import map updates.");
    return { changed: false, notes, warnings };
  }

  const original = await readFile(denoPath, "utf8");
  let config: Record<string, unknown>;
  try {
    config = parseJsonLike(original);
  } catch (error) {
    warnings.push(`Failed to parse ${path.basename(denoPath)}. Skipped import map updates.`);
    return { changed: false, notes, warnings };
  }

  const imports = ensureObject(config, "imports");

  const cssTsVersion = await readPackageVersion();
  const cssTsSpecifier = cssTsVersion
    ? `npm:@jsr/kt-tools__css-ts@^${cssTsVersion}`
    : "npm:@jsr/kt-tools__css-ts";

  const requiredImports: Record<string, string> = {
    "@kt-tools/css-ts": cssTsSpecifier,
    "@sveltejs/kit": `npm:@sveltejs/kit@${README_VERSIONS.kit}`,
    "@sveltejs/vite-plugin-svelte": `npm:@sveltejs/vite-plugin-svelte@${README_VERSIONS.vitePluginSvelte}`,
    svelte: `npm:svelte@${README_VERSIONS.svelte}`,
    vite: `npm:vite@${README_VERSIONS.vite}`,
  };

  let changed = false;

  for (const [key, value] of Object.entries(requiredImports)) {
    if (!(key in imports)) {
      imports[key] = value;
      changed = true;
    }
  }

  if (config.nodeModulesDir !== "auto") {
    config.nodeModulesDir = "auto";
    changed = true;
  }

  if (changed) {
    const updated = JSON.stringify(config, null, 2) + "\n";
    await writeFile(denoPath, updated, "utf8");
    notes.push(`Updated ${path.basename(denoPath)} with import map entries and nodeModulesDir.`);
    if (denoPath.endsWith(".jsonc")) {
      warnings.push(`Rewrote ${path.basename(denoPath)} as JSON (comments removed).`);
    }
  }

  return { changed, notes, warnings };
}

async function updatePackageJson(root: string): Promise<UpdateResult> {
  const notes: string[] = [];
  const warnings: string[] = [];

  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) {
    warnings.push("No package.json found. Skipped npm dependency updates.");
    return { changed: false, notes, warnings };
  }

  const original = await readFile(pkgPath, "utf8");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(original);
  } catch (error) {
    warnings.push("Failed to parse package.json. Skipped dependency updates.");
    return { changed: false, notes, warnings };
  }

  const deps = ensureObject(pkg, "dependencies");
  if (!("@kt-tools/css-ts" in deps)) {
    deps["@kt-tools/css-ts"] = await readPackageVersionOrLatest();
    const updated = JSON.stringify(pkg, null, 2) + "\n";
    await writeFile(pkgPath, updated, "utf8");
    notes.push("Added @kt-tools/css-ts to dependencies in package.json.");
    return { changed: true, notes, warnings };
  }

  return { changed: false, notes, warnings };
}

async function updateSvelteConfig(root: string, denoMode: boolean): Promise<UpdateResult> {
  const notes: string[] = [];
  const warnings: string[] = [];

  if (!denoMode) {
    return { changed: false, notes, warnings };
  }

  const sveltePath = findFirst(root, [
    "svelte.config.js",
    "svelte.config.ts",
    "svelte.config.mjs",
    "svelte.config.cjs",
  ]);

  if (!sveltePath) {
    warnings.push("No svelte.config file found. Skipped adapter update.");
    return { changed: false, notes, warnings };
  }

  const original = await readFile(sveltePath, "utf8");
  if (original.includes("@deno/svelte-adapter")) {
    return { changed: false, notes, warnings };
  }

  let updated = original;

  const importRegex = /from\s+["']@sveltejs\/adapter-[^"']+["']/;
  const requireRegex = /require\(["']@sveltejs\/adapter-[^"']+["']\)/;

  if (importRegex.test(updated)) {
    updated = updated.replace(importRegex, "from \"@deno/svelte-adapter\"");
  } else if (requireRegex.test(updated)) {
    updated = updated.replace(requireRegex, "require(\"@deno/svelte-adapter\")");
  } else {
    warnings.push("Could not find an existing Svelte adapter import to replace. Update svelte.config manually if needed.");
    return { changed: false, notes, warnings };
  }

  await writeFile(sveltePath, updated, "utf8");
  notes.push(`Updated ${path.basename(sveltePath)} to use @deno/svelte-adapter.`);

  return { changed: true, notes, warnings };
}

async function updateViteConfig(root: string, denoMode: boolean): Promise<UpdateResult> {
  const notes: string[] = [];
  const warnings: string[] = [];

  const vitePath = findFirst(root, [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
  ]);

  if (!vitePath) {
    warnings.push("No vite.config file found. Skipped Vite plugin updates.");
    return { changed: false, notes, warnings };
  }

  const original = await readFile(vitePath, "utf8");
  let updated = original;
  let changed = false;

  if (!updated.includes("@kt-tools/css-ts")) {
    updated = insertImport(updated, 'import ct from "@kt-tools/css-ts";');
    changed = true;
  }

  if (!updated.includes("ct.vite")) {
    const replaced = updated.replace(/sveltekit\s*\(\s*\)/, "ct.vite(), sveltekit()");
    if (replaced !== updated) {
      updated = replaced;
      changed = true;
    } else if (/plugins\s*:\s*\[/.test(updated)) {
      updated = updated.replace(/plugins\s*:\s*\[/, "plugins: [ct.vite(), ");
      changed = true;
    } else {
      warnings.push("Could not find a plugins array in vite.config. Add ct.vite() manually.");
    }
  }

  if (denoMode && !updated.includes("@jsr/kt-tools__css-ts")) {
    const aliasSnippet = `  resolve: {\n    alias: {\n      \"@kt-tools/css-ts\": \"@jsr/kt-tools__css-ts\",\n    },\n  },\n`;

    if (/resolve\s*:\s*{/.test(updated)) {
      if (/alias\s*:\s*{/.test(updated)) {
        updated = updated.replace(/alias\s*:\s*{/, `alias: {\n      \"@kt-tools/css-ts\": \"@jsr/kt-tools__css-ts\",`);
        changed = true;
      } else {
        updated = updated.replace(/resolve\s*:\s*{/, `resolve: {\n    alias: {\n      \"@kt-tools/css-ts\": \"@jsr/kt-tools__css-ts\",\n    },`);
        changed = true;
      }
    } else {
      const defineMatch = /defineConfig\(\s*{/.exec(updated);
      if (defineMatch && defineMatch.index !== undefined) {
        const insertPos = defineMatch.index + defineMatch[0].length;
        updated = updated.slice(0, insertPos) + "\n" + aliasSnippet + updated.slice(insertPos);
        changed = true;
      } else {
        warnings.push("Could not insert Vite resolve.alias entry. Add it manually.");
      }
    }
  }

  if (changed) {
    await writeFile(vitePath, updated, "utf8");
    notes.push(`Updated ${path.basename(vitePath)} with CSS-TS Vite plugin configuration.`);
  }

  return { changed, notes, warnings };
}

async function runPackageInstall(root: string): Promise<boolean> {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return false;
  }

  const pm = detectPackageManager(root);
  const cmd = pm === "pnpm"
    ? "pnpm add @kt-tools/css-ts"
    : pm === "yarn"
    ? "yarn add @kt-tools/css-ts"
    : pm === "bun"
    ? "bun add @kt-tools/css-ts"
    : "npm install @kt-tools/css-ts";

  try {
    execSync(cmd, { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

async function runDenoAdd(root: string): Promise<boolean> {
  const cssTsVersion = await readPackageVersion();
  const specifier = cssTsVersion
    ? `npm:@jsr/kt-tools__css-ts@^${cssTsVersion}`
    : "npm:@jsr/kt-tools__css-ts";

  try {
    execSync(`deno add ${specifier}`, { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

function detectPackageManager(root: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function ensureObject(target: Record<string, unknown>, key: string): Record<string, string> {
  if (!target[key] || typeof target[key] !== "object") {
    target[key] = {};
  }
  return target[key] as Record<string, string>;
}

function insertImport(source: string, line: string): string {
  const importRegex = /^import[^;\n]*;?\s*$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source))) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return `${line}\n${source}`;
  }

  const insertPos = lastMatch.index + lastMatch[0].length;
  return `${source.slice(0, insertPos)}\n${line}${source.slice(insertPos)}`;
}

function findFirst(root: string, candidates: string[]): string | null {
  for (const file of candidates) {
    const fullPath = path.join(root, file);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function parseJsonLike(value: string): Record<string, unknown> {
  const stripped = stripJsonComments(value);
  return JSON.parse(stripped);
}

function stripJsonComments(value: string): string {
  let output = "";
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const next = value[i + 1];

    if (inSingleLineComment) {
      if (char === "\n") {
        inSingleLineComment = false;
        output += char;
      }
      continue;
    }

    if (inMultiLineComment) {
      if (char === "*" && next === "/") {
        inMultiLineComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (char === "\\" && next) {
        output += char + next;
        i += 1;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      output += char;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inSingleLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inMultiLineComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

async function readPackageVersion(): Promise<string | null> {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch (error) {
    return null;
  }
}

async function readPackageVersionOrLatest(): Promise<string> {
  const version = await readPackageVersion();
  if (!version) return "latest";
  return `^${version}`;
}
