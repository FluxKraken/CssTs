import type { Plugin, ViteDevServer } from "vite";
import { findCtCalls, parseCtCallArguments } from "./parser.js";
import { createClassName, toCssRules } from "./shared.js";

const PUBLIC_VIRTUAL_ID = "virtual:css-ts/styles.css";
const RESOLVED_VIRTUAL_ID = "\0virtual:css-ts/styles.css";

function cleanId(id: string): string {
  return id.replace(/\?.*$/, "");
}

function supportsTransform(id: string): boolean {
  return /\.(?:[jt]sx?|svelte)$/.test(cleanId(id));
}

function isVirtualSubRequest(id: string): boolean {
  return id.includes("?");
}

function toSvelteGlobalRule(rule: string): string {
  const open = rule.indexOf("{");
  if (open === -1) return rule;
  const selector = rule.slice(0, open).trim();
  const body = rule.slice(open);
  return `:global(${selector})${body}`;
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
      server.ws.send({ type: "full-reload" });
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

      for (const call of calls) {
        const parsed = parseCtCallArguments(call.arg);
        if (!parsed) {
          continue;
        }

        const classMap: Record<string, string> = {};
        const variantClassMap: Record<string, Record<string, Partial<Record<string, string>>>> = {};

        for (const [key, declaration] of Object.entries(parsed.base)) {
          const className = createClassName(key, declaration, normalizedId);
          classMap[key] = className;
          for (const rule of toCssRules(className, declaration)) {
            rules.add(rule);
          }
        }

        if (parsed.variants) {
          for (const [group, variants] of Object.entries(parsed.variants)) {
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
        }

        const compiledMap = parsed.variants
          ? {
              base: classMap,
              variants: variantClassMap,
            }
          : classMap;

        const replacement = `ct(${call.arg}, ${JSON.stringify(compiledMap)})`;
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

      if (isSvelte) {
        nextCode = addVirtualImportToSvelte(nextCode);
        nextCode = addSvelteStyleBlock(nextCode, rules);
        moduleCss.delete(normalizedId);
      } else {
        nextCode = addVirtualImport(nextCode);
        moduleCss.set(normalizedId, mergeCss(rules));
      }
      invalidateVirtualModule();

      return {
        code: nextCode,
        map: null,
      };
    },

    handleHotUpdate(ctx) {
      const normalizedId = cleanId(ctx.file);
      if (moduleCss.has(normalizedId)) {
        moduleCss.delete(normalizedId);
      }
    },
  };
}

/** Default export for {@link cssTsPlugin}. */
export default cssTsPlugin;
