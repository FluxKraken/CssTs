import {
  findCtCalls,
  findExpressionTerminator,
  findNewCtDeclarations,
  parseCtCallArguments,
  parseCtCallArgumentsWithResolver,
  parseCtConfig,
  parseStaticExpression,
} from "./parser.js";
import { camelToKebab, createClassName, type StyleSheet, toCssGlobalRules, toCssRules } from "./shared.js";

const PUBLIC_VIRTUAL_ID = "virtual:css-ts/styles.css";
const RESOLVED_VIRTUAL_ID = "\0virtual:css-ts/styles.css";
const STATIC_STYLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

type ImportBinding =
  | {
    source: string;
    kind: "named";
    imported: string;
  }
  | {
    source: string;
    kind: "namespace";
  }
  | {
    source: string;
    kind: "default";
  };

type ModuleStaticInfo = {
  imports: Map<string, ImportBinding>;
  constInitializers: Map<string, string>;
  functionDeclarations: Map<string, string>;
  exportedConsts: Map<string, string>;
  defaultExportExpression: string | null;
};

type ViteAliasEntry = {
  find: string | RegExp;
  replacement: string;
};

type TsconfigPathMatcher = {
  pattern: string;
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
  targets: string[];
};

type TsconfigPathResolver = {
  resolve: (source: string) => string | null;
};

type ViteModuleGraphLike = {
  getModuleById: (id: string) => unknown;
  invalidateModule: (module: unknown) => void;
};

type ViteDevServerLike = {
  moduleGraph: ViteModuleGraphLike;
};

type ViteResolvedConfigLike = {
  root: string;
  resolve: {
    alias?: unknown;
  };
};

type ImportResolverOptions = {
  projectRoot: string;
  viteAliases: readonly ViteAliasEntry[];
  tsconfigResolver: TsconfigPathResolver | null;
};

type LoadedCssConfig = {
  path: string | null;
  imports: string[];
  resolution: "static" | "dynamic" | "hybrid";
  hasExplicitResolution: boolean;
  debug: {
    logDynamic: boolean;
    logStatic: boolean;
  };
  breakpoints: Record<string, string>;
  containers: Record<string, { type?: string; rule: string }>;
  include: string[];
  utilities: StyleSheet;
  utilityCss: string;
  runtimeOptions: {
    breakpoints?: Record<string, string>;
    containers?: Record<string, { type?: string; rule: string }>;
    utilities?: StyleSheet;
    resolution?: "static" | "dynamic" | "hybrid";
    debug?: {
      enabled?: boolean;
      logDynamic?: boolean;
      logStatic?: boolean;
    };
  };
};

type NodeFs = typeof import("node:fs");
type NodePath = typeof import("node:path");
type NodeModule = typeof import("node:module");
type NodeRequire = (id: string) => unknown;

let nodeFs: NodeFs | null | undefined;
let nodePath: NodePath | null | undefined;
let nodeRequire: NodeRequire | null | undefined;
let tsTranspiler: ((source: string) => string) | null | undefined;

function getBuiltinModule(id: string): unknown | null {
  const processValue = (globalThis as { process?: unknown }).process;
  if (!processValue || typeof processValue !== "object") {
    return null;
  }

  const getBuiltinModule = (processValue as { getBuiltinModule?: unknown }).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return null;
  }

  try {
    return (getBuiltinModule as (name: string) => unknown)(id);
  } catch {
    return null;
  }
}

function getFallbackRequire(): NodeRequire | null {
  try {
    const req = new Function("return typeof require === \"function\" ? require : null;")();
    return typeof req === "function" ? (req as NodeRequire) : null;
  } catch {
    return null;
  }
}

function getNodeRequire(): NodeRequire | null {
  if (nodeRequire !== undefined) {
    return nodeRequire;
  }

  const moduleBuiltin = getBuiltinModule("node:module") as NodeModule | null;
  if (moduleBuiltin && typeof moduleBuiltin.createRequire === "function") {
    nodeRequire = moduleBuiltin.createRequire(import.meta.url) as NodeRequire;
    return nodeRequire;
  }

  nodeRequire = getFallbackRequire();
  return nodeRequire;
}

function getNodeFs(): NodeFs {
  if (nodeFs) {
    return nodeFs;
  }

  const builtin = getBuiltinModule("node:fs") as NodeFs | null;
  if (builtin) {
    nodeFs = builtin;
    return nodeFs;
  }

  const requireFn = getNodeRequire();
  if (requireFn) {
    nodeFs = requireFn("node:fs") as NodeFs;
    return nodeFs;
  }

  throw new Error("css-ts vite plugin requires Node.js built-ins (node:fs).");
}

function getNodePath(): NodePath {
  if (nodePath) {
    return nodePath;
  }

  const builtin = getBuiltinModule("node:path") as NodePath | null;
  if (builtin) {
    nodePath = builtin;
    return nodePath;
  }

  const requireFn = getNodeRequire();
  if (requireFn) {
    nodePath = requireFn("node:path") as NodePath;
    return nodePath;
  }

  throw new Error("css-ts vite plugin requires Node.js built-ins (node:path).");
}

const STATIC_EVAL_GLOBALS: Record<string, unknown> = {
  Array,
  Boolean,
  Infinity,
  JSON,
  Math,
  NaN,
  Number,
  Object,
  String,
  isFinite,
  isNaN,
  parseFloat,
  parseInt,
  undefined,
};

function cleanId(id: string): string {
  return id.replace(/\?.*$/, "");
}

function supportsTransform(id: string): boolean {
  return /\.(?:[jt]sx?|svelte|astro)$/.test(cleanId(id));
}

const CSS_TS_IMPORT_SOURCES = [
  "css-ts",
  "@kt-tools/css-ts",
  "@jsr/kt-tools__css-ts",
] as const;

function hasCssTsImport(code: string): boolean {
  for (const source of CSS_TS_IMPORT_SOURCES) {
    if (code.includes(`from "${source}"`) || code.includes(`from '${source}'`)) {
      return true;
    }
  }
  return false;
}

