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
export type StyleValue =
  | PrimitiveStyleValue
  | CssVarRef
  | readonly (PrimitiveStyleValue | CssVarRef)[];
/** CSS custom properties emitted on `:root` (optionally within a layer). */
export type RootVarInput =
  | Record<string, StyleValue>
  | {
    vars: Record<string, StyleValue>;
    layer?: string;
  };
/** Friendly token map accepted by {@link Theme}. */
export type ThemeTokenInput = Record<string, StyleValue>;
/** Theme-like value accepted by `importThemes`. */
export type ThemeInput = Theme | ThemeTokenInput;
/** Map of imported theme names/selectors to theme definitions. */
export type ImportedThemesInput = Record<string, ThemeInput>;
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

/** Base shape for importing global style objects with a layer. */
export interface ImportRuleObject {
  /** The CSS style object to import as global rules. */
  rules: StyleSheet;
  /** Optional layer name for the imported styles. */
  layer?: string;
}

/** Base shape for importing external CSS files with a layer. */
export interface ImportPathObject {
  /** The external CSS string path to import. */
  path: string;
  /** Optional layer name for the imported styles. */
  layer?: string;
}

/** Singular import input item. */
export type SingularImportInput =
  | string
  | StyleSheet
  | ImportPathObject
  | ImportRuleObject;

/** Import shapes accepted by the `.import()` method. */
export type ImportInput = SingularImportInput | readonly SingularImportInput[];

/** Optional serialization settings shared by runtime and build-time extraction. */
export interface CssSerializationOptions {
  /** Named breakpoint aliases (for example `{ md: "48rem" }` used as `"@md"`). */
  breakpoints?: Record<string, string>;
  /** Named container presets (for example `{ card: { type: "inline-size", rule: "width < 20rem" } }`). */
  containers?: Record<string, { type?: string; rule: string }>;
  /** Default unit for numeric style values (for example `"px"` or `"rem"`). */
  defaultUnit?: string;
}

function isPrimitiveThemeValue(
  value: unknown,
): value is PrimitiveStyleValue | CssVarRef {
  return typeof value === "string" || typeof value === "number" ||
    isCssVarRef(value);
}

function isThemeStyleValue(value: unknown): value is StyleValue {
  return isPrimitiveThemeValue(value) ||
    (Array.isArray(value) && value.every((entry) => isPrimitiveThemeValue(entry)));
}

/** Convert a theme token name like `headerBG` to a CSS custom property name. */
export function toThemeVarName(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new Error("Theme token names must not be empty.");
  }

  return trimmed.startsWith("--") ? trimmed : `--${camelToKebab(trimmed)}`;
}

function normalizeThemeTokens(
  tokens: Record<string, unknown>,
): Record<string, StyleValue> {
  const vars: Record<string, StyleValue> = {};

  for (const [token, value] of Object.entries(tokens)) {
    if (!isThemeStyleValue(value)) {
      throw new Error(
        `Theme token "${token}" must be a string, number, css-ts variable reference, or array of those values.`,
      );
    }
    vars[toThemeVarName(token)] = value;
  }

  return vars;
}

/** First-class theme definition used by `importThemes`. */
export class Theme {
  /** Discriminator used for theme detection across parsing/runtime paths. */
  readonly kind = "css-ts-theme" as const;
  /** Normalized CSS custom properties emitted for this theme. */
  readonly vars: Record<string, StyleValue>;

  constructor(tokens: ThemeTokenInput) {
    this.vars = normalizeThemeTokens(tokens);
  }
}

/** Type guard for {@link Theme} values. */
export function isTheme(value: unknown): value is Theme {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "css-ts-theme" &&
    "vars" in value &&
    typeof (value as { vars?: unknown }).vars === "object" &&
    (value as { vars?: unknown }).vars !== null &&
    !Array.isArray((value as { vars?: unknown }).vars)
  );
}

/** Create a theme-backed CSS variable reference from a friendly token name. */
export function themeVar(
  token: string,
  fallback?: PrimitiveStyleValue,
): CssVarRef {
  return cv(toThemeVarName(token), fallback);
}

/** Expand `{token}` placeholders into `var(--token)` references. */
export function evalThemeTemplate(template: string): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    const varName = toThemeVarName(token.trim());
    return `var(${varName})`;
  });
}

export type ThemeVarAccessor = Record<string, CssVarRef> & {
  /** Expand a CSS string template containing `{token}` placeholders. */
  eval(template: string): string;
};

