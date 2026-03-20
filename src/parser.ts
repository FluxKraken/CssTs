import {
  cv,
  Theme,
  isTheme,
  isCssVarRef,
  toThemeVarName,
  type StyleDeclaration,
  type StyleSheet,
  type StyleValue,
} from "./shared.js";

interface ParseResult {
  value: ParsedObject;
  end: number;
}

type VariantSheet = Record<string, Record<string, StyleSheet>>;
type VariantGlobalSheet = Record<string, Record<string, StyleSheet>>;
type VariantSelection = Record<string, string>;
type CtConfig = {
  imports?: string[];
  global?: StyleSheet;
  root?: Array<
    Record<string, StyleValue> | {
      vars: Record<string, StyleValue>;
      layer?: string;
    }
  >;
  rootVars?: Array<
    Record<string, StyleValue> | {
      vars: Record<string, StyleValue>;
      layer?: string;
    }
  >;
  base: StyleSheet;
  variant?: VariantSheet;
  variantGlobal?: VariantGlobalSheet;
  defaults?: VariantSelection;
};

type RootVarEntry =
  | Record<string, StyleValue>
  | {
    vars: Record<string, StyleValue>;
    layer?: string;
  };
type ParseCtOptions = {
  imports?: Set<string>;
  utilities?: StyleSheet;
  containers?: Record<string, { type?: string; rule: string }>;
};

type IdentifierReference = {
  kind: "identifier-ref";
  path: string[];
};

type TemplateLiteralReference = {
  kind: "template-literal";
  parts: ParsedValue[];
};

type ThemeConstructorReference = {
  kind: "theme-constructor";
  tokens: ParsedObject;
};

interface ParsedObject {
  [key: string]: ParsedValue;
}

const QUOTED_KEYS = Symbol("ct-parser-quoted-keys");

interface ParsedArray extends Array<ParsedValue> {}

type ParsedValue =
  | string
  | number
  | ReturnType<typeof cv>
  | IdentifierReference
  | TemplateLiteralReference
  | ThemeConstructorReference
  | ParsedObject
  | ParsedArray;

