import fs from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import {
  findCtCalls,
  parseCtCallArguments,
  parseCtCallArgumentsWithResolver,
  parseStaticExpression,
} from "./parser.js";
import { createClassName, toCssGlobalRules, toCssRules } from "./shared.js";

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
  exportedConsts: Map<string, string>;
};

function cleanId(id: string): string {
  return id.replace(/\?.*$/, "");
}

function supportsTransform(id: string): boolean {
  return /\.(?:[jt]sx?|svelte)$/.test(cleanId(id));
}

function isVirtualSubRequest(id: string): boolean {
  return id.includes("?");
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
  const css = Array.from(rules)
    .map(toSvelteGlobalRule)
    .join("\n");

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

function findExpressionTerminator(input: string, start: number): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString: "" | '"' | "'" | "`" = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
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

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      continue;
    }

    if (char === "}") {
      braceDepth -= 1;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      continue;
    }

    if (char === "]") {
      bracketDepth -= 1;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }

    if (char === ")") {
      parenDepth -= 1;
      continue;
    }

    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (char === ";" || char === ",") {
        return i;
      }

      if (char === "\n") {
        const remaining = input.slice(i + 1).trimStart();
        if (
          remaining.startsWith("const ") ||
          remaining.startsWith("export ") ||
          remaining.startsWith("import ") ||
          remaining.startsWith("function ") ||
          remaining.startsWith("class ") ||
          remaining.startsWith("let ") ||
          remaining.startsWith("var ") ||
          remaining.startsWith("</script>")
        ) {
          return i;
        }
      }
    }
  }

  return input.length;
}