/** Proxy that maps `tv.headerBG` to `var(--header-bg)`. */
export const tv = new Proxy({} as ThemeVarAccessor, {
  get(_target, prop) {
    if (typeof prop !== "string") {
      return undefined;
    }
    if (prop === "eval") {
      return evalThemeTemplate;
    }
    return themeVar(prop);
  },
}) as ThemeVarAccessor;

function resolveImportedThemeVars(theme: ThemeInput): Record<string, StyleValue> {
  return isTheme(theme) ? theme.vars : normalizeThemeTokens(theme);
}

function toThemeScopeSelector(scope: string): string | null {
  const trimmed = scope.trim();
  if (
    trimmed.length === 0 || trimmed === "default" || trimmed === "root" ||
    trimmed === ":root"
  ) {
    return null;
  }

  if (
    /^[.#:[*]/.test(trimmed) ||
    /[.#:[\]\s>+~]/.test(trimmed)
  ) {
    return trimmed;
  }

  return `.${trimmed}`;
}

/** Expand `importThemes` into `root` vars and scoped global rules. */
export function importedThemesToConfig(
  importedThemes: ImportedThemesInput | undefined,
): {
  root: RootVarInput[];
  global: StyleSheet;
} {
  const root: RootVarInput[] = [];
  const global: StyleSheet = {};

  if (!importedThemes) {
    return { root, global };
  }

  for (const [scope, theme] of Object.entries(importedThemes)) {
    const vars = resolveImportedThemeVars(theme);
    const selector = toThemeScopeSelector(scope);

    if (selector === null) {
      root.push(vars);
      continue;
    }

    const scopeKey = `@scope (${selector})`;
    const currentRule =
      (global[scopeKey] as Record<string, StyleValue | StyleDeclaration> | undefined) ??
        {};
    const currentScope =
      (currentRule[":scope"] as Record<string, StyleValue> | undefined) ?? {};
    currentRule[":scope"] = { ...currentScope, ...vars };
    global[scopeKey] = currentRule as StyleDeclaration;
  }

  return { root, global };
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

const COMMA_DELIMITED_PROPERTIES = new Set([
  "animation",
  "animation-delay",
  "animation-direction",
  "animation-duration",
  "animation-fill-mode",
  "animation-iteration-count",
  "animation-name",
  "animation-play-state",
  "animation-timing-function",
  "background",
  "background-attachment",
  "background-clip",
  "background-image",
  "background-origin",
  "background-position",
  "background-repeat",
  "background-size",
  "box-shadow",
  "font-family",
  "mask",
  "mask-clip",
  "mask-composite",
  "mask-image",
  "mask-mode",
  "mask-origin",
  "mask-position",
  "mask-repeat",
  "mask-size",
  "text-shadow",
  "transition",
  "transition-delay",
  "transition-duration",
  "transition-property",
  "transition-timing-function",
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
 * @param options Optional serialization settings (breakpoints, containers, default unit).
 */
export function toCssDeclaration(
  name: string,
  value: StyleValue,
  options?: CssSerializationOptions,
): string {
  const property = camelToKebab(name);
  return `${property}:${formatStyleValue(property, value, options)}`;
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

function isNestedStyleDeclaration(
  value: StyleValue | NestedStyleDeclaration,
): value is NestedStyleDeclaration {
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

function toCssRule(
  selector: string,
  declaration: PseudoStyleDeclaration,
  options?: CssSerializationOptions,
): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(declaration)) {
    parts.push(toCssDeclaration(name, value, options));
  }
  return `${selector}{${parts.join(";")}}`;
}

function splitSelectors(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter((part) =>
    part.length > 0
  );
}

function unwrapGlobalSelector(value: string): string {
  return value.replace(/:global\(([^()]+)\)/g, "$1");
}

function extractScopeSelector(
  key: string,
  declaration: StyleDeclaration,
): string | null {
  if (key === "@scope") {
    const selector = declaration.selector;
    return typeof selector === "string" && selector.trim().length > 0
      ? unwrapGlobalSelector(selector.trim())
      : null;
  }

  const embeddedMatch = key.match(/^@scope\s*\((.+)\)$/);
  if (!embeddedMatch || embeddedMatch[1].trim().length === 0) {
    return null;
  }

  return unwrapGlobalSelector(embeddedMatch[1].trim());
}

function isScopeDirectiveDeclaration(
  value: unknown,
): value is StyleDeclaration {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !isCssVarRef(value);
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

  const pseudoSelector =
    childSelector.startsWith(":") || childSelector.startsWith("::")
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
  return key.startsWith("@") || key.startsWith("!@");
}

function resolveAtRule(key: string, options?: CssSerializationOptions): string {
  if (!(key.startsWith("@") || key.startsWith("!@"))) {
    return key;
  }

  const reverseAliasMatch = key.match(/^!@([A-Za-z0-9_$-]+)$/);
  if (reverseAliasMatch) {
    const reverseBreakpoint = options?.breakpoints?.[reverseAliasMatch[1]];
    if (reverseBreakpoint) {
      return `@media (width <= ${reverseBreakpoint})`;
    }
    return key;
  }

  const rangeMatch = key.match(
    /^@\(\s*([A-Za-z0-9_$-]+)\s*,\s*([A-Za-z0-9_$-]+)\s*\)$/,
  );
  if (rangeMatch) {
    const lower = options?.breakpoints?.[rangeMatch[1]];
    const upper = options?.breakpoints?.[rangeMatch[2]];
    if (lower && upper) {
      return `@media (${lower} < width < ${upper})`;
    }

    const lowerContainer = options?.containers?.[rangeMatch[1]];
    const upperContainer = options?.containers?.[rangeMatch[2]];
    if (lowerContainer?.rule && upperContainer?.rule) {
      return `@container (${lowerContainer.rule}) and (${upperContainer.rule})`;
    }

    return key;
  }

  const aliasMatch = key.match(/^@([A-Za-z0-9_$-]+)$/);
  if (!aliasMatch) {
    return key;
  }

  const breakpoint = options?.breakpoints?.[aliasMatch[1]];
  if (!breakpoint) {
    const container = options?.containers?.[aliasMatch[1]];
    if (container?.rule) {
      return `@container ${aliasMatch[1]} (${container.rule})`;
    }
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
  const nested: Array<[string, NestedStyleDeclaration]> = [];

  for (const [name, value] of Object.entries(declaration)) {
    if (!isNestedStyleDeclaration(value)) {
      base[name] = value;
      continue;
    }

    nested.push([name, value]);
  }

  if (Object.keys(base).length > 0) {
    rules.push(wrapInAtRules(toCssRule(selector, base, options), atRules));
  }

  for (const [name, value] of nested) {
    if (isSupportedAtRule(name)) {
      collectCssRules(
        selector,
        value,
        [...atRules, resolveAtRule(name, options)],
        rules,
        options,
      );
      continue;
    }

    collectCssRules(
      nestSelector(selector, name),
      value,
      atRules,
      rules,
      options,
    );
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
  const scopeSelector = extractScopeSelector(selectorOrAtRule, declaration);
  if (scopeSelector !== null) {
    const scopedRules: string[] = [];
    for (const [name, value] of Object.entries(declaration)) {
      if (
        (selectorOrAtRule === "@scope" && name === "selector") ||
        !isScopeDirectiveDeclaration(value)
      ) {
        continue;
      }
      collectGlobalCssRules(name, value, [], scopedRules, options);
    }

    rules.push(
      wrapInAtRules(
        `@scope (${scopeSelector}){${scopedRules.join("")}}`,
        atRules,
      ),
    );
    return;
  }

  if (isSupportedAtRule(selectorOrAtRule)) {
    const nestedAtRules = [
      ...atRules,
      resolveAtRule(selectorOrAtRule, options),
    ];
    const nestedDeclarations: PseudoStyleDeclaration = {};

    for (const [name, value] of Object.entries(declaration)) {
      if (!isNestedStyleDeclaration(value)) {
        nestedDeclarations[name] = value;
        continue;
      }

      collectGlobalCssRules(name, value, nestedAtRules, rules, options);
    }

    if (Object.keys(nestedDeclarations).length > 0) {
      rules.push(
        wrapInAtRules(
          toCssRule(selectorOrAtRule, nestedDeclarations, options),
          atRules,
        ),
      );
    }

    return;
  }

  collectCssRules(
    unwrapGlobalSelector(selectorOrAtRule),
    declaration,
    atRules,
    rules,
    options,
  );
}

/**
 * Build CSS rules for global selectors/at-rules without generating class names.
 * @param styles Selector/at-rule map to serialize.
 */
export function toCssGlobalRules(
  styles: StyleSheet,
  options?: CssSerializationOptions,
): string[] {
  const rules: string[] = [];
  for (const [selectorOrAtRule, declaration] of Object.entries(styles)) {
    collectGlobalCssRules(selectorOrAtRule, declaration, [], rules, options);
  }
  return rules;
}

/** Convert `root`/`rootVars` inputs into global `:root` rules. */
export function rootVarsToGlobalRules(
  rootVars: readonly RootVarInput[] | undefined,
): StyleSheet {
  const globalRules: StyleSheet = {};
  if (!rootVars) {
    return globalRules;
  }

  for (const entry of rootVars) {
    const vars = ("vars" in entry ? entry.vars : entry) as Record<
      string,
      StyleValue
    >;
    const layer = "layer" in entry && typeof entry.layer === "string" &&
        entry.layer.trim().length > 0
      ? entry.layer.trim()
      : null;

    if (layer) {
      const layerKey = `@layer ${layer}`;
      const layerRules =
        (globalRules[layerKey] as StyleDeclaration | undefined) ?? {};
      const rootDeclaration =
        (layerRules[":root"] as Record<string, StyleValue> | undefined) ?? {};
      layerRules[":root"] = { ...rootDeclaration, ...vars };
      globalRules[layerKey] = layerRules;
      continue;
    }

    const rootDeclaration =
      (globalRules[":root"] as Record<string, StyleValue> | undefined) ?? {};
    globalRules[":root"] = { ...rootDeclaration, ...vars };
  }

  return globalRules;
}

/**
 * Create a CSS custom property reference for use in style objects.
 * @param name CSS custom property name (must start with `--`).
 * @param fallback Optional fallback value for the `var()` call.
 */
export function cv(name: string, fallback?: PrimitiveStyleValue): CssVarRef {
  if (!name.startsWith("--")) {
    throw new Error(
      `Expected a CSS variable name like "--token", got "${name}"`,
    );
  }

  if (
    fallback !== undefined && typeof fallback !== "string" &&
    typeof fallback !== "number"
  ) {
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

function formatPrimitiveStyleValue(
  property: string,
  value: PrimitiveStyleValue,
  options?: CssSerializationOptions,
): string {
  if (property === "content" && typeof value === "string") {
    return formatContentValue(value);
  }

  if (typeof value === "number" && !UNITLESS_PROPERTIES.has(property)) {
    return `${value}${options?.defaultUnit ?? "px"}`;
  }
  return String(value);
}

const RAW_CONTENT_KEYWORDS = new Set([
  "none",
  "normal",
  "open-quote",
  "close-quote",
  "no-open-quote",
  "no-close-quote",
]);

function isQuotedCssString(value: string): boolean {
  return (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  );
}

function isRawContentFunction(value: string): boolean {
  return /^(attr|counter|counters|element|leader|target-counter|target-counters|target-text|string)\(/
    .test(value);
}

function formatContentValue(value: string): string {
  if (
    isQuotedCssString(value) || RAW_CONTENT_KEYWORDS.has(value) ||
    isRawContentFunction(value)
  ) {
    return value;
  }

  return JSON.stringify(value);
}

function isTransitionTimingToken(value: string): boolean {
  return (
    /^-?\d*\.?\d+m?s$/i.test(value) ||
    value === "linear" ||
    value === "step-start" ||
    value === "step-end" ||
    value.startsWith("ease") ||
    value.startsWith("steps(") ||
    value.startsWith("cubic-bezier(")
  );
}

function shouldUseSpaceDelimitedTransitionValue(
  value: readonly (PrimitiveStyleValue | CssVarRef)[],
): boolean {
  if (value.length < 2) {
    return false;
  }

  let hasTimingToken = false;
  for (const entry of value) {
    if (typeof entry === "number") {
      return false;
    }

    if (isCssVarRef(entry)) {
      hasTimingToken = true;
      continue;
    }

    if (/\s|,/.test(entry)) {
      return false;
    }

    if (isTransitionTimingToken(entry)) {
      hasTimingToken = true;
    }
  }

  return hasTimingToken;
}

function formatStyleValue(
  property: string,
  value: StyleValue,
  options?: CssSerializationOptions,
): string {
  if (Array.isArray(value)) {
    if (
      property === "transition" && shouldUseSpaceDelimitedTransitionValue(value)
    ) {
      return value.map((entry) => formatStyleValue(property, entry, options))
        .join(" ");
    }
    const separator = COMMA_DELIMITED_PROPERTIES.has(property) ? ", " : " ";
    return value.map((entry) => formatStyleValue(property, entry, options))
      .join(separator);
  }

  if (isCssVarRef(value)) {
    if (value.fallback === undefined) {
      return `var(${value.name})`;
    }
    return `var(${value.name}, ${
      formatPrimitiveStyleValue(property, value.fallback, options)
    })`;
  }

  return formatPrimitiveStyleValue(
    property,
    value as PrimitiveStyleValue,
    options,
  );
}
