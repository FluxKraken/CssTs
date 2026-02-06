import {
  createClassName,
  StyleSheet,
  toCssGlobalRules,
  toCssRules,
} from "./shared.js";

type CompiledMap<T extends StyleSheet> = Partial<Record<keyof T, string>>;
type VariantSheet<T extends StyleSheet> = Record<string, Record<string, Partial<T>>>;
type VariantClassMap<T extends StyleSheet> = Record<
  string,
  Record<string, Partial<Record<keyof T, string>>>
>;
type CtConfig<T extends StyleSheet, V extends VariantSheet<T> | undefined> = {
  global?: StyleSheet;
  base?: T;
  variant?: V;
};
type CompiledConfig<T extends StyleSheet> = {
  global?: true;
  base?: CompiledMap<T>;
  variant?: VariantClassMap<T>;
};
type VariantSelection<V extends VariantSheet<any> | undefined> = V extends VariantSheet<any>
  ? { [G in keyof V]?: keyof V[G] }
  : Record<string, string>;
type Accessor<T extends StyleSheet, V extends VariantSheet<T> | undefined> = {
  [K in keyof T]: (variants?: VariantSelection<V>) => string;
};

const RUNTIME_STYLE_TAG_ID = "__css_ts_runtime_styles";
const injectedRules = new Set<string>();

type StyleTag = {
  id: string;
  appendChild(node: unknown): void;
};

type DocumentLike = {
  getElementById(id: string): StyleTag | null;
  createElement(tag: "style"): StyleTag;
  createTextNode(text: string): unknown;
  head: { appendChild(node: unknown): void };
};

function injectRule(rule: string): void {
  const doc = (globalThis as unknown as { document?: DocumentLike }).document;
  if (!doc || injectedRules.has(rule)) {
    return;
  }

  let tag = doc.getElementById(RUNTIME_STYLE_TAG_ID);
  if (!tag) {
    tag = doc.createElement("style");
    tag.id = RUNTIME_STYLE_TAG_ID;
    doc.head.appendChild(tag);
  }

  tag.appendChild(doc.createTextNode(rule));
  injectedRules.add(rule);
}

function assertVariantKeys<T extends StyleSheet>(
  styles: T,
  variants: VariantSheet<T>,
): void {
  const styleKeys = new Set(Object.keys(styles));
  for (const [group, groupVariants] of Object.entries(variants)) {
    for (const [variantName, declarations] of Object.entries(groupVariants)) {
      for (const classKey of Object.keys(declarations)) {
        if (!styleKeys.has(classKey)) {
          throw new Error(
            `Unknown style key '${classKey}' in variant '${group}.${variantName}'. ` +
              "Define it in the base style object (use an empty object if needed).",
          );
        }
      }
    }
  }
}

/**
 * Runtime stylesheet helper that generates class names and injects CSS rules.
 *
 * Use this in browsers when you want styles created and applied at runtime.
 */
export default function ct<
  T extends StyleSheet = StyleSheet,
  V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined,
>(
  config: CtConfig<T, V>,
  compiled?: CompiledConfig<T>,
): () => Accessor<T, V> {
  const globalStyles = config.global;
  const styles = (config.base ?? {}) as T;
  const variants = config.variant as VariantSheet<T> | undefined;

  if (globalStyles && !compiled?.global) {
    for (const rule of toCssGlobalRules(globalStyles)) {
      injectRule(rule);
    }
  }

  const accessors = {} as Accessor<T, V>;
  const variantClassMap: VariantClassMap<T> = {};
  const compiledBase = compiled?.base;

  for (const [key, declaration] of Object.entries(styles) as [keyof T, T[keyof T]][]) {
    const className =
      compiledBase?.[key] ?? createClassName(String(key), declaration, "runtime");

    if (!compiledBase?.[key]) {
      for (const rule of toCssRules(className, declaration)) {
        injectRule(rule);
      }
    }

    accessors[key] = (selection) => {
      if (!selection) {
        return className;
      }

      const classNames = [className];

      for (const [group, variantName] of Object.entries(selection)) {
        if (!variantName) {
          continue;
        }

        const variantClass = variantClassMap[group]?.[variantName as string]?.[key];
        if (variantClass) {
          classNames.push(variantClass);
        }
      }

      return classNames.join(" ");
    };
  }

  if (variants) {
    assertVariantKeys(styles, variants);
    const compiledVariants = compiled?.variant;

    for (const [group, groupVariants] of Object.entries(variants)) {
      const groupMap: Record<string, Partial<Record<keyof T, string>>> = {};
      const compiledGroup = compiledVariants?.[group];

      for (const [variantName, declarations] of Object.entries(groupVariants)) {
        const variantMap: Partial<Record<keyof T, string>> = {};
        const compiledVariant = compiledGroup?.[variantName];

        for (const [key, declaration] of Object.entries(declarations) as [
          keyof T,
          T[keyof T],
        ][]) {
          const className =
            compiledVariant?.[key] ??
            createClassName(`${group}:${variantName}:${String(key)}`, declaration, "runtime");

          if (!compiledVariant?.[key]) {
            for (const rule of toCssRules(className, declaration)) {
              injectRule(rule);
            }
          }

          variantMap[key] = className;
        }

        groupMap[variantName] = variantMap;
      }

      variantClassMap[group] = groupMap;
    }
  }

  return () => accessors;
}

/** Re-exported style types for convenience. */
export type { StyleSheet, StyleDeclaration, StyleValue } from "./shared.js";