/** Callback that resolves a dotted identifier path to its static value during parsing. */
export type IdentifierResolver = (
  path: readonly string[],
) => unknown | undefined;

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function skipWhitespace(input: string, index: number): number {
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "/" && input[index + 1] === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && input[index + 1] === "*") {
      index += 2;
      while (
        index < input.length &&
        !(input[index] === "*" && input[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    break;
  }

  return index;
}

function parseString(input: string, index: number): [string, number] {
  const quote = input[index];
  index += 1;
  let value = "";

  while (index < input.length) {
    const char = input[index];
    if (char === "\\") {
      value += input[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === quote) {
      return [value, index + 1];
    }
    value += char;
    index += 1;
  }

  throw new Error("Unterminated string literal");
}

function parseNumber(input: string, index: number): [number, number] {
  const match = input.slice(index).match(/^-?\d+(?:\.\d+)?/);
  if (!match) {
    throw new Error("Invalid number literal");
  }
  return [Number(match[0]), index + match[0].length];
}

function parseTemplateLiteral(
  input: string,
  index: number,
): [ParsedValue, number] {
  if (input[index] !== "`") {
    throw new Error(`Expected '\`' at ${index}`);
  }

  index += 1;
  const parts: ParsedValue[] = [];
  let currentString = "";
  let escaped = false;

  while (index < input.length) {
    const char = input[index];

    if (escaped) {
      currentString += char;
      escaped = false;
      index += 1;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      index += 1;
      continue;
    }

    if (char === "`") {
      if (currentString !== "") {
        parts.push(currentString);
      }
      return [{ kind: "template-literal", parts }, index + 1];
    }

    if (char === "$" && input[index + 1] === "{") {
      if (currentString !== "") {
        parts.push(currentString);
        currentString = "";
      }
      index += 2;
      const [expressionValue, expressionEnd] = parseValue(input, index);
      parts.push(expressionValue);
      index = skipWhitespace(input, expressionEnd);
      if (input[index] !== "}") {
        throw new Error(`Expected '}' at ${index}`);
      }
      index += 1;
      continue;
    }

    currentString += char;
    index += 1;
  }

  throw new Error("Unterminated template literal");
}

function parseIdentifier(input: string, index: number): [string, number] {
  if (!isIdentifierStart(input[index])) {
    throw new Error("Invalid identifier");
  }

  let end = index + 1;
  while (end < input.length && isIdentifierPart(input[end])) end += 1;
  return [input.slice(index, end), end];
}

function parseKey(input: string, index: number): [string, number, boolean] {
  const char = input[index];
  if (char === '"' || char === "'") {
    const [value, end] = parseString(input, index);
    return [value, end, true];
  }
  const [value, end] = parseIdentifier(input, index);
  return [value, end, false];
}

function parseIdentifierReference(
  input: string,
  identifier: string,
  identifierEnd: number,
): [IdentifierReference, number] {
  const path = [identifier];
  let cursor = identifierEnd;

  while (cursor < input.length) {
    cursor = skipWhitespace(input, cursor);
    if (input[cursor] !== ".") {
      break;
    }

    cursor = skipWhitespace(input, cursor + 1);
    const [segment, segmentEnd] = parseIdentifier(input, cursor);
    path.push(segment);
    cursor = segmentEnd;
  }

  return [{ kind: "identifier-ref", path }, cursor];
}

function parseThemeConstructor(
  input: string,
  index: number,
): [ThemeConstructorReference, number] {
  const [constructorName, constructorEnd] = parseIdentifier(input, index);
  if (constructorName !== "Theme") {
    throw new Error(`Unsupported constructor "${constructorName}"`);
  }

  let cursor = skipWhitespace(input, constructorEnd);
  if (input[cursor] !== "(") {
    throw new Error("Expected '(' after Theme");
  }

  cursor = skipWhitespace(input, cursor + 1);
  const [argumentValue, argumentEnd] = parseValue(input, cursor);
  if (
    typeof argumentValue !== "object" || argumentValue === null ||
    Array.isArray(argumentValue) || isCssVarRef(argumentValue)
  ) {
    throw new Error("Theme() expects an object literal");
  }

  cursor = skipWhitespace(input, argumentEnd);
  if (input[cursor] === ",") {
    throw new Error("Theme() accepts a single object argument");
  }
  if (input[cursor] !== ")") {
    throw new Error("Expected ')' after Theme() call");
  }

  return [{
    kind: "theme-constructor",
    tokens: argumentValue,
  }, cursor + 1];
}

function parseDashedIdentifierLiteral(
  input: string,
  identifier: string,
  identifierEnd: number,
): [string, number] | null {
  const parts = [identifier];
  let cursor = identifierEnd;

  while (
    cursor < input.length && input[cursor] === "-" &&
    isIdentifierStart(input[cursor + 1])
  ) {
    const [nextPart, nextEnd] = parseIdentifier(input, cursor + 1);
    parts.push(nextPart);
    cursor = nextEnd;
  }

  if (parts.length < 2) {
    return null;
  }

  return [parts.join("-"), cursor];
}

function parseArray(input: string, index: number): [ParsedArray, number] {
  if (input[index] !== "[") {
    throw new Error(`Expected '[' at ${index}`);
  }

  const values: ParsedArray = [];
  index += 1;

  while (index < input.length) {
    index = skipWhitespace(input, index);

    if (input[index] === "]") {
      return [values, index + 1];
    }

    const [parsedValue, valueEnd] = parseValue(input, index);
    values.push(parsedValue);
    index = skipWhitespace(input, valueEnd);

    if (input[index] === ",") {
      index += 1;
      continue;
    }

    if (input[index] === "]") {
      return [values, index + 1];
    }

    throw new Error(`Expected ',' or ']' at ${index}`);
  }

  throw new Error("Unterminated array literal");
}

function parseValue(input: string, index: number): [ParsedValue, number] {
  index = skipWhitespace(input, index);
  const char = input[index];

  if (char === "{") {
    const result = parseObject(input, index);
    return [result.value, result.end];
  }

  if (char === "[") {
    return parseArray(input, index);
  }

  if (char === '"' || char === "'") {
    return parseString(input, index);
  }

  if (char === "`") {
    return parseTemplateLiteral(input, index);
  }

  if (char === "-" || /\d/.test(char)) {
    return parseNumber(input, index);
  }

  if (isIdentifierStart(char)) {
    const [identifier, identifierEnd] = parseIdentifier(input, index);
    if (identifier === "new") {
      const constructorIndex = skipWhitespace(input, identifierEnd);
      return parseThemeConstructor(input, constructorIndex);
    }
    const dashedLiteral = parseDashedIdentifierLiteral(
      input,
      identifier,
      identifierEnd,
    );
    if (dashedLiteral) {
      return dashedLiteral;
    }
    let cursor = skipWhitespace(input, identifierEnd);
    if (input[cursor] !== "(") {
      return parseIdentifierReference(input, identifier, identifierEnd);
    }
    cursor = skipWhitespace(input, cursor + 1);

    if (identifier === "cv") {
      if (input[cursor] !== '"' && input[cursor] !== "'") {
        throw new Error("cv() expects a string variable name");
      }
      const [variableName, variableEnd] = parseString(input, cursor);
      cursor = skipWhitespace(input, variableEnd);

      let fallback: string | number | undefined;
      if (input[cursor] === ",") {
        const [fallbackValue, fallbackEnd] = parseValue(input, cursor + 1);
        if (
          typeof fallbackValue !== "string" && typeof fallbackValue !== "number"
        ) {
          throw new Error("cv() fallback must be a string or number");
        }
        fallback = fallbackValue;
        cursor = skipWhitespace(input, fallbackEnd);
      }

      if (input[cursor] !== ")") {
        throw new Error("Expected ')' after cv() call");
      }

      return [cv(variableName, fallback), cursor + 1];
    }

    return parseIdentifierReference(input, identifier, identifierEnd);
  }

  throw new Error(`Unsupported value at ${index}`);
}

function parseObject(input: string, index: number): ParseResult {
  if (input[index] !== "{") {
    throw new Error(`Expected '{' at ${index}`);
  }

  const value: ParsedObject = {};
  index += 1;

  while (index < input.length) {
    index = skipWhitespace(input, index);
    if (input[index] === "}") {
      return { value, end: index + 1 };
    }

    const [key, keyEnd, quoted] = parseKey(input, index);
    index = skipWhitespace(input, keyEnd);

    if (input[index] !== ":") {
      throw new Error(`Expected ':' after key '${key}'`);
    }

    const [parsedValue, valueEnd] = parseValue(input, index + 1);
    value[key] = parsedValue;
    if (quoted) {
      setQuotedKey(value, key);
    }
    index = skipWhitespace(input, valueEnd);

    if (input[index] === ",") {
      index += 1;
      continue;
    }

    if (input[index] === "}") {
      return { value, end: index + 1 };
    }

    throw new Error(`Expected ',' or '}' at ${index}`);
  }

  throw new Error("Unterminated object literal");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setQuotedKey(value: Record<string, unknown>, key: string): void {
  let quotedKeys = (value as Record<PropertyKey, unknown>)[QUOTED_KEYS];
  if (!(quotedKeys instanceof Set)) {
    quotedKeys = new Set<string>();
    Object.defineProperty(value, QUOTED_KEYS, {
      value: quotedKeys,
      enumerable: false,
      configurable: true,
    });
  }
  (quotedKeys as Set<string>).add(key);
}

function getQuotedKeys(value: unknown): ReadonlySet<string> {
  if (!isPlainObject(value)) {
    return new Set<string>();
  }

  const quotedKeys = (value as Record<PropertyKey, unknown>)[QUOTED_KEYS];
  return quotedKeys instanceof Set ? quotedKeys : new Set<string>();
}

function isIdentifierReference(value: unknown): value is IdentifierReference {
  return (
    isPlainObject(value) &&
    value.kind === "identifier-ref" &&
    Array.isArray(value.path) &&
    value.path.every((part) => typeof part === "string")
  );
}

function isTemplateLiteralReference(
  value: unknown,
): value is TemplateLiteralReference {
  return (
    isPlainObject(value) &&
    value.kind === "template-literal" &&
    Array.isArray(value.parts)
  );
}

function isThemeConstructorReference(
  value: unknown,
): value is ThemeConstructorReference {
  return (
    isPlainObject(value) &&
    value.kind === "theme-constructor" &&
    isPlainObject(value.tokens)
  );
}

function identifierReferenceToCssLiteral(value: unknown): string | null {
  if (!isIdentifierReference(value) || value.path.length !== 1) {
    return null;
  }

  const [identifier] = value.path;
  if (identifier === "revertLayer") {
    return "revert-layer";
  }
  if (identifier === "currentColor") {
    return "currentColor";
  }

  if (!/^[a-z][a-z0-9]*$/.test(identifier)) {
    return null;
  }

  return identifier;
}

function identifierReferenceToThemeVar(value: unknown): ReturnType<typeof cv> | null {
  if (!isIdentifierReference(value) || value.path.length !== 2) {
    return null;
  }

  const [head, token] = value.path;
  if (head !== "tv" || token.length === 0) {
    return null;
  }

  return cv(toThemeVarName(token));
}

function normalizeStyleLeafValue(value: unknown): StyleValue | null {
  const themeVar = identifierReferenceToThemeVar(value);
  if (themeVar) {
    return themeVar;
  }

  const cssIdentifierLiteral = identifierReferenceToCssLiteral(value);
  if (cssIdentifierLiteral !== null) {
    return cssIdentifierLiteral;
  }

  if (
    typeof value === "string" || typeof value === "number" || isCssVarRef(value)
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const normalizedArray: Array<string | number | ReturnType<typeof cv>> = [];
    for (const entry of value) {
      const normalizedEntry = normalizeStyleLeafValue(entry);
      if (
        normalizedEntry === null || Array.isArray(normalizedEntry) ||
        typeof normalizedEntry === "object" && !isCssVarRef(normalizedEntry)
      ) {
        return null;
      }
      normalizedArray.push(normalizedEntry);
    }
    return normalizedArray;
  }

  return null;
}

function isPrimitiveStyleLeaf(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    isCssVarRef(value) ||
    identifierReferenceToCssLiteral(value) !== null ||
    identifierReferenceToThemeVar(value) !== null
  );
}

function isStyleLeaf(value: unknown): boolean {
  if (isPrimitiveStyleLeaf(value)) {
    return true;
  }

  return Array.isArray(value) &&
    value.every((entry) => isPrimitiveStyleLeaf(entry));
}

function isStyleDeclarationObject(value: unknown): value is StyleDeclaration {
  if (!isPlainObject(value) || isCssVarRef(value)) {
    return false;
  }

  for (const declarationValue of Object.values(value)) {
    if (
      !isStyleLeaf(declarationValue) &&
      !isStyleDeclarationObject(declarationValue)
    ) {
      return false;
    }
  }
  return true;
}

function normalizeApplyValue(
  value: unknown,
  options: ParseCtOptions,
): StyleDeclaration | null {
  if (Array.isArray(value)) {
    let merged: StyleDeclaration = {};
    for (const item of value) {
      const declaration = normalizeApplyValue(item, options);
      if (!declaration) {
        return null;
      }
      merged = mergeStyleDeclarations(merged, declaration);
    }
    return merged;
  }

  if (typeof value === "string") {
    const utility = options.utilities?.[value];
    if (!utility) {
      return null;
    }
    return normalizeStyleDeclaration(utility, options);
  }

  return normalizeStyleDeclaration(value, options);
}

function normalizeSetValue(
  value: unknown,
  options: ParseCtOptions,
): StyleDeclaration | null {
  if (Array.isArray(value)) {
    let merged: StyleDeclaration = {};
    for (const item of value) {
      const declaration = normalizeSetValue(item, options);
      if (!declaration) {
        return null;
      }
      merged = mergeStyleDeclarations(merged, declaration);
    }
    return merged;
  }

  if (typeof value === "string") {
    const preset = options.containers?.[value];
    if (preset) {
      return {
        containerName: value,
        containerType: preset.type ?? "inline-size",
      };
    }

    return {
      containerName: value,
      containerType: "inline-size",
    };
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const name = value.name;
  if (typeof name !== "string") {
    return null;
  }

  const type = typeof value.type === "string" ? value.type : "inline-size";
  return {
    containerName: name,
    containerType: type,
  };
}

function mergeStyleDeclarations(
  base: StyleDeclaration,
  next: StyleDeclaration,
): StyleDeclaration {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, nextValue] of Object.entries(next)) {
    const previousValue = merged[key];
    if (
      isStyleDeclarationObject(previousValue) &&
      isStyleDeclarationObject(nextValue)
    ) {
      merged[key] = mergeStyleDeclarations(previousValue, nextValue);
      continue;
    }
    merged[key] = nextValue;
  }

  return merged as StyleDeclaration;
}

function normalizeStyleDeclaration(
  value: unknown,
  options: ParseCtOptions,
): StyleDeclaration | null {
  if (Array.isArray(value)) {
    let merged: StyleDeclaration = {};
    for (const item of value) {
      const declaration = normalizeStyleDeclaration(item, options);
      if (!declaration) {
        return null;
      }
      merged = mergeStyleDeclarations(merged, declaration);
    }
    return merged;
  }

  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value) || isCssVarRef(value)) {
    return null;
  }

  let merged: StyleDeclaration = {};

  for (const [key, declarationValue] of Object.entries(value)) {
    if (key === "@apply") {
      const declaration = normalizeApplyValue(declarationValue, options);
      if (!declaration) {
        return null;
      }
      merged = mergeStyleDeclarations(merged, declaration);
      continue;
    }

    if (key === "@set") {
      const declaration = normalizeSetValue(declarationValue, options);
      if (!declaration) {
        return null;
      }
      merged = mergeStyleDeclarations(merged, declaration);
      continue;
    }

    if (isStyleLeaf(declarationValue)) {
      const normalizedLeaf = normalizeStyleLeafValue(declarationValue);
      if (normalizedLeaf === null) {
        return null;
      }
      (merged as Record<string, StyleValue>)[key] = normalizedLeaf;
      continue;
    }

    const nested = normalizeStyleDeclaration(declarationValue, options);
    if (!nested) {
      return null;
    }
    merged[key] = nested;
  }

  return merged;
}

