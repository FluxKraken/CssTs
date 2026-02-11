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
  /** Whether stylesheet imports have been extracted. */
  imports?: true;
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
  /** Style resolution mode from `css.config.ts`. */
  resolution?: "static" | "dynamic" | "hybrid";
  /** Dev-only debug logging settings injected by the Vite plugin. */
  debug?: {
    /** Internal gate so debug logs only run in the Vite dev server. */
    enabled?: boolean;
    /** Log dynamically injected style rules/class names. */
    logDynamic?: boolean;
    /** Log statically resolved class names/rules. */
    logStatic?: boolean;
  };
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
const RUNTIME_IMPORT_TAG_ID = "__css_ts_runtime_imports";
const injectedRules = new Set<string>();
const injectedImportRules = new Set<string>();

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

function injectImportRule(rule: string): void {
  const doc = (globalThis as unknown as { document?: DocumentLike }).document;
  if (!doc || injectedImportRules.has(rule)) {
    return;
  }

  let tag = doc.getElementById(RUNTIME_IMPORT_TAG_ID);
  if (!tag) {
    tag = doc.createElement("style");
    tag.id = RUNTIME_IMPORT_TAG_ID;
    doc.head.appendChild(tag);
  }

  tag.appendChild(doc.createTextNode(rule));
  injectedImportRules.add(rule);
}

function isStyleDeclarationObject(value: unknown): value is StyleDeclaration {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isCssVarRef(value)
  ) {
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
    imports?: Set<string>;
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
    imports?: Set<string>;
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
    imports?: Set<string>;
    utilities?: StyleSheet;
    containers?: Record<string, { type?: string; rule: string }>;
  } = {},
): StyleSheet {
  const normalized: StyleSheet = {};

  function addImportPaths(value: unknown): void {
    const entries = typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];

    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        options.imports?.add(trimmed);
      }
    }
  }

  if (!styles) {
    return normalized;
  }

  for (const [key, declaration] of Object.entries(styles)) {
    if (key === "@import") {
      addImportPaths(declaration);
      continue;
    }
    if (key === "@apply") {
      normalizeApplyInput(declaration, options);
      continue;
    }
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
    imports?: Set<string>;
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

function compileConfig<
  T extends StyleSheetInput,
  V extends VariantSheet<T> | undefined,
>(
  config: CtConfig<T, V>,
  compiled?: CompiledConfig<T>,
  runtimeOptions: CtRuntimeOptions = {},
): () => Accessor<T, V> {
  const resolution = runtimeOptions.resolution ?? "hybrid";
  const effectiveCompiled = resolution === "dynamic" ? undefined : compiled;
  const debugEnabled = runtimeOptions.debug?.enabled === true;
  const logDynamic = debugEnabled && runtimeOptions.debug?.logDynamic === true;
  const logStatic = debugEnabled && runtimeOptions.debug?.logStatic === true;
  const log = (mode: "dynamic" | "static", message: string): void => {
    if ((mode === "dynamic" && !logDynamic) || (mode === "static" && !logStatic)) {
      return;
    }
    console.log(`[css-ts][${mode}] ${message}`);
  };

  const imports = new Set<string>();
  const utilities = runtimeOptions.utilities
    ? normalizeStyleSheetInput(runtimeOptions.utilities, {
      imports,
      containers: runtimeOptions.containers,
    })
    : undefined;
  const normalizeOptions = { imports, utilities, containers: runtimeOptions.containers };
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

  if (imports.size > 0 && !effectiveCompiled?.imports) {
    if (resolution === "static") {
      throw new Error("css-ts resolution=\"static\" requires @import rules to be statically extracted.");
    }
    for (const importPath of imports) {
      injectImportRule(`@import "${importPath}";`);
      log("dynamic", `@import "${importPath}"`);
    }
  } else if (imports.size > 0) {
    for (const importPath of imports) {
      log("static", `@import "${importPath}"`);
    }
  }

  if (Object.keys(globalStyles).length > 0 && !effectiveCompiled?.global) {
    if (resolution === "static") {
      throw new Error("css-ts resolution=\"static\" requires global rules to be statically extracted.");
    }
    for (const rule of toCssGlobalRules(globalStyles, cssOptions)) {
      injectRule(rule);
      log("dynamic", `global rule injected: ${rule}`);
    }
  } else if (Object.keys(globalStyles).length > 0) {
    for (const selector of Object.keys(globalStyles)) {
      log("static", `global selector: ${selector}`);
    }
  }

  const accessors = {} as Accessor<T, V>;
  const variantClassMap: VariantClassMap<T> = {};
  const compiledBase = effectiveCompiled?.base;

  for (const [key, declaration] of Object.entries(styles) as [keyof T, StyleDeclaration][]) {
    const compiledClassName = compiledBase?.[key];
    if (resolution === "static" && !compiledClassName) {
      throw new Error(`css-ts resolution="static" could not statically resolve base.${String(key)}.`);
    }
    const className = compiledClassName ?? createClassName(String(key), declaration, "runtime");

    if (!compiledClassName) {
      for (const rule of toCssRules(className, declaration, cssOptions)) {
        injectRule(rule);
      }
      log("dynamic", `base.${String(key)} -> .${className}`);
    } else {
      log("static", `base.${String(key)} -> .${className}`);
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
    const compiledVariants = effectiveCompiled?.variant;

    for (const [group, groupVariants] of Object.entries(variants)) {
      const groupMap: Record<string, Partial<Record<keyof T, string>>> = {};
      const compiledGroup = compiledVariants?.[group];

      for (const [variantName, declarations] of Object.entries(groupVariants)) {
        const variantMap: Partial<Record<keyof T, string>> = {};
        const compiledVariant = compiledGroup?.[variantName];

        for (const [key, declaration] of Object.entries(declarations) as [keyof T, StyleDeclaration][]) {
          const compiledClassName = compiledVariant?.[key];
          if (resolution === "static" && !compiledClassName) {
            throw new Error(
              `css-ts resolution="static" could not statically resolve variant.${group}.${variantName}.${String(key)}.`,
            );
          }
          const className =
            compiledClassName ??
            createClassName(`${group}:${variantName}:${String(key)}`, declaration, "runtime");

          if (!compiledClassName) {
            for (const rule of toCssRules(className, declaration, cssOptions)) {
              injectRule(rule);
            }
            log("dynamic", `variant.${group}.${variantName}.${String(key)} -> .${className}`);
          } else {
            log("static", `variant.${group}.${variantName}.${String(key)} -> .${className}`);
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
