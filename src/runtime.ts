import {
  createClassName,
  isCssVarRef,
  StyleDeclaration,
  StyleSheet,
  toCssGlobalRules,
  toCssRules,
} from "./shared.js";

type StyleDeclarationInput = StyleDeclaration | readonly StyleDeclarationInput[];
type StyleSheetInput = Record<string, StyleDeclarationInput>;
type CompiledMap<T extends StyleSheetInput> = Partial<Record<keyof T, string>>;
type VariantSheet<T extends StyleSheetInput> = Record<string, Record<string, Partial<T>>>;
type VariantClassMap<T extends StyleSheetInput> = Record<
  string,
  Record<string, Partial<Record<keyof T, string>>>
>;
type VariantSelection<V extends VariantSheet<any> | undefined> = V extends VariantSheet<any>
  ? { [G in keyof V]?: keyof V[G] }
  : Record<string, string>;
type CtConfig<T extends StyleSheetInput, V extends VariantSheet<T> | undefined> = {
  global?: StyleSheetInput;
  base?: T;
  variant?: V;
  defaults?: VariantSelection<V>;
};
type CompiledConfig<T extends StyleSheetInput> = {
  global?: true;
  base?: CompiledMap<T>;
  variant?: VariantClassMap<T>;
};
type Accessor<T extends StyleSheetInput, V extends VariantSheet<T> | undefined> = {
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

function isStyleDeclarationObject(value: unknown): value is StyleDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isCssVarRef(value)) {
    return false;
  }

  for (const nested of Object.values(value)) {
    if (
      typeof nested !== "string" &&
      typeof nested !== "number" &&
      !isCssVarRef(nested) &&
      !isStyleDeclarationObject(nested)
    ) {
      return false;
    }
  }

  return true;
}

function mergeStyleDeclarations(base: StyleDeclaration, next: StyleDeclaration): StyleDeclaration {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, nextValue] of Object.entries(next)) {
    const previousValue = merged[key];
    if (isStyleDeclarationObject(previousValue) && isStyleDeclarationObject(nextValue)) {
      merged[key] = mergeStyleDeclarations(previousValue, nextValue);
      continue;
    }
    merged[key] = nextValue;
  }

  return merged as StyleDeclaration;
}

function normalizeStyleDeclarationInput(input: StyleDeclarationInput): StyleDeclaration {
  if (Array.isArray(input)) {
    let merged: StyleDeclaration = {};
    for (const entry of input) {
      merged = mergeStyleDeclarations(merged, normalizeStyleDeclarationInput(entry));
    }
    return merged;
  }

  return input as StyleDeclaration;
}

function normalizeStyleSheetInput(styles: StyleSheetInput | undefined): StyleSheet {
  const normalized: StyleSheet = {};

  if (!styles) {
    return normalized;
  }

  for (const [key, declaration] of Object.entries(styles)) {
    normalized[key] = normalizeStyleDeclarationInput(declaration);
  }

  return normalized;
}

function normalizeVariantSheetInput<T extends StyleSheetInput>(
  variants: VariantSheet<T> | undefined,
): Record<string, Record<string, Partial<StyleSheet>>> | undefined {
  if (!variants) {
    return undefined;
  }

  const normalized: Record<string, Record<string, Partial<StyleSheet>>> = {};
  for (const [group, groupVariants] of Object.entries(variants)) {
    const normalizedGroup: Record<string, Partial<StyleSheet>> = {};
    for (const [variantName, declarations] of Object.entries(groupVariants)) {
      const normalizedVariant: Partial<StyleSheet> = {};
      for (const [key, declaration] of Object.entries(declarations)) {
        if (!declaration) {
          continue;
        }
        normalizedVariant[key] = normalizeStyleDeclarationInput(declaration as StyleDeclarationInput);
      }
      normalizedGroup[variantName] = normalizedVariant;
    }
    normalized[group] = normalizedGroup;
  }

  return normalized;
}

