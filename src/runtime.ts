import {
  createClassName,
  StyleSheet,
  toCssRules,
} from "./shared.js";

type CompiledMap<T extends StyleSheet> = Partial<Record<keyof T, string>>;
type VariantSheet<T extends StyleSheet> = Record<string, Record<string, Partial<T>>>;
type VariantClassMap<T extends StyleSheet> = Record<
  string,
  Record<string, Partial<Record<keyof T, string>>>
>;
type CompiledBundle<T extends StyleSheet> = {
  base: CompiledMap<T>;
  variants?: VariantClassMap<T>;
};
type VariantSelection<V extends VariantSheet<any> | undefined> = V extends VariantSheet<any>
  ? { [G in keyof V]?: keyof V[G] }
  : Record<string, string>;
type Accessor<T extends StyleSheet, V extends VariantSheet<T> | undefined> = {
  [K in keyof T]: (variants?: VariantSelection<V>) => string;
};

const RUNTIME_STYLE_TAG_ID = "__css_ts_runtime_styles";
const injectedRules = new Set<string>();

function injectRule(rule: string): void {
  if (typeof document === "undefined" || injectedRules.has(rule)) {
    return;
  }

  let tag = document.getElementById(RUNTIME_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = RUNTIME_STYLE_TAG_ID;
    document.head.appendChild(tag);
  }

  tag.appendChild(document.createTextNode(rule));
  injectedRules.add(rule);
}

function isCompiledBundle<T extends StyleSheet>(value: unknown): value is CompiledBundle<T> {
  return typeof value === "object" && value !== null && "base" in value;
}

function isClassMapForStyles<T extends StyleSheet>(
  value: unknown,
  styles: T,
): value is CompiledMap<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return Object.keys(styles).length === 0;
  }
  return entries.every(
    ([key, entryValue]) => key in styles && typeof entryValue === "string",
  );
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

export default function ct<
  T extends StyleSheet,
  V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined,
>(
  styles: T,
  variantsOrCompiled?: V | CompiledBundle<T> | CompiledMap<T>,
  compiledMaybe?: CompiledBundle<T> | CompiledMap<T>,
): () => Accessor<T, V> {
  let variants: VariantSheet<T> | undefined;
  let compiled: CompiledBundle<T> | CompiledMap<T> | undefined;

  if (compiledMaybe !== undefined) {
    variants = variantsOrCompiled as VariantSheet<T>;
    compiled = compiledMaybe;
  } else if (isCompiledBundle<T>(variantsOrCompiled)) {
    compiled = variantsOrCompiled;
  } else if (isClassMapForStyles(variantsOrCompiled, styles)) {
    compiled = variantsOrCompiled;
  } else {
    variants = variantsOrCompiled as VariantSheet<T> | undefined;
  }

  const accessors = {} as Accessor<T, V>;
  const variantClassMap: VariantClassMap<T> = {};
  const compiledBase = isCompiledBundle<T>(compiled) ? compiled.base : compiled;

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
    const compiledVariants = isCompiledBundle<T>(compiled) ? compiled.variants : undefined;

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

export type { StyleSheet, StyleDeclaration, StyleValue } from "./shared.js";
