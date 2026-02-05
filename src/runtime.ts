import {
  createClassName,
  StyleSheet,
  toCssRule,
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
type Accessor<T extends StyleSheet> = { [K in keyof T]: () => string };
type VariantAccessors<T extends StyleSheet> = Record<string, Record<string, Partial<Accessor<T>>>>;

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

export default function ct<T extends StyleSheet>(
  styles: T,
  variantsOrCompiled?: VariantSheet<T> | CompiledBundle<T> | CompiledMap<T>,
  compiledMaybe?: CompiledBundle<T> | CompiledMap<T>,
): () => Accessor<T> & { variants: VariantAccessors<T> } {
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

  const accessors = {} as Accessor<T>;
  const variantAccessors: VariantAccessors<T> = {};
  const compiledBase = isCompiledBundle<T>(compiled) ? compiled.base : compiled;

  for (const [key, declaration] of Object.entries(styles) as [keyof T, T[keyof T]][]) {
    const className =
      compiledBase?.[key] ?? createClassName(String(key), declaration, "runtime");

    if (!compiledBase?.[key]) {
      injectRule(toCssRule(className, declaration));
    }

    accessors[key] = () => className;
  }

  if (variants) {
    assertVariantKeys(styles, variants);
    const compiledVariants = isCompiledBundle<T>(compiled) ? compiled.variants : undefined;

    for (const [group, groupVariants] of Object.entries(variants)) {
      const groupAccessors: Record<string, Partial<Accessor<T>>> = {};
      const compiledGroup = compiledVariants?.[group];

      for (const [variantName, declarations] of Object.entries(groupVariants)) {
        const variantAccessor: Partial<Accessor<T>> = {};
        const compiledVariant = compiledGroup?.[variantName];

        for (const [key, declaration] of Object.entries(declarations) as [
          keyof T,
          T[keyof T],
        ][]) {
          const className =
            compiledVariant?.[key] ??
            createClassName(`${group}:${variantName}:${String(key)}`, declaration, "runtime");

          if (!compiledVariant?.[key]) {
            injectRule(toCssRule(className, declaration));
          }

          variantAccessor[key] = () => className;
        }

        groupAccessors[variantName] = variantAccessor;
      }

      variantAccessors[group] = groupAccessors;
    }
  }

  return () => ({ ...accessors, variants: variantAccessors });
}

export type { StyleSheet, StyleDeclaration, StyleValue } from "./shared.js";
