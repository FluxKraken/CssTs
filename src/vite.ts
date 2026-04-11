import {
  findCtCalls,
  findExpressionTerminator,
  findNewCtDeclarations,
  parseCtBuilderOptions,
  parseCtCallArguments,
  parseCtCallArgumentsWithResolver,
  parseCtConfig,
  parseStaticExpression,
} from "./parser.js";
import runtimeCt from "./runtime.js";
import {
  camelToKebab,
  createClassName,
  cv,
  font,
  isCssVarRef,
  mergeTailwindClassNames,
  rootVarsToGlobalRules,
  type StyleDeclaration,
  type StyleSheet,
  type StyleValue,
  type ThemeMode,
  Theme,
  toCssGlobalRules,
  toCssLayerOrderRule,
  toCssRules,
  tv,
  tw,
} from "./shared.js";

const PUBLIC_VIRTUAL_ID = "virtual:css-ts/styles.css";
const RESOLVED_VIRTUAL_ID = "\0virtual:css-ts/styles.css";
const PUBLIC_TAILWIND_RUNTIME_ID = "virtual:css-ts/tailwind-merge";
const RESOLVED_TAILWIND_RUNTIME_ID = "\0virtual:css-ts/tailwind-merge";
const MODULE_VIRTUAL_QUERY_KEY = "css-ts-module";
const SIMPLE_STYLE_KEY = "__css_ts_simple__";
const STATIC_STYLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
];
const IMAGE_ASSET_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);
const CSS_CONFIG_FILENAMES = [
  "css.config.ts",
  "css.config.mts",
  "css.config.js",
  "css.config.mjs",
  "css.config.cts",
  "css.config.cjs",
] as const;
const PROJECT_ROOT_MARKERS = [
  ...CSS_CONFIG_FILENAMES,
  "package.json",
  "deno.json",
  "tsconfig.json",
] as const;

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
  constInitializers: Map<
    string,
    { initializer: string; start: number; end: number; exported: boolean }
  >;
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
  getModulesByFile?: (file: string) => Set<unknown> | undefined;
  invalidateModule: (
    module: unknown,
    invalidatedModules?: Set<unknown>,
    timestamp?: number,
    isHmr?: boolean,
  ) => void;
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

type ViteTransformContextLike = {
  addWatchFile?: (id: string) => void;
};

type ImportResolverOptions = {
  projectRoot: string;
  viteRoot: string;
  viteAliases: readonly ViteAliasEntry[];
  tsconfigResolver: TsconfigPathResolver | null;
};

type LoadedCssConfig = {
  path: string | null;
  dependencies: string[];
  imports: string[];
  themeMode: ThemeMode;
  resolution: "static" | "dynamic" | "hybrid";
  hasExplicitResolution: boolean;
  debug: {
    logDynamic: boolean;
    logStatic: boolean;
  };
  breakpoints: Record<string, string>;
  containers: Record<string, { type?: string; rule: string }>;
  layers: string[];
  defaultUnit?: string;
  include: string[];
  utilities: NormalizedStyleSheet;
  configCss: string;
  utilityCss: string;
  runtimeOptions: {
    breakpoints?: Record<string, string>;
    containers?: Record<string, { type?: string; rule: string }>;
    layers?: string[];
    defaultUnit?: string;
    utilities?: NormalizedStyleSheet;
    themeMode?: ThemeMode;
    resolution?: "static" | "dynamic" | "hybrid";
    debug?: {
      enabled?: boolean;
      logDynamic?: boolean;
      logStatic?: boolean;
    };
  };
};

type ResolvedStyleDefinition = {
  kind: "css-ts-style";
  declaration: StyleDeclaration;
  tailwindClassNames?: readonly string[];
};
type NormalizedStyleSheet = Record<string, ResolvedStyleDefinition>;

