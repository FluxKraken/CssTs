import {
  CssSerializationOptions,
  createClassName,
  isCssVarRef,
  StyleDeclaration,
  StyleSheet,
  StyleValue,
  toCssDeclaration,
  toCssGlobalRules,
  toCssRules,
} from "./shared.js";

/** A style declaration or recursive array of declarations (merged left-to-right). */
type StyleDeclarationInput = StyleDeclaration | readonly StyleDeclarationInput[];
/** Map of class keys to style declaration inputs. */
type StyleSheetInput = Record<string, StyleDeclarationInput>;
/** Precompiled class name map keyed by style key. */
type CompiledMap<T extends StyleSheetInput> = Partial<Record<keyof T, string>>;
/** Variant group map: `{ groupName: { variantName: Partial<StyleSheet> } }`. */
type VariantSheet<T extends StyleSheetInput> = Record<string, Record<string, Partial<T>>>;
/** Precompiled variant class name map. */
type VariantClassMap<T extends StyleSheetInput> = Record<
  string,
  Record<string, Partial<Record<keyof T, string>>>
>;
/** Selected variant values: `{ groupName: variantName }`. */
type VariantSelection<V extends VariantSheet<any> | undefined> = V extends VariantSheet<any>
  ? { [G in keyof V]?: keyof V[G] }
  : Record<string, string>;
