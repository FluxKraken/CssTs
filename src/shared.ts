/** Primitive CSS value before unit formatting. */
export type PrimitiveStyleValue = string | number;

/** Reference to a CSS custom property created by {@link cv}. */
export interface CssVarRef {
  /** Discriminator for {@link CssVarRef} values. */
  kind: "css-ts-var";
  /** CSS custom property name (for example `"--brand"`). */
  name: string;
  /** Optional fallback value used in `var()` output. */
  fallback?: PrimitiveStyleValue;
}
/** CSS value accepted by style declarations. */
export type StyleValue = PrimitiveStyleValue | CssVarRef | readonly (PrimitiveStyleValue | CssVarRef)[];
/** Flat style object with only CSS declarations. */
export type PseudoStyleDeclaration = Record<string, StyleValue>;
/** Recursive style object supporting nested selectors and at-rules. */
export interface NestedStyleDeclaration {
  [key: string]: StyleValue | NestedStyleDeclaration;
}
/** Style object for a single class name. */
export type StyleDeclaration = NestedStyleDeclaration;
/** Map of class keys to their style declarations. */
export type StyleSheet = Record<string, StyleDeclaration>;

/** Optional serialization settings shared by runtime and build-time extraction. */
export interface CssSerializationOptions {
  /** Named breakpoint aliases (for example `{ md: "48rem" }` used as `"@md"`). */
  breakpoints?: Record<string, string>;
}

const UNITLESS_PROPERTIES = new Set([
  "line-height",
  "font-weight",
  "opacity",
  "z-index",
  "flex",
  "flex-grow",
  "flex-shrink",
  "order",
  "grid-row",
  "grid-column",
]);

/** Convert a camelCased property name to kebab-case. */
export function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Create a short, deterministic hash for class name generation. */
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Build a stable class name from a style key and declaration.
 * @param key Unique key for the style.
 * @param declaration Style declaration to fingerprint.
 * @param salt Optional salt to namespace class names.
 */
export function createClassName(
  key: string,
  declaration: StyleDeclaration,
  salt = "",
): string {
  const fingerprint = JSON.stringify({ key, declaration, salt });
  return `ct_${hashString(fingerprint).slice(0, 8)}`;
}

/**
 * Convert a style property to a CSS declaration string.
 * @param name Property name in camelCase.
 * @param value Style value to serialize.
 */
export function toCssDeclaration(name: string, value: StyleValue): string {
  const property = camelToKebab(name);
  return `${property}:${formatStyleValue(property, value)}`;
}

const PSEUDO_ELEMENT_KEYS = new Set([
  "before",
  "after",
  "firstLine",
  "firstLetter",
  "selection",
  "placeholder",
  "marker",
  "backdrop",
  "fileSelectorButton",
]);

const PSEUDO_CLASS_KEYS = new Set([
  "active",
  "checked",
  "default",
  "disabled",
  "empty",
  "enabled",
  "first-child",
  "first-of-type",
  "focus",
  "focus-visible",
  "focus-within",
  "has",
  "hover",
  "in-range",
  "indeterminate",
  "invalid",
  "is",
  "last-child",
  "last-of-type",
  "link",
  "not",
  "nth-child",
  "nth-last-child",
  "nth-last-of-type",
  "nth-of-type",
  "only-child",
  "only-of-type",
  "optional",
  "out-of-range",
  "placeholder-shown",
  "read-only",
  "read-write",
  "required",
  "root",
  "target",
  "valid",
  "visited",
  "where",
]);

function isNestedStyleDeclaration(value: StyleValue | NestedStyleDeclaration): value is NestedStyleDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isCssVarRef(value)
  );
}

function toPseudoSelectorIfShorthand(key: string): string | null {
  if (PSEUDO_ELEMENT_KEYS.has(key)) {
    return `::${camelToKebab(key)}`;
  }
  const pseudoClass = camelToKebab(key);
  if (PSEUDO_CLASS_KEYS.has(pseudoClass)) {
    return `:${pseudoClass}`;
  }
  return null;
}

function toCssRule(selector: string, declaration: PseudoStyleDeclaration): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(declaration)) {
    parts.push(toCssDeclaration(name, value));
  }
  return `${selector}{${parts.join(";")}}`;
}