type NodeFs = typeof import("node:fs");
type NodePath = typeof import("node:path");
type NodeModule = typeof import("node:module");
type NodeRequire = (id: string) => unknown;
type NodeRequireWithResolve = NodeRequire & {
  resolve?: (id: string) => string;
};
type TypeScriptTranspileApi = {
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
type TypeScriptAstApi = TypeScriptTranspileApi & {
  createSourceFile: (
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number,
  ) => unknown;
  ScriptKind: Record<string, number>;
  SyntaxKind: Record<string, number>;
  forEachChild: (node: unknown, cbNode: (node: unknown) => void) => void;
};
type AstCtCall = {
  start: number;
  end: number;
  arg: string;
};
type AstNewCtAssignment = {
  property: string;
  start: number;
  end: number;
  valueSource: string;
};
type AstNewCtDeclaration = {
  varName: string;
  start: number;
  initializerStart: number;
  initializerEnd: number;
  optionsSource?: string;
  hasStaticOptions: boolean;
  simple: boolean;
  hasAddContainerCall: boolean;
  assignments: AstNewCtAssignment[];
};
type AstTransformTargets = {
  calls: AstCtCall[];
  newCtDecls: AstNewCtDeclaration[];
};

let nodeFs: NodeFs | null | undefined;
let nodePath: NodePath | null | undefined;
let nodeRequire: NodeRequire | null | undefined;
let typeScriptModule: TypeScriptTranspileApi | null | undefined;
let tsTranspiler: ((source: string) => string) | null | undefined;

function getBuiltinModule(id: string): unknown | null {
  const processValue = (globalThis as { process?: unknown }).process;
  if (!processValue || typeof processValue !== "object") {
    return null;
  }

  const getBuiltinModule =
    (processValue as { getBuiltinModule?: unknown }).getBuiltinModule;
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
    const req = new Function(
      'return typeof require === "function" ? require : null;',
    )();
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

function isTypeScriptTranspileApi(
  value: unknown,
): value is TypeScriptTranspileApi {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TypeScriptTranspileApi>;
  return (
    typeof candidate.transpileModule === "function" &&
    typeof candidate.ScriptTarget?.ES2020 === "number" &&
    typeof candidate.ModuleKind?.ESNext === "number"
  );
}

function loadTypeScriptModuleFromDisk(
  requireFn: NodeRequire,
): TypeScriptTranspileApi | null {
  const requireWithResolve = requireFn as NodeRequireWithResolve;
  if (typeof requireWithResolve.resolve !== "function") {
    return null;
  }

  try {
    const modulePath = requireWithResolve.resolve(
      "typescript/lib/typescript.js",
    );
    const fs = getNodeFs();
    const path = getNodePath();
    const source = fs.readFileSync(modulePath, "utf8");
    const module = { exports: {} as unknown };
    const exports = module.exports;

    // Deno's CommonJS interop can return an empty namespace for typescript; execute the CJS bundle directly instead.
    const loaded = new Function(
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
      `${source}\nreturn module.exports;`,
    )(exports, requireFn, module, modulePath, path.dirname(modulePath));

    return isTypeScriptTranspileApi(loaded) ? loaded : null;
  } catch {
    return null;
  }
}

function loadTypeScriptModule(
  requireFn: NodeRequire,
): TypeScriptTranspileApi | null {
  try {
    const loaded = requireFn("typescript");
    if (isTypeScriptTranspileApi(loaded)) {
      return loaded;
    }

    if (
      loaded &&
      typeof loaded === "object" &&
      "default" in (loaded as Record<string, unknown>) &&
      isTypeScriptTranspileApi((loaded as Record<string, unknown>).default)
    ) {
      return (loaded as { default: TypeScriptTranspileApi }).default;
    }
  } catch {
    // fall through to the disk-backed fallback
  }

  return loadTypeScriptModuleFromDisk(requireFn);
}

function getTypeScriptModule(): TypeScriptTranspileApi | null {
  if (typeScriptModule !== undefined) {
    return typeScriptModule;
  }

  const requireFn = getNodeRequire();
  if (!requireFn) {
    typeScriptModule = null;
    return null;
  }

  typeScriptModule = loadTypeScriptModule(requireFn);
  return typeScriptModule;
}

function getTypeScriptAstApi(): TypeScriptAstApi | null {
  const typescript = getTypeScriptModule();
  if (
    !typescript ||
    typeof (typescript as Partial<TypeScriptAstApi>).createSourceFile !==
      "function" ||
    typeof (typescript as Partial<TypeScriptAstApi>).forEachChild !==
      "function" ||
    typeof typescript.ScriptTarget?.ES2020 !== "number" ||
    typeof (typescript as Partial<TypeScriptAstApi>).ScriptKind?.TSX !==
      "number" ||
    typeof (typescript as Partial<TypeScriptAstApi>).SyntaxKind
        ?.CallExpression !==
      "number"
  ) {
    return null;
  }

  return typescript as TypeScriptAstApi;
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

function resolveTailwindSharedModuleUrl(): string {
  const candidates = [
    new URL("./shared.js", import.meta.url),
    new URL("./shared.ts", import.meta.url),
  ];

  for (const candidate of candidates) {
    if (candidate.protocol !== "file:") {
      return candidate.href;
    }

    let pathName = decodeURIComponent(candidate.pathname);
    if (/^\/[A-Za-z]:\//.test(pathName)) {
      pathName = pathName.slice(1);
    }

    if (getNodeFs().existsSync(pathName)) {
      return candidate.href;
    }
  }

  return candidates[0].href;
}

// Keep this helper inline so JSR's npm wrapper does not rewrite the
// `tailwind-merge` import into a missing local file path.
function loadTailwindRuntimeModule(): string {
  return `import { twMerge } from "tailwind-merge";
import { setTailwindMerge } from ${
    JSON.stringify(resolveTailwindSharedModuleUrl())
  };
setTailwindMerge(twMerge);
export {};
`;
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
let staticCssTsDefaultExport: Record<string, unknown> | null = null;

function isCssTsImportSource(source: string): boolean {
  return (CSS_TS_IMPORT_SOURCES as readonly string[]).includes(source);
}

function getStaticCssTsDefaultExport(): Record<string, unknown> {
  if (staticCssTsDefaultExport) {
    return staticCssTsDefaultExport;
  }

  const callable = function (
    ...args: unknown[]
  ): unknown {
    return (runtimeCt as (...args: unknown[]) => unknown)(...args);
  };
  Object.defineProperty(callable, "prototype", {
    value: (runtimeCt as unknown as { prototype: unknown }).prototype,
  });

  staticCssTsDefaultExport = Object.assign(
    callable as unknown as Record<string, unknown>,
    {
      vite: cssTsPlugin,
      cv,
      font,
      var: cv,
      Theme,
      tw,
      tv,
    },
  );
  return staticCssTsDefaultExport;
}

function getStaticCssTsNamespace(): Record<string, unknown> {
  return {
    default: getStaticCssTsDefaultExport(),
    vite: cssTsPlugin,
    cv,
    font,
    var: cv,
    Theme,
    tw,
    tv,
  };
}

function resolveStaticCssTsImport(
  binding: ImportBinding,
  tail: readonly string[],
): unknown | null {
  if (!isCssTsImportSource(binding.source)) {
    return null;
  }

  if (binding.kind === "namespace") {
    const namespaceValue = getStaticCssTsNamespace();
    return tail.length > 0
      ? readMemberPath(namespaceValue, tail)
      : namespaceValue;
  }

  const importedValue = binding.kind === "default"
    ? getStaticCssTsDefaultExport()
    : getStaticCssTsNamespace()[binding.imported];

  if (importedValue === undefined) {
    return null;
  }

  return tail.length > 0 ? readMemberPath(importedValue, tail) : importedValue;
}

function hasCssTsImport(code: string): boolean {
  for (const source of CSS_TS_IMPORT_SOURCES) {
    if (
      code.includes(`from "${source}"`) || code.includes(`from '${source}'`)
    ) {
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

function readMemberPath(
  value: unknown,
  members: readonly string[],
): unknown | null {
  let current: unknown = value;
  for (const member of members) {
    if (
      typeof current !== "object" || current === null || Array.isArray(current)
    ) {
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

  const styleOpenMatch = code.match(/<style\b[^>]*>/);
  if (styleOpenMatch && styleOpenMatch.index !== undefined) {
    const styleOpenEnd = styleOpenMatch.index + styleOpenMatch[0].length;
    const styleCloseIndex = code.indexOf("</style>", styleOpenEnd);
    if (styleCloseIndex !== -1) {
      const needsLeadingNewline = !code.slice(0, styleCloseIndex).endsWith(
        "\n",
      );
      const cssPrefix = needsLeadingNewline ? "\n" : "";
      return code.slice(0, styleCloseIndex) +
        `${cssPrefix}${css}\n` +
        code.slice(styleCloseIndex);
    }
  }

  return `${code}\n<style>\n${css}\n</style>\n`;
}

function addVirtualImport(code: string, importId = PUBLIC_VIRTUAL_ID): string {
  if (code.includes(importId)) {
    return code;
  }

  return `import "${importId}";\n${code}`;
}

function addVirtualImportToSvelte(
  code: string,
  importId = PUBLIC_VIRTUAL_ID,
): string {
  if (code.includes(importId)) {
    return code;
  }

  const match = code.match(/<script\b[^>]*>/);
  if (!match || match.index === undefined) {
    return `<script>\nimport "${importId}";\n</script>\n${code}`;
  }

  const insertAt = match.index + match[0].length;
  return (
    code.slice(0, insertAt) +
    `\nimport "${importId}";` +
    code.slice(insertAt)
  );
}

function addVirtualImportToAstro(
  code: string,
  importId = PUBLIC_VIRTUAL_ID,
): string {
  if (code.includes(importId)) {
    return code;
  }

  const frontmatterMatch = code.match(/^---[ \t]*\r?\n/);
  if (frontmatterMatch) {
    const insertAt = frontmatterMatch[0].length;
    return (
      code.slice(0, insertAt) +
      `import "${importId}";\n` +
      code.slice(insertAt)
    );
  }

  const trimmed = code.trimStart();
  if (/^(?:import|export|const|let|var|function|class)\b/.test(trimmed)) {
    return addVirtualImport(code, importId);
  }

  return `---\nimport "${importId}";\n---\n${code}`;
}

function addModuleVirtualImportToAstro(code: string, importId: string): string {
  if (code.includes(importId)) {
    return code;
  }

  const frontmatterMatch = code.match(/^---[ \t]*\r?\n/);
  if (!frontmatterMatch) {
    return `${code}\nimport "${importId}";\n`;
  }

  const frontmatterBody = code.slice(frontmatterMatch[0].length);
  const closeMatch = frontmatterBody.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return `${code}\nimport "${importId}";\n`;
  }

  const insertAt = frontmatterMatch[0].length + closeMatch.index;
  return code.slice(0, insertAt) + `\nimport "${importId}";` +
    code.slice(insertAt);
}

function moduleVirtualImportId(moduleId: string): string {
  return `${PUBLIC_VIRTUAL_ID}?${MODULE_VIRTUAL_QUERY_KEY}=${
    encodeURIComponent(moduleId)
  }`;
}

function resolvedModuleVirtualId(moduleId: string): string {
  return `${RESOLVED_VIRTUAL_ID}?${MODULE_VIRTUAL_QUERY_KEY}=${
    encodeURIComponent(moduleId)
  }`;
}

function readModuleVirtualImportId(id: string): string | null {
  const queryIndex = id.indexOf("?");
  if (queryIndex === -1) {
    return null;
  }

  const params = new URLSearchParams(id.slice(queryIndex + 1));
  const moduleId = params.get(MODULE_VIRTUAL_QUERY_KEY);
  return moduleId && moduleId.length > 0 ? moduleId : null;
}

function mergeCss(rules: Iterable<string>): string {
  return Array.from(rules).join("\n");
}

function parseBindingList(
  specifierList: string,
): Array<{ local: string; imported: string }> {
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

    const asMatch = normalized.match(
      /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/,
    );
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
  const constInitializers = new Map<
    string,
    { initializer: string; start: number; end: number; exported: boolean }
  >();
  const functionDeclarations = new Map<string, string>();
  const exportedConsts = new Map<string, string>();

  const defaultImportMatcher =
    /import\s+(?!type\b)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*(?:\{[\s\S]*?\}|\*\s*as\s*[A-Za-z_$][A-Za-z0-9_$]*))?\s*from\s*["']([^"']+)["']/g;
  for (
    let match = defaultImportMatcher.exec(code);
    match;
    match = defaultImportMatcher.exec(code)
  ) {
    imports.set(match[1], {
      source: match[2],
      kind: "default",
    });
  }

  const namespaceImportMatcher =
    /import\s*\*\s*as\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*from\s*["']([^"']+)["']/g;
  for (
    let match = namespaceImportMatcher.exec(code);
    match;
    match = namespaceImportMatcher.exec(code)
  ) {
    imports.set(match[1], {
      source: match[2],
      kind: "namespace",
    });
  }

  const importMatcher = /import\s*{([\s\S]*?)}\s*from\s*["']([^"']+)["']/g;
  for (
    let match = importMatcher.exec(code);
    match;
    match = importMatcher.exec(code)
  ) {
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
  for (
    let match = exportListMatcher.exec(code);
    match;
    match = exportListMatcher.exec(code)
  ) {
    for (const binding of parseBindingList(match[1])) {
      exportedConsts.set(binding.local, binding.imported);
    }
  }

  const constMatcher = /\b(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  for (
    let match = constMatcher.exec(code);
    match;
    match = constMatcher.exec(code)
  ) {
    const isExported = Boolean(match[1]);
    const name = match[2];
    let initializerStart = constMatcher.lastIndex;

    while (
      initializerStart < code.length && /\s/.test(code[initializerStart])
    ) {
      initializerStart += 1;
    }

    if (code[initializerStart] === ":") {
      initializerStart += 1;
      let angleDepth = 0;
      let parenDepth = 0;
      let bracketDepth = 0;
      let braceDepth = 0;
      let inString: "" | '"' | "'" | "`" = "";
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

        if (char === '"' || char === "'" || char === "`") {
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

    const declarationEnd =
      initializerEnd < code.length && code[initializerEnd] === ";"
        ? initializerEnd + 1
        : initializerEnd;

    if (initializer.length > 0) {
      constInitializers.set(name, {
        initializer,
        start: match.index,
        end: declarationEnd,
        exported: isExported,
      });
    }

    if (isExported) {
      exportedConsts.set(name, name);
    }

    constMatcher.lastIndex = declarationEnd;
  }

  const functionMatcher =
    /\b(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (
    let match = functionMatcher.exec(code);
    match;
    match = functionMatcher.exec(code)
  ) {
    const isExported = Boolean(match[1]);
    const name = match[2];
    let cursor = functionMatcher.lastIndex;
    let parenDepth = 1;
    let inString: "" | '"' | "'" | "`" = "";
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

      if (char === '"' || char === "'" || char === "`") {
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
        while (
          cursor < code.length &&
          !(code[cursor] === "*" && code[cursor + 1] === "/")
        ) {
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

      if (char === '"' || char === "'" || char === "`") {
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
        while (
          cursor < code.length &&
          !(code[cursor] === "*" && code[cursor + 1] === "/")
        ) {
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

function findFileUpwards(
  startDir: string,
  candidates: readonly string[],
): string | null {
  let currentDir = getNodePath().resolve(startDir);

  while (true) {
    for (const candidate of candidates) {
      const fullPath = getNodePath().resolve(currentDir, candidate);
      if (
        getNodeFs().existsSync(fullPath) &&
        getNodeFs().statSync(fullPath).isFile()
      ) {
        return fullPath;
      }
    }

    const parentDir = getNodePath().dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function findCssConfigPath(searchStart: string): string | null {
  return findFileUpwards(searchStart, CSS_CONFIG_FILENAMES);
}

function findProjectRoot(searchStart: string): string {
  const markerPath = findFileUpwards(searchStart, PROJECT_ROOT_MARKERS);
  return markerPath
    ? getNodePath().dirname(markerPath)
    : getNodePath().resolve(searchStart);
}

function findTsconfigPath(searchStart: string): string | null {
  return findFileUpwards(searchStart, ["tsconfig.json"]);
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
  const expression = source.slice(start, end === -1 ? source.length : end)
    .trim();
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

function normalizeDefaultUnit(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeLayers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
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

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "scope" || value === "color-scheme"
    ? value
    : "color-scheme";
}

function normalizeDebugOptions(
  value: unknown,
): { logDynamic: boolean; logStatic: boolean } {
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

function normalizeIncludePaths(value: unknown, baseDir: string): string[] {
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
        getNodePath().isAbsolute(entry)
          ? entry
          : getNodePath().resolve(baseDir, entry),
      )
    );

  return Array.from(new Set(normalized));
}

function toBrowserStylesheetPath(
  importPath: string,
  importerPath: string,
  options: ImportResolverOptions,
): string | null {
  const match = importPath.match(/^"([^"]+)"(.*)$/);
  const bareImportPathRaw = match ? match[1] : importPath;
  const suffix = match ? match[2] : "";

  const queryIndex = bareImportPathRaw.indexOf("?");
  const bareImportPath = queryIndex === -1
    ? bareImportPathRaw
    : bareImportPathRaw.slice(0, queryIndex);
  const querySuffix = queryIndex === -1
    ? ""
    : bareImportPathRaw.slice(queryIndex);

  const formatResult = (resolvedValue: string | null): string | null => {
    if (!resolvedValue) return null;
    return match ? `"${resolvedValue}"${suffix}` : resolvedValue;
  };

  const toProjectPath = (resolvedFile: string): string | null => {
    const relative = getNodePath().relative(options.viteRoot, resolvedFile)
      .split(getNodePath().sep).join("/");
    if (relative.startsWith("..")) {
      return null;
    }
    return `/${relative}${querySuffix}`;
  };

  if (
    /^(?:https?:)?\/\//.test(bareImportPath) ||
    bareImportPath.startsWith("data:")
  ) {
    return formatResult(bareImportPathRaw);
  }
  if (bareImportPath.startsWith("/")) {
    return formatResult(bareImportPathRaw);
  }

  if (bareImportPath.startsWith(".")) {
    const resolved = resolveFileFromBase(
      getNodePath().resolve(
        getNodePath().dirname(importerPath),
        bareImportPath,
      ),
    );
    if (resolved) {
      return formatResult(toProjectPath(resolved));
    }

    const fallback = getNodePath().resolve(
      getNodePath().dirname(importerPath),
      bareImportPath,
    );
    return formatResult(toProjectPath(fallback));
  }

  const resolved = resolveImportToFile(importerPath, bareImportPath, options);
  if (resolved) {
    const projectPath = toProjectPath(resolved);
    if (projectPath) {
      return formatResult(projectPath);
    }
  }

  return formatResult(bareImportPathRaw);
}

function stripQueryAndHash(value: string): string {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const endIndex = queryIndex === -1
    ? hashIndex
    : hashIndex === -1
    ? queryIndex
    : Math.min(queryIndex, hashIndex);
  return endIndex === -1 ? value : value.slice(0, endIndex);
}

function hasRawAssetQuery(value: string): boolean {
  const queryIndex = value.indexOf("?");
  if (queryIndex === -1) {
    return false;
  }

  const hashIndex = value.indexOf("#", queryIndex);
  const query = value.slice(
    queryIndex + 1,
    hashIndex === -1 ? undefined : hashIndex,
  );
  return query.split("&").some((part) => part === "raw");
}

function isDefaultLikeImport(binding: ImportBinding): boolean {
  return binding.kind === "default" ||
    (binding.kind === "named" && binding.imported === "default");
}

function isImageAssetImportPath(value: string): boolean {
  if (hasRawAssetQuery(value)) {
    return false;
  }

  const normalized = stripQueryAndHash(value).toLowerCase();
  return IMAGE_ASSET_EXTENSIONS.has(getNodePath().extname(normalized));
}

function isImageAssetFilePath(value: string): boolean {
  return IMAGE_ASSET_EXTENSIONS.has(getNodePath().extname(value).toLowerCase());
}

function resolveStaticImageImport(
  binding: ImportBinding,
  tail: readonly string[],
  importerPath: string,
  resolvedImportFile: string | null,
  options: ImportResolverOptions,
): string | null {
  if (tail.length > 0 || !isDefaultLikeImport(binding)) {
    return null;
  }

  if (
    !isImageAssetImportPath(binding.source) &&
    !(resolvedImportFile && isImageAssetFilePath(resolvedImportFile))
  ) {
    return null;
  }

  return toBrowserStylesheetPath(binding.source, importerPath, options);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierMentioned(
  source: string | undefined,
  identifier: string,
): boolean {
  if (!source || source.trim().length === 0) {
    return true;
  }
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(source);
}

function countIdentifierMentions(source: string, identifier: string): number {
  const matcher = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, "g");
  let count = 0;
  for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
    count += 1;
  }
  return count;
}

function containsIdentifierReference(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (
    "kind" in value &&
    (value as { kind?: unknown }).kind === "identifier-ref" &&
    "path" in value &&
    Array.isArray((value as { path?: unknown }).path)
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => containsIdentifierReference(entry));
  }

  return Object.values(value as Record<string, unknown>).some((entry) =>
    containsIdentifierReference(entry)
  );
}

function stripUnusedStaticHelperConsts(code: string): string {
  const moduleInfo = parseModuleStaticInfo(code);
  const removals: Array<{ start: number; end: number }> = [];

  for (const [name, info] of moduleInfo.constInitializers) {
    if (info.exported) {
      continue;
    }

    const parsedInitializer = parseStaticExpression(
      info.initializer,
      undefined,
      { keepUnresolvedIdentifiers: true },
    );
    if (
      parsedInitializer === null ||
      !containsIdentifierReference(parsedInitializer)
    ) {
      continue;
    }

    if (countIdentifierMentions(code, name) <= 1) {
      removals.push({ start: info.start, end: info.end });
    }
  }

  if (removals.length === 0) {
    return code;
  }

  removals.sort((a, b) => b.start - a.start);
  let nextCode = code;
  for (const removal of removals) {
    nextCode = nextCode.slice(0, removal.start) + nextCode.slice(removal.end);
  }
  return nextCode;
}

function hasStyleDeclarations(declaration: StyleDeclaration): boolean {
  for (const value of Object.values(declaration)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      Array.isArray(value) ||
      isCssVarRef(value)
    ) {
      return true;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      hasStyleDeclarations(value as StyleDeclaration)
    ) {
      return true;
    }
  }
  return false;
}

function hasTailwindClassNames(style: ResolvedStyleDefinition): boolean {
  return (style.tailwindClassNames?.length ?? 0) > 0;
}

function resolveStyleClassValue(
  generatedClassName: string | undefined,
  style: ResolvedStyleDefinition,
): string {
  if (hasTailwindClassNames(style)) {
    return mergeTailwindClassNames([
      ...(generatedClassName ? [generatedClassName] : []),
      ...(style.tailwindClassNames ?? []),
    ]);
  }

  return generatedClassName ?? "";
}

function toRuntimeCtConfigLiteral(parsed: {
  simple?: boolean;
  global?: StyleSheet;
  root?: Array<
    Record<string, StyleValue> | {
      vars: Record<string, StyleValue>;
      layer?: string;
    }
  >;
  rootVars?: Array<
    Record<string, StyleValue> | {
      vars: Record<string, StyleValue>;
      layer?: string;
    }
  >;
  base: NormalizedStyleSheet;
  variant?: Record<string, Record<string, NormalizedStyleSheet>>;
  variantGlobal?: Record<string, Record<string, StyleSheet>>;
  defaults?: Record<string, string | boolean>;
}): string {
  const runtimeConfig: Record<string, unknown> = {};

  if (parsed.simple) {
    runtimeConfig.simple = true;
    runtimeConfig.base = parsed.base[SIMPLE_STYLE_KEY];
  } else {
    runtimeConfig.base = parsed.base;
  }

  if (parsed.global && Object.keys(parsed.global).length > 0) {
    runtimeConfig.global = parsed.global;
  }
  if (parsed.root && parsed.root.length > 0) {
    runtimeConfig.root = parsed.root;
  } else if (parsed.rootVars && parsed.rootVars.length > 0) {
    runtimeConfig.root = parsed.rootVars;
  }
  if (parsed.variant && Object.keys(parsed.variant).length > 0) {
    if (parsed.simple) {
      const simpleVariantConfig: Record<
        string,
        Record<string, unknown>
      > = {};
      for (const [group, variants] of Object.entries(parsed.variant)) {
        const runtimeVariants: Record<string, unknown> = {};
        for (const [variantName, declarations] of Object.entries(variants)) {
          runtimeVariants[variantName] = declarations[SIMPLE_STYLE_KEY];
        }
        simpleVariantConfig[group] = runtimeVariants;
      }
      runtimeConfig.variant = simpleVariantConfig;
    } else {
      runtimeConfig.variant = parsed.variant;
    }
  }
  if (parsed.variantGlobal && Object.keys(parsed.variantGlobal).length > 0) {
    runtimeConfig.variantGlobal = parsed.variantGlobal;
  }
  if (parsed.defaults && Object.keys(parsed.defaults).length > 0) {
    runtimeConfig.defaults = parsed.defaults;
  }

  return JSON.stringify(runtimeConfig);
}

function loadCssConfig(
  searchStart: string,
  resolverOptions: {
    projectRoot: string;
    viteRoot: string;
    viteAliases: readonly ViteAliasEntry[];
    tsconfigResolver: TsconfigPathResolver | null;
  },
): LoadedCssConfig {
  const configPath = findCssConfigPath(searchStart);
  if (!configPath) {
    return {
      path: null,
      dependencies: [],
      imports: [],
      themeMode: "color-scheme",
      resolution: "hybrid",
      hasExplicitResolution: false,
      debug: {
        logDynamic: false,
        logStatic: false,
      },
      breakpoints: {},
      containers: {},
      layers: [],
      defaultUnit: undefined,
      include: [],
      utilities: {},
      configCss: "",
      utilityCss: "",
      runtimeOptions: {
        themeMode: "color-scheme",
      },
    };
  }

  const source = getNodeFs().readFileSync(configPath, "utf8");
  const configDir = getNodePath().dirname(configPath);
  const dependencies = new Set<string>();
  const sideEffectImports: string[] = [];
  const cssImportMatcher = /import\s*["']([^"']+\.css(?:\?[^"']*)?)["']\s*;?/g;
  for (
    let match = cssImportMatcher.exec(source);
    match;
    match = cssImportMatcher.exec(source)
  ) {
    sideEffectImports.push(`"${match[1]}"`);
  }

  const moduleInfoCache = new Map<string, ModuleStaticInfo>();
  const constValueCache = new Map<string, unknown | null>();
  const resolving = new Set<string>();

  function getModuleCode(moduleId: string): string | null {
    if (moduleId === configPath) {
      return source;
    }
    try {
      dependencies.add(cleanId(moduleId));
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
    sourceHint?: string,
  ): Record<string, unknown> {
    const evalScope: Record<string, unknown> = {
      ...STATIC_EVAL_GLOBALS,
    };

    for (const localName of moduleInfo.functionDeclarations.keys()) {
      if (
        localName === excludeName || !identifierMentioned(sourceHint, localName)
      ) {
        continue;
      }
      const localValue = resolveIdentifierInModule([localName], moduleId);
      if (localValue !== null) {
        evalScope[localName] = localValue;
      }
    }

    for (const localName of moduleInfo.constInitializers.keys()) {
      if (
        localName === excludeName || !identifierMentioned(sourceHint, localName)
      ) {
        continue;
      }
      const localValue = resolveIdentifierInModule([localName], moduleId);
      if (localValue !== null) {
        evalScope[localName] = localValue;
      }
    }

    for (const localName of moduleInfo.imports.keys()) {
      if (!identifierMentioned(sourceHint, localName)) {
        continue;
      }
      const localValue = resolveIdentifierInModule([localName], moduleId);
      if (localValue !== null) {
        evalScope[localName] = localValue;
      }
    }

    return evalScope;
  }

  function resolveIdentifierInModule(
    identifierPath: readonly string[],
    moduleId: string,
  ): unknown | null {
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
      const initializerInfo = moduleInfo.constInitializers.get(head);
      if (initializerInfo !== undefined) {
        const initializer = initializerInfo.initializer;
        let value = parseStaticExpression(initializer, (nestedPath) => {
          const nested = resolveIdentifierInModule(nestedPath, moduleId);
          return nested === null ? undefined : nested;
        }, { keepUnresolvedIdentifiers: true });

        if (value === null) {
          value = evaluateExpression(
            initializer,
            buildEvalScope(moduleInfo, moduleId, head, initializer),
          );
        }

        if (value !== null) {
          resolved = tail.length > 0 ? readMemberPath(value, tail) : value;
        }
      } else {
        const functionDeclaration = moduleInfo.functionDeclarations.get(head);
        if (functionDeclaration !== undefined) {
          const functionValue = evaluateFunctionDeclaration(
            functionDeclaration,
            buildEvalScope(moduleInfo, moduleId, head, functionDeclaration),
          );
          if (functionValue !== null) {
            resolved = tail.length > 0
              ? readMemberPath(functionValue, tail)
              : functionValue;
          }
        }
      }

      if (resolved === null) {
        const binding = moduleInfo.imports.get(head);
        if (binding) {
          resolved = resolveStaticCssTsImport(binding, tail);
          if (resolved === null) {
            const resolvedImportFile = resolveImportToFile(
              moduleId,
              binding.source,
              {
                projectRoot: resolverOptions.projectRoot,
                viteRoot: resolverOptions.viteRoot,
                viteAliases: resolverOptions.viteAliases,
                tsconfigResolver: resolverOptions.tsconfigResolver,
              },
            );
            resolved = resolveStaticImageImport(
              binding,
              tail,
              moduleId,
              resolvedImportFile,
              {
                projectRoot: resolverOptions.projectRoot,
                viteRoot: resolverOptions.viteRoot,
                viteAliases: resolverOptions.viteAliases,
                tsconfigResolver: resolverOptions.tsconfigResolver,
              },
            );
            if (resolved === null && resolvedImportFile) {
              const importedModuleInfo = getModuleInfo(resolvedImportFile);
              if (importedModuleInfo) {
                if (binding.kind === "namespace") {
                  if (tail.length > 0) {
                    const [namespaceExport, ...namespaceTail] = tail;
                    const exportedLocalName =
                      importedModuleInfo.exportedConsts.get(namespaceExport) ??
                        namespaceExport;
                    const namespaceValue = resolveIdentifierInModule(
                      [exportedLocalName],
                      resolvedImportFile,
                    );
                    resolved = namespaceTail.length > 0
                      ? readMemberPath(namespaceValue, namespaceTail)
                      : namespaceValue;
                  }
                } else {
                  const importedName = binding.kind === "default"
                    ? "default"
                    : binding.imported;
                  const exportedLocalName = importedName === "default"
                    ? null
                    : (importedModuleInfo.exportedConsts.get(importedName) ??
                      importedName);
                  const importedValue = resolveIdentifierInModule(
                    exportedLocalName ? [exportedLocalName] : ["default"],
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
      }

      if (
        resolved === null && head === "default" &&
        moduleInfo.defaultExportExpression
      ) {
        const parsedDefault = parseStaticExpression(
          moduleInfo.defaultExportExpression,
          (nestedPath) =>
            resolveIdentifierInModule(nestedPath, moduleId) ?? undefined,
        );
        if (parsedDefault !== null) {
          resolved = tail.length > 0
            ? readMemberPath(parsedDefault, tail)
            : parsedDefault;
        } else {
          const evaluatedDefault = evaluateExpression(
            moduleInfo.defaultExportExpression,
            buildEvalScope(
              moduleInfo,
              moduleId,
              undefined,
              moduleInfo.defaultExportExpression,
            ),
          );
          if (evaluatedDefault !== null) {
            resolved = tail.length > 0
              ? readMemberPath(evaluatedDefault, tail)
              : evaluatedDefault;
          }
        }
      }
    }

    resolving.delete(cacheKey);
    if (resolved !== null) {
      constValueCache.set(cacheKey, resolved);
    } else {
      constValueCache.delete(cacheKey);
    }
    return resolved;
  }

  const configModuleInfo = getModuleInfo(configPath);
  const defaultExpr = configModuleInfo?.defaultExportExpression ??
    extractDefaultExportExpression(source);
  let configObject: Record<string, unknown> = {};

  if (defaultExpr) {
    const parsed = parseStaticExpression(
      defaultExpr,
      (identifierPath) =>
        resolveIdentifierInModule(identifierPath, configPath) ?? undefined,
    );
    if (isRecord(parsed)) {
      configObject = parsed;
    } else if (configModuleInfo) {
      const evalScope: Record<string, unknown> = {
        ...buildEvalScope(configModuleInfo, configPath, undefined, defaultExpr),
        defineCssConfig: (input: unknown) => input,
      };
      const evaluated = evaluateExpression(defaultExpr, evalScope);
      if (isRecord(evaluated)) {
        configObject = evaluated;
      }
    }
  }

  const importsFromObject = Array.isArray(configObject.imports)
    ? configObject.imports
      .filter((entry): entry is string => typeof entry === "string")
      .map((
        entry,
      ) => (entry.startsWith('"') && entry.endsWith('"')
        ? entry
        : `"${entry}"`)
      )
    : [];
  const hasExplicitResolution = Object.prototype.hasOwnProperty.call(
    configObject,
    "resolution",
  );
  const resolution = normalizeResolution(configObject.resolution);
  const themeMode = normalizeThemeMode(configObject.themeMode);
  const debug = normalizeDebugOptions(configObject.debug);
  const breakpoints = normalizeBreakpoints(configObject.breakpoints);
  const containers = normalizeContainers(configObject.containers);
  const layers = normalizeLayers(configObject.layers);
  const defaultUnit = normalizeDefaultUnit(configObject.defaultUnit);

  const parsedThemes = Object.prototype.hasOwnProperty.call(
      configObject,
      "themes",
    )
    ? parseCtConfig(
      { themes: configObject.themes },
      { containers, themeMode },
    )
    : null;
  const parsedUtilities = isRecord(configObject.utilities)
    ? parseCtConfig({ base: configObject.utilities }, { containers })
    : null;
  const utilityImports = parsedUtilities?.imports ?? [];

  const dedupedRawImports = Array.from(
    new Set([...sideEffectImports, ...importsFromObject, ...utilityImports]),
  );
  const resolvedImports = dedupedRawImports
    .map((importPath) =>
      toBrowserStylesheetPath(importPath, configPath, {
        projectRoot: resolverOptions.projectRoot,
        viteRoot: resolverOptions.viteRoot,
        viteAliases: resolverOptions.viteAliases,
        tsconfigResolver: resolverOptions.tsconfigResolver,
      })
    )
    .filter((entry): entry is string => Boolean(entry));
  const allImports = Array.from(new Set(resolvedImports));

  const include = normalizeIncludePaths(configObject.include, configDir);
  const themeRules = parsedThemes
    ? toCssGlobalRules(
      {
        ...rootVarsToGlobalRules(parsedThemes.root ?? parsedThemes.rootVars),
        ...(parsedThemes.global ?? {}),
      },
      {
        breakpoints,
        containers,
        defaultUnit,
      },
    )
    : [];
  const layerOrderRule = toCssLayerOrderRule(layers);
  const configCss = [layerOrderRule, ...themeRules].filter((part) =>
    part.length > 0
  ).join("\n");
  const utilitiesParsed = parsedUtilities?.base ?? {};

  const utilityRules = Object.entries(utilitiesParsed)
    .flatMap(([name, style]) => {
      if (!hasStyleDeclarations(style.declaration)) {
        return [];
      }

      return toCssRules(`u-${camelToKebab(name)}`, style.declaration, {
        breakpoints,
        containers,
        defaultUnit,
      });
    });
  const utilityCss = resolution === "dynamic" ? "" : utilityRules.join("\n");

  const runtimeOptions: LoadedCssConfig["runtimeOptions"] = {};
  if (Object.keys(breakpoints).length > 0) {
    runtimeOptions.breakpoints = breakpoints;
  }
  if (Object.keys(containers).length > 0) {
    runtimeOptions.containers = containers;
  }
  if (layers.length > 0) {
    runtimeOptions.layers = layers;
  }
  if (defaultUnit) {
    runtimeOptions.defaultUnit = defaultUnit;
  }
  if (Object.keys(utilitiesParsed).length > 0) {
    runtimeOptions.utilities = utilitiesParsed;
  }
  runtimeOptions.themeMode = themeMode;
  runtimeOptions.resolution = resolution;

  return {
    path: configPath,
    dependencies: Array.from(dependencies),
    imports: allImports,
    themeMode,
    resolution,
    hasExplicitResolution,
    debug,
    breakpoints,
    containers,
    layers,
    defaultUnit,
    include,
    utilities: utilitiesParsed,
    configCss,
    utilityCss,
    runtimeOptions,
  };
}

function getTsTranspiler(): ((source: string) => string) | null {
  if (tsTranspiler !== undefined) {
    return tsTranspiler;
  }

  const typescript = getTypeScriptModule();
  if (!typescript) {
    tsTranspiler = null;
    return null;
  }

  tsTranspiler = (source: string): string =>
    typescript.transpileModule(source, {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2020,
        module: typescript.ModuleKind.ESNext,
      },
    }).outputText;
  return tsTranspiler;
}

const CT_BUILDER_ASSIGNMENT_PROPERTIES = new Set([
  "base",
  "global",
  "themes",
  "root",
  "rootVars",
  "variant",
  "defaults",
]);

type AstScopeEntry = AstNewCtDeclaration | null;

function scriptKindForModule(
  typescript: TypeScriptAstApi,
  moduleId: string,
): number {
  if (moduleId.endsWith(".tsx")) {
    return typescript.ScriptKind.TSX;
  }
  if (moduleId.endsWith(".jsx")) {
    return typescript.ScriptKind.JSX;
  }
  if (
    moduleId.endsWith(".ts") ||
    moduleId.endsWith(".mts") ||
    moduleId.endsWith(".cts")
  ) {
    return typescript.ScriptKind.TS;
  }
  return typescript.ScriptKind.JS;
}

function astNodeStart(node: unknown, sourceFile: unknown): number {
  if (
    node &&
    typeof node === "object" &&
    "getStart" in (node as Record<string, unknown>) &&
    typeof (node as { getStart?: unknown }).getStart === "function"
  ) {
    return (node as { getStart: (sourceFile?: unknown) => number }).getStart(
      sourceFile,
    );
  }

  return (node as { pos?: number } | null)?.pos ?? 0;
}

function astNodeEnd(node: unknown): number {
  return (node as { end?: number } | null)?.end ?? 0;
}

function astNodeText(
  node: unknown,
  code: string,
  sourceFile: unknown,
): string {
  return code.slice(astNodeStart(node, sourceFile), astNodeEnd(node));
}

function astIdentifierText(node: unknown): string | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const textValue = (node as { text?: unknown }).text;
  if (typeof textValue === "string") {
    return textValue;
  }

  const escapedText = (node as { escapedText?: unknown }).escapedText;
  if (typeof escapedText === "string") {
    return escapedText;
  }

  return null;
}

function isCtIdentifier(node: unknown): boolean {
  return astIdentifierText(node) === "ct";
}

function isCtObjectCall(
  node: unknown,
  typescript: TypeScriptAstApi,
): node is { expression: unknown; arguments: unknown[]; end: number } {
  const syntaxKind = typescript.SyntaxKind;
  if (
    !node || typeof node !== "object" ||
    (node as { kind?: number }).kind !== syntaxKind.CallExpression
  ) {
    return false;
  }

  const call = node as { expression?: unknown; arguments?: unknown[] };
  return Boolean(
    isCtIdentifier(call.expression) &&
      Array.isArray(call.arguments) &&
      call.arguments.length > 0 &&
      (call.arguments[0] as { kind?: number } | undefined)?.kind ===
        syntaxKind.ObjectLiteralExpression,
  );
}

function isNewCtBuilder(
  node: unknown,
  typescript: TypeScriptAstApi,
): node is { expression: unknown; arguments?: unknown[]; end: number } {
  const syntaxKind = typescript.SyntaxKind;
  if (
    !node || typeof node !== "object" ||
    (node as { kind?: number }).kind !== syntaxKind.NewExpression
  ) {
    return false;
  }

  const expression = (node as { expression?: unknown }).expression;
  const args = (node as { arguments?: unknown[] }).arguments;
  return isCtIdentifier(expression) && (args?.length ?? 0) <= 1;
}

function addScopeBinding(
  nameNode: unknown,
  scope: Map<string, AstScopeEntry>,
): void {
  const name = astIdentifierText(nameNode);
  if (name) {
    scope.set(name, null);
  }
}

function addBindingPattern(
  nameNode: unknown,
  scope: Map<string, AstScopeEntry>,
  typescript: TypeScriptAstApi,
): void {
  if (!nameNode || typeof nameNode !== "object") {
    return;
  }

  const syntaxKind = typescript.SyntaxKind;
  const node = nameNode as Record<string, unknown>;
  if (node.kind === syntaxKind.Identifier) {
    addScopeBinding(node, scope);
    return;
  }

  if (node.kind === syntaxKind.ObjectBindingPattern) {
    const elements = node.elements;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        addBindingPattern(
          (element as { name?: unknown } | null)?.name,
          scope,
          typescript,
        );
      }
    }
    return;
  }

  if (node.kind === syntaxKind.ArrayBindingPattern) {
    const elements = node.elements;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        addBindingPattern(
          (element as { name?: unknown } | null)?.name,
          scope,
          typescript,
        );
      }
    }
  }
}

function resolveBuilderDeclaration(
  scopes: readonly Map<string, AstScopeEntry>[],
  name: string,
): AstNewCtDeclaration | null {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (!scope.has(name)) {
      continue;
    }
    return scope.get(name) ?? null;
  }

  return null;
}

function collectAstTransformTargets(
  code: string,
  id: string,
): AstTransformTargets | null {
  const typescript = getTypeScriptAstApi();
  if (!typescript) {
    return null;
  }

  const ast = typescript;
  const normalizedId = cleanId(id);
  const sourceFile = ast.createSourceFile(
    normalizedId,
    code,
    ast.ScriptTarget.ES2020,
    true,
    scriptKindForModule(ast, normalizedId),
  ) as Record<string, unknown>;
  const syntaxKind = ast.SyntaxKind;
  const calls: AstCtCall[] = [];
  const newCtDecls: AstNewCtDeclaration[] = [];

  function recordCtCall(node: unknown): void {
    if (isCtObjectCall(node, ast)) {
      calls.push({
        start: astNodeStart(node, sourceFile),
        end: astNodeEnd(node),
        arg: astNodeText(node.arguments[0], code, sourceFile),
      });
    }
  }

  function registerVariableDeclaration(
    declaration: unknown,
    scope: Map<string, AstScopeEntry>,
  ): void {
    if (!declaration || typeof declaration !== "object") {
      return;
    }

    const declarationNode = declaration as {
      name?: unknown;
      initializer?: unknown;
    };
    const name = astIdentifierText(declarationNode.name);
    if (!name) {
      addBindingPattern(declarationNode.name, scope, ast);
      return;
    }

    if (isNewCtBuilder(declarationNode.initializer, ast)) {
      const initializerArgs = declarationNode.initializer.arguments ?? [];
      const optionsSource = initializerArgs.length > 0
        ? astNodeText(initializerArgs[0], code, sourceFile)
        : undefined;
      const parsedBuilderOptions = parseCtBuilderOptions(
        optionsSource ? parseStaticExpression(optionsSource) : undefined,
      ) ?? { simple: false };
      const builder: AstNewCtDeclaration = {
        varName: name,
        start: astNodeStart(declaration, sourceFile),
        initializerStart: astNodeStart(declarationNode.initializer, sourceFile),
        initializerEnd: astNodeEnd(declarationNode.initializer),
        optionsSource,
        hasStaticOptions: !optionsSource ||
          parseStaticExpression(optionsSource) !== null,
        simple: parsedBuilderOptions.simple,
        hasAddContainerCall: false,
        assignments: [],
      };
      newCtDecls.push(builder);
      scope.set(name, builder);
      return;
    }

    scope.set(name, null);
  }

  function recordBuilderMutation(
    statement: unknown,
    scopes: readonly Map<string, AstScopeEntry>[],
  ): void {
    if (!statement || typeof statement !== "object") {
      return;
    }

    const expression = (statement as { expression?: unknown }).expression;
    if (!expression || typeof expression !== "object") {
      return;
    }

    if (
      (expression as { kind?: number }).kind === syntaxKind.BinaryExpression
    ) {
      const binary = expression as {
        left?: unknown;
        right?: unknown;
        operatorToken?: { kind?: number };
      };
      if (binary.operatorToken?.kind !== syntaxKind.EqualsToken) {
        return;
      }

      const left = binary.left as {
        kind?: number;
        expression?: unknown;
        name?: unknown;
      } | null;
      if (!left || left.kind !== syntaxKind.PropertyAccessExpression) {
        return;
      }

      const varName = astIdentifierText(left.expression);
      const property = astIdentifierText(left.name);
      if (
        !varName || !property ||
        !CT_BUILDER_ASSIGNMENT_PROPERTIES.has(property)
      ) {
        return;
      }

      const builder = resolveBuilderDeclaration(scopes, varName);
      if (!builder || !binary.right) {
        return;
      }

      builder.assignments.push({
        property,
        start: astNodeStart(statement, sourceFile),
        end: astNodeEnd(statement),
        valueSource: astNodeText(binary.right, code, sourceFile),
      });
      return;
    }

    if ((expression as { kind?: number }).kind !== syntaxKind.CallExpression) {
      return;
    }

    const call = expression as {
      expression?: unknown;
      arguments?: unknown[];
    };
    const access = call.expression as {
      kind?: number;
      expression?: unknown;
      name?: unknown;
    } | null;
    if (!access || access.kind !== syntaxKind.PropertyAccessExpression) {
      return;
    }

    if (astIdentifierText(access.name) !== "import") {
      if (astIdentifierText(access.name) !== "addContainer") {
        return;
      }

      const varName = astIdentifierText(access.expression);
      const builder = varName
        ? resolveBuilderDeclaration(scopes, varName)
        : null;
      if (builder) {
        builder.hasAddContainerCall = true;
      }
      return;
    }

    const varName = astIdentifierText(access.expression);
    const builder = varName ? resolveBuilderDeclaration(scopes, varName) : null;
    if (
      !builder || !Array.isArray(call.arguments) || call.arguments.length === 0
    ) {
      return;
    }

    const firstArg = call.arguments[0];
    const lastArg = call.arguments[call.arguments.length - 1];
    builder.assignments.push({
      property: "import",
      start: astNodeStart(statement, sourceFile),
      end: astNodeEnd(statement),
      valueSource: code.slice(
        astNodeStart(firstArg, sourceFile),
        astNodeEnd(lastArg),
      ),
    });
  }

  function visitFunctionLike(node: unknown): void {
    if (!node || typeof node !== "object") {
      return;
    }

    const functionNode = node as {
      name?: unknown;
      parameters?: unknown[];
      body?: unknown;
    };
    const scope = new Map<string, AstScopeEntry>();
    addScopeBinding(functionNode.name, scope);
    if (Array.isArray(functionNode.parameters)) {
      for (const parameter of functionNode.parameters) {
        addBindingPattern(
          (parameter as { name?: unknown } | null)?.name,
          scope,
          ast,
        );
      }
    }
    visitScopedNode(functionNode.body, [scope]);
  }

  function visitStatementList(
    statements: unknown[] | undefined,
    parentScopes: readonly Map<string, AstScopeEntry>[],
  ): void {
    if (!Array.isArray(statements)) {
      return;
    }

    const scope = new Map<string, AstScopeEntry>();
    const scopes = [...parentScopes, scope];

    for (const statement of statements) {
      visitScopedNode(statement, scopes);
    }
  }

  function visitScopedNode(
    node: unknown,
    scopes: readonly Map<string, AstScopeEntry>[],
  ): void {
    if (!node || typeof node !== "object") {
      return;
    }

    recordCtCall(node);

    const kind = (node as { kind?: number }).kind;
    if (kind === syntaxKind.SourceFile) {
      visitStatementList(
        (node as { statements?: unknown[] }).statements,
        [],
      );
      return;
    }

    if (
      kind === syntaxKind.FunctionDeclaration ||
      kind === syntaxKind.FunctionExpression ||
      kind === syntaxKind.ArrowFunction ||
      kind === syntaxKind.MethodDeclaration ||
      kind === syntaxKind.GetAccessor ||
      kind === syntaxKind.SetAccessor ||
      kind === syntaxKind.Constructor
    ) {
      if (kind === syntaxKind.FunctionDeclaration && scopes.length > 0) {
        addScopeBinding(
          (node as { name?: unknown }).name,
          scopes[scopes.length - 1],
        );
      }
      visitFunctionLike(node);
      return;
    }

    if (
      kind === syntaxKind.Block ||
      kind === syntaxKind.ModuleBlock ||
      kind === syntaxKind.CaseClause ||
      kind === syntaxKind.DefaultClause
    ) {
      visitStatementList(
        (node as { statements?: unknown[] }).statements,
        scopes,
      );
      return;
    }

    if (kind === syntaxKind.CatchClause) {
      const scope = new Map<string, AstScopeEntry>();
      addBindingPattern(
        (node as { variableDeclaration?: { name?: unknown } })
          .variableDeclaration
          ?.name,
        scope,
        ast,
      );
      visitScopedNode((node as { block?: unknown }).block, [...scopes, scope]);
      return;
    }

    if (kind === syntaxKind.ClassDeclaration && scopes.length > 0) {
      addScopeBinding(
        (node as { name?: unknown }).name,
        scopes[scopes.length - 1],
      );
    }

    if (kind === syntaxKind.VariableStatement && scopes.length > 0) {
      const declarations =
        (node as { declarationList?: { declarations?: unknown[] } })
          .declarationList?.declarations;
      if (Array.isArray(declarations)) {
        for (const declaration of declarations) {
          registerVariableDeclaration(declaration, scopes[scopes.length - 1]);
        }
      }
    }

    if (kind === syntaxKind.ExpressionStatement) {
      recordBuilderMutation(node, scopes);
    }

    ast.forEachChild(node, (child) => visitScopedNode(child, scopes));
  }

  visitScopedNode(sourceFile, []);

  const builderRanges = newCtDecls.flatMap((decl) => [
    { start: decl.initializerStart, end: decl.initializerEnd },
    ...decl.assignments.map((assignment) => ({
      start: assignment.start,
      end: assignment.end,
    })),
  ]);

  return {
    calls: calls.filter((call) =>
      !builderRanges.some((range) =>
        call.start >= range.start && call.end <= range.end
      )
    ),
    newCtDecls,
  };
}

function splitTopLevelSegments(
  source: string,
  separator: string,
): string[] {
  const segments: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString: "" | '"' | "'" | "`" = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = "";
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      current += char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }

    if (
      char === separator &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      segments.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  segments.push(current);
  return segments;
}

function findTopLevelCharacter(source: string, target: string): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString: "" | '"' | "'" | "`" = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = "";
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
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
      char === target &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function stripTypeAnnotationsFromParameters(source: string): string {
  return splitTopLevelSegments(source, ",")
    .map((segment) => {
      const trimmed = segment.trim();
      if (trimmed.length === 0) {
        return trimmed;
      }

      const equalsIndex = findTopLevelCharacter(trimmed, "=");
      const head = equalsIndex === -1
        ? trimmed
        : trimmed.slice(0, equalsIndex).trimEnd();
      const tail = equalsIndex === -1
        ? ""
        : trimmed.slice(equalsIndex).trimStart();

      const typeAnnotationIndex = findTopLevelCharacter(head, ":");
      let strippedHead = typeAnnotationIndex === -1
        ? head
        : head.slice(0, typeAnnotationIndex).trimEnd();
      strippedHead = strippedHead.replace(/\?$/, "");

      return tail.length > 0 ? `${strippedHead} ${tail}` : strippedHead;
    })
    .join(", ");
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  let inString: "" | '"' | "'" | "`" = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = "";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findArrowAfterParams(
  source: string,
  closeIndex: number,
): { arrowIndex: number; returnTypeStart: number | null } | null {
  let cursor = closeIndex + 1;
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }

  if (source[cursor] === "=" && source[cursor + 1] === ">") {
    return { arrowIndex: cursor, returnTypeStart: null };
  }

  if (source[cursor] !== ":") {
    return null;
  }

  const returnTypeStart = cursor;
  cursor += 1;

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let inString: "" | '"' | "'" | "`" = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    const next = source[cursor + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        cursor += 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = "";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      cursor += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      cursor += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
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
    if (char === "<") {
      angleDepth += 1;
      continue;
    }
    if (char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      continue;
    }

    if (
      char === "=" &&
      next === ">" &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      return { arrowIndex: cursor, returnTypeStart };
    }
  }

  return null;
}

function stripArrowFunctionTypeAnnotations(source: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    const openIndex = source.indexOf("(", cursor);
    if (openIndex === -1) {
      output += source.slice(cursor);
      break;
    }

    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex === -1) {
      output += source.slice(cursor);
      break;
    }

    const arrowInfo = findArrowAfterParams(source, closeIndex);
    if (!arrowInfo) {
      output += source.slice(cursor, openIndex + 1);
      cursor = openIndex + 1;
      continue;
    }

    output += source.slice(cursor, openIndex + 1);
    output += stripTypeAnnotationsFromParameters(
      source.slice(openIndex + 1, closeIndex),
    );
    output += ")";
    if (arrowInfo.returnTypeStart === null) {
      output += source.slice(closeIndex + 1, arrowInfo.arrowIndex);
    } else {
      output += source.slice(closeIndex + 1, arrowInfo.returnTypeStart);
    }
    output += "=>";
    cursor = arrowInfo.arrowIndex + 2;
  }

  return output;
}

function stripTypeScriptSnippetFallback(source: string): string {
  return stripArrowFunctionTypeAnnotations(
    source
      .replace(
        /function(\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(([^)]*)\)\s*(?::\s*[^({=]+)?\s*\{/g,
        (_match, name: string | undefined, params: string) =>
          `function${name ?? ""}(${
            stripTypeAnnotationsFromParameters(params)
          }) {`,
      )
      .replace(/\s+as\s+const\b/g, "")
      .trim(),
  );
}

function transpileTsSnippet(source: string): string {
  const transpile = getTsTranspiler();
  if (!transpile) {
    return stripTypeScriptSnippetFallback(source);
  }

  let output = transpile(source)
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/^(?:(?:"use strict"|'use strict');\s*)+/, "")
    .trim();
  while (output.endsWith(";")) {
    output = output.slice(0, -1).trimEnd();
  }
  return output;
}

function evaluateExpression(
  source: string,
  scope: Record<string, unknown>,
): unknown | null {
  const IDENTIFIER_PROXY_PATH = Symbol("css-ts-identifier-proxy-path");
  const createIdentifierProxy = (path: string[]): unknown =>
    new Proxy({ [IDENTIFIER_PROXY_PATH]: path }, {
      get(_target, key) {
        if (key === IDENTIFIER_PROXY_PATH) {
          return path;
        }
        if (key === Symbol.toPrimitive) {
          return () => path[path.length - 1] ?? "";
        }
        if (key === "toString" || key === "valueOf") {
          return () => path[path.length - 1] ?? "";
        }
        if (typeof key === "string") {
          return createIdentifierProxy([...path, key]);
        }
        return undefined;
      },
    });
  const materializeIdentifierProxies = (
    value: unknown,
    seen = new WeakMap<object, unknown>(),
  ): unknown => {
    if (typeof value !== "object" || value === null) {
      return value;
    }

    const proxyPath = (value as Record<PropertyKey, unknown>)[
      IDENTIFIER_PROXY_PATH
    ];
    if (
      Array.isArray(proxyPath) &&
      proxyPath.every((segment) => typeof segment === "string")
    ) {
      return {
        kind: "identifier-ref",
        path: [...proxyPath],
      };
    }

    if (seen.has(value)) {
      return seen.get(value);
    }

    if (Array.isArray(value)) {
      const resolved: unknown[] = [];
      seen.set(value, resolved);
      for (const entry of value) {
        resolved.push(materializeIdentifierProxies(entry, seen));
      }
      return resolved;
    }

    const resolved: Record<string, unknown> = {};
    seen.set(value, resolved);
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = materializeIdentifierProxies(entry, seen);
    }
    return resolved;
  };

  const jsSource = transpileTsSnippet(`(${source})`);
  try {
    const proxyScope = new Proxy(scope, {
      has(target, key) {
        return true;
      },
      get(target, key) {
        if (key in target) {
          return target[key as string];
        }
        if (key === Symbol.unscopables) {
          return undefined;
        }
        if (typeof key === "string" && key in globalThis) {
          return globalThis[key as keyof typeof globalThis];
        }
        if (typeof key === "string") {
          return createIdentifierProxy([key]);
        }
        return undefined;
      },
    });

    const fn = new Function(
      "__scope",
      `with (__scope) { return ${jsSource}; }`,
    );
    return materializeIdentifierProxies(fn(proxyScope));
  } catch {
    return null;
  }
}

function evaluateFunctionDeclaration(
  source: string,
  scope: Record<string, unknown>,
): unknown | null {
  try {
    const jsSource = transpileTsSnippet(source);
    const proxyScope = new Proxy(scope, {
      has(target, key) {
        return true;
      },
      get(target, key) {
        if (key in target) {
          return target[key as string];
        }
        if (key === Symbol.unscopables) {
          return undefined;
        }
        if (typeof key === "string" && key in globalThis) {
          return globalThis[key as keyof typeof globalThis];
        }
        return key;
      },
    });

    const fn = new Function(
      "__scope",
      `with (__scope) { return (${jsSource}); }`,
    );
    return fn(proxyScope);
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
    if (
      getNodeFs().existsSync(candidate) &&
      getNodeFs().statSync(candidate).isFile()
    ) {
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
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
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
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let cursor = i + 1;
      while (cursor < input.length && /\s/.test(input[cursor])) {
        cursor += 1;
      }
      if (
        cursor < input.length &&
        (input[cursor] === "}" || input[cursor] === "]")
      ) {
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

function resolveTsconfigExtendsPath(
  configDir: string,
  extendsValue: string,
): string | null {
  if (extendsValue.startsWith(".")) {
    const withExtension = extendsValue.endsWith(".json")
      ? extendsValue
      : `${extendsValue}.json`;
    return getNodePath().resolve(configDir, withExtension);
  }

  if (extendsValue.startsWith("/")) {
    return extendsValue;
  }

  const candidate = getNodePath().resolve(
    configDir,
    "node_modules",
    extendsValue,
  );
  if (
    getNodeFs().existsSync(candidate) &&
    getNodeFs().statSync(candidate).isFile()
  ) {
    return candidate;
  }
  if (
    getNodeFs().existsSync(`${candidate}.json`) &&
    getNodeFs().statSync(`${candidate}.json`).isFile()
  ) {
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
        mergedBaseUrl = getNodePath().resolve(
          getNodePath().dirname(parentPath),
          parent.baseUrl,
        );
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
        const targets = targetValue.filter((entry): entry is string =>
          typeof entry === "string"
        );
        if (targets.length > 0) {
          mergedPaths[pattern] = targets;
        }
      }
    }
  }

  return {
    // Only propagate baseUrl when it is explicitly defined by this config chain.
    // Falling back to configDir here makes extended configs (for example
    // "astro/tsconfigs/strict") incorrectly become the alias root.
    baseUrl: mergedBaseUrl,
    paths: mergedPaths,
  };
}

function createTsconfigResolver(
  searchStart: string,
): TsconfigPathResolver | null {
  const tsconfigPath = findTsconfigPath(searchStart);
  if (!tsconfigPath) {
    return null;
  }

  const compilerOptions = loadTsconfigCompilerOptions(tsconfigPath);
  if (!compilerOptions?.paths) {
    return null;
  }

  const tsconfigDir = getNodePath().dirname(tsconfigPath);
  const baseUrl = compilerOptions.baseUrl ?? tsconfigDir;
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
          const resolvedTarget = matcher.hasWildcard
            ? target.replace(/\*/g, wildcardValue)
            : target;
          const candidateBase = getNodePath().isAbsolute(resolvedTarget)
            ? resolvedTarget
            : getNodePath().resolve(baseUrl, resolvedTarget);
          const resolvedFile = resolveFileFromBase(candidateBase);
          if (resolvedFile) {
            return resolvedFile;
          }
        }
      }

      const baseUrlFallback = resolveFileFromBase(
        getNodePath().resolve(baseUrl, source),
      );
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

function resolveAliasedPath(
  importerId: string,
  source: string,
  options: Pick<ImportResolverOptions, "projectRoot" | "viteRoot">,
): string | null {
  if (source.startsWith(".")) {
    return resolveFileFromBase(
      getNodePath().resolve(getNodePath().dirname(importerId), source),
    );
  }

  if (getNodePath().isAbsolute(source)) {
    const rootRelative = resolveFileFromBase(
      getNodePath().resolve(options.viteRoot, `.${source}`),
    );
    if (rootRelative) {
      return rootRelative;
    }
    const resolved = resolveFileFromBase(source);
    if (resolved) {
      return resolved;
    }
    return null;
  }

  const projectRelative = resolveFileFromBase(
    getNodePath().resolve(options.projectRoot, source),
  );
  if (projectRelative) {
    return projectRelative;
  }

  if (options.viteRoot !== options.projectRoot) {
    return resolveFileFromBase(getNodePath().resolve(options.viteRoot, source));
  }

  return null;
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

function resolveImportToFile(
  importerId: string,
  source: string,
  options: ImportResolverOptions,
): string | null {
  if (source.startsWith(".")) {
    const base = getNodePath().resolve(
      getNodePath().dirname(importerId),
      source,
    );
    return resolveFileFromBase(base);
  }

  if (source.startsWith("/")) {
    const resolvedRootRelative = resolveFileFromBase(
      getNodePath().resolve(options.viteRoot, `.${source}`),
    );
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

    const resolvedAliased = resolveAliasedPath(
      importerId,
      aliased,
      options,
    );
    if (resolvedAliased) {
      return resolvedAliased;
    }
  }

  if (source === "$lib" || source.startsWith("$lib/")) {
    const projectRoot = inferProjectRootFromImporter(importerId) ??
      options.projectRoot;
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

function moduleIdToFilePath(id: string, viteRoot: string): string | null {
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

    const rootRelative = getNodePath().resolve(viteRoot, `.${normalizedId}`);
    if (getNodeFs().existsSync(rootRelative)) {
      return getNodePath().normalize(rootRelative);
    }

    return absolute;
  }

  return getNodePath().normalize(
    getNodePath().resolve(viteRoot, normalizedId),
  );
}

function isPathWithinScope(filePath: string, scopePath: string): boolean {
  const relative = getNodePath().relative(scopePath, filePath);
  return relative === "" ||
    (!relative.startsWith("..") && !getNodePath().isAbsolute(relative));
}

function isInDefaultTransformScope(
  id: string,
  viteRoot: string,
  projectRoot: string,
  includePaths: readonly string[],
): boolean {
  const modulePath = moduleIdToFilePath(id, viteRoot);
  if (!modulePath) {
    return false;
  }

  if (viteRoot !== projectRoot && isPathWithinScope(modulePath, viteRoot)) {
    return true;
  }

  const defaultSourceDirs = ["src", "app"];
  for (const sourceDir of defaultSourceDirs) {
    const sourcePath = getNodePath().resolve(projectRoot, sourceDir);
    if (isPathWithinScope(modulePath, sourcePath)) {
      return true;
    }
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
  /** Override the default scope (`<root>/{src,app}/**`) with a custom id matcher. */
  include?: RegExp;
}

/**
 * Vite plugin that extracts `ct()` usage and emits a virtual stylesheet.
 */
export function cssTsPlugin(options: CssTsPluginOptions = {}): any {
  const moduleImports = new Map<string, string[]>();
  const moduleCss = new Map<string, string>();
  const managedModules = new Set<string>();
  const moduleStaticDependencies = new Map<string, Set<string>>();
  const dependencyOwners = new Map<string, Set<string>>();
  let server: ViteDevServerLike | undefined;
  let viteRoot = process.cwd();
  let projectRoot = process.cwd();
  let viteAliases: ViteAliasEntry[] = [];
  let tsconfigResolver: TsconfigPathResolver | null = null;
  let cssConfig: LoadedCssConfig = {
    path: null,
    dependencies: [],
    imports: [],
    themeMode: "color-scheme",
    resolution: "hybrid",
    hasExplicitResolution: false,
    debug: {
      logDynamic: false,
      logStatic: false,
    },
    breakpoints: {},
    containers: {},
    layers: [],
    defaultUnit: undefined,
    include: [],
    utilities: {},
    configCss: "",
    utilityCss: "",
    runtimeOptions: {
      themeMode: "color-scheme",
    },
  };
  let resolverInitialized = false;

  function initializeResolvers(root: string): void {
    viteRoot = root;
    projectRoot = findProjectRoot(root);
    tsconfigResolver = createTsconfigResolver(viteRoot);
    cssConfig = loadCssConfig(viteRoot, {
      projectRoot,
      viteRoot,
      viteAliases,
      tsconfigResolver,
    });
    resolverInitialized = true;
  }

  function ensureResolvers(importerId: string): void {
    if (resolverInitialized) {
      return;
    }
    const inferredRoot = inferProjectRootFromImporter(importerId);
    initializeResolvers(inferredRoot ?? viteRoot);
  }

  function combinedCss(): string {
    const parts: string[] = [];
    for (const cssImport of cssConfig.imports) {
      parts.push(`@import ${cssImport};`);
    }
    const dedupedModuleImports = new Set<string>();
    for (const imports of moduleImports.values()) {
      for (const cssImport of imports) {
        dedupedModuleImports.add(cssImport);
      }
    }
    for (const cssImport of dedupedModuleImports) {
      parts.push(`@import ${cssImport};`);
    }
    if (cssConfig.configCss) {
      parts.push(cssConfig.configCss);
    }
    if (cssConfig.utilityCss) {
      parts.push(cssConfig.utilityCss);
    }
    parts.push(mergeCss(moduleCss.values()));
    return parts.filter((part) => part.length > 0).join("\n");
  }

  function moduleScopedCss(moduleId: string): string {
    const parts: string[] = [];
    const imports = moduleImports.get(moduleId) ?? [];
    for (const cssImport of imports) {
      parts.push(`@import ${cssImport};`);
    }
    const rules = moduleCss.get(moduleId);
    if (rules && rules.length > 0) {
      parts.push(rules);
    }
    return parts.join("\n");
  }

  function updateModuleStaticDependencies(
    moduleId: string,
    dependencies: Iterable<string>,
  ): void {
    const previous = moduleStaticDependencies.get(moduleId);
    if (previous) {
      for (const dependency of previous) {
        const owners = dependencyOwners.get(dependency);
        if (!owners) {
          continue;
        }
        owners.delete(moduleId);
        if (owners.size === 0) {
          dependencyOwners.delete(dependency);
        }
      }
      moduleStaticDependencies.delete(moduleId);
    }

    const next = new Set<string>();
    for (const dependency of dependencies) {
      const normalizedDependency = cleanId(dependency);
      if (!normalizedDependency || normalizedDependency === moduleId) {
        continue;
      }
      next.add(normalizedDependency);
    }

    if (next.size === 0) {
      return;
    }

    moduleStaticDependencies.set(moduleId, next);
    for (const dependency of next) {
      const owners = dependencyOwners.get(dependency) ?? new Set<string>();
      owners.add(moduleId);
      dependencyOwners.set(dependency, owners);
    }
  }

  function clearManagedModuleState(moduleId: string): boolean {
    managedModules.delete(moduleId);
    updateModuleStaticDependencies(moduleId, []);

    let didChange = false;
    if (moduleCss.delete(moduleId)) {
      didChange = true;
    }
    if (moduleImports.delete(moduleId)) {
      didChange = true;
    }
    return didChange;
  }

  function addWatchFiles(
    ctx: ViteTransformContextLike | undefined,
    dependencies: Iterable<string>,
  ): void {
    if (typeof ctx?.addWatchFile !== "function") {
      return;
    }

    for (const dependency of dependencies) {
      ctx.addWatchFile(dependency);
    }
  }

  function invalidateGraphModule(
    module: unknown,
    timestamp?: number,
    invalidatedModules?: Set<unknown>,
  ): void {
    if (!server) {
      return;
    }
    server.moduleGraph.invalidateModule(
      module,
      invalidatedModules,
      timestamp,
      true,
    );
  }

  function invalidateModuleById(
    id: string,
    timestamp?: number,
    invalidatedModules?: Set<unknown>,
  ): unknown[] {
    if (!server) {
      return [];
    }
    const module = server.moduleGraph.getModuleById(id);
    if (module) {
      invalidateGraphModule(module, timestamp, invalidatedModules);
      return [module];
    }
    return [];
  }

  function invalidateModulesByFile(
    file: string,
    timestamp?: number,
    invalidatedModules?: Set<unknown>,
  ): unknown[] {
    if (!server) {
      return [];
    }

    const modules = server.moduleGraph.getModulesByFile?.(file);
    if (modules && modules.size > 0) {
      const invalidated = Array.from(modules);
      for (const module of invalidated) {
        invalidateGraphModule(module, timestamp, invalidatedModules);
      }
      return invalidated;
    }

    const fallback = server.moduleGraph.getModuleById(file);
    if (!fallback) {
      return [];
    }

    invalidateGraphModule(fallback, timestamp, invalidatedModules);
    return [fallback];
  }

  function invalidateVirtualModules(
    moduleIds: Iterable<string> = [],
    timestamp?: number,
    invalidatedModules?: Set<unknown>,
  ): unknown[] {
    const invalidated = new Set<unknown>();
    for (
      const module of invalidateModuleById(
        RESOLVED_VIRTUAL_ID,
        timestamp,
        invalidatedModules,
      )
    ) {
      invalidated.add(module);
    }
    for (const moduleId of moduleIds) {
      for (
        const module of invalidateModuleById(
          resolvedModuleVirtualId(moduleId),
          timestamp,
          invalidatedModules,
        )
      ) {
        invalidated.add(module);
      }
    }
    return Array.from(invalidated);
  }

  function invalidateManagedModules(
    moduleIds: Iterable<string>,
    timestamp?: number,
    invalidatedModules?: Set<unknown>,
  ): unknown[] {
    const normalizedIds = new Set<string>();
    for (const moduleId of moduleIds) {
      normalizedIds.add(cleanId(moduleId));
    }

    const invalidated = new Set<unknown>();
    for (const moduleId of normalizedIds) {
      for (
        const module of invalidateModulesByFile(
          moduleId,
          timestamp,
          invalidatedModules,
        )
      ) {
        invalidated.add(module);
      }
    }
    for (
      const module of invalidateVirtualModules(
        normalizedIds,
        timestamp,
        invalidatedModules,
      )
    ) {
      invalidated.add(module);
    }
    return Array.from(invalidated);
  }

  return {
    name: "css-ts",
    enforce: "pre",

    configureServer(devServer: ViteDevServerLike) {
      server = devServer;
    },

    configResolved(config: ViteResolvedConfigLike) {
      viteRoot = config.root;
      viteAliases = normalizeViteAliases(config.resolve.alias);
      initializeResolvers(viteRoot);
    },

    resolveId(id: string) {
      if (cleanId(id) === PUBLIC_VIRTUAL_ID) {
        const suffix = id.slice(PUBLIC_VIRTUAL_ID.length);
        return `${RESOLVED_VIRTUAL_ID}${suffix}`;
      }
      if (cleanId(id) === PUBLIC_TAILWIND_RUNTIME_ID) {
        return RESOLVED_TAILWIND_RUNTIME_ID;
      }
      return null;
    },

    load(id: string) {
      if (cleanId(id) === RESOLVED_VIRTUAL_ID) {
        const moduleId = readModuleVirtualImportId(id);
        if (moduleId) {
          return moduleScopedCss(moduleId);
        }
        return combinedCss();
      }
      if (cleanId(id) === RESOLVED_TAILWIND_RUNTIME_ID) {
        return loadTailwindRuntimeModule();
      }
      return null;
    },

    transform(
      this: ViteTransformContextLike | undefined,
      code: string,
      id: string,
    ) {
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
      if (
        !options.include &&
        !isInDefaultTransformScope(
          normalizedId,
          viteRoot,
          projectRoot,
          cssConfig.include,
        )
      ) {
        return null;
      }
      const isSvelte = normalizedId.endsWith(".svelte");
      const isAstro = normalizedId.endsWith(".astro");
      let nextCode = code;

      if (!isSvelte && !isAstro && !hasCssTsImport(code)) {
        return null;
      }

      const astTargets = !isSvelte && !isAstro
        ? collectAstTransformTargets(nextCode, normalizedId)
        : null;
      const calls = astTargets?.calls ?? findCtCalls(nextCode);
      const newCtDecls: AstNewCtDeclaration[] = astTargets?.newCtDecls ??
        findNewCtDeclarations(nextCode).map((decl) => {
          return {
            varName: decl.varName,
            start: decl.start,
            initializerStart: decl.initializerStart,
            initializerEnd: decl.initializerEnd,
            optionsSource: decl.optionsSource,
            hasStaticOptions: decl.hasStaticOptions,
            simple: decl.simple,
            hasAddContainerCall: new RegExp(
              `\\b${decl.varName}\\.addContainer\\s*\\(`,
            ).test(nextCode),
            assignments: decl.assignments,
          };
        });
      if (calls.length === 0 && newCtDecls.length === 0) {
        if (!isSvelte && !isAstro) {
          return null;
        }

        const usesStylesCall = /\bstyles\s*\(\s*\)/.test(nextCode);
        if (!usesStylesCall) {
          return null;
        }

        nextCode = isSvelte
          ? addVirtualImportToSvelte(nextCode)
          : addVirtualImportToAstro(nextCode);
        return {
          code: nextCode,
          map: null,
        };
      }

      const replacements: Array<{ start: number; end: number; text: string }> =
        [];
      const importRules = new Set<string>();
      const rules = new Set<string>();
      const resolution = isAstro && !cssConfig.hasExplicitResolution
        ? "static"
        : cssConfig.resolution;
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
      const staticDependencies = new Set<string>();

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
        return new Error(
          `[css-ts] ${message} (${normalizedId}:${lineAt(index)})`,
        );
      }

      function logStatic(message: string): void {
        if (!shouldLogStatic) {
          return;
        }
        console.log(`[css-ts][static] ${normalizedId} ${message}`);
      }

      function withRuntimeOptionsInNewCtInitializer(
        optionsSource?: string,
      ): string {
        return `new ct(${optionsSource ?? "undefined"}, undefined, ${runtimeOptionsLiteral})`;
      }

      function readMemberPath(
        value: unknown,
        members: readonly string[],
      ): unknown | null {
        let current: unknown = value;
        for (const member of members) {
          if (
            typeof current !== "object" || current === null ||
            Array.isArray(current)
          ) {
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
          staticDependencies.add(cleanId(moduleId));
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

      function resolveIdentifierInModule(
        identifierPath: readonly string[],
        moduleId: string,
      ): unknown | null {
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
          const buildEvalScope = (
            excludeName?: string,
            sourceHint?: string,
          ): Record<string, unknown> => {
            const evalScope: Record<string, unknown> = {
              ...STATIC_EVAL_GLOBALS,
            };
            for (const localName of moduleInfo.functionDeclarations.keys()) {
              if (
                localName === excludeName ||
                !identifierMentioned(sourceHint, localName)
              ) {
                continue;
              }
              const localValue = resolveIdentifierInModule(
                [localName],
                moduleId,
              );
              if (localValue !== null) {
                evalScope[localName] = localValue;
              }
            }
            for (const localName of moduleInfo.constInitializers.keys()) {
              if (
                localName === excludeName ||
                !identifierMentioned(sourceHint, localName)
              ) {
                continue;
              }
              const localValue = resolveIdentifierInModule(
                [localName],
                moduleId,
              );
              if (localValue !== null) {
                evalScope[localName] = localValue;
              }
            }
            for (const localName of moduleInfo.imports.keys()) {
              if (!identifierMentioned(sourceHint, localName)) {
                continue;
              }
              const localValue = resolveIdentifierInModule(
                [localName],
                moduleId,
              );
              if (localValue !== null) {
                evalScope[localName] = localValue;
              }
            }
            return evalScope;
          };

          const initializerInfo = moduleInfo.constInitializers.get(head);
          if (initializerInfo !== undefined) {
            const initializer = initializerInfo.initializer;
            let value = parseStaticExpression(initializer, (nestedPath) => {
              const nested = resolveIdentifierInModule(nestedPath, moduleId);
              return nested === null ? undefined : nested;
            }, { keepUnresolvedIdentifiers: true });

            if (value === null) {
              value = evaluateExpression(
                initializer,
                buildEvalScope(head, initializer),
              );
            }

            if (value !== null) {
              resolved = tail.length > 0 ? readMemberPath(value, tail) : value;
            }
          } else {
            const functionDeclaration = moduleInfo.functionDeclarations.get(
              head,
            );
            if (functionDeclaration !== undefined) {
              const functionValue = evaluateFunctionDeclaration(
                functionDeclaration,
                buildEvalScope(head, functionDeclaration),
              );
              if (functionValue !== null) {
                resolved = tail.length > 0
                  ? readMemberPath(functionValue, tail)
                  : functionValue;
              }
            }
          }

          if (resolved === null) {
            const binding = moduleInfo.imports.get(head);
            if (binding) {
              resolved = resolveStaticCssTsImport(binding, tail);
              if (resolved === null) {
                const resolvedImportFile = resolveImportToFile(
                  moduleId,
                  binding.source,
                  {
                    projectRoot,
                    viteRoot,
                    viteAliases,
                    tsconfigResolver,
                  },
                );
                resolved = resolveStaticImageImport(
                  binding,
                  tail,
                  moduleId,
                  resolvedImportFile,
                  {
                    projectRoot,
                    viteRoot,
                    viteAliases,
                    tsconfigResolver,
                  },
                );
                if (resolved === null && resolvedImportFile) {
                  const importedModuleInfo = getModuleInfo(resolvedImportFile);
                  if (importedModuleInfo) {
                    if (binding.kind === "namespace") {
                      if (tail.length > 0) {
                        const [namespaceExport, ...namespaceTail] = tail;
                        const exportedLocalName =
                          importedModuleInfo.exportedConsts.get(
                            namespaceExport,
                          ) ?? namespaceExport;
                        const namespaceValue = resolveIdentifierInModule(
                          [exportedLocalName],
                          resolvedImportFile,
                        );
                        resolved = namespaceTail.length > 0
                          ? readMemberPath(namespaceValue, namespaceTail)
                          : namespaceValue;
                      }
                    } else {
                      const importedName = binding.kind === "default"
                        ? "default"
                        : binding.imported;
                      const exportedLocalName = importedName === "default"
                        ? null
                        : (importedModuleInfo.exportedConsts.get(
                          importedName,
                        ) ??
                          importedName);
                      const importedValue = resolveIdentifierInModule(
                        exportedLocalName ? [exportedLocalName] : ["default"],
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
          }

          if (
            resolved === null && head === "default" &&
            moduleInfo.defaultExportExpression
          ) {
            const parsedDefault = parseStaticExpression(
              moduleInfo.defaultExportExpression,
              (nestedPath) =>
                resolveIdentifierInModule(nestedPath, moduleId) ?? undefined,
            );
            if (parsedDefault !== null) {
              resolved = tail.length > 0
                ? readMemberPath(parsedDefault, tail)
                : parsedDefault;
            } else {
              const evaluatedDefault = evaluateExpression(
                moduleInfo.defaultExportExpression,
                buildEvalScope(undefined, moduleInfo.defaultExportExpression),
              );
              if (evaluatedDefault !== null) {
                resolved = tail.length > 0
                  ? readMemberPath(evaluatedDefault, tail)
                  : evaluatedDefault;
              }
            }
          }
        }

        resolving.delete(cacheKey);
        if (resolved !== null) {
          constValueCache.set(cacheKey, resolved);
        } else {
          constValueCache.delete(cacheKey);
        }
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

        const parsed = parseCtCallArgumentsWithResolver(
          call.arg,
          (identifierPath) =>
            resolveIdentifierInModule(identifierPath, normalizedId) ??
              undefined,
          {
            utilities: cssConfig.utilities,
            containers: cssConfig.containers,
            themeMode: cssConfig.themeMode,
          },
        ) ??
          parseCtCallArguments(call.arg, {
            utilities: cssConfig.utilities,
            containers: cssConfig.containers,
            themeMode: cssConfig.themeMode,
          });
        if (!parsed) {
          if (resolution === "static") {
            throw staticResolutionError(
              'resolution="static" could not statically resolve ct(...)',
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
          const browserPath = toBrowserStylesheetPath(
            importPath,
            normalizedId,
            {
              projectRoot,
              viteRoot,
              viteAliases,
              tsconfigResolver,
            },
          );
          if (browserPath) {
            importRules.add(browserPath);
            logStatic(`import -> ${browserPath}`);
          }
        }

        const classMap: Record<string, string> = {};
        const variantClassMap: Record<
          string,
          Record<string, Partial<Record<string, string>>>
        > = {};
        const variantGlobalRuleMap: Record<string, Record<string, string[]>> =
          {};
        const compiledConfig: Record<string, unknown> = {};
        if ((parsed.imports?.length ?? 0) > 0) {
          compiledConfig.imports = true;
        }

        const extractedGlobalRules = {
          ...rootVarsToGlobalRules(parsed.root ?? parsed.rootVars),
          ...(parsed.global ?? {}),
        };
        if (Object.keys(extractedGlobalRules).length > 0) {
          for (
            const rule of toCssGlobalRules(extractedGlobalRules, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
              defaultUnit: cssConfig.defaultUnit,
            })
          ) {
            rules.add(rule);
          }
          compiledConfig.global = true;
          for (const selector of Object.keys(extractedGlobalRules)) {
            logStatic(`global.${selector}`);
          }
        }

        for (const [key, style] of Object.entries(parsed.base)) {
          const generatedClassName = hasStyleDeclarations(style.declaration) ||
              !hasTailwindClassNames(style)
            ? createClassName(key, style.declaration, normalizedId)
            : undefined;
          const classValue = resolveStyleClassValue(generatedClassName, style);
          classMap[key] = classValue;
          if (!generatedClassName) {
            continue;
          }
          for (
            const rule of toCssRules(generatedClassName, style.declaration, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
              defaultUnit: cssConfig.defaultUnit,
            })
          ) {
            rules.add(rule);
          }
        }
        compiledConfig.base = classMap;
        for (const [key, className] of Object.entries(classMap)) {
          logStatic(`base.${key} -> ${className}`);
        }

        if (parsed.variant) {
          for (const [group, variants] of Object.entries(parsed.variant)) {
            const groupMap: Record<string, Partial<Record<string, string>>> =
              {};
            for (
              const [variantName, declarations] of Object.entries(variants)
            ) {
              const variantMap: Partial<Record<string, string>> = {};
              for (const [key, style] of Object.entries(declarations)) {
                const generatedClassName =
                  hasStyleDeclarations(style.declaration) ||
                    !hasTailwindClassNames(style)
                    ? createClassName(
                      `${group}:${variantName}:${key}`,
                      style.declaration,
                      normalizedId,
                    )
                    : undefined;
                const classValue = resolveStyleClassValue(
                  generatedClassName,
                  style,
                );
                variantMap[key] = classValue;
                if (generatedClassName) {
                  for (
                    const rule of toCssRules(
                      generatedClassName,
                      style.declaration,
                      {
                        breakpoints: cssConfig.breakpoints,
                        containers: cssConfig.containers,
                        defaultUnit: cssConfig.defaultUnit,
                      },
                    )
                  ) {
                    rules.add(rule);
                  }
                }
                logStatic(
                  `variant.${group}.${variantName}.${key} -> ${classValue}`,
                );
              }
              groupMap[variantName] = variantMap;
            }
            variantClassMap[group] = groupMap;
          }
          compiledConfig.variant = variantClassMap;
        }

        if (parsed.variantGlobal) {
          for (
            const [group, variants] of Object.entries(parsed.variantGlobal)
          ) {
            const groupMap: Record<string, string[]> = {};
            for (
              const [variantName, declarations] of Object.entries(variants)
            ) {
              const variantRules = toCssGlobalRules(declarations, {
                breakpoints: cssConfig.breakpoints,
                containers: cssConfig.containers,
                defaultUnit: cssConfig.defaultUnit,
              });
              groupMap[variantName] = variantRules;
              logStatic(`variantGlobal.${group}.${variantName}`);
            }
            variantGlobalRuleMap[group] = groupMap;
          }
          compiledConfig.variantGlobal = variantGlobalRuleMap;
        }

        const runtimeConfigLiteral = toRuntimeCtConfigLiteral(parsed);
        const replacement = `ct(${runtimeConfigLiteral}, ${
          JSON.stringify(compiledConfig)
        }, ${runtimeOptionsLiteral})`;
        replacements.push({
          start: call.start,
          end: call.end,
          text: replacement,
        });
      }

      for (const decl of newCtDecls) {
        const resolvedBuilderOptionsValue = decl.optionsSource
          ? parseStaticExpression(
            decl.optionsSource,
            (identifierPath) =>
              resolveIdentifierInModule(identifierPath, normalizedId) ??
                undefined,
          ) ?? parseStaticExpression(decl.optionsSource)
          : undefined;
        const hasStaticBuilderOptions = decl.optionsSource === undefined ||
          resolvedBuilderOptionsValue !== null;
        const resolvedBuilderOptions = parseCtBuilderOptions(
          resolvedBuilderOptionsValue,
        ) ?? { simple: decl.simple };
        const runtimeDeclaration = withRuntimeOptionsInNewCtInitializer(
          decl.optionsSource,
        );

        if (resolution === "dynamic") {
          replacements.push({
            start: decl.initializerStart,
            end: decl.initializerEnd,
            text: runtimeDeclaration,
          });
          continue;
        }

        if (decl.hasAddContainerCall) {
          if (resolution === "static") {
            throw staticResolutionError(
              `resolution="static" cannot statically resolve ${decl.varName}.addContainer(...)`,
              decl.start,
            );
          }
          replacements.push({
            start: decl.initializerStart,
            end: decl.initializerEnd,
            text: runtimeDeclaration,
          });
          continue;
        }

        if (!hasStaticBuilderOptions) {
          if (resolution === "static") {
            throw staticResolutionError(
              `resolution="static" could not statically resolve options for ${decl.varName}`,
              decl.start,
            );
          }
          replacements.push({
            start: decl.initializerStart,
            end: decl.initializerEnd,
            text: runtimeDeclaration,
          });
          continue;
        }

        const configParts: Record<string, unknown> = resolvedBuilderOptions.simple
          ? { simple: true }
          : {};
        const importParts: unknown[] = [];
        let allParsed = true;

        for (const assignment of decl.assignments) {
          let value = parseStaticExpression(assignment.valueSource) ??
            parseStaticExpression(
              assignment.valueSource,
              (identifierPath) =>
                resolveIdentifierInModule(identifierPath, normalizedId) ??
                  undefined,
            );
          if (value === null) {
            const moduleInfo = getModuleInfo(normalizedId);
            if (moduleInfo) {
              const evalScope: Record<string, unknown> = {
                ...STATIC_EVAL_GLOBALS,
              };
              for (const localName of moduleInfo.functionDeclarations.keys()) {
                if (!identifierMentioned(assignment.valueSource, localName)) {
                  continue;
                }
                const localValue = resolveIdentifierInModule(
                  [localName],
                  normalizedId,
                );
                if (localValue !== null) {
                  evalScope[localName] = localValue;
                }
              }
              for (const localName of moduleInfo.constInitializers.keys()) {
                if (!identifierMentioned(assignment.valueSource, localName)) {
                  continue;
                }
                const localValue = resolveIdentifierInModule(
                  [localName],
                  normalizedId,
                );
                if (localValue !== null) {
                  evalScope[localName] = localValue;
                }
              }
              for (const localName of moduleInfo.imports.keys()) {
                if (!identifierMentioned(assignment.valueSource, localName)) {
                  continue;
                }
                const localValue = resolveIdentifierInModule(
                  [localName],
                  normalizedId,
                );
                if (localValue !== null) {
                  evalScope[localName] = localValue;
                }
              }
              value = evaluateExpression(assignment.valueSource, evalScope);
            }
          }
          if (value === null) {
            if (
              assignment.property === "base" ||
              assignment.property === "global" ||
              assignment.property === "themes" ||
              assignment.property === "root" ||
              assignment.property === "rootVars" ||
              assignment.property === "variant" ||
              assignment.property === "defaults"
            ) {
              const partialParsed = parseCtCallArgumentsWithResolver(
                `{ ${
                  resolvedBuilderOptions.simple ? "simple: true, " : ""
                }${assignment.property}: ${assignment.valueSource} }`,
                (identifierPath) =>
                  resolveIdentifierInModule(identifierPath, normalizedId) ??
                    undefined,
                {
                  utilities: cssConfig.utilities,
                  containers: cssConfig.containers,
                  themeMode: cssConfig.themeMode,
                },
              ) ?? parseCtCallArguments(
                `{ ${
                  resolvedBuilderOptions.simple ? "simple: true, " : ""
                }${assignment.property}: ${assignment.valueSource} }`,
                {
                  utilities: cssConfig.utilities,
                  containers: cssConfig.containers,
                  themeMode: cssConfig.themeMode,
                },
              );

              if (partialParsed) {
                const parsedRoot = partialParsed.root ?? partialParsed.rootVars;
                if (assignment.property === "base") {
                  configParts.base = partialParsed.base;
                } else if (assignment.property === "global") {
                  configParts.global = partialParsed.global ?? {};
                } else if (
                  assignment.property === "themes" &&
                  Object.keys(partialParsed.global ?? {}).length > 0
                ) {
                  configParts.global = {
                    ...(configParts.global as Record<string, unknown> ?? {}),
                    ...(partialParsed.global as Record<string, unknown>),
                  };
                  if (parsedRoot) {
                    configParts.root = [
                      ...((configParts.root as unknown[]) ?? []),
                      ...parsedRoot,
                    ];
                  }
                } else if (
                  (assignment.property === "root" ||
                    assignment.property === "rootVars") &&
                  parsedRoot
                ) {
                  configParts.root = parsedRoot;
                } else if (
                  assignment.property === "themes" &&
                  parsedRoot
                ) {
                  configParts.root = [
                    ...((configParts.root as unknown[]) ?? []),
                    ...parsedRoot,
                  ];
                } else if (
                  assignment.property === "variant" && partialParsed.variant
                ) {
                  configParts.variant = partialParsed.variant;
                } else if (
                  assignment.property === "defaults" && partialParsed.defaults
                ) {
                  configParts.defaults = partialParsed.defaults;
                }
                if ((partialParsed.imports?.length ?? 0) > 0) {
                  importParts.push(partialParsed.imports!);
                }
                continue;
              }
            }

            allParsed = false;
            break;
          }

          if (assignment.property === "import") {
            importParts.push(value);
          } else {
            configParts[
              assignment.property === "rootVars" ? "root" : assignment.property
            ] = value;
          }
        }

        if (importParts.length > 0) {
          configParts.global = configParts.global ?? {};
          const currentGlobal = configParts.global as Record<string, unknown>;

          for (const entryGroup of importParts) {
            const entries = Array.isArray(entryGroup)
              ? entryGroup
              : [entryGroup];
            for (const entry of entries) {
              if (
                typeof entry === "string" ||
                (typeof entry === "object" && entry !== null && "path" in entry)
              ) {
                currentGlobal["@import"] = currentGlobal["@import"] ?? [];
                if (Array.isArray(currentGlobal["@import"])) {
                  currentGlobal["@import"].push(entry);
                } else {
                  currentGlobal["@import"] = [currentGlobal["@import"], entry];
                }
              } else if (typeof entry === "object" && entry !== null) {
                if ("rules" in entry) {
                  const ruleObj = entry as { layer?: string; rules: unknown };
                  if (ruleObj.layer && typeof ruleObj.layer === "string") {
                    currentGlobal[`@layer ${ruleObj.layer}`] = ruleObj.rules;
                  } else if (
                    ruleObj.rules && typeof ruleObj.rules === "object"
                  ) {
                    Object.assign(currentGlobal, ruleObj.rules);
                  }
                } else {
                  Object.assign(currentGlobal, entry);
                }
              }
            }
          }
        }

        if (!allParsed) {
          if (resolution === "static") {
            throw staticResolutionError(
              `resolution="static" could not statically resolve assignments for ${decl.varName}`,
              decl.start,
            );
          }
          replacements.push({
            start: decl.initializerStart,
            end: decl.initializerEnd,
            text: runtimeDeclaration,
          });
          continue;
        }

        const parsed = parseCtConfig(configParts, {
          utilities: cssConfig.utilities,
          containers: cssConfig.containers,
          themeMode: cssConfig.themeMode,
        });
        if (!parsed) {
          if (resolution === "static") {
            throw staticResolutionError(
              `resolution="static" could not statically resolve config for ${decl.varName}`,
              decl.start,
            );
          }
          replacements.push({
            start: decl.initializerStart,
            end: decl.initializerEnd,
            text: runtimeDeclaration,
          });
          continue;
        }

        for (const importPath of parsed.imports ?? []) {
          const browserPath = toBrowserStylesheetPath(
            importPath,
            normalizedId,
            {
              projectRoot,
              viteRoot,
              viteAliases,
              tsconfigResolver,
            },
          );
          if (browserPath) {
            importRules.add(browserPath);
            logStatic(`import -> ${browserPath}`);
          }
        }

        const classMap: Record<string, string> = {};
        const variantClassMap: Record<
          string,
          Record<string, Partial<Record<string, string>>>
        > = {};
        const variantGlobalRuleMap: Record<string, Record<string, string[]>> =
          {};
        const compiledConfig: Record<string, unknown> = {};
        if ((parsed.imports?.length ?? 0) > 0) {
          compiledConfig.imports = true;
        }

        const extractedGlobalRules = {
          ...rootVarsToGlobalRules(parsed.root ?? parsed.rootVars),
          ...(parsed.global ?? {}),
        };
        if (Object.keys(extractedGlobalRules).length > 0) {
          for (
            const rule of toCssGlobalRules(extractedGlobalRules, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
              defaultUnit: cssConfig.defaultUnit,
            })
          ) {
            rules.add(rule);
          }
          compiledConfig.global = true;
          for (const selector of Object.keys(extractedGlobalRules)) {
            logStatic(`global.${selector}`);
          }
        }

        for (const [key, style] of Object.entries(parsed.base)) {
          const generatedClassName = hasStyleDeclarations(style.declaration) ||
              !hasTailwindClassNames(style)
            ? createClassName(key, style.declaration, normalizedId)
            : undefined;
          const classValue = resolveStyleClassValue(generatedClassName, style);
          classMap[key] = classValue;
          if (!generatedClassName) {
            continue;
          }
          for (
            const rule of toCssRules(generatedClassName, style.declaration, {
              breakpoints: cssConfig.breakpoints,
              containers: cssConfig.containers,
              defaultUnit: cssConfig.defaultUnit,
            })
          ) {
            rules.add(rule);
          }
        }
        compiledConfig.base = classMap;
        for (const [key, className] of Object.entries(classMap)) {
          logStatic(`base.${key} -> ${className}`);
        }

        if (parsed.variant) {
          for (const [group, variants] of Object.entries(parsed.variant)) {
            const groupMap: Record<string, Partial<Record<string, string>>> =
              {};
            for (
              const [variantName, declarations] of Object.entries(variants)
            ) {
              const variantMap: Partial<Record<string, string>> = {};
              for (const [key, style] of Object.entries(declarations)) {
                const generatedClassName =
                  hasStyleDeclarations(style.declaration) ||
                    !hasTailwindClassNames(style)
                    ? createClassName(
                      `${group}:${variantName}:${key}`,
                      style.declaration,
                      normalizedId,
                    )
                    : undefined;
                const classValue = resolveStyleClassValue(
                  generatedClassName,
                  style,
                );
                variantMap[key] = classValue;
                if (generatedClassName) {
                  for (
                    const rule of toCssRules(
                      generatedClassName,
                      style.declaration,
                      {
                        breakpoints: cssConfig.breakpoints,
                        containers: cssConfig.containers,
                        defaultUnit: cssConfig.defaultUnit,
                      },
                    )
                  ) {
                    rules.add(rule);
                  }
                }
                logStatic(
                  `variant.${group}.${variantName}.${key} -> ${classValue}`,
                );
              }
              groupMap[variantName] = variantMap;
            }
            variantClassMap[group] = groupMap;
          }
          compiledConfig.variant = variantClassMap;
        }

        if (parsed.variantGlobal) {
          for (
            const [group, variants] of Object.entries(parsed.variantGlobal)
          ) {
            const groupMap: Record<string, string[]> = {};
            for (
              const [variantName, declarations] of Object.entries(variants)
            ) {
              const variantRules = toCssGlobalRules(declarations, {
                breakpoints: cssConfig.breakpoints,
                containers: cssConfig.containers,
                defaultUnit: cssConfig.defaultUnit,
              });
              groupMap[variantName] = variantRules;
              logStatic(`variantGlobal.${group}.${variantName}`);
            }
            variantGlobalRuleMap[group] = groupMap;
          }
          compiledConfig.variantGlobal = variantGlobalRuleMap;
        }

        const runtimeConfigLiteral = toRuntimeCtConfigLiteral(parsed);
        const ctCall = `ct(${runtimeConfigLiteral}, ${
          JSON.stringify(compiledConfig)
        }, ${runtimeOptionsLiteral})`;
        replacements.push({
          start: decl.initializerStart,
          end: decl.initializerEnd,
          text: ctCall,
        });

        for (const assignment of decl.assignments) {
          replacements.push({
            start: assignment.start,
            end: assignment.end,
            text: "",
          });
        }
      }

      if (replacements.length === 0) {
        return null;
      }

      replacements.sort((a, b) => b.start - a.start);

      for (const replacement of replacements) {
        nextCode = nextCode.slice(0, replacement.start) +
          replacement.text +
          nextCode.slice(replacement.end);
      }

      nextCode = stripUnusedStaticHelperConsts(nextCode);
      const needsTailwindRuntimeImport =
        nextCode.includes('"tailwindClassNames"') ||
        /\btw\s*\(/.test(nextCode);
      managedModules.add(normalizedId);
      updateModuleStaticDependencies(normalizedId, staticDependencies);
      addWatchFiles(this, staticDependencies);

      let didVirtualCssChange = false;
      let scopedVirtualImport: string | null = null;

      if (isSvelte) {
        nextCode = addVirtualImportToSvelte(nextCode);
        if (needsTailwindRuntimeImport) {
          nextCode = addVirtualImportToSvelte(
            nextCode,
            PUBLIC_TAILWIND_RUNTIME_ID,
          );
        }
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
        nextCode = isAstro
          ? addVirtualImportToAstro(nextCode)
          : addVirtualImport(nextCode);
        if (needsTailwindRuntimeImport) {
          nextCode = isAstro
            ? addVirtualImportToAstro(nextCode, PUBLIC_TAILWIND_RUNTIME_ID)
            : addVirtualImport(nextCode, PUBLIC_TAILWIND_RUNTIME_ID);
        }
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

        if (nextImports.length > 0 || nextCss.length > 0) {
          scopedVirtualImport = moduleVirtualImportId(normalizedId);
        }
      }

      if (scopedVirtualImport) {
        nextCode = isAstro
          ? addModuleVirtualImportToAstro(nextCode, scopedVirtualImport)
          : addVirtualImport(nextCode, scopedVirtualImport);
      }
      if (didVirtualCssChange) {
        invalidateVirtualModules(scopedVirtualImport ? [normalizedId] : []);
      }

      return {
        code: nextCode,
        map: null,
      };
    },

    handleHotUpdate(ctx: { file: string; timestamp?: number }) {
      const normalizedId = cleanId(ctx.file);
      const affectedModules = new Set<unknown>();
      const graphInvalidated = new Set<unknown>();
      const configChanged = (cssConfig.path &&
        normalizedId === cleanId(cssConfig.path)) ||
        cssConfig.dependencies.includes(normalizedId);
      if (configChanged) {
        cssConfig = loadCssConfig(viteRoot, {
          projectRoot,
          viteRoot,
          viteAliases,
          tsconfigResolver,
        });
        for (
          const module of invalidateManagedModules(
            managedModules,
            ctx.timestamp,
            graphInvalidated,
          )
        ) {
          affectedModules.add(module);
        }
        return affectedModules.size > 0
          ? Array.from(affectedModules)
          : undefined;
      }

      const affectedOwners = dependencyOwners.get(normalizedId);
      if (affectedOwners && affectedOwners.size > 0) {
        for (
          const module of invalidateManagedModules(
            affectedOwners,
            ctx.timestamp,
            graphInvalidated,
          )
        ) {
          affectedModules.add(module);
        }
      }

      if (clearManagedModuleState(normalizedId)) {
        for (
          const module of invalidateVirtualModules(
            [normalizedId],
            ctx.timestamp,
            graphInvalidated,
          )
        ) {
          affectedModules.add(module);
        }
        for (
          const module of invalidateModulesByFile(
            normalizedId,
            ctx.timestamp,
            graphInvalidated,
          )
        ) {
          affectedModules.add(module);
        }
      }

      return affectedModules.size > 0 ? Array.from(affectedModules) : undefined;
    },
  };
}

/** Default export for {@link cssTsPlugin}. */
export default cssTsPlugin;