function isVirtualSubRequest(id: string): boolean {
  return id.includes("?");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMemberPath(value: unknown, members: readonly string[]): unknown | null {
  let current: unknown = value;
  for (const member of members) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (!(member in record)) {
      return null;
    }
    current = record[member];
  }
  return current;
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0;

  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function toSvelteGlobalRule(rule: string): string {
  const open = rule.indexOf("{");
  if (open === -1) return rule;

  const close = findMatchingBrace(rule, open);
  if (close === -1) return rule;

  const head = rule.slice(0, open).trim();
  const body = rule.slice(open + 1, close);
  const suffix = rule.slice(close + 1).trim();

  const next = head.startsWith("@")
    ? `${head}{${toSvelteGlobalRule(body)}}`
    : `:global(${head}){${body}}`;

  if (suffix.length === 0) {
    return next;
  }
  return `${next}${suffix}`;
}

function addSvelteStyleBlock(code: string, rules: Iterable<string>): string {
  const css = Array.from(rules).map(toSvelteGlobalRule).join("\n");

  if (!css) {
    return code;
  }

  return `${code}\n<style>\n${css}\n</style>\n`;
}

function addVirtualImport(code: string): string {
  if (code.includes(PUBLIC_VIRTUAL_ID)) {
    return code;
  }

  return `import "${PUBLIC_VIRTUAL_ID}";\n${code}`;
}

function addVirtualImportToSvelte(code: string): string {
  if (code.includes(PUBLIC_VIRTUAL_ID)) {
    return code;
  }

  const match = code.match(/<script\b[^>]*>/);
  if (!match || match.index === undefined) {
    return `<script>\nimport "${PUBLIC_VIRTUAL_ID}";\n</script>\n${code}`;
  }

  const insertAt = match.index + match[0].length;
  return (
    code.slice(0, insertAt) +
    `\nimport "${PUBLIC_VIRTUAL_ID}";` +
    code.slice(insertAt)
  );
}

function addVirtualImportToAstro(code: string): string {
  if (code.includes(PUBLIC_VIRTUAL_ID)) {
    return code;
  }

  const frontmatterMatch = code.match(/^---[ \t]*\r?\n/);
  if (frontmatterMatch) {
    const insertAt = frontmatterMatch[0].length;
    return (
      code.slice(0, insertAt) +
      `import "${PUBLIC_VIRTUAL_ID}";\n` +
      code.slice(insertAt)
    );
  }

  const trimmed = code.trimStart();
  if (/^(?:import|export|const|let|var|function|class)\b/.test(trimmed)) {
    return addVirtualImport(code);
  }

  return `---\nimport "${PUBLIC_VIRTUAL_ID}";\n---\n${code}`;
}

function mergeCss(rules: Iterable<string>): string {
  return Array.from(rules).join("\n");
}

function parseBindingList(specifierList: string): Array<{ local: string; imported: string }> {
  const bindings: Array<{ local: string; imported: string }> = [];

  for (const rawSpecifier of specifierList.split(",")) {
    const specifier = rawSpecifier.replace(/\s+/g, " ").trim();
    if (!specifier) {
      continue;
    }

    const normalized = specifier.replace(/^type\s+/, "").trim();
    if (!normalized) {
      continue;
    }

    const asMatch = normalized.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (asMatch) {
      bindings.push({
        imported: asMatch[1],
        local: asMatch[2],
      });
      continue;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) {
      bindings.push({
        imported: normalized,
        local: normalized,
      });
    }
  }

  return bindings;
}

function parseModuleStaticInfo(code: string): ModuleStaticInfo {
  const imports = new Map<string, ImportBinding>();
  const constInitializers = new Map<string, string>();
  const functionDeclarations = new Map<string, string>();
  const exportedConsts = new Map<string, string>();

  const defaultImportMatcher =
    /import\s+(?!type\b)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*(?:\{[\s\S]*?\}|\*\s*as\s*[A-Za-z_$][A-Za-z0-9_$]*))?\s*from\s*["']([^"']+)["']/g;
  for (let match = defaultImportMatcher.exec(code); match; match = defaultImportMatcher.exec(code)) {
    imports.set(match[1], {
      source: match[2],
      kind: "default",
    });
  }

  const namespaceImportMatcher =
    /import\s*\*\s*as\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*from\s*["']([^"']+)["']/g;
  for (let match = namespaceImportMatcher.exec(code); match; match = namespaceImportMatcher.exec(code)) {
    imports.set(match[1], {
      source: match[2],
      kind: "namespace",
    });
  }

  const importMatcher = /import\s*{([\s\S]*?)}\s*from\s*["']([^"']+)["']/g;
  for (let match = importMatcher.exec(code); match; match = importMatcher.exec(code)) {
    const source = match[2];
    for (const binding of parseBindingList(match[1])) {
      imports.set(binding.local, {
        source,
        kind: "named",
        imported: binding.imported,
      });
    }
  }

  const exportListMatcher = /export\s*{([\s\S]*?)}\s*;?/g;
  for (let match = exportListMatcher.exec(code); match; match = exportListMatcher.exec(code)) {
    for (const binding of parseBindingList(match[1])) {
      exportedConsts.set(binding.local, binding.imported);
    }
  }

  const constMatcher = /\b(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  for (let match = constMatcher.exec(code); match; match = constMatcher.exec(code)) {
    const isExported = Boolean(match[1]);
    const name = match[2];
    let initializerStart = constMatcher.lastIndex;

    while (initializerStart < code.length && /\s/.test(code[initializerStart])) {
      initializerStart += 1;
    }

    if (code[initializerStart] === ":") {
      initializerStart += 1;
      let angleDepth = 0;
      let parenDepth = 0;
      let bracketDepth = 0;
      let braceDepth = 0;
      let inString: "" | "\"" | "'" | "`" = "";
      let escaped = false;

      for (; initializerStart < code.length; initializerStart += 1) {
        const char = code[initializerStart];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char === inString) {
            inString = "";
          }
          continue;
        }

        if (char === "\"" || char === "'" || char === "`") {
          inString = char;
          continue;
        }

        if (char === "<") {
          angleDepth += 1;
          continue;
        }
        if (char === ">") {
          angleDepth = Math.max(0, angleDepth - 1);
          continue;
        }
        if (char === "(") {
          parenDepth += 1;
          continue;
        }
        if (char === ")") {
          parenDepth = Math.max(0, parenDepth - 1);
          continue;
        }
        if (char === "[") {
          bracketDepth += 1;
          continue;
        }
        if (char === "]") {
          bracketDepth = Math.max(0, bracketDepth - 1);
          continue;
        }
        if (char === "{") {
          braceDepth += 1;
          continue;
        }
        if (char === "}") {
          braceDepth = Math.max(0, braceDepth - 1);
          continue;
        }

        if (
          char === "=" &&
          angleDepth === 0 &&
          parenDepth === 0 &&
          bracketDepth === 0 &&
          braceDepth === 0
        ) {
          break;
        }
      }
    }

    if (code[initializerStart] !== "=") {
      continue;
    }

    initializerStart += 1;
    const initializerEnd = findExpressionTerminator(code, initializerStart);
    const initializer = code.slice(initializerStart, initializerEnd).trim();

    if (initializer.length > 0) {
      constInitializers.set(name, initializer);
    }

    if (isExported) {
      exportedConsts.set(name, name);
    }

    constMatcher.lastIndex = initializerEnd < code.length && code[initializerEnd] === ";"
      ? initializerEnd + 1
      : initializerEnd;
  }

  const functionMatcher =
    /\b(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (let match = functionMatcher.exec(code); match; match = functionMatcher.exec(code)) {
    const isExported = Boolean(match[1]);
    const name = match[2];
    let cursor = functionMatcher.lastIndex;
    let parenDepth = 1;
    let inString: "" | "\"" | "'" | "`" = "";
    let escaped = false;

    for (; cursor < code.length; cursor += 1) {
      const char = code[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === inString) {
          inString = "";
        }
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        inString = char;
        continue;
      }

      if (char === "/" && code[cursor + 1] === "/") {
        cursor += 2;
        while (cursor < code.length && code[cursor] !== "\n") {
          cursor += 1;
        }
        continue;
      }

      if (char === "/" && code[cursor + 1] === "*") {
        cursor += 2;
        while (cursor < code.length && !(code[cursor] === "*" && code[cursor + 1] === "/")) {
          cursor += 1;
        }
        cursor += 1;
        continue;
      }

      if (char === "(") {
        parenDepth += 1;
        continue;
      }
      if (char === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) {
          cursor += 1;
          break;
        }
      }
    }

    while (cursor < code.length && /\s/.test(code[cursor])) {
      cursor += 1;
    }

    if (code[cursor] === ":") {
      cursor += 1;
      while (cursor < code.length && code[cursor] !== "{") {
        cursor += 1;
      }
    }
    while (cursor < code.length && code[cursor] !== "{") {
      cursor += 1;
    }
    if (cursor >= code.length) {
      continue;
    }

    let bodyDepth = 0;
    inString = "";
    escaped = false;

    for (; cursor < code.length; cursor += 1) {
      const char = code[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === inString) {
          inString = "";
        }
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        inString = char;
        continue;
      }

      if (char === "/" && code[cursor + 1] === "/") {
        cursor += 2;
        while (cursor < code.length && code[cursor] !== "\n") {
          cursor += 1;
        }
        continue;
      }
      if (char === "/" && code[cursor + 1] === "*") {
        cursor += 2;
        while (cursor < code.length && !(code[cursor] === "*" && code[cursor + 1] === "/")) {
          cursor += 1;
        }
        cursor += 1;
        continue;
      }

      if (char === "{") {
        bodyDepth += 1;
        continue;
      }
      if (char === "}") {
        bodyDepth -= 1;
        if (bodyDepth === 0) {
          const declarationSource = code
            .slice(match.index, cursor + 1)
            .replace(/^export\s+/, "")
            .trim();
          functionDeclarations.set(name, declarationSource);
          if (isExported) {
            exportedConsts.set(name, name);
          }
          functionMatcher.lastIndex = cursor + 1;
          break;
        }
      }
    }
  }

  return {
    imports,
    constInitializers,
    functionDeclarations,
    exportedConsts,
    defaultExportExpression: extractDefaultExportExpression(code),
  };
}

