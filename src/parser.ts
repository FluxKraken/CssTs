import { cv, isCssVarRef, type StyleDeclaration, type StyleSheet } from "./shared.js";

interface ParseResult {
  value: Record<string, unknown>;
  end: number;
}

type VariantSheet = Record<string, Record<string, StyleSheet>>;

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

function parseValue(input: string, index: number): [unknown, number] {
  index = skipWhitespace(input, index);
  const char = input[index];

  if (char === "{") {
    const result = parseObject(input, index);
    return [result.value, result.end];
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
      throw new Error(`Unsupported value function '${identifier}'`);
    }

    let cursor = skipWhitespace(input, identifierEnd);
    if (input[cursor] !== "(") {
      throw new Error(`Expected '(' after ${identifier}`);
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

  const value: Record<string, unknown> = {};
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

function isPseudoStyleDeclaration(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const declarationValue of Object.values(value)) {
    if (
      typeof declarationValue !== "string" &&
      typeof declarationValue !== "number" &&
      !isCssVarRef(declarationValue)
    ) {
      return false;
    }
  }
  return true;
}

function isStyleDeclaration(value: unknown): value is StyleDeclaration {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const declarationValue of Object.values(value)) {
    if (
      typeof declarationValue !== "string" &&
      typeof declarationValue !== "number" &&
      !isCssVarRef(declarationValue) &&
      !isPseudoStyleDeclaration(declarationValue)
    ) {
      return false;
    }
  }
  return true;
}

function isStyleSheet(value: unknown): value is StyleSheet {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const declaration of Object.values(value)) {
    if (!isStyleDeclaration(declaration)) {
      return false;
    }
  }
  return true;
}

function isVariantSheet(value: unknown, baseKeys: Set<string>): value is VariantSheet {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const group of Object.values(value)) {
    if (!isPlainObject(group)) {
      return false;
    }

    for (const variant of Object.values(group)) {
      if (!isStyleSheet(variant)) {
        return false;
      }
      for (const classKey of Object.keys(variant)) {
        if (!baseKeys.has(classKey)) {
          return false;
        }
      }
    }
  }

  return true;
}

export function parseCtCallArguments(
  source: string,
): { base: StyleSheet; variants?: VariantSheet } | null {
  try {
    const index = skipWhitespace(source, 0);
    if (source[index] !== "{") {
      return null;
    }

    const baseParsed = parseObject(source, index);
    if (!isStyleSheet(baseParsed.value)) {
      return null;
    }

    let cursor = skipWhitespace(source, baseParsed.end);
    if (cursor === source.length) {
      return { base: baseParsed.value };
    }

    if (source[cursor] !== ",") {
      return null;
    }

    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] !== "{") {
      return null;
    }

    const variantParsed = parseObject(source, cursor);
    cursor = skipWhitespace(source, variantParsed.end);
    if (cursor !== source.length) {
      return null;
    }

    const baseKeys = new Set(Object.keys(baseParsed.value));
    if (!isVariantSheet(variantParsed.value, baseKeys)) {
      return null;
    }

    return { base: baseParsed.value, variants: variantParsed.value };
  } catch {
    return null;
  }
}

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
