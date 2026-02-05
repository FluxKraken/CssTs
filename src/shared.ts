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
export type StyleValue = PrimitiveStyleValue | CssVarRef;
/** Style object for a pseudo selector (`:hover`, `::before`, etc.). */
export type PseudoStyleDeclaration = Record<string, StyleValue>;
/** Style object for a single class name. */
export type StyleDeclaration = Record<string, StyleValue | PseudoStyleDeclaration>;
/** Map of class keys to their style declarations. */
export type StyleSheet = Record<string, StyleDeclaration>;

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

function isPseudoStyleDeclaration(value: StyleValue | PseudoStyleDeclaration): value is PseudoStyleDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isCssVarRef(value)
  );
}

function toPseudoSelector(key: string): string {
  if (key.startsWith("::") || key.startsWith(":")) {
    return key;
  }
  if (PSEUDO_ELEMENT_KEYS.has(key)) {
    return `::${camelToKebab(key)}`;
  }
  return `:${camelToKebab(key)}`;
}

function toCssRule(selector: string, declaration: PseudoStyleDeclaration): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(declaration)) {
    parts.push(toCssDeclaration(name, value));
  }
  return `${selector}{${parts.join(";")}}`;
}

/**
 * Build CSS rules for a class name, including pseudo selectors.
 * @param className Class name without the leading dot.
 * @param declaration Style declaration to serialize.
 */
export function toCssRules(className: string, declaration: StyleDeclaration): string[] {
  const base: PseudoStyleDeclaration = {};
  const pseudos: Array<{ selector: string; declaration: PseudoStyleDeclaration }> = [];

  for (const [name, value] of Object.entries(declaration)) {
    if (isPseudoStyleDeclaration(value)) {
      pseudos.push({
        selector: `.${className}${toPseudoSelector(name)}`,
        declaration: value,
      });
    } else {
      base[name] = value;
    }
  }

  const rules: string[] = [];
  if (Object.keys(base).length > 0) {
    rules.push(toCssRule(`.${className}`, base));
  }
  for (const pseudo of pseudos) {
    if (Object.keys(pseudo.declaration).length > 0) {
      rules.push(toCssRule(pseudo.selector, pseudo.declaration));
    }
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
  if (isCssVarRef(value)) {
    if (value.fallback === undefined) {
      return `var(${value.name})`;
    }
    return `var(${value.name}, ${formatPrimitiveStyleValue(property, value.fallback)})`;
  }

  return formatPrimitiveStyleValue(property, value);
}