function findCssConfigPath(projectRoot: string): string | null {
  const candidates = [
    "css.config.ts",
    "css.config.mts",
    "css.config.js",
    "css.config.mjs",
    "css.config.cts",
    "css.config.cjs",
  ];

  for (const candidate of candidates) {
    const fullPath = getNodePath().resolve(projectRoot, candidate);
    if (getNodeFs().existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

function extractDefaultExportExpression(source: string): string | null {
  const marker = "export default";
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  let start = markerIndex + marker.length;
  while (start < source.length && /\s/.test(source[start])) {
    start += 1;
  }

  const end = findExpressionTerminator(source, start);
  const expression = source.slice(start, end === -1 ? source.length : end).trim();
  if (!expression) {
    return null;
  }

  return expression.endsWith(";") ? expression.slice(0, -1).trim() : expression;
}

function normalizeBreakpoints(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      normalized[name] = raw;
      continue;
    }
    if (typeof raw === "number") {
      normalized[name] = `${raw}px`;
    }
  }
  return normalized;
}

function normalizeContainers(
  value: unknown,
): Record<string, { type?: string; rule: string }> {
  const normalized: Record<string, { type?: string; rule: string }> = {};

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) {
        continue;
      }
      const name = entry.name;
      const rule = entry.rule;
      if (typeof name !== "string" || typeof rule !== "string") {
        continue;
      }
      const type = typeof entry.type === "string" ? entry.type : undefined;
      normalized[name] = type ? { type, rule } : { rule };
    }
    return normalized;
  }

  if (!isRecord(value)) {
    return normalized;
  }

  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.rule !== "string") {
      continue;
    }
    const type = typeof raw.type === "string" ? raw.type : undefined;
    normalized[name] = type ? { type, rule: raw.rule } : { rule: raw.rule };
  }

  return normalized;
}

function normalizeResolution(value: unknown): "static" | "dynamic" | "hybrid" {
  if (value === "static" || value === "dynamic" || value === "hybrid") {
    return value;
  }
  return "hybrid";
}

function normalizeDebugOptions(value: unknown): { logDynamic: boolean; logStatic: boolean } {
  if (!isRecord(value)) {
    return {
      logDynamic: false,
      logStatic: false,
    };
  }

  return {
    logDynamic: value.logDynamic === true,
    logStatic: value.logStatic === true,
  };
}

function normalizeIncludePaths(value: unknown, projectRoot: string): string[] {
  const entries = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];

  const normalized = entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) =>
      getNodePath().normalize(
        getNodePath().isAbsolute(entry) ? entry : getNodePath().resolve(projectRoot, entry),
      )
    );

  return Array.from(new Set(normalized));
}

function toBrowserStylesheetPath(
  importPath: string,
  importerPath: string,
  options: ImportResolverOptions,
): string | null {
  const queryIndex = importPath.indexOf("?");
  const bareImportPath = queryIndex === -1 ? importPath : importPath.slice(0, queryIndex);
  const querySuffix = queryIndex === -1 ? "" : importPath.slice(queryIndex);

  const toProjectPath = (resolvedFile: string): string | null => {
    const relative = getNodePath().relative(options.projectRoot, resolvedFile).split(getNodePath().sep).join("/");
    if (relative.startsWith("..")) {
      return null;
    }
    return `/${relative}${querySuffix}`;
  };

  if (/^(?:https?:)?\/\//.test(importPath) || importPath.startsWith("data:")) {
    return importPath;
  }
  if (bareImportPath.startsWith("/")) {
    return importPath;
  }

  if (bareImportPath.startsWith(".")) {
    const resolved = resolveFileFromBase(getNodePath().resolve(getNodePath().dirname(importerPath), bareImportPath));
    if (resolved) {
      return toProjectPath(resolved);
    }

    const fallback = getNodePath().resolve(getNodePath().dirname(importerPath), bareImportPath);
    return toProjectPath(fallback);
  }

  const resolved = resolveImportToFile(importerPath, bareImportPath, options);
  if (resolved) {
    const projectPath = toProjectPath(resolved);
    if (projectPath) {
      return projectPath;
    }
  }

  return importPath;
}

function loadCssConfig(
  projectRoot: string,
  resolverOptions: {
    viteAliases: readonly ViteAliasEntry[];
    tsconfigResolver: TsconfigPathResolver | null;
  },
): LoadedCssConfig {
  const configPath = findCssConfigPath(projectRoot);
  if (!configPath) {
    return {
      path: null,
      imports: [],
      resolution: "hybrid",
      hasExplicitResolution: false,
      debug: {
        logDynamic: false,
        logStatic: false,
      },
      breakpoints: {},
      containers: {},
      include: [],
      utilities: {},
      utilityCss: "",
      runtimeOptions: {},
    };
  }

  const source = getNodeFs().readFileSync(configPath, "utf8");
  const sideEffectImports: string[] = [];
  const cssImportMatcher = /import\s*["']([^"']+\.css(?:\?[^"']*)?)["']\s*;?/g;
  for (let match = cssImportMatcher.exec(source); match; match = cssImportMatcher.exec(source)) {
    sideEffectImports.push(match[1]);
  }

  const moduleInfoCache = new Map<string, ModuleStaticInfo>();
  const constValueCache = new Map<string, unknown | null>();
  const resolving = new Set<string>();

  function getModuleCode(moduleId: string): string | null {
    if (moduleId === configPath) {
      return source;
    }
    try {
      return getNodeFs().readFileSync(moduleId, "utf8");
    } catch {
      return null;
    }
  }

  function getModuleInfo(moduleId: string): ModuleStaticInfo | null {
    const cached = moduleInfoCache.get(moduleId);
    if (cached) {
      return cached;
    }
    const moduleCode = getModuleCode(moduleId);
    if (!moduleCode) {
      return null;
    }
    const parsed = parseModuleStaticInfo(moduleCode);
    moduleInfoCache.set(moduleId, parsed);
    return parsed;
  }

  function buildEvalScope(
    moduleInfo: ModuleStaticInfo,
    moduleId: string,
    excludeName?: string,
  ): Record<string, unknown> {
    const evalScope: Record<string, unknown> = {
      ...STATIC_EVAL_GLOBALS,
    };

    for (const localName of moduleInfo.functionDeclarations.keys()) {
      if (localName === excludeName) {
        continue;
      }
      const localValue = resolveIdentifierInModule([localName], moduleId);
      if (localValue !== null) {
        evalScope[localName] = localValue;
      }
    }

    for (const localName of moduleInfo.constInitializers.keys()) {
      if (localName === excludeName) {
        continue;
      }
      const localValue = resolveIdentifierInModule([localName], moduleId);
      if (localValue !== null) {
        evalScope[localName] = localValue;
      }
    }

    for (const localName of moduleInfo.imports.keys()) {
      const localValue = resolveIdentifierInModule([localName], moduleId);
      if (localValue !== null) {
        evalScope[localName] = localValue;
      }
    }

    return evalScope;
  }

  function resolveIdentifierInModule(identifierPath: readonly string[], moduleId: string): unknown | null {
    if (identifierPath.length === 0) {
      return null;
    }

    const cacheKey = `${moduleId}::${identifierPath.join(".")}`;
    if (constValueCache.has(cacheKey)) {
      return constValueCache.get(cacheKey) ?? null;
    }
    if (resolving.has(cacheKey)) {
      return null;
    }

    resolving.add(cacheKey);
    let resolved: unknown | null = null;
    const [head, ...tail] = identifierPath;

    const moduleInfo = getModuleInfo(moduleId);
    if (moduleInfo) {
      const initializer = moduleInfo.constInitializers.get(head);
      if (initializer !== undefined) {
        let value = parseStaticExpression(initializer, (nestedPath) => {
          const nested = resolveIdentifierInModule(nestedPath, moduleId);
          return nested === null ? undefined : nested;
        });

        if (value === null) {
          value = evaluateExpression(initializer, buildEvalScope(moduleInfo, moduleId, head));
        }

        if (value !== null) {
          resolved = tail.length > 0 ? readMemberPath(value, tail) : value;
        }
      } else {
        const functionDeclaration = moduleInfo.functionDeclarations.get(head);
        if (functionDeclaration !== undefined) {
          const functionValue = evaluateFunctionDeclaration(
            functionDeclaration,
            buildEvalScope(moduleInfo, moduleId, head),
          );
          if (functionValue !== null) {
            resolved = tail.length > 0 ? readMemberPath(functionValue, tail) : functionValue;
          }
        }
      }

      if (resolved === null) {
        const binding = moduleInfo.imports.get(head);
        if (binding) {
          const resolvedImportFile = resolveImportToFile(moduleId, binding.source, {
            projectRoot,
            viteAliases: resolverOptions.viteAliases,
            tsconfigResolver: resolverOptions.tsconfigResolver,
          });
          if (resolvedImportFile) {
            const importedModuleInfo = getModuleInfo(resolvedImportFile);
            if (importedModuleInfo) {
              if (binding.kind === "namespace") {
                if (tail.length > 0) {
                  const [namespaceExport, ...namespaceTail] = tail;
                  const exportedLocalName =
                    importedModuleInfo.exportedConsts.get(namespaceExport) ?? namespaceExport;
                  const namespaceValue = resolveIdentifierInModule(
                    [exportedLocalName],
                    resolvedImportFile,
                  );
                  resolved = namespaceTail.length > 0
                    ? readMemberPath(namespaceValue, namespaceTail)
                    : namespaceValue;
                }
              } else {
                const importedName = binding.kind === "default" ? "default" : binding.imported;
                const exportedLocalName = importedName === "default"
                  ? null
                  : (importedModuleInfo.exportedConsts.get(importedName) ?? importedName);
                const importedValue = resolveIdentifierInModule(
                  exportedLocalName
                    ? [exportedLocalName]
                    : ["default"],
                  resolvedImportFile,
                );
                resolved = tail.length > 0
                  ? readMemberPath(importedValue, tail)
                  : importedValue;
              }
            }
          }
        }
      }

      if (resolved === null && head === "default" && moduleInfo.defaultExportExpression) {
        const parsedDefault = parseStaticExpression(
          moduleInfo.defaultExportExpression,
          (nestedPath) => resolveIdentifierInModule(nestedPath, moduleId) ?? undefined,
        );
        if (parsedDefault !== null) {
          resolved = tail.length > 0 ? readMemberPath(parsedDefault, tail) : parsedDefault;
        } else {
          const evaluatedDefault = evaluateExpression(
            moduleInfo.defaultExportExpression,
            buildEvalScope(moduleInfo, moduleId),
          );
          if (evaluatedDefault !== null) {
            resolved = tail.length > 0 ? readMemberPath(evaluatedDefault, tail) : evaluatedDefault;
          }
        }
      }
    }

    resolving.delete(cacheKey);
    constValueCache.set(cacheKey, resolved);
    return resolved;
  }

  const configModuleInfo = getModuleInfo(configPath);
  const defaultExpr = configModuleInfo?.defaultExportExpression ?? extractDefaultExportExpression(source);
  let configObject: Record<string, unknown> = {};

  if (defaultExpr) {
    const parsed = parseStaticExpression(
      defaultExpr,
      (identifierPath) => resolveIdentifierInModule(identifierPath, configPath) ?? undefined,
    );
    if (isRecord(parsed)) {
      configObject = parsed;
    } else if (configModuleInfo) {
      const evalScope: Record<string, unknown> = {
        ...buildEvalScope(configModuleInfo, configPath),
        defineCssConfig: (input: unknown) => input,
      };
      const evaluated = evaluateExpression(defaultExpr, evalScope);
      if (isRecord(evaluated)) {
        configObject = evaluated;
      }
    }
  }

  const importsFromObject = Array.isArray(configObject.imports)
    ? configObject.imports.filter((entry): entry is string => typeof entry === "string")
    : [];
  const hasExplicitResolution = Object.prototype.hasOwnProperty.call(configObject, "resolution");
  const resolution = normalizeResolution(configObject.resolution);
  const debug = normalizeDebugOptions(configObject.debug);
  const breakpoints = normalizeBreakpoints(configObject.breakpoints);
  const containers = normalizeContainers(configObject.containers);

  const parsedUtilities = isRecord(configObject.utilities)
    ? parseCtConfig({ base: configObject.utilities }, { containers })
    : null;
  const utilityImports = parsedUtilities?.imports ?? [];

  const dedupedRawImports = Array.from(new Set([...sideEffectImports, ...importsFromObject, ...utilityImports]));
  const resolvedImports = dedupedRawImports
    .map((importPath) => toBrowserStylesheetPath(importPath, configPath, {
      projectRoot,
      viteAliases: resolverOptions.viteAliases,
      tsconfigResolver: resolverOptions.tsconfigResolver,
    }))
    .filter((entry): entry is string => Boolean(entry));
  const allImports = Array.from(new Set(resolvedImports));

  const include = normalizeIncludePaths(configObject.include, projectRoot);
  const utilitiesParsed = parsedUtilities?.base ?? {};

  const utilityRules = Object.entries(utilitiesParsed)
    .flatMap(([name, declaration]) =>
      toCssRules(`u-${camelToKebab(name)}`, declaration, { breakpoints, containers })
    );
  const utilityCss = resolution === "dynamic" ? "" : utilityRules.join("\n");

  const runtimeOptions: LoadedCssConfig["runtimeOptions"] = {};
  if (Object.keys(breakpoints).length > 0) {
    runtimeOptions.breakpoints = breakpoints;
  }
  if (Object.keys(containers).length > 0) {
    runtimeOptions.containers = containers;
  }
  if (Object.keys(utilitiesParsed).length > 0) {
    runtimeOptions.utilities = utilitiesParsed;
  }
  runtimeOptions.resolution = resolution;

  return {
    path: configPath,
    imports: allImports,
    resolution,
    hasExplicitResolution,
    debug,
    breakpoints,
    containers,
    include,
    utilities: utilitiesParsed,
    utilityCss,
    runtimeOptions,
  };
}