function splitSelectors(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function nestSelector(parentSelector: string, childSelector: string): string {
  const parents = splitSelectors(parentSelector);
  const children = splitSelectors(childSelector);

  if (childSelector.includes("&")) {
    const expanded: string[] = [];
    for (const parent of parents) {
      for (const child of children) {
        expanded.push(child.replace(/&/g, parent));
      }
    }
    return expanded.join(", ");
  }

  const pseudoSelector = childSelector.startsWith(":") || childSelector.startsWith("::")
    ? childSelector
    : toPseudoSelectorIfShorthand(childSelector);
  if (pseudoSelector) {
    return parents.map((parent) => `${parent}${pseudoSelector}`).join(", ");
  }

  const expanded: string[] = [];
  for (const parent of parents) {
    for (const child of children) {
      expanded.push(`${parent} ${child}`);
    }
  }
  return expanded.join(", ");
}

function wrapInAtRules(rule: string, atRules: readonly string[]): string {
  let wrapped = rule;
  for (let i = atRules.length - 1; i >= 0; i -= 1) {
    wrapped = `${atRules[i]}{${wrapped}}`;
  }
  return wrapped;
}

function isSupportedAtRule(key: string): boolean {
  return key.startsWith("@");
}

function resolveAtRule(key: string, options?: CssSerializationOptions): string {
  if (!key.startsWith("@")) {
    return key;
  }

  const aliasMatch = key.match(/^@([A-Za-z_$][A-Za-z0-9_$-]*)$/);
  if (!aliasMatch) {
    return key;
  }

  const breakpoint = options?.breakpoints?.[aliasMatch[1]];
  if (!breakpoint) {
    return key;
  }

  return `@media (width >= ${breakpoint})`;
}

function collectCssRules(
  selector: string,
  declaration: StyleDeclaration,
  atRules: readonly string[],
  rules: string[],
  options?: CssSerializationOptions,
): void {
  const base: PseudoStyleDeclaration = {};

  for (const [name, value] of Object.entries(declaration)) {
    if (!isNestedStyleDeclaration(value)) {
      base[name] = value;
      continue;
    }

    if (isSupportedAtRule(name)) {
      collectCssRules(selector, value, [...atRules, resolveAtRule(name, options)], rules, options);
      continue;
    }

    collectCssRules(nestSelector(selector, name), value, atRules, rules, options);
  }

  if (Object.keys(base).length > 0) {
    rules.push(wrapInAtRules(toCssRule(selector, base), atRules));
  }
}

/**
 * Build CSS rules for a class name, including nested selectors and at-rules.
 * @param className Class name without the leading dot.
 * @param declaration Style declaration to serialize.
 */
export function toCssRules(
  className: string,
  declaration: StyleDeclaration,
  options?: CssSerializationOptions,
): string[] {
  const rules: string[] = [];
  collectCssRules(`.${className}`, declaration, [], rules, options);
  return rules;
}

function collectGlobalCssRules(
  selectorOrAtRule: string,
  declaration: StyleDeclaration,
  atRules: readonly string[],
  rules: string[],
  options?: CssSerializationOptions,
): void {
  if (isSupportedAtRule(selectorOrAtRule)) {
    const nestedAtRules = [...atRules, resolveAtRule(selectorOrAtRule, options)];
    const nestedDeclarations: PseudoStyleDeclaration = {};

    for (const [name, value] of Object.entries(declaration)) {
      if (!isNestedStyleDeclaration(value)) {
        nestedDeclarations[name] = value;
        continue;
      }

      collectGlobalCssRules(name, value, nestedAtRules, rules, options);
    }

    if (Object.keys(nestedDeclarations).length > 0) {
      rules.push(wrapInAtRules(toCssRule(selectorOrAtRule, nestedDeclarations), atRules));
    }

    return;
  }

  collectCssRules(selectorOrAtRule, declaration, atRules, rules, options);
}

/**
 * Build CSS rules for global selectors/at-rules without generating class names.
 * @param styles Selector/at-rule map to serialize.
 */
export function toCssGlobalRules(styles: StyleSheet, options?: CssSerializationOptions): string[] {
  const rules: string[] = [];
  for (const [selectorOrAtRule, declaration] of Object.entries(styles)) {
    collectGlobalCssRules(selectorOrAtRule, declaration, [], rules, options);
  }
  return rules;
}

/**
 * Create a CSS custom property reference for use in style objects.
 * @param name CSS custom property name (must start with `--`).
 * @param fallback Optional fallback value for the `var()` call.
 */
export function cv(name: string, fallback?: PrimitiveStyleValue): CssVarRef {
  if (!name.startsWith("--")) {
    throw new Error(`Expected a CSS variable name like "--token", got "${name}"`);
  }

  if (fallback !== undefined && typeof fallback !== "string" && typeof fallback !== "number") {
    throw new Error("cv() fallback must be a string or number");
  }

  return {
    kind: "css-ts-var",
    name,
    fallback,
  };
}

/**
 * Type guard for {@link CssVarRef} values.
 * @param value Unknown value to test.
 */
export function isCssVarRef(value: unknown): value is CssVarRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as CssVarRef).kind === "css-ts-var"
  );
}

function formatPrimitiveStyleValue(property: string, value: PrimitiveStyleValue): string {
  if (typeof value === "number" && !UNITLESS_PROPERTIES.has(property)) {
    return `${value}px`;
  }
  return String(value);
}

function formatStyleValue(property: string, value: StyleValue): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatStyleValue(property, entry)).join(" ");
  }

  if (isCssVarRef(value)) {
    if (value.fallback === undefined) {
      return `var(${value.name})`;
    }
    return `var(${value.name}, ${formatPrimitiveStyleValue(property, value.fallback)})`;
  }

  return formatPrimitiveStyleValue(property, value as PrimitiveStyleValue);
}
