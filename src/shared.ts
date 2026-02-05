export type PrimitiveStyleValue = string | number;
export interface CssVarRef {
  kind: "css-ts-var";
  name: string;
  fallback?: PrimitiveStyleValue;
}
export type StyleValue = PrimitiveStyleValue | CssVarRef;
export type StyleDeclaration = Record<string, StyleValue>;
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

export function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export function createClassName(
  key: string,
  declaration: StyleDeclaration,
  salt = "",
): string {
  const fingerprint = JSON.stringify({ key, declaration, salt });
  return `ct_${hashString(fingerprint).slice(0, 8)}`;
}

export function toCssDeclaration(name: string, value: StyleValue): string {
  const property = camelToKebab(name);
  return `${property}:${formatStyleValue(property, value)}`;
}

export function toCssRule(className: string, declaration: StyleDeclaration): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(declaration)) {
    parts.push(toCssDeclaration(name, value));
  }
  return `.${className}{${parts.join(";")}}`;
}

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