function getTsTranspiler(): ((source: string) => string) | null {
  if (tsTranspiler !== undefined) {
    return tsTranspiler;
  }

  const requireFn = getNodeRequire();
  if (!requireFn) {
    tsTranspiler = null;
    return null;
  }

  try {
    const nodeRequire = requireFn;
    const typescript = nodeRequire("typescript") as {
      transpileModule: (
        source: string,
        options: {
          compilerOptions: {
            target: number;
            module: number;
          };
        },
      ) => { outputText: string };
      ScriptTarget: { ES2020: number };
      ModuleKind: { ESNext: number };
    };

    tsTranspiler = (source: string): string =>
      typescript.transpileModule(source, {
        compilerOptions: {
          target: typescript.ScriptTarget.ES2020,
          module: typescript.ModuleKind.ESNext,
        },
      }).outputText;
    return tsTranspiler;
  } catch {
    tsTranspiler = null;
    return null;
  }
}

function transpileTsSnippet(source: string): string {
  const transpile = getTsTranspiler();
  if (!transpile) {
    return source.trim();
  }

  let output = transpile(source)
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
    .trim();
  while (output.endsWith(";")) {
    output = output.slice(0, -1).trimEnd();
  }
  return output;
}

function evaluateExpression(source: string, scope: Record<string, unknown>): unknown | null {
  const jsSource = transpileTsSnippet(`(${source})`);
  try {
    const names = Object.keys(scope);
    const values = names.map((name) => scope[name]);
    const fn = new Function(...names, `"use strict"; return ${jsSource};`);
    return fn(...values);
  } catch {
    return null;
  }
}

function evaluateFunctionDeclaration(source: string, scope: Record<string, unknown>): unknown | null {
  try {
    const jsSource = transpileTsSnippet(source);
    const names = Object.keys(scope);
    const values = names.map((name) => scope[name]);
    const fn = new Function(...names, `"use strict"; return (${jsSource});`);
    return fn(...values);
  } catch {
    return null;
  }
}

