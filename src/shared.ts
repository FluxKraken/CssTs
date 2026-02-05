export type StyleValue = string | number;
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
  if (typeof value === "number" && !UNITLESS_PROPERTIES.has(property)) {
    return `${property}:${value}px`;
  }
  return `${property}:${String(value)}`;
}

export function toCssRule(className: string, declaration: StyleDeclaration): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(declaration)) {
    parts.push(toCssDeclaration(name, value));
  }
  return `.${className}{${parts.join(";")}}`;
}

export function cv(name: string, fallback?: StyleValue): string {
  if (!name.startsWith("--")) {
    throw new Error(`Expected a CSS variable name like "--token", got "${name}"`);
  }

  if (fallback === undefined) {
    return `var(${name})`;
  }

  return `var(${name}, ${String(fallback)})`;
}