function assertVariantKeys(
  styles: StyleSheet,
  variants: Record<string, Record<string, Partial<StyleSheet>>>,
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

function compileConfig<
  T extends StyleSheetInput,
  V extends VariantSheet<T> | undefined,
>(
  config: CtConfig<T, V>,
  compiled?: CompiledConfig<T>,
): () => Accessor<T, V> {
  const globalStyles = normalizeStyleSheetInput(config.global);
  const styles = normalizeStyleSheetInput(config.base);
  const variants = normalizeVariantSheetInput(config.variant as VariantSheet<T> | undefined);
  const defaultSelection = (config.defaults ?? {}) as VariantSelection<V>;

  if (Object.keys(globalStyles).length > 0 && !compiled?.global) {
    for (const rule of toCssGlobalRules(globalStyles)) {
      injectRule(rule);
    }
  }

  const accessors = {} as Accessor<T, V>;
  const variantClassMap: VariantClassMap<T> = {};
  const compiledBase = compiled?.base;

  for (const [key, declaration] of Object.entries(styles) as [keyof T, StyleDeclaration][]) {
    const className =
      compiledBase?.[key] ?? createClassName(String(key), declaration, "runtime");

    if (!compiledBase?.[key]) {
      for (const rule of toCssRules(className, declaration)) {
        injectRule(rule);
      }
    }

    accessors[key] = (selection) => {
      const resolvedSelection = selection
        ? ({ ...defaultSelection, ...selection } as VariantSelection<V>)
        : defaultSelection;

      if (!resolvedSelection) {
        return className;
      }

      const classNames = [className];

      for (const [group, variantName] of Object.entries(
        resolvedSelection as Record<string, string | number | symbol | undefined>,
      )) {
        if (!variantName) {
          continue;
        }

        const variantClass = variantClassMap[group]?.[String(variantName)]?.[key];
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

        for (const [key, declaration] of Object.entries(declarations) as [keyof T, StyleDeclaration][]) {
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

const CONFIG_KEYS = new Set(["base", "global", "variant", "defaults"]);

type CtBuilder<
  T extends StyleSheetInput = StyleSheetInput,
  V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined,
> = {
  (): Accessor<T, V>;
  base: T | undefined;
  global: StyleSheetInput | undefined;
  variant: V | undefined;
  defaults: VariantSelection<V> | undefined;
} & Accessor<T, V>;

function createCtBuilder<
  T extends StyleSheetInput,
  V extends VariantSheet<T> | undefined,
>(compiled?: CompiledConfig<T>): CtBuilder<T, V> {
  const config: Partial<CtConfig<T, V>> = {};
  let cachedFactory: (() => Accessor<T, V>) | null = null;

  function ensureCompiled(): () => Accessor<T, V> {
    if (!cachedFactory) {
      cachedFactory = compileConfig(config as CtConfig<T, V>, compiled);
    }
    return cachedFactory;
  }

  const builder = function () {
    return ensureCompiled()();
  };

  return new Proxy(builder, {
    apply(_target, _thisArg, _args) {
      return ensureCompiled()();
    },
    set(_target, prop, value) {
      if (typeof prop === "string" && CONFIG_KEYS.has(prop)) {
        (config as Record<string, unknown>)[prop] = value;
        cachedFactory = null;
        return true;
      }
      return Reflect.set(_target, prop, value);
    },
    get(target, prop, receiver) {
      if (typeof prop === "string" && CONFIG_KEYS.has(prop)) {
        return (config as Record<string, unknown>)[prop];
      }
      if (typeof prop === "string" && !Reflect.has(target, prop)) {
        const accessor = ensureCompiled()();
        if (prop in accessor) {
          return (accessor as Record<string, unknown>)[prop];
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as CtBuilder<T, V>;
}

/**
 * Runtime stylesheet helper that generates class names and injects CSS rules.
 *
 * Call as `ct({ base, global, variant, defaults })` to compile styles immediately,
 * or as `new ct()` to create a builder where properties can be set incrementally.
 */
export default function ct<
  T extends StyleSheetInput = StyleSheetInput,
  V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined,
>(
  config?: CtConfig<T, V>,
  compiled?: CompiledConfig<T>,
): (() => Accessor<T, V>) | CtBuilder<T, V> {
  if (new.target) {
    return createCtBuilder<T, V>(compiled);
  }
  return compileConfig(config!, compiled);
}

/** Re-exported builder type. */
export type { CtBuilder };

/** Re-exported style types for convenience. */
export type { StyleSheet, StyleDeclaration, StyleValue } from "./shared.js";