function normalizeStyleSheet(
  value: unknown,
  options: ParseCtOptions,
): StyleSheet | null {
  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const sheet: StyleSheet = {};

  function addImportPaths(importValue: unknown): boolean {
    const entries =
      typeof importValue === "string" || isPlainObject(importValue)
        ? [importValue]
        : Array.isArray(importValue)
        ? importValue
        : null;
    if (!entries) {
      return false;
    }

    for (const entry of entries) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed.length === 0) {
          return false;
        }
        options.imports?.add(`"${trimmed}"`);
      } else if (
        isPlainObject(entry) && "path" in entry &&
        typeof entry.path === "string"
      ) {
        const trimmed = entry.path.trim();
        if (trimmed.length === 0) {
          return false;
        }
        if (
          "layer" in entry && typeof entry.layer === "string" &&
          entry.layer.trim().length > 0
        ) {
          options.imports?.add(`"${trimmed}" layer(${entry.layer.trim()})`);
        } else {
          options.imports?.add(`"${trimmed}"`);
        }
      } else {
        return false;
      }
    }
    return true;
  }

  for (const [key, declaration] of Object.entries(value)) {
    if (key === "@import") {
      if (!addImportPaths(declaration)) {
        return null;
      }
      continue;
    }

    if (key === "@apply") {
      const normalizedApply = normalizeApplyValue(declaration, options);
      if (!normalizedApply) {
        return null;
      }
      continue;
    }
    const normalized = normalizeStyleDeclaration(declaration, options);
    if (!normalized) {
      return null;
    }
    sheet[key] = normalized;
  }

  return sheet;
}

