import { cv, isCssVarRef, type StyleDeclaration, type StyleSheet, type StyleValue } from "./shared.js";

interface ParseResult {
  value: ParsedObject;
  end: number;
}

type VariantSheet = Record<string, Record<string, StyleSheet>>;
type VariantSelection = Record<string, string>;
type CtConfig = {
  global?: StyleSheet;
  base: StyleSheet;
  variant?: VariantSheet;
  defaults?: VariantSelection;
};
type ParseCtOptions = {
  utilities?: StyleSheet;
};

type IdentifierReference = {
  kind: "identifier-ref";
  path: string[];
};

interface ParsedObject {
  [key: string]: ParsedValue;
}

interface ParsedArray extends Array<ParsedValue> {}

type ParsedValue =
  | string
  | number
  | ReturnType<typeof cv>
  | IdentifierReference
  | ParsedObject
  | ParsedArray;

export type IdentifierResolver = (path: readonly string[]) => unknown | undefined;

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
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
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

function parseIdentifier(input: string, index: number): [string, number] {
  if (!isIdentifierStart(input[index])) {
    throw new Error("Invalid identifier");
  }

  let end = index + 1;
  while (end < input.length && isIdentifierPart(input[end])) end += 1;
  return [input.slice(index, end), end];
}

function parseKey(input: string, index: number): [string, number] {
  const char = input[index];
  if (char === '"' || char === "'") return parseString(input, index);
  return parseIdentifier(input, index);
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

  if (char === "-" || /\d/.test(char)) {
    return parseNumber(input, index);
  }

  if (isIdentifierStart(char)) {
    const [identifier, identifierEnd] = parseIdentifier(input, index);
    if (identifier !== "cv") {
      return parseIdentifierReference(input, identifier, identifierEnd);
    }

    let cursor = skipWhitespace(input, identifierEnd);
    if (input[cursor] !== "(") {
      return parseIdentifierReference(input, identifier, identifierEnd);
    }
    cursor = skipWhitespace(input, cursor + 1);

    if (input[cursor] !== '"' && input[cursor] !== "'") {
      throw new Error("cv() expects a string variable name");
    }
    const [variableName, variableEnd] = parseString(input, cursor);
    cursor = skipWhitespace(input, variableEnd);

    let fallback: string | number | undefined;
    if (input[cursor] === ",") {
      const [fallbackValue, fallbackEnd] = parseValue(input, cursor + 1);
      if (typeof fallbackValue !== "string" && typeof fallbackValue !== "number") {
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

    const [key, keyEnd] = parseKey(input, index);
    index = skipWhitespace(input, keyEnd);

    if (input[index] !== ":") {
      throw new Error(`Expected ':' after key '${key}'`);
    }

    const [parsedValue, valueEnd] = parseValue(input, index + 1);
    value[key] = parsedValue;
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

function isIdentifierReference(value: unknown): value is IdentifierReference {
  return (
    isPlainObject(value) &&
    value.kind === "identifier-ref" &&
    Array.isArray(value.path) &&
    value.path.every((part) => typeof part === "string")
  );
}

function isPrimitiveStyleLeaf(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || isCssVarRef(value);
}

function isStyleLeaf(value: unknown): boolean {
  if (isPrimitiveStyleLeaf(value)) {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => isPrimitiveStyleLeaf(entry));
}

function isStyleDeclarationObject(value: unknown): value is StyleDeclaration {
  if (!isPlainObject(value) || isCssVarRef(value)) {
    return false;
  }

  for (const declarationValue of Object.values(value)) {
    if (!isStyleLeaf(declarationValue) && !isStyleDeclarationObject(declarationValue)) {
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

function normalizeStyleDeclaration(value: unknown, options: ParseCtOptions): StyleDeclaration | null {
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

    if (isStyleLeaf(declarationValue)) {
      (merged as Record<string, StyleValue>)[key] = declarationValue as StyleValue;
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

function normalizeStyleSheet(value: unknown, options: ParseCtOptions): StyleSheet | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const sheet: StyleSheet = {};
  for (const [key, declaration] of Object.entries(value)) {
    const normalized = normalizeStyleDeclaration(declaration, options);
    if (!normalized) {
      return null;
    }
    sheet[key] = normalized;
  }

  return sheet;
}

function normalizeVariantSheet(value: unknown, baseKeys: Set<string>, options: ParseCtOptions): VariantSheet | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const variantSheet: VariantSheet = {};

  for (const [groupName, group] of Object.entries(value)) {
    if (!isPlainObject(group)) {
      return null;
    }

    const normalizedGroup: Record<string, StyleSheet> = {};

    for (const [variantName, variant] of Object.entries(group)) {
      const normalizedVariant = normalizeStyleSheet(variant, options);
      if (!normalizedVariant) {
        return null;
      }

      for (const classKey of Object.keys(normalizedVariant)) {
        if (!baseKeys.has(classKey)) {
          return null;
        }
      }

      normalizedGroup[variantName] = normalizedVariant;
    }

    variantSheet[groupName] = normalizedGroup;
  }

  return variantSheet;
}

function normalizeVariantSelection(
  value: unknown,
  variants: VariantSheet | undefined,
): VariantSelection | null {
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

export function parseCtConfig(value: Record<string, unknown>, options: ParseCtOptions = {}): CtConfig | null {
  const allowed = new Set(["global", "base", "variant", "defaults"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return null;
    }
  }

  let global: StyleSheet | undefined;
  let base: StyleSheet = {};
  let variant: VariantSheet | undefined;
  let defaults: VariantSelection | undefined;

  if ("global" in value) {
    const normalized = normalizeStyleSheet(value.global, options);
    if (!normalized) {
      return null;
    }
    global = normalized;
  }

  if ("base" in value) {
    const normalized = normalizeStyleSheet(value.base, options);
    if (!normalized) {
      return null;
    }
    base = normalized;
  }

  if ("variant" in value) {
    const normalized = normalizeVariantSheet(value.variant, new Set(Object.keys(base)), options);
    if (!normalized) {
      return null;
    }
    variant = normalized;
  }

  if ("defaults" in value) {
    const normalizedDefaults = normalizeVariantSelection(value.defaults, variant);
    if (!normalizedDefaults) {
      return null;
    }

    defaults = normalizedDefaults;
  }

  return {
    global,
    base,
    variant,
    defaults,
  };
}

const UNRESOLVED = Symbol("ct-parser-unresolved");

function resolveParsedValue(value: ParsedValue, resolveIdentifier: IdentifierResolver): unknown | typeof UNRESOLVED {
  if (isIdentifierReference(value)) {
    const resolved = resolveIdentifier(value.path);
    return resolved === undefined ? UNRESOLVED : resolved;
  }

  if (Array.isArray(value)) {
    const resolvedArray: unknown[] = [];
    for (const entry of value) {
      const resolved = resolveParsedValue(entry, resolveIdentifier);
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
      const resolved = resolveParsedValue(nestedValue as ParsedValue, resolveIdentifier);
      if (resolved === UNRESOLVED) {
        return UNRESOLVED;
      }
      resolvedObject[key] = resolved;
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
): unknown | null {
  const parsed = parseExpression(source);
  if (!parsed) {
    return null;
  }

  if (!resolveIdentifier) {
    const unresolved = resolveParsedValue(parsed, () => undefined);
    return unresolved === UNRESOLVED ? null : unresolved;
  }

  const resolved = resolveParsedValue(parsed, resolveIdentifier);
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

  const resolved = resolveParsedValue(parsed, resolveIdentifier);
  if (resolved === UNRESOLVED || !isPlainObject(resolved)) {
    return null;
  }

  return parseCtConfig(resolved, options);
}

/**
 * Parse a `ct({ global?, base?, variant?, defaults? })` argument string into style objects.
 * Returns `null` when the input cannot be parsed or validated.
 */
export function parseCtCallArguments(source: string, options: ParseCtOptions = {}): CtConfig | null {
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
export function findCtCalls(code: string): Array<{ start: number; end: number; arg: string }> {
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
 * (`x.base = ...`, `x.global = ...`, etc.) for static extraction.
 */
export function findNewCtDeclarations(code: string): NewCtDeclaration[] {
  const declarations: NewCtDeclaration[] = [];
  const matcher = /\b(const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+ct\s*\(\s*\)/g;

  for (let match = matcher.exec(code); match; match = matcher.exec(code)) {
    const varName = match[2];
    const declStart = match.index;
    const declEnd = matcher.lastIndex;

    const assignments: NewCtAssignment[] = [];
    const assignmentMatcher = new RegExp(
      `\\b${varName}\\.(base|global|variant|defaults)\\s*=\\s*`,
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

    declarations.push({ varName, start: declStart, end: declEnd, assignments });
  }

  return declarations;
}