function resolveFileFromBase(basePath: string): string | null {
  const candidates: string[] = [];
  if (getNodePath().extname(basePath)) {
    candidates.push(basePath);
  } else {
    for (const extension of STATIC_STYLE_EXTENSIONS) {
      candidates.push(`${basePath}${extension}`);
      candidates.push(getNodePath().join(basePath, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    if (getNodeFs().existsSync(candidate) && getNodeFs().statSync(candidate).isFile()) {
      return getNodePath().normalize(candidate);
    }
  }

  return null;
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let isEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = i + 1 < input.length ? input[i + 1] : "";

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function removeTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      output += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let cursor = i + 1;
      while (cursor < input.length && /\s/.test(input[cursor])) {
        cursor += 1;
      }
      if (cursor < input.length && (input[cursor] === "}" || input[cursor] === "]")) {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function parseJsonc(input: string): unknown | null {
  const withoutComments = stripJsonComments(input);
  const cleaned = removeTrailingCommas(withoutComments);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function parseJsoncFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = getNodeFs().readFileSync(filePath, "utf8");
    const parsed = parseJsonc(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveTsconfigExtendsPath(configDir: string, extendsValue: string): string | null {
  if (extendsValue.startsWith(".")) {
    const withExtension = extendsValue.endsWith(".json") ? extendsValue : `${extendsValue}.json`;
    return getNodePath().resolve(configDir, withExtension);
  }

  if (extendsValue.startsWith("/")) {
    return extendsValue;
  }

  const candidate = getNodePath().resolve(configDir, "node_modules", extendsValue);
  if (getNodeFs().existsSync(candidate) && getNodeFs().statSync(candidate).isFile()) {
    return candidate;
  }
  if (getNodeFs().existsSync(`${candidate}.json`) && getNodeFs().statSync(`${candidate}.json`).isFile()) {
    return `${candidate}.json`;
  }
  const nested = getNodePath().resolve(candidate, "tsconfig.json");
  if (getNodeFs().existsSync(nested) && getNodeFs().statSync(nested).isFile()) {
    return nested;
  }

  return null;
}

function loadTsconfigCompilerOptions(
  tsconfigPath: string,
  visited = new Set<string>(),
): {
  baseUrl?: string;
  paths?: Record<string, string[]>;
} | null {
  const normalizedPath = getNodePath().normalize(tsconfigPath);
  if (visited.has(normalizedPath)) {
    return null;
  }
  visited.add(normalizedPath);

  const config = parseJsoncFile(normalizedPath);
  if (!config) {
    return null;
  }

  const configDir = getNodePath().dirname(normalizedPath);
  let mergedBaseUrl: string | undefined;
  let mergedPaths: Record<string, string[]> = {};

  const rawExtends = config.extends;
  if (typeof rawExtends === "string") {
    const parentPath = resolveTsconfigExtendsPath(configDir, rawExtends);
    if (parentPath) {
      const parent = loadTsconfigCompilerOptions(parentPath, visited);
      if (parent?.baseUrl) {
        mergedBaseUrl = getNodePath().resolve(getNodePath().dirname(parentPath), parent.baseUrl);
      }
      if (parent?.paths) {
        mergedPaths = { ...parent.paths };
      }
    }
  }

  const rawCompilerOptions = config.compilerOptions;
  if (isRecord(rawCompilerOptions)) {
    const rawBaseUrl = rawCompilerOptions.baseUrl;
    if (typeof rawBaseUrl === "string") {
      mergedBaseUrl = getNodePath().resolve(configDir, rawBaseUrl);
    }

    const rawPaths = rawCompilerOptions.paths;
    if (isRecord(rawPaths)) {
      for (const [pattern, targetValue] of Object.entries(rawPaths)) {
        if (!Array.isArray(targetValue)) {
          continue;
        }
        const targets = targetValue.filter((entry): entry is string => typeof entry === "string");
        if (targets.length > 0) {
          mergedPaths[pattern] = targets;
        }
      }
    }
  }

  return {
    baseUrl: mergedBaseUrl ?? configDir,
    paths: mergedPaths,
  };
}

function createTsconfigResolver(projectRoot: string): TsconfigPathResolver | null {
  const tsconfigPath = getNodePath().resolve(projectRoot, "tsconfig.json");
  if (!getNodeFs().existsSync(tsconfigPath) || !getNodeFs().statSync(tsconfigPath).isFile()) {
    return null;
  }

  const compilerOptions = loadTsconfigCompilerOptions(tsconfigPath);
  if (!compilerOptions?.paths) {
    return null;
  }

  const baseUrl = compilerOptions.baseUrl ?? projectRoot;
  const pathMatchers: TsconfigPathMatcher[] = [];

  for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
    const wildcardIndex = pattern.indexOf("*");
    const hasWildcard = wildcardIndex !== -1;
    const prefix = hasWildcard ? pattern.slice(0, wildcardIndex) : pattern;
    const suffix = hasWildcard ? pattern.slice(wildcardIndex + 1) : "";

    pathMatchers.push({
      pattern,
      prefix,
      suffix,
      hasWildcard,
      targets,
    });
  }

  pathMatchers.sort((a, b) => b.pattern.length - a.pattern.length);

  return {
    resolve(source: string): string | null {
      for (const matcher of pathMatchers) {
        let wildcardValue = "";

        if (matcher.hasWildcard) {
          if (!source.startsWith(matcher.prefix)) {
            continue;
          }
          if (!source.endsWith(matcher.suffix)) {
            continue;
          }
          const dynamicStart = matcher.prefix.length;
          const dynamicEnd = source.length - matcher.suffix.length;
          if (dynamicEnd < dynamicStart) {
            continue;
          }
          wildcardValue = source.slice(dynamicStart, dynamicEnd);
        } else if (source !== matcher.pattern) {
          continue;
        }

        for (const target of matcher.targets) {
          const resolvedTarget = matcher.hasWildcard ? target.replace(/\*/g, wildcardValue) : target;
          const candidateBase = getNodePath().isAbsolute(resolvedTarget)
            ? resolvedTarget
            : getNodePath().resolve(baseUrl, resolvedTarget);
          const resolvedFile = resolveFileFromBase(candidateBase);
          if (resolvedFile) {
            return resolvedFile;
          }
        }
      }

      const baseUrlFallback = resolveFileFromBase(getNodePath().resolve(baseUrl, source));
      return baseUrlFallback;
    },
  };
}

function normalizeViteAliases(alias: unknown): ViteAliasEntry[] {
  if (Array.isArray(alias)) {
    return alias
      .filter((entry): entry is ViteAliasEntry => {
        if (!isRecord(entry)) {
          return false;
        }
        const find = entry.find;
        const replacement = entry.replacement;
        if (typeof replacement !== "string") {
          return false;
        }
        return typeof find === "string" || find instanceof RegExp;
      })
      .map((entry) => ({
        find: entry.find,
        replacement: entry.replacement,
      }));
  }

  if (!isRecord(alias)) {
    return [];
  }

  return Object.entries(alias)
    .filter(([, replacement]) => typeof replacement === "string")
    .map(([find, replacement]) => ({
      find,
      replacement: replacement as string,
    }));
}

function applyViteAlias(source: string, alias: ViteAliasEntry): string | null {
  if (typeof alias.find === "string") {
    if (source === alias.find) {
      return alias.replacement;
    }
    if (source.startsWith(`${alias.find}/`)) {
      return `${alias.replacement}${source.slice(alias.find.length)}`;
    }
    return null;
  }

  alias.find.lastIndex = 0;
  if (!alias.find.test(source)) {
    return null;
  }
  alias.find.lastIndex = 0;
  return source.replace(alias.find, alias.replacement);
}

function resolveAliasedPath(importerId: string, source: string, projectRoot: string): string | null {
  if (source.startsWith(".")) {
    return resolveFileFromBase(getNodePath().resolve(getNodePath().dirname(importerId), source));
  }

  if (getNodePath().isAbsolute(source)) {
    const rootRelative = resolveFileFromBase(getNodePath().resolve(projectRoot, `.${source}`));
    if (rootRelative) {
      return rootRelative;
    }
    const resolved = resolveFileFromBase(source);
    if (resolved) {
      return resolved;
    }
    return null;
  }

  return resolveFileFromBase(getNodePath().resolve(projectRoot, source));
}

function inferProjectRootFromImporter(importerId: string): string | null {
  const normalized = getNodePath().normalize(importerId);
  const marker = `${getNodePath().sep}src${getNodePath().sep}`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const inferred = normalized.slice(0, markerIndex);
  return inferred || getNodePath().parse(normalized).root;
}

function resolveImportToFile(importerId: string, source: string, options: ImportResolverOptions): string | null {
  if (source.startsWith(".")) {
    const base = getNodePath().resolve(getNodePath().dirname(importerId), source);
    return resolveFileFromBase(base);
  }

  if (source.startsWith("/")) {
    const resolvedRootRelative = resolveFileFromBase(getNodePath().resolve(options.projectRoot, `.${source}`));
    if (resolvedRootRelative) {
      return resolvedRootRelative;
    }
    return resolveFileFromBase(source);
  }

  for (const alias of options.viteAliases) {
    const aliased = applyViteAlias(source, alias);
    if (!aliased) {
      continue;
    }

    const resolvedAliased = resolveAliasedPath(importerId, aliased, options.projectRoot);
    if (resolvedAliased) {
      return resolvedAliased;
    }
  }

  if (source === "$lib" || source.startsWith("$lib/")) {
    const projectRoot = inferProjectRootFromImporter(importerId) ?? options.projectRoot;
    if (!projectRoot) {
      return null;
    }

    const suffix = source === "$lib" ? "" : source.slice("$lib/".length);
    const base = getNodePath().join(projectRoot, "src", "lib", suffix);
    return resolveFileFromBase(base);
  }

  if (options.tsconfigResolver) {
    const resolved = options.tsconfigResolver.resolve(source);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function moduleIdToFilePath(id: string, projectRoot: string): string | null {
  if (id.startsWith("\0")) {
    return null;
  }

  let normalizedId = id;
  if (normalizedId.startsWith("file://")) {
    try {
      const url = new URL(normalizedId);
      if (url.protocol !== "file:") {
        return null;
      }
      normalizedId = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(normalizedId)) {
        normalizedId = normalizedId.slice(1);
      }
    } catch {
      return null;
    }
  }

  if (getNodePath().isAbsolute(normalizedId)) {
    const absolute = getNodePath().normalize(normalizedId);
    if (getNodeFs().existsSync(absolute)) {
      return absolute;
    }

    const rootRelative = getNodePath().resolve(projectRoot, `.${normalizedId}`);
    if (getNodeFs().existsSync(rootRelative)) {
      return getNodePath().normalize(rootRelative);
    }

    return absolute;
  }

  return getNodePath().normalize(getNodePath().resolve(projectRoot, normalizedId));
}

function isPathWithinScope(filePath: string, scopePath: string): boolean {
  const relative = getNodePath().relative(scopePath, filePath);
  return relative === "" || (!relative.startsWith("..") && !getNodePath().isAbsolute(relative));
}

function isInDefaultTransformScope(id: string, projectRoot: string, includePaths: readonly string[]): boolean {
  const modulePath = moduleIdToFilePath(id, projectRoot);
  if (!modulePath) {
    return false;
  }

  const srcPath = getNodePath().resolve(projectRoot, "src");
  if (isPathWithinScope(modulePath, srcPath)) {
    return true;
  }

  for (const includePath of includePaths) {
    if (isPathWithinScope(modulePath, includePath)) {
      return true;
    }
  }

  return false;
}

/** Options for {@link cssTsPlugin}. */
export interface CssTsPluginOptions {
  /** Override the default scope (`<root>/src/**`) with a custom id matcher. */
  include?: RegExp;
}

/**
 * Vite plugin that extracts `ct()` usage and emits a virtual stylesheet.
 */
export function cssTsPlugin(options: CssTsPluginOptions = {}): any {
  const moduleImports = new Map<string, string[]>();
  const moduleCss = new Map<string, string>();
  let server: ViteDevServerLike | undefined;
  let projectRoot = process.cwd();
  let viteAliases: ViteAliasEntry[] = [];
  let tsconfigResolver: TsconfigPathResolver | null = null;
  let cssConfig: LoadedCssConfig = {
    path: null,
    imports: [],
    resolution: "hybrid",
    hasExplicitResolution: false,
    debug: {
      logDynamic: false,
      logStatic: false,
    },
    breakpoints: {},
    containers: {},
    include: [],
    utilities: {},
    utilityCss: "",
    runtimeOptions: {},
  };
  let resolverInitialized = false;

  function initializeResolvers(root: string): void {
    projectRoot = root;
    tsconfigResolver = createTsconfigResolver(root);
    cssConfig = loadCssConfig(root, { viteAliases, tsconfigResolver });
    resolverInitialized = true;
  }

  function ensureResolvers(importerId: string): void {
    if (resolverInitialized) {
      return;
    }
    const inferredRoot = inferProjectRootFromImporter(importerId);
    initializeResolvers(inferredRoot ?? projectRoot);
  }

  function combinedCss(): string {
    const parts: string[] = [];
    for (const cssImport of cssConfig.imports) {
      parts.push(`@import "${cssImport}";`);
    }
    const dedupedModuleImports = new Set<string>();
    for (const imports of moduleImports.values()) {
      for (const cssImport of imports) {
        dedupedModuleImports.add(cssImport);
      }
    }
    for (const cssImport of dedupedModuleImports) {
      parts.push(`@import "${cssImport}";`);
    }
    if (cssConfig.utilityCss) {
      parts.push(cssConfig.utilityCss);
    }
    parts.push(mergeCss(moduleCss.values()));
    return parts.filter((part) => part.length > 0).join("\n");
  }

  function invalidateVirtualModule(): void {
    if (!server) return;
    const module = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
    if (module) {
      server.moduleGraph.invalidateModule(module);
    }
  }

  return {
    name: "css-ts",
    enforce: "pre",

    configureServer(devServer: ViteDevServerLike) {
      server = devServer;
    },

    configResolved(config: ViteResolvedConfigLike) {
      projectRoot = config.root;
      viteAliases = normalizeViteAliases(config.resolve.alias);
      initializeResolvers(projectRoot);
    },

    resolveId(id: string) {
      if (cleanId(id) === PUBLIC_VIRTUAL_ID) {
        const suffix = id.slice(PUBLIC_VIRTUAL_ID.length);
        return `${RESOLVED_VIRTUAL_ID}${suffix}`;
      }
      return null;
    },

    load(id: string) {
      if (cleanId(id) === RESOLVED_VIRTUAL_ID) {
        return combinedCss();
      }
      return null;
    },

    transform(code: string, id: string) {
      if (isVirtualSubRequest(id)) {
        return null;
      }

      const normalizedId = cleanId(id);
      ensureResolvers(normalizedId);
      if (!supportsTransform(normalizedId)) {
        return null;
      }
      if (options.include && !options.include.test(normalizedId)) {
        return null;
      }
      if (!options.include && !isInDefaultTransformScope(normalizedId, projectRoot, cssConfig.include)) {
        return null;
      }
      const isSvelte = normalizedId.endsWith(".svelte");
      const isAstro = normalizedId.endsWith(".astro");
      let nextCode = code;

      if (!isSvelte && !isAstro && !hasCssTsImport(code)) {
        return null;
      }

      const calls = findCtCalls(nextCode);
      const newCtDecls = findNewCtDeclarations(nextCode);
      if (calls.length === 0 && newCtDecls.length === 0) {
        if (!isSvelte && !isAstro) {
          return null;
        }

        const usesStylesCall = /\bstyles\s*\(\s*\)/.test(nextCode);
        if (!usesStylesCall) {
          return null;
        }

        nextCode = isSvelte ? addVirtualImportToSvelte(nextCode) : addVirtualImportToAstro(nextCode);
        return {
          code: nextCode,
          map: null,
        };
      }

      const replacements: Array<{ start: number; end: number; text: string }> = [];
      const importRules = new Set<string>();
      const rules = new Set<string>();
      const resolution = isAstro && !cssConfig.hasExplicitResolution ? "static" : cssConfig.resolution;
      const runtimeOptionsForRuntime: LoadedCssConfig["runtimeOptions"] = {
        ...cssConfig.runtimeOptions,
      };
      runtimeOptionsForRuntime.resolution = resolution;
      if (server && (cssConfig.debug.logDynamic || cssConfig.debug.logStatic)) {
        runtimeOptionsForRuntime.debug = {
          enabled: true,
          logDynamic: cssConfig.debug.logDynamic,
          logStatic: cssConfig.debug.logStatic,
        };
      }
      const runtimeOptionsLiteral = JSON.stringify(runtimeOptionsForRuntime);
      const shouldLogStatic = Boolean(server && cssConfig.debug.logStatic);
      const moduleInfoCache = new Map<string, ModuleStaticInfo>();
      const constValueCache = new Map<string, unknown | null>();
      const resolving = new Set<string>();

      function lineAt(index: number): number {
        let line = 1;
        for (let i = 0; i < index; i += 1) {
          if (nextCode[i] === "\n") {
            line += 1;
          }
        }
        return line;
      }

      function staticResolutionError(message: string, index: number): Error {
        return new Error(`[css-ts] ${message} (${normalizedId}:${lineAt(index)})`);
      }

      function logStatic(message: string): void {
        if (!shouldLogStatic) {
          return;
        }
        console.log(`[css-ts][static] ${normalizedId} ${message}`);
      }

      function withRuntimeOptionsInNewCtDeclaration(declarationSource: string): string {
        const replaced = declarationSource.replace(
          /new\s+ct\s*\(\s*\)/,
          `new ct(undefined, undefined, ${runtimeOptionsLiteral})`,
        );
        return replaced;
      }

      function readMemberPath(value: unknown, members: readonly string[]): unknown | null {
        let current: unknown = value;
        for (const member of members) {
          if (typeof current !== "object" || current === null || Array.isArray(current)) {
            return null;
          }
          const record = current as Record<string, unknown>;
          if (!(member in record)) {
            return null;
          }
          current = record[member];
        }
        return current;
      }

      function getModuleCode(moduleId: string): string | null {
        if (moduleId === normalizedId) {
          return code;
        }
        try {
          return getNodeFs().readFileSync(moduleId, "utf8");
        } catch {
          return null;
        }
      }

      function getModuleInfo(moduleId: string): ModuleStaticInfo | null {
        const cached = moduleInfoCache.get(moduleId);
        if (cached) {
          return cached;
        }
        const moduleCode = getModuleCode(moduleId);
        if (!moduleCode) {
          return null;
        }
        const parsed = parseModuleStaticInfo(moduleCode);
        moduleInfoCache.set(moduleId, parsed);
        return parsed;
      }

      function resolveIdentifierInModule(identifierPath: readonly string[], moduleId: string): unknown | null {
        if (identifierPath.length === 0) {
          return null;
        }

        const cacheKey = `${moduleId}::${identifierPath.join(".")}`;
        if (constValueCache.has(cacheKey)) {
          return constValueCache.get(cacheKey) ?? null;
        }
        if (resolving.has(cacheKey)) {
          return null;
        }

        resolving.add(cacheKey);
        let resolved: unknown | null = null;
        const [head, ...tail] = identifierPath;

        const moduleInfo = getModuleInfo(moduleId);
        if (moduleInfo) {
          const buildEvalScope = (excludeName?: string): Record<string, unknown> => {
            const evalScope: Record<string, unknown> = {
              ...STATIC_EVAL_GLOBALS,
            };
            for (const localName of moduleInfo.functionDeclarations.keys()) {
              if (localName === excludeName) {
                continue;
              }
              const localValue = resolveIdentifierInModule([localName], moduleId);
              if (localValue !== null) {
                evalScope[localName] = localValue;
              }
            }
            for (const localName of moduleInfo.constInitializers.keys()) {
              if (localName === excludeName) {
                continue;
              }
              const localValue = resolveIdentifierInModule([localName], moduleId);
              if (localValue !== null) {
                evalScope[localName] = localValue;
              }
            }
            for (const localName of moduleInfo.imports.keys()) {
              const localValue = resolveIdentifierInModule([localName], moduleId);
              if (localValue !== null) {
                evalScope[localName] = localValue;
              }
            }
            return evalScope;
          };

          const initializer = moduleInfo.constInitializers.get(head);
          if (initializer !== undefined) {
            let value = parseStaticExpression(initializer, (nestedPath) => {
              const nested = resolveIdentifierInModule(nestedPath, moduleId);
              return nested === null ? undefined : nested;
            });

            if (value === null) {
              value = evaluateExpression(initializer, buildEvalScope(head));
            }

            if (value !== null) {
              resolved = tail.length > 0 ? readMemberPath(value, tail) : value;
            }
          } else {
            const functionDeclaration = moduleInfo.functionDeclarations.get(head);
            if (functionDeclaration !== undefined) {
              const functionValue = evaluateFunctionDeclaration(
                functionDeclaration,
                buildEvalScope(head),
              );
              if (functionValue !== null) {
                resolved = tail.length > 0 ? readMemberPath(functionValue, tail) : functionValue;
              }
            }
          }

          if (resolved === null) {
            const binding = moduleInfo.imports.get(head);
            if (binding) {
              const resolvedImportFile = resolveImportToFile(moduleId, binding.source, {
                projectRoot,
                viteAliases,
                tsconfigResolver,
              });
              if (resolvedImportFile) {
                const importedModuleInfo = getModuleInfo(resolvedImportFile);
                if (importedModuleInfo) {
                  if (binding.kind === "namespace") {
                    if (tail.length > 0) {
                      const [namespaceExport, ...namespaceTail] = tail;
                      const exportedLocalName =
                        importedModuleInfo.exportedConsts.get(namespaceExport) ?? namespaceExport;
                      const namespaceValue = resolveIdentifierInModule(
                        [exportedLocalName],
                        resolvedImportFile,
                      );
                      resolved = namespaceTail.length > 0
                        ? readMemberPath(namespaceValue, namespaceTail)
                        : namespaceValue;
                    }
                  } else {
                    const importedName = binding.kind === "default" ? "default" : binding.imported;
                    const exportedLocalName = importedName === "default"
                      ? null
                      : (importedModuleInfo.exportedConsts.get(importedName) ?? importedName);
                    const importedValue = resolveIdentifierInModule(
                      exportedLocalName
                        ? [exportedLocalName]
                        : ["default"],
                      resolvedImportFile,
                    );
                    resolved = tail.length > 0
                      ? readMemberPath(importedValue, tail)
                      : importedValue;
                  }
                }
              }
            }
          }

          if (resolved === null && head === "default" && moduleInfo.defaultExportExpression) {
            const parsedDefault = parseStaticExpression(
              moduleInfo.defaultExportExpression,
              (nestedPath) => resolveIdentifierInModule(nestedPath, moduleId) ?? undefined,
            );
            if (parsedDefault !== null) {
              resolved = tail.length > 0 ? readMemberPath(parsedDefault, tail) : parsedDefault;
            } else {
              const evaluatedDefault = evaluateExpression(
                moduleInfo.defaultExportExpression,
                buildEvalScope(),
              );
              if (evaluatedDefault !== null) {
                resolved = tail.length > 0 ? readMemberPath(evaluatedDefault, tail) : evaluatedDefault;
              }
            }
          }
        }

        resolving.delete(cacheKey);
        constValueCache.set(cacheKey, resolved);
        return resolved;
      }

      for (const call of calls) {
        if (resolution === "dynamic") {
          replacements.push({
            start: call.start,
            end: call.end,
            text: `ct(${call.arg}, undefined, ${runtimeOptionsLiteral})`,
          });
          continue;
        }

        const parsed = parseCtCallArguments(call.arg, {
          utilities: cssConfig.utilities,
          containers: cssConfig.containers,
        }) ??
          parseCtCallArgumentsWithResolver(
            call.arg,
            (identifierPath) => resolveIdentifierInModule(identifierPath, normalizedId) ?? undefined,
            {
              utilities: cssConfig.utilities,
              containers: cssConfig.containers,
            },
          );
        if (!parsed) {
          if (resolution === "static") {
            throw staticResolutionError(
              "resolution=\"static\" could not statically resolve ct(...)",
              call.start,
            );
          }
          replacements.push({
            start: call.start,
            end: call.end,
            text: `ct(${call.arg}, undefined, ${runtimeOptionsLiteral})`,
          });
          continue;
        }

        for (const importPath of parsed.imports ?? []) {
          const browserPath = toBrowserStylesheetPath(importPath, normalizedId, {
            projectRoot,
            viteAliases,
            tsconfigResolver,
          });
          if (browserPath) {
            importRules.add(browserPath);
            logStatic(`import -> ${browserPath}`);
          }
        }

        const classMap: Record<string, string> = {};
        const variantClassMap: Record<string, Record<string, Partial<Record<string, string>>>> = {};
        const compiledConfig: Record<string, unknown> = {};
        if ((parsed.imports?.length ?? 0) > 0) {
          compiledConfig.imports = true;
        }

        if (parsed.global) {
          for (
            const rule of toCssGlobalRules(parsed.global, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
            })
          ) {
            rules.add(rule);
          }
          compiledConfig.global = true;
          for (const selector of Object.keys(parsed.global)) {
            logStatic(`global.${selector}`);
          }
        }

        for (const [key, declaration] of Object.entries(parsed.base)) {
          const className = createClassName(key, declaration, normalizedId);
          classMap[key] = className;
          for (
            const rule of toCssRules(className, declaration, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
            })
          ) {
            rules.add(rule);
          }
        }
        compiledConfig.base = classMap;
        for (const [key, className] of Object.entries(classMap)) {
          logStatic(`base.${key} -> .${className}`);
        }

        if (parsed.variant) {
          for (const [group, variants] of Object.entries(parsed.variant)) {
            const groupMap: Record<string, Partial<Record<string, string>>> = {};
            for (const [variantName, declarations] of Object.entries(variants)) {
              const variantMap: Partial<Record<string, string>> = {};
              for (const [key, declaration] of Object.entries(declarations)) {
                const className = createClassName(
                  `${group}:${variantName}:${key}`,
                  declaration,
                  normalizedId,
                );
                variantMap[key] = className;
                for (
                  const rule of toCssRules(className, declaration, {
                    breakpoints: cssConfig.breakpoints,
                    containers: cssConfig.containers,
                  })
                ) {
                  rules.add(rule);
                }
                logStatic(`variant.${group}.${variantName}.${key} -> .${className}`);
              }
              groupMap[variantName] = variantMap;
            }
            variantClassMap[group] = groupMap;
          }
          compiledConfig.variant = variantClassMap;
        }

        const replacement = `ct(${call.arg}, ${JSON.stringify(compiledConfig)}, ${runtimeOptionsLiteral})`;
        replacements.push({ start: call.start, end: call.end, text: replacement });
      }

      for (const decl of newCtDecls) {
        const declarationSource = nextCode.slice(decl.start, decl.end);
        const runtimeDeclaration = withRuntimeOptionsInNewCtDeclaration(declarationSource);

        if (resolution === "dynamic") {
          replacements.push({ start: decl.start, end: decl.end, text: runtimeDeclaration });
          continue;
        }

        const addContainerMatcher = new RegExp(`\\b${decl.varName}\\.addContainer\\s*\\(`);
        if (addContainerMatcher.test(nextCode)) {
          if (resolution === "static") {
            throw staticResolutionError(
              `resolution="static" cannot statically resolve ${decl.varName}.addContainer(...)`,
              decl.start,
            );
          }
          replacements.push({ start: decl.start, end: decl.end, text: runtimeDeclaration });
          continue;
        }

        const configParts: Record<string, unknown> = {};
        const rawParts: Record<string, string> = {};
        let allParsed = true;

        for (const assignment of decl.assignments) {
          let value = parseStaticExpression(assignment.valueSource) ??
            parseStaticExpression(
              assignment.valueSource,
              (identifierPath) => resolveIdentifierInModule(identifierPath, normalizedId) ?? undefined,
            );
          if (value === null) {
            const moduleInfo = getModuleInfo(normalizedId);
            if (moduleInfo) {
              const evalScope: Record<string, unknown> = {
                ...STATIC_EVAL_GLOBALS,
              };
              for (const localName of moduleInfo.functionDeclarations.keys()) {
                const localValue = resolveIdentifierInModule([localName], normalizedId);
                if (localValue !== null) {
                  evalScope[localName] = localValue;
                }
              }
              for (const localName of moduleInfo.constInitializers.keys()) {
                const localValue = resolveIdentifierInModule([localName], normalizedId);
                if (localValue !== null) {
                  evalScope[localName] = localValue;
                }
              }
              for (const localName of moduleInfo.imports.keys()) {
                const localValue = resolveIdentifierInModule([localName], normalizedId);
                if (localValue !== null) {
                  evalScope[localName] = localValue;
                }
              }
              value = evaluateExpression(assignment.valueSource, evalScope);
            }
          }
          if (value === null) {
            allParsed = false;
            break;
          }
          configParts[assignment.property] = value;
          rawParts[assignment.property] = assignment.valueSource;
        }

        if (!allParsed) {
          if (resolution === "static") {
            throw staticResolutionError(
              `resolution="static" could not statically resolve assignments for ${decl.varName}`,
              decl.start,
            );
          }
          replacements.push({ start: decl.start, end: decl.end, text: runtimeDeclaration });
          continue;
        }

        const parsed = parseCtConfig(configParts, {
          utilities: cssConfig.utilities,
          containers: cssConfig.containers,
        });
        if (!parsed) {
          if (resolution === "static") {
            throw staticResolutionError(
              `resolution="static" could not statically resolve config for ${decl.varName}`,
              decl.start,
            );
          }
          replacements.push({ start: decl.start, end: decl.end, text: runtimeDeclaration });
          continue;
        }

        for (const importPath of parsed.imports ?? []) {
          const browserPath = toBrowserStylesheetPath(importPath, normalizedId, {
            projectRoot,
            viteAliases,
            tsconfigResolver,
          });
          if (browserPath) {
            importRules.add(browserPath);
            logStatic(`import -> ${browserPath}`);
          }
        }

        const classMap: Record<string, string> = {};
        const variantClassMap: Record<string, Record<string, Partial<Record<string, string>>>> = {};
        const compiledConfig: Record<string, unknown> = {};
        if ((parsed.imports?.length ?? 0) > 0) {
          compiledConfig.imports = true;
        }

        if (parsed.global) {
          for (
            const rule of toCssGlobalRules(parsed.global, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
            })
          ) {
            rules.add(rule);
          }
          compiledConfig.global = true;
          for (const selector of Object.keys(parsed.global)) {
            logStatic(`global.${selector}`);
          }
        }

        for (const [key, declaration] of Object.entries(parsed.base)) {
          const className = createClassName(key, declaration, normalizedId);
          classMap[key] = className;
          for (
            const rule of toCssRules(className, declaration, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
            })
          ) {
            rules.add(rule);
          }
        }
        compiledConfig.base = classMap;
        for (const [key, className] of Object.entries(classMap)) {
          logStatic(`base.${key} -> .${className}`);
        }

        if (parsed.variant) {
          for (const [group, variants] of Object.entries(parsed.variant)) {
            const groupMap: Record<string, Partial<Record<string, string>>> = {};
            for (const [variantName, declarations] of Object.entries(variants)) {
              const variantMap: Partial<Record<string, string>> = {};
              for (const [key, declaration] of Object.entries(declarations)) {
                const className = createClassName(
                  `${group}:${variantName}:${key}`,
                  declaration,
                  normalizedId,
                );
                variantMap[key] = className;
                for (
                  const rule of toCssRules(className, declaration, {
                    breakpoints: cssConfig.breakpoints,
                    containers: cssConfig.containers,
                  })
                ) {
                  rules.add(rule);
                }
                logStatic(`variant.${group}.${variantName}.${key} -> .${className}`);
              }
              groupMap[variantName] = variantMap;
            }
            variantClassMap[group] = groupMap;
          }
          compiledConfig.variant = variantClassMap;
        }

        const configEntries = Object.entries(rawParts)
          .map(([key, raw]) => `${key}: ${raw}`)
          .join(", ");
        const ctCall =
          `ct({ ${configEntries} }, ${JSON.stringify(compiledConfig)}, ${runtimeOptionsLiteral})`;
        replacements.push({ start: decl.start, end: decl.end, text: `const ${decl.varName} = ${ctCall}` });

        for (const assignment of decl.assignments) {
          replacements.push({ start: assignment.start, end: assignment.end, text: "" });
        }
      }

      if (replacements.length === 0) {
        return null;
      }

      replacements.sort((a, b) => b.start - a.start);

      for (const replacement of replacements) {
        nextCode =
          nextCode.slice(0, replacement.start) +
          replacement.text +
          nextCode.slice(replacement.end);
      }

      let didVirtualCssChange = false;

      if (isSvelte) {
        nextCode = addVirtualImportToSvelte(nextCode);
        nextCode = addSvelteStyleBlock(nextCode, rules);
        const nextImports = Array.from(importRules);
        const prevImports = moduleImports.get(normalizedId) ?? [];
        const importsChanged = nextImports.length !== prevImports.length ||
          nextImports.some((entry, index) => entry !== prevImports[index]);
        if (importsChanged) {
          if (nextImports.length > 0) {
            moduleImports.set(normalizedId, nextImports);
          } else {
            moduleImports.delete(normalizedId);
          }
          didVirtualCssChange = true;
        }
        if (moduleCss.delete(normalizedId)) {
          didVirtualCssChange = true;
        }
      } else {
        nextCode = isAstro ? addVirtualImportToAstro(nextCode) : addVirtualImport(nextCode);
        const nextImports = Array.from(importRules);
        const prevImports = moduleImports.get(normalizedId) ?? [];
        const importsChanged = nextImports.length !== prevImports.length ||
          nextImports.some((entry, index) => entry !== prevImports[index]);
        if (importsChanged) {
          if (nextImports.length > 0) {
            moduleImports.set(normalizedId, nextImports);
          } else {
            moduleImports.delete(normalizedId);
          }
          didVirtualCssChange = true;
        }

        const nextCss = mergeCss(rules);
        const prevCss = moduleCss.get(normalizedId) ?? "";
        if (prevCss !== nextCss) {
          if (nextCss.length > 0) {
            moduleCss.set(normalizedId, nextCss);
          } else {
            moduleCss.delete(normalizedId);
          }
          didVirtualCssChange = true;
        }
      }
      if (didVirtualCssChange) {
        invalidateVirtualModule();
      }

      return {
        code: nextCode,
        map: null,
      };
    },

    handleHotUpdate(ctx: { file: string }) {
      const normalizedId = cleanId(ctx.file);
      if (cssConfig.path && normalizedId === cleanId(cssConfig.path)) {
        cssConfig = loadCssConfig(projectRoot, { viteAliases, tsconfigResolver });
        invalidateVirtualModule();
      }
      if (moduleCss.has(normalizedId)) {
        moduleCss.delete(normalizedId);
        invalidateVirtualModule();
      }
      if (moduleImports.has(normalizedId)) {
        moduleImports.delete(normalizedId);
        invalidateVirtualModule();
      }
    },
  };
}

/** Default export for {@link cssTsPlugin}. */
export default cssTsPlugin;