function normalizeRootVars(
  value: unknown,
  options: ParseCtOptions,
):
  | RootVarEntry[]
  | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: RootVarEntry[] = [];
  for (const entry of value) {
    if (isIdentifierReference(entry)) {
      return null;
    }
    if (!isPlainObject(entry) || isCssVarRef(entry)) {
      return null;
    }

    if ("vars" in entry) {
      const varsDeclaration = normalizeStyleDeclaration(entry.vars, options);
      if (!varsDeclaration) {
        return null;
      }
      const vars: Record<string, StyleValue> = {};
      for (const [name, declarationValue] of Object.entries(varsDeclaration)) {
        if (!isStyleLeaf(declarationValue)) {
          return null;
        }
        vars[name] = declarationValue as StyleValue;
      }

      const layer = typeof entry.layer === "string" ? entry.layer : undefined;
      normalized.push(layer ? { vars, layer } : { vars });
      continue;
    }

    const declaration = normalizeStyleDeclaration(entry, options);
    if (!declaration) {
      return null;
    }
    const vars: Record<string, StyleValue> = {};
    for (const [name, declarationValue] of Object.entries(declaration)) {
      if (!isStyleLeaf(declarationValue)) {
        return null;
      }
      vars[name] = declarationValue as StyleValue;
    }
    normalized.push(vars);
  }

  return normalized;
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