function parseModuleStaticInfo(code: string): ModuleStaticInfo {
  const imports = new Map<string, ImportBinding>();
  const constInitializers = new Map<string, string>();
  const exportedConsts = new Map<string, string>();

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

  const constMatcher = /\b(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  for (let match = constMatcher.exec(code); match; match = constMatcher.exec(code)) {
    const isExported = Boolean(match[1]);
    const name = match[2];
    const initializerStart = constMatcher.lastIndex;
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

  return {
    imports,
    constInitializers,
    exportedConsts,
  };
}

function resolveFileFromBase(basePath: string): string | null {
  const candidates: string[] = [];
  if (path.extname(basePath)) {
    candidates.push(basePath);
  } else {
    for (const extension of STATIC_STYLE_EXTENSIONS) {
      candidates.push(`${basePath}${extension}`);
      candidates.push(path.join(basePath, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.normalize(candidate);
    }
  }

  return null;
}

function resolveImportToFile(importerId: string, source: string): string | null {
  if (source.startsWith(".")) {
    const base = path.resolve(path.dirname(importerId), source);
    return resolveFileFromBase(base);
  }

  if (source.startsWith("/")) {
    return resolveFileFromBase(source);
  }

  if (source === "$lib" || source.startsWith("$lib/")) {
    const marker = `${path.sep}src${path.sep}`;
    const markerIndex = importerId.lastIndexOf(marker);
    if (markerIndex === -1) {
      return null;
    }

    const projectRoot = importerId.slice(0, markerIndex);
    const suffix = source === "$lib" ? "" : source.slice("$lib/".length);
    const base = path.join(projectRoot, "src", "lib", suffix);
    return resolveFileFromBase(base);
  }

  return null;
}

/** Options for {@link cssTsPlugin}. */
export interface CssTsPluginOptions {
  /** Limit transforms to ids that match this regex. */
  include?: RegExp;
}

/**
 * Vite plugin that extracts `ct()` usage and emits a virtual stylesheet.
 */
export function cssTsPlugin(options: CssTsPluginOptions = {}): Plugin {
  const moduleCss = new Map<string, string>();
  let server: ViteDevServer | undefined;

  function combinedCss(): string {
    return mergeCss(moduleCss.values());
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

    configureServer(devServer) {
      server = devServer;
    },

    resolveId(id) {
      if (cleanId(id) === PUBLIC_VIRTUAL_ID) {
        const suffix = id.slice(PUBLIC_VIRTUAL_ID.length);
        return `${RESOLVED_VIRTUAL_ID}${suffix}`;
      }
      return null;
    },

    load(id) {
      if (cleanId(id) === RESOLVED_VIRTUAL_ID) {
        return combinedCss();
      }
      return null;
    },

    transform(code, id) {
      if (isVirtualSubRequest(id)) {
        return null;
      }

      const normalizedId = cleanId(id);
      if (!supportsTransform(normalizedId)) {
        return null;
      }
      if (options.include && !options.include.test(normalizedId)) {
        return null;
      }
      const isSvelte = normalizedId.endsWith(".svelte");
      let nextCode = code;

      const hasCssTsImport =
        code.includes("from \"css-ts\"") || code.includes("from 'css-ts'");
      if (!isSvelte && !hasCssTsImport) {
        return null;
      }

      const calls = findCtCalls(nextCode);
      if (calls.length === 0) {
        if (!isSvelte) {
          return null;
        }

        const usesStylesCall = /\bstyles\s*\(\s*\)/.test(nextCode);
        if (!usesStylesCall) {
          return null;
        }

        nextCode = addVirtualImportToSvelte(nextCode);
        return {
          code: nextCode,
          map: null,
        };
      }

      const replacements: Array<{ start: number; end: number; text: string }> = [];
      const rules = new Set<string>();
      const moduleInfoCache = new Map<string, ModuleStaticInfo>();
      const constValueCache = new Map<string, unknown | null>();
      const resolving = new Set<string>();

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
          return fs.readFileSync(moduleId, "utf8");
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
          const initializer = moduleInfo.constInitializers.get(head);
          if (initializer !== undefined) {
            const value = parseStaticExpression(initializer, (nestedPath) => {
              const nested = resolveIdentifierInModule(nestedPath, moduleId);
              return nested === null ? undefined : nested;
            });

            if (value !== null) {
              resolved = tail.length > 0 ? readMemberPath(value, tail) : value;
            }
          } else {
            const binding = moduleInfo.imports.get(head);
            if (binding) {
              const resolvedImportFile = resolveImportToFile(moduleId, binding.source);
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
                    const exportedLocalName =
                      importedModuleInfo.exportedConsts.get(importedName) ?? importedName;
                    const importedValue = resolveIdentifierInModule(
                      [exportedLocalName],
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

        resolving.delete(cacheKey);
        constValueCache.set(cacheKey, resolved);
        return resolved;
      }

      for (const call of calls) {
        const parsed = parseCtCallArguments(call.arg) ??
          parseCtCallArgumentsWithResolver(
            call.arg,
            (identifierPath) => resolveIdentifierInModule(identifierPath, normalizedId) ?? undefined,
          );
        if (!parsed) {
          continue;
        }

        const classMap: Record<string, string> = {};
        const variantClassMap: Record<string, Record<string, Partial<Record<string, string>>>> = {};
        const compiledConfig: Record<string, unknown> = {};

        if (parsed.global) {
          for (const rule of toCssGlobalRules(parsed.global)) {
            rules.add(rule);
          }
          compiledConfig.global = true;
        }

        for (const [key, declaration] of Object.entries(parsed.base)) {
          const className = createClassName(key, declaration, normalizedId);
          classMap[key] = className;
          for (const rule of toCssRules(className, declaration)) {
            rules.add(rule);
          }
        }
        compiledConfig.base = classMap;

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
                for (const rule of toCssRules(className, declaration)) {
                  rules.add(rule);
                }
              }
              groupMap[variantName] = variantMap;
            }
            variantClassMap[group] = groupMap;
          }
          compiledConfig.variant = variantClassMap;
        }

        const replacement = `ct(${call.arg}, ${JSON.stringify(compiledConfig)})`;
        replacements.push({ start: call.start, end: call.end, text: replacement });
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
        moduleCss.delete(normalizedId);
      } else {
        nextCode = addVirtualImport(nextCode);
        const nextCss = mergeCss(rules);
        const prevCss = moduleCss.get(normalizedId);
        if (prevCss !== nextCss) {
          moduleCss.set(normalizedId, nextCss);
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

    handleHotUpdate(ctx) {
      const normalizedId = cleanId(ctx.file);
      if (moduleCss.has(normalizedId)) {
        moduleCss.delete(normalizedId);
        invalidateVirtualModule();
      }
    },
  };
}

/** Default export for {@link cssTsPlugin}. */
export default cssTsPlugin;