/** Configuration object accepted by `ct()`. */
type CtConfig<T extends StyleSheetInput, V extends VariantSheet<T> | undefined> = {
  /** Global stylesheet rules applied without class names. */
  global?: StyleSheetInput;
  /** Base stylesheet mapping class keys to declarations. */
  base?: T;
  /** Variant groups that conditionally override base styles. */
  variant?: V;
  /** Default variant selections. */
  defaults?: VariantSelection<V>;
};
/** Build-time precompiled config passed as the second argument to `ct()`. */
type CompiledConfig<T extends StyleSheetInput> = {
  /** Whether global rules have been extracted. */
  global?: true;
  /** Precompiled base class names. */
  base?: CompiledMap<T>;
  /** Precompiled variant class names. */
  variant?: VariantClassMap<T>;
};
/** Runtime options merged from `css.config.ts` and passed as the third argument to `ct()`. */
type CtRuntimeOptions = CssSerializationOptions & {
  /** Utility declarations available for `@apply` references. */
  utilities?: StyleSheetInput;
};
/** Input for {@link CtBuilder.addContainer} to register a container preset at runtime. */
type ContainerDefinitionInput = {
  /** Container name used in `@set` and `@<name>` shorthand. */
  name: string;
  /** CSS container type (defaults to `"inline-size"`). */
  type?: string;
  /** Container query condition (for example `"width < 20rem"`). */
  rule: string;
};
/** Maps each base style key to a {@link StyleAccessor} for class/style output. */
type Accessor<T extends StyleSheetInput, V extends VariantSheet<T> | undefined> = {
  [K in keyof T]: StyleAccessor<V>;
};
/** Callable accessor for a single style key that returns class names or inline styles. */
type StyleAccessor<V extends VariantSheet<any> | undefined> = ((variants?: VariantSelection<V>) => string) & {
  /** Return the CSS class name(s) for this style key. */
  class: (variants?: VariantSelection<V>) => string;
  /** Return an inline style string for this style key. */
  style: (variants?: VariantSelection<V>) => string;
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
    if (isStyleLeafArray(nested)) {
      continue;
    }
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

function isPrimitiveStyleLeaf(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || isCssVarRef(value);
}

function isStyleLeafArray(value: unknown): value is readonly StyleValue[] {
  return Array.isArray(value) && value.every((entry) => isPrimitiveStyleLeaf(entry));
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

function normalizeStyleDeclarationInput(
  input: StyleDeclarationInput,
  options: {
    utilities?: StyleSheet;
    containers?: Record<string, { type?: string; rule: string }>;
  } = {},
): StyleDeclaration {
  if (Array.isArray(input)) {
    let merged: StyleDeclaration = {};
    for (const entry of input) {
      merged = mergeStyleDeclarations(merged, normalizeStyleDeclarationInput(entry, options));
    }
    return merged;
  }

  const declaration = input as StyleDeclaration;
  let normalized: StyleDeclaration = {};

  for (const [key, value] of Object.entries(declaration)) {
    if (key === "@apply") {
      const applyValue = normalizeApplyInput(value, options);
      normalized = mergeStyleDeclarations(normalized, applyValue);
      continue;
    }

    if (key === "@set") {
      const setValue = normalizeSetInput(value, options);
      normalized = mergeStyleDeclarations(normalized, setValue);
      continue;
    }

    if (isStyleLeafArray(value) || isPrimitiveStyleLeaf(value)) {
      (normalized as Record<string, StyleValue>)[key] = value as StyleValue;
      continue;
    }

    if (Array.isArray(value) || isStyleDeclarationObject(value)) {
      (normalized as Record<string, unknown>)[key] = normalizeStyleDeclarationInput(
        value as StyleDeclarationInput,
        options,
      );
      continue;
    }

    (normalized as Record<string, unknown>)[key] = value;
  }

  return normalized;
}

function normalizeApplyInput(
  value: unknown,
  options: {
    utilities?: StyleSheet;
    containers?: Record<string, { type?: string; rule: string }>;
  },
): StyleDeclaration {
  if (Array.isArray(value)) {
    let merged: StyleDeclaration = {};
    for (const entry of value) {
      merged = mergeStyleDeclarations(merged, normalizeApplyInput(entry, options));
    }
    return merged;
  }

  if (typeof value === "string") {
    const utility = options.utilities?.[value];
    if (!utility) {
      return {};
    }
    return normalizeStyleDeclarationInput(utility, options);
  }

  if (isStyleDeclarationObject(value) || Array.isArray(value)) {
    return normalizeStyleDeclarationInput(value as StyleDeclarationInput, options);
  }

  return {};
}

function normalizeSetInput(
  value: unknown,
  options: {
    containers?: Record<string, { type?: string; rule: string }>;
  },
): StyleDeclaration {
  if (Array.isArray(value)) {
    let merged: StyleDeclaration = {};
    for (const entry of value) {
      merged = mergeStyleDeclarations(merged, normalizeSetInput(entry, options));
    }
    return merged;
  }

  if (typeof value === "string") {
    const preset = options.containers?.[value];
    return {
      containerName: value,
      containerType: preset?.type ?? "inline-size",
    };
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const name = (value as { name?: unknown }).name;
    if (typeof name !== "string") {
      return {};
    }
    const type = (value as { type?: unknown }).type;
    return {
      containerName: name,
      containerType: typeof type === "string" ? type : "inline-size",
    };
  }

  return {};
}

function normalizeStyleSheetInput(
  styles: StyleSheetInput | undefined,
  options: {
    utilities?: StyleSheet;
    containers?: Record<string, { type?: string; rule: string }>;
  } = {},
): StyleSheet {
  const normalized: StyleSheet = {};

  if (!styles) {
    return normalized;
  }

  for (const [key, declaration] of Object.entries(styles)) {
    normalized[key] = normalizeStyleDeclarationInput(declaration, options);
  }

  return normalized;
}

function isInlineStyleValue(value: unknown): value is StyleValue {
  return typeof value === "string" || typeof value === "number" || isCssVarRef(value) || isStyleLeafArray(value);
}

function mergeInlineDeclarations(...declarations: readonly StyleDeclaration[]): Record<string, StyleValue> {
  const merged: Record<string, StyleValue> = {};
  for (const declaration of declarations) {
    for (const [name, value] of Object.entries(declaration)) {
      if (!isInlineStyleValue(value)) {
        continue;
      }
      merged[name] = value;
    }
  }
  return merged;
}

function toInlineStyleString(...declarations: readonly StyleDeclaration[]): string {
  const merged = mergeInlineDeclarations(...declarations);
  const parts: string[] = [];
  for (const [name, value] of Object.entries(merged)) {
    parts.push(toCssDeclaration(name, value));
  }
  return parts.join(";");
}

function normalizeVariantSheetInput<T extends StyleSheetInput>(
  variants: VariantSheet<T> | undefined,
  options: {
    utilities?: StyleSheet;
    containers?: Record<string, { type?: string; rule: string }>;
  } = {},
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
        normalizedVariant[key] = normalizeStyleDeclarationInput(
          declaration as StyleDeclarationInput,
          options,
        );
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
  runtimeOptions: CtRuntimeOptions = {},
): () => Accessor<T, V> {
  const utilities = runtimeOptions.utilities
    ? normalizeStyleSheetInput(runtimeOptions.utilities)
    : undefined;
  const normalizeOptions = { utilities, containers: runtimeOptions.containers };
  const cssOptions: CssSerializationOptions = {
    breakpoints: runtimeOptions.breakpoints,
    containers: runtimeOptions.containers,
  };

  const globalStyles = normalizeStyleSheetInput(config.global, normalizeOptions);
  const styles = normalizeStyleSheetInput(config.base, normalizeOptions);
  const variants = normalizeVariantSheetInput(
    config.variant as VariantSheet<T> | undefined,
    normalizeOptions,
  );
  const defaultSelection = (config.defaults ?? {}) as VariantSelection<V>;

  if (Object.keys(globalStyles).length > 0 && !compiled?.global) {
    for (const rule of toCssGlobalRules(globalStyles, cssOptions)) {
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
      for (const rule of toCssRules(className, declaration, cssOptions)) {
        injectRule(rule);
      }
    }

    const resolveSelection = (selection?: VariantSelection<V>) =>
      selection
        ? ({ ...defaultSelection, ...selection } as VariantSelection<V>)
        : defaultSelection;

    const resolveVariantDeclarations = (selection?: VariantSelection<V>): StyleDeclaration[] => {
      if (!variants) {
        return [];
      }

      const resolvedSelection = resolveSelection(selection);
      const declarations: StyleDeclaration[] = [];

      for (const [group, variantName] of Object.entries(
        resolvedSelection as Record<string, string | number | symbol | undefined>,
      )) {
        if (!variantName) {
          continue;
        }

        const variantDeclaration = variants[group]?.[String(variantName)]?.[String(key)];
        if (variantDeclaration) {
          declarations.push(variantDeclaration as StyleDeclaration);
        }
      }

      return declarations;
    };

    const classAccessor = (selection?: VariantSelection<V>): string => {
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

    const accessor = classAccessor as StyleAccessor<V>;
    accessor.class = classAccessor;
    accessor.style = (selection?: VariantSelection<V>) =>
      toInlineStyleString(declaration, ...resolveVariantDeclarations(selection));

    accessors[key] = accessor as Accessor<T, V>[keyof T];
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
            for (const rule of toCssRules(className, declaration, cssOptions)) {
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

/**
 * Builder returned by `new ct()` that supports incremental property assignment.
 *
 * Set config via `builder.base = ...`, `builder.variant = ...`, etc.
 * Access compiled styles via `builder()` (factory) or `builder.myKey()` (direct).
 * The builder compiles lazily on first access and recompiles when a config property changes.
 *
 * @template T The base stylesheet input type.
 * @template V The variant sheet type, or `undefined` if no variants are used.
 */
type CtBuilder<
  T extends StyleSheetInput = StyleSheetInput,
  V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined,
> = {
  /** Call the builder as a factory to get the compiled style accessor. */
  (): Accessor<T, V>;
  /** Base stylesheet mapping class keys to style declarations. */
  base: T | undefined;
  /** Global stylesheet rules (selectors and at-rules applied without class names). */
  global: StyleSheetInput | undefined;
  /** Variant groups that conditionally override base styles. */
  variant: V | undefined;
  /** Default variant selections applied when no explicit selection is given. */
  defaults: VariantSelection<V> | undefined;
  /** Register a container preset for `@set` and `@<name>` shorthand at runtime. */
  addContainer(container: ContainerDefinitionInput): CtBuilder<T, V>;
} & Accessor<T, V>;

function createCtBuilder<
  T extends StyleSheetInput,
  V extends VariantSheet<T> | undefined,
>(compiled?: CompiledConfig<T>, runtimeOptions: CtRuntimeOptions = {}): CtBuilder<T, V> {
  const config: Partial<CtConfig<T, V>> = {};
  const mutableContainers = { ...(runtimeOptions.containers ?? {}) };
  const effectiveRuntimeOptions: CtRuntimeOptions = {
    ...runtimeOptions,
    containers: mutableContainers,
  };
  let cachedFactory: (() => Accessor<T, V>) | null = null;

  function ensureCompiled(): () => Accessor<T, V> {
    if (!cachedFactory) {
      cachedFactory = compileConfig(config as CtConfig<T, V>, compiled, effectiveRuntimeOptions);
    }
    return cachedFactory;
  }

  const builder = function () {
    return ensureCompiled()();
  };
  const proxy = new Proxy(builder, {
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

  proxy.addContainer = (container: ContainerDefinitionInput) => {
    if (typeof container?.name !== "string" || container.name.length === 0 || typeof container.rule !== "string") {
      throw new Error("addContainer() expects { name: string, rule: string, type?: string }");
    }

    mutableContainers[container.name] = {
      type: typeof container.type === "string" ? container.type : "inline-size",
      rule: container.rule,
    };
    cachedFactory = null;
    return proxy;
  };

  return proxy;
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
  runtimeOptions: CtRuntimeOptions = {},
): (() => Accessor<T, V>) | CtBuilder<T, V> {
  if (new.target) {
    return createCtBuilder<T, V>(compiled, runtimeOptions);
  }
  return compileConfig(config!, compiled, runtimeOptions);
}

/** Re-exported builder type. */
export type { CtBuilder };

/** Re-exported style types for convenience. */
export type { StyleSheet, StyleDeclaration, StyleValue } from "./shared.js";