function normalizeThemeVarsRecord(
  value: unknown,
  options: ParseCtOptions,
): Record<string, StyleValue> | null {
  if (!isPlainObject(value) || isCssVarRef(value)) {
    return null;
  }

  const normalizedVars: Record<string, StyleValue> = {};
  for (const [token, tokenValue] of Object.entries(value)) {
    const normalizedValue = normalizeStyleLeafValue(tokenValue);
    if (normalizedValue === null) {
      return null;
    }
    normalizedVars[token.startsWith("--") ? token : toThemeVarName(token)] =
      normalizedValue;
  }

  return normalizedVars;
}

function normalizeImportedThemes(
  value: unknown,
  options: ParseCtOptions,
): { root: RootVarEntry[]; global: StyleSheet } | null {
  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const root: RootVarEntry[] = [];
  const global: StyleSheet = {};

  for (const [scope, themeValue] of Object.entries(value)) {
    let vars: Record<string, StyleValue> | null = null;

    if (isTheme(themeValue)) {
      vars = normalizeThemeVarsRecord(themeValue.vars, options);
    } else {
      vars = normalizeThemeVarsRecord(themeValue, options);
    }

    if (!vars) {
      return null;
    }

    const selector = toThemeScopeSelector(scope);
    if (selector === null) {
      root.push(vars);
      continue;
    }

    const scopeKey = `@scope (${selector})`;
    const scopeRule =
      (global[scopeKey] as Record<string, StyleDeclaration | StyleValue> | undefined) ??
        {};
    const currentScope =
      (scopeRule[":scope"] as Record<string, StyleValue> | undefined) ?? {};
    scopeRule[":scope"] = { ...currentScope, ...vars };
    global[scopeKey] = scopeRule as StyleDeclaration;
  }

  return { root, global };
}

