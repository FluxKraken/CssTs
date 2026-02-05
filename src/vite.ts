import type { Plugin, ViteDevServer } from "vite";
import { findCtCalls, parseCtCallArguments } from "./parser.js";
import { createClassName, toCssRule } from "./shared.js";

const PUBLIC_VIRTUAL_ID = "virtual:css-ts/styles.css";
const RESOLVED_VIRTUAL_ID = "\0virtual:css-ts/styles.css";

function cleanId(id: string): string {
  return id.replace(/\?.*$/, "");
}

function supportsTransform(id: string): boolean {
  return /\.(?:[jt]sx?|svelte)$/.test(cleanId(id));
}

function hasModuleContext(attrs: string): boolean {
  return /\bcontext\s*=\s*["']module["']/.test(attrs);
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

function addVirtualImport(code: string, id: string): string {
  if (code.includes(PUBLIC_VIRTUAL_ID)) {
    return code;
  }

  if (id.endsWith(".svelte")) {
    const scriptTag = /<script\b([^>]*)>/gi;
    let match = scriptTag.exec(code);

    while (match) {
      const attrs = match[1] ?? "";
      if (!hasModuleContext(attrs)) {
        const insertAt = match.index + match[0].length;
        return (
          code.slice(0, insertAt) +
          `\nimport "${PUBLIC_VIRTUAL_ID}";` +
          code.slice(insertAt)
        );
      }
      match = scriptTag.exec(code);
    }

    return `<script>\nimport "${PUBLIC_VIRTUAL_ID}";\n</script>\n${code}`;
  }

  return `import "${PUBLIC_VIRTUAL_ID}";\n${code}`;
}

function mergeCss(rules: Iterable<string>): string {
  return Array.from(rules).join("\n");
}

export interface CssTsPluginOptions {
  include?: RegExp;
}

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
      if (id === PUBLIC_VIRTUAL_ID) {
        return RESOLVED_VIRTUAL_ID;
      }
      return null;
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_ID) {
        return combinedCss();
      }
      return null;
    },

    transform(code, id) {
      const normalizedId = cleanId(id);
      if (!supportsTransform(normalizedId)) {
        return null;
      }
      if (options.include && !options.include.test(normalizedId)) {
        return null;
      }
      const isSvelte = normalizedId.endsWith(".svelte");
      let nextCode = code;
      let touched = false;

      if (isSvelte) {
        const withVirtualImport = addVirtualImport(nextCode, normalizedId);
        if (withVirtualImport !== nextCode) {
          nextCode = withVirtualImport;
          touched = true;
        }
      }

      if (!code.includes("from \"css-ts\"") && !code.includes("from 'css-ts'")) {
        return touched
          ? {
              code: nextCode,
              map: null,
            }
          : null;
      }

      const calls = findCtCalls(nextCode);
      if (calls.length === 0) {
        return touched
          ? {
              code: nextCode,
              map: null,
            }
          : null;
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
          rules.add(toCssRule(className, declaration));
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
                rules.add(toCssRule(className, declaration));
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
        nextCode = addSvelteStyleBlock(nextCode, rules);
        moduleCss.delete(normalizedId);
      } else {
        nextCode = addVirtualImport(nextCode, normalizedId);
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

export default cssTsPlugin;