function normalizeVariantSheet(
  value: unknown,
  base: StyleSheet,
  options: ParseCtOptions,
): { variant?: VariantSheet; variantGlobal?: VariantGlobalSheet } | null {
  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const variantSheet: VariantSheet = {};
  const variantGlobalSheet: VariantGlobalSheet = {};

  for (const [groupName, group] of Object.entries(value)) {
    if (!isPlainObject(group)) {
      return null;
    }

    const normalizedGroup: Record<string, StyleSheet> = {};
    const normalizedGlobalGroup: Record<string, StyleSheet> = {};

    for (const [variantName, variant] of Object.entries(group)) {
      if (!isPlainObject(variant)) {
        return null;
      }

      const normalizedVariant: StyleSheet = {};
      const normalizedGlobalVariant: StyleSheet = {};
      const quotedKeys = getQuotedKeys(variant);

      for (const [key, declaration] of Object.entries(variant)) {
        const normalizedDeclaration = normalizeStyleDeclaration(
          declaration,
          options,
        );
        if (!normalizedDeclaration) {
          return null;
        }

        if (quotedKeys.has(key)) {
          normalizedGlobalVariant[key] = normalizedDeclaration;
          continue;
        }

        if (!(key in base)) {
          return null;
        }

        normalizedVariant[key] = normalizedDeclaration;
      }

      if (Object.keys(normalizedVariant).length > 0) {
        normalizedGroup[variantName] = normalizedVariant;
      }
      if (Object.keys(normalizedGlobalVariant).length > 0) {
        normalizedGlobalGroup[variantName] = normalizedGlobalVariant;
      }
    }

    if (Object.keys(normalizedGroup).length > 0) {
      variantSheet[groupName] = normalizedGroup;
    }
    if (Object.keys(normalizedGlobalGroup).length > 0) {
      variantGlobalSheet[groupName] = normalizedGlobalGroup;
    }
  }

  return {
    variant: Object.keys(variantSheet).length > 0 ? variantSheet : undefined,
    variantGlobal: Object.keys(variantGlobalSheet).length > 0
      ? variantGlobalSheet
      : undefined,
  };
}

function normalizeVariantSelection(
  value: unknown,
  variants: VariantSheet | undefined,
): VariantSelection | null {
  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const selection: VariantSelection = {};
  for (const [groupName, variantName] of Object.entries(value)) {
    if (typeof variantName !== "string") {
      return null;
    }
    if (variants) {
      const group = variants[groupName];
      if (!group || !(variantName in group)) {
        return null;
      }
    }
    selection[groupName] = variantName;
  }

  return selection;
}

/**
 * Validate and normalize a parsed config object into a {@link CtConfig}.
 * Allowed top-level keys: `global`, `importThemes`, `root`, `rootVars`, `base`, `variant`, `defaults`.
 * Returns `null` when the input cannot be validated.
 */
export function parseCtConfig(
  value: Record<string, unknown>,
  options: ParseCtOptions = {},
): CtConfig | null {
  const allowed = new Set([
    "global",
    "importThemes",
    "root",
    "rootVars",
    "base",
    "variant",
    "defaults",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return null;
    }
  }

  const imports = options.imports ?? new Set<string>();
  const parseOptions: ParseCtOptions = {
    ...options,
    imports,
  };

  let global: StyleSheet | undefined;
  let root: RootVarEntry[] | undefined;
  let base: StyleSheet = {};
  let variant: VariantSheet | undefined;
  let variantGlobal: VariantGlobalSheet | undefined;
  let defaults: VariantSelection | undefined;
  const rootEntries: RootVarEntry[] = [];

  if ("importThemes" in value) {
    const normalizedThemes = normalizeImportedThemes(
      value.importThemes,
      parseOptions,
    );
    if (!normalizedThemes) {
      return null;
    }
    rootEntries.push(...normalizedThemes.root);
    if (Object.keys(normalizedThemes.global).length > 0) {
      global = normalizedThemes.global;
    }
  }

  if ("global" in value) {
    const normalized = normalizeStyleSheet(value.global, parseOptions);
    if (!normalized) {
      return null;
    }
    global = { ...(global ?? {}), ...normalized };
  }

  if ("root" in value) {
    const normalizedRoot = normalizeRootVars(value.root, parseOptions);
    if (!normalizedRoot) {
      return null;
    }
    rootEntries.push(...normalizedRoot);
  }

  if ("rootVars" in value) {
    const normalizedRootVars = normalizeRootVars(value.rootVars, parseOptions);
    if (!normalizedRootVars) {
      return null;
    }
    rootEntries.push(...normalizedRootVars);
  }

  if (rootEntries.length > 0) {
    root = rootEntries;
  }

  if ("base" in value) {
    const normalized = normalizeStyleSheet(value.base, parseOptions);
    if (!normalized) {
      return null;
    }
    base = normalized;
  }

  if ("variant" in value) {
    const normalized = normalizeVariantSheet(value.variant, base, parseOptions);
    if (!normalized) {
      return null;
    }
    variant = normalized.variant;
    variantGlobal = normalized.variantGlobal;
  }

  if ("defaults" in value) {
    const normalizedDefaults = normalizeVariantSelection(
      value.defaults,
      variant,
    );
    if (!normalizedDefaults) {
      return null;
    }

    defaults = normalizedDefaults;
  }

  return {
    imports: imports.size > 0 ? Array.from(imports) : undefined,
    global,
    root,
    rootVars: root,
    base,
    variant,
    variantGlobal,
    defaults,
  };
}

const UNRESOLVED = Symbol("ct-parser-unresolved");

function resolveParsedValue(
  value: ParsedValue,
  resolveIdentifier: IdentifierResolver,
  keepUnresolvedIdentifiers = false,
): unknown | typeof UNRESOLVED {
  if (isIdentifierReference(value)) {
    const resolved = resolveIdentifier(value.path);
    if (resolved === undefined) {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
    return resolved;
  }

  if (isTemplateLiteralReference(value)) {
    let resolvedString = "";
    for (const part of value.parts) {
      const resolvedPart = resolveParsedValue(
        part,
        resolveIdentifier,
        keepUnresolvedIdentifiers,
      );
      if (resolvedPart === UNRESOLVED) {
        return keepUnresolvedIdentifiers ? value : UNRESOLVED;
      }
      resolvedString += String(resolvedPart);
    }
    return resolvedString;
  }

  if (isThemeConstructorReference(value)) {
    const resolvedTokens = resolveParsedValue(
      value.tokens,
      resolveIdentifier,
      keepUnresolvedIdentifiers,
    );
    if (resolvedTokens === UNRESOLVED) {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
    if (!isPlainObject(resolvedTokens)) {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
    try {
      return new Theme(resolvedTokens as Record<string, StyleValue>);
    } catch {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
  }

  if (Array.isArray(value)) {
    const resolvedArray: unknown[] = [];
    for (const entry of value) {
      const resolved = resolveParsedValue(
        entry,
        resolveIdentifier,
        keepUnresolvedIdentifiers,
      );
      if (resolved === UNRESOLVED) {
        return UNRESOLVED;
      }
      resolvedArray.push(resolved);
    }
    return resolvedArray;
  }

  if (isPlainObject(value)) {
    const resolvedObject: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const resolved = resolveParsedValue(
        nestedValue as ParsedValue,
        resolveIdentifier,
        keepUnresolvedIdentifiers,
      );
      if (resolved === UNRESOLVED) {
        return UNRESOLVED;
      }
      resolvedObject[key] = resolved;
    }
    for (const quotedKey of getQuotedKeys(value)) {
      setQuotedKey(resolvedObject, quotedKey);
    }
    return resolvedObject;
  }

  return value;
}

function parseExpression(source: string): ParsedValue | null {
  try {
    const index = skipWhitespace(source, 0);
    const [parsed, end] = parseValue(source, index);
    const cursor = skipWhitespace(source, end);
    if (cursor !== source.length) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parse a limited static expression used by css-ts extraction:
 * objects, arrays, strings, numbers, identifiers, and `cv(...)`.
 */
export function parseStaticExpression(
  source: string,
  resolveIdentifier?: IdentifierResolver,
  options: { keepUnresolvedIdentifiers?: boolean } = {},
): unknown | null {
  const parsed = parseExpression(source);
  if (!parsed) {
    return null;
  }
  const keepUnresolvedIdentifiers = options.keepUnresolvedIdentifiers === true;

  if (!resolveIdentifier) {
    const unresolved = resolveParsedValue(
      parsed,
      () => undefined,
      keepUnresolvedIdentifiers,
    );
    return unresolved === UNRESOLVED ? null : unresolved;
  }

  const resolved = resolveParsedValue(
    parsed,
    resolveIdentifier,
    keepUnresolvedIdentifiers,
  );
  if (resolved === UNRESOLVED) {
    return null;
  }
  return resolved;
}

function parseCtCallArgumentsInternal(
  source: string,
  resolveIdentifier: IdentifierResolver,
  options: ParseCtOptions,
): CtConfig | null {
  const parsed = parseExpression(source);
  if (!parsed || !isPlainObject(parsed)) {
    return null;
  }

  const resolved = resolveParsedValue(parsed, resolveIdentifier, true);
  if (resolved === UNRESOLVED || !isPlainObject(resolved)) {
    return null;
  }

  return parseCtConfig(resolved, options);
}

/**
 * Parse a `ct({ global?, base?, variant?, defaults? })` argument string into style objects.
 * Returns `null` when the input cannot be parsed or validated.
 */
export function parseCtCallArguments(
  source: string,
  options: ParseCtOptions = {},
): CtConfig | null {
  return parseCtCallArgumentsInternal(source, () => undefined, options);
}

/**
 * Parse `ct({ ... })` arguments and resolve identifier references through the provided callback.
 */
export function parseCtCallArgumentsWithResolver(
  source: string,
  resolveIdentifier: IdentifierResolver,
  options: ParseCtOptions = {},
): CtConfig | null {
  return parseCtCallArgumentsInternal(source, resolveIdentifier, options);
}

/**
 * Find `ct(...)` calls in source code and return their locations plus raw arguments.
 */
export function findCtCalls(
  code: string,
): Array<{ start: number; end: number; arg: string }> {
  const calls: Array<{ start: number; end: number; arg: string }> = [];
  const matcher = /\bct\s*\(/g;

  for (let match = matcher.exec(code); match; match = matcher.exec(code)) {
    const callStart = match.index;
    const before = callStart > 0 ? code[callStart - 1] : "";
    if (before === "." || isIdentifierPart(before)) {
      continue;
    }
    let index = matcher.lastIndex;

    index = skipWhitespace(code, index);
    if (code[index] !== "{") {
      continue;
    }

    let parenDepth = 1;
    let inString = "";
    let escaped = false;

    for (; index < code.length; index += 1) {
      const char = code[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === inString) {
          inString = "";
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = char;
        continue;
      }

      if (char === "(") {
        parenDepth += 1;
        continue;
      }

      if (char === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) {
          const argEnd = index;
          calls.push({
            start: callStart,
            end: argEnd + 1,
            arg: code.slice(match[0].length + callStart, argEnd),
          });
          break;
        }
      }
    }
  }

  return calls;
}

/**
 * Find the end of a JavaScript expression starting at `start` by tracking
 * balanced braces, brackets, parentheses, string literals, and comments.
 */
export function findExpressionTerminator(input: string, start: number): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString: "" | '"' | "'" | "`" = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = "";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      continue;
    }

    if (char === "}") {
      braceDepth -= 1;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      continue;
    }

    if (char === "]") {
      bracketDepth -= 1;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }

    if (char === ")") {
      parenDepth -= 1;
      continue;
    }

    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (char === ";" || char === ",") {
        return i;
      }

      if (char === "\n") {
        const remaining = input.slice(i + 1).trimStart();
        if (
          remaining.startsWith("const ") ||
          remaining.startsWith("export ") ||
          remaining.startsWith("import ") ||
          remaining.startsWith("function ") ||
          remaining.startsWith("class ") ||
          remaining.startsWith("let ") ||
          remaining.startsWith("var ") ||
          remaining.startsWith("</script>")
        ) {
          return i;
        }
      }
    }
  }

  return input.length;
}

type NewCtAssignment = {
  property: string;
  start: number;
  end: number;
  valueSource: string;
};

type NewCtDeclaration = {
  varName: string;
  start: number;
  end: number;
  assignments: NewCtAssignment[];
};

/**
 * Find `const x = new ct()` declarations and their subsequent property assignments
 * (`x.base = ...`, `x.global = ...`, `x.root = ...`, etc.) for static extraction.
 */
export function findNewCtDeclarations(code: string): NewCtDeclaration[] {
  const declarations: NewCtDeclaration[] = [];
  const matcher =
    /\b(const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+ct\s*\(\s*\)/g;

  for (let match = matcher.exec(code); match; match = matcher.exec(code)) {
    const varName = match[2];
    const declStart = match.index;
    const declEnd = matcher.lastIndex;

    const assignments: NewCtAssignment[] = [];
    const assignmentMatcher = new RegExp(
      `\\b${varName}\\.(base|global|importThemes|root|rootVars|variant|defaults)\\s*=\\s*`,
      "g",
    );
    assignmentMatcher.lastIndex = declEnd;

    for (
      let aMatch = assignmentMatcher.exec(code);
      aMatch;
      aMatch = assignmentMatcher.exec(code)
    ) {
      const property = aMatch[1];
      const assignStart = aMatch.index;
      const valueStart = aMatch.index + aMatch[0].length;
      const valueEnd = findExpressionTerminator(code, valueStart);
      const valueSource = code.slice(valueStart, valueEnd).trim();

      const end = valueEnd < code.length && code[valueEnd] === ";"
        ? valueEnd + 1
        : valueEnd;

      assignments.push({ property, start: assignStart, end, valueSource });
      assignmentMatcher.lastIndex = end;
    }

    const importMatcher = new RegExp(
      `\\b${varName}\\.import\\s*(?=\\()`,
      "g",
    );
    importMatcher.lastIndex = declEnd;

    for (
      let iMatch = importMatcher.exec(code);
      iMatch;
      iMatch = importMatcher.exec(code)
    ) {
      const assignStart = iMatch.index;
      const valueStart = iMatch.index + iMatch[0].length;
      const valueEnd = findExpressionTerminator(code, valueStart);
      let valueSource = code.slice(valueStart, valueEnd).trim();

      if (valueSource.startsWith("(") && valueSource.endsWith(");")) {
        valueSource = valueSource.slice(1, -2).trim();
      } else if (valueSource.startsWith("(") && valueSource.endsWith(")")) {
        valueSource = valueSource.slice(1, -1).trim();
      }

      const end = valueEnd < code.length && code[valueEnd] === ";"
        ? valueEnd + 1
        : valueEnd;

      assignments.push({
        property: "import",
        start: assignStart,
        end,
        valueSource,
      });
      importMatcher.lastIndex = end;
    }

    declarations.push({ varName, start: declStart, end: declEnd, assignments });
  }

  return declarations;
}
