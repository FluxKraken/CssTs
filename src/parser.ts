import {
  cv,
  evalThemeTemplate,
  font,
  isCssVarRef,
  isTailwindClassValue,
  isTheme,
  prefixTailwindVariantClasses,
  type StyleDeclaration,
  type StyleSheet,
  type StyleValue,
  type TailwindClassValue,
  type ThemeMode,
  Theme,
  toTailwindVariantForNestedKey,
  toThemeVarName,
  tw,
} from "./shared.js";

interface ParseResult {
  value: ParsedObject;
  end: number;
}

type ResolvedStyleDefinition = {
  kind: "css-ts-style";
  declaration: StyleDeclaration;
  tailwindClassNames?: readonly string[];
};
type NormalizedStyleSheet = Record<string, ResolvedStyleDefinition>;
type VariantSheet = Record<string, Record<string, NormalizedStyleSheet>>;
type VariantGlobalSheet = Record<string, Record<string, StyleSheet>>;
type VariantSelection = Record<string, string | boolean>;
type CtConfig = {
  simple?: boolean;
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
  base: NormalizedStyleSheet;
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
  utilities?: NormalizedStyleSheet;
  containers?: Record<string, { type?: string; rule: string }>;
  themeMode?: ThemeMode;
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

type FontCallReference = {
  kind: "font-call";
  families: ParsedArray;
};

type TailwindCallReference = {
  kind: "tailwind-call";
  classes: ParsedValue;
};

interface ParsedObject {
  [key: string]: ParsedValue;
}

const QUOTED_KEYS = Symbol("ct-parser-quoted-keys");
const RESOLVED_STYLE_KIND = "css-ts-style";
const SIMPLE_STYLE_KEY = "__css_ts_simple__";

interface ParsedArray extends Array<ParsedValue> {}

type ParsedValue =
  | string
  | number
  | boolean
  | ReturnType<typeof cv>
  | IdentifierReference
  | TemplateLiteralReference
  | ThemeConstructorReference
  | FontCallReference
  | TailwindCallReference
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

function parseThemeEval(
  input: string,
  index: number,
): [string, number] {
  let cursor = skipWhitespace(input, index);
  if (input[cursor] !== "(") {
    throw new Error("Expected '(' after tv.eval");
  }

  cursor = skipWhitespace(input, cursor + 1);
  const [templateValue, templateEnd] = parseValue(input, cursor);
  if (typeof templateValue !== "string") {
    throw new Error("tv.eval() expects a single string argument");
  }

  cursor = parseCallTerminator(
    input,
    templateEnd,
    "tv.eval() accepts a single string argument",
    "Expected ')' after tv.eval() call",
  );

  return [evalThemeTemplate(templateValue), cursor];
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

  cursor = parseCallTerminator(
    input,
    argumentEnd,
    "Theme() accepts a single object argument",
    "Expected ')' after Theme() call",
  );

  return [{
    kind: "theme-constructor",
    tokens: argumentValue,
  }, cursor];
}

function parseFontCall(
  input: string,
  index: number,
): [FontCallReference, number] {
  let cursor = skipWhitespace(input, index);
  if (input[cursor] !== "(") {
    throw new Error("Expected '(' after font");
  }

  cursor = skipWhitespace(input, cursor + 1);
  const [argumentValue, argumentEnd] = parseValue(input, cursor);
  if (!Array.isArray(argumentValue)) {
    throw new Error("font() expects an array of font family names");
  }

  cursor = parseCallTerminator(
    input,
    argumentEnd,
    "font() accepts a single array argument",
    "Expected ')' after font() call",
  );

  return [{
    kind: "font-call",
    families: argumentValue,
  }, cursor];
}

function parseTailwindCall(
  input: string,
  index: number,
): [TailwindCallReference, number] {
  let cursor = skipWhitespace(input, index);
  if (input[cursor] !== "(") {
    throw new Error("Expected '(' after tw");
  }

  cursor = skipWhitespace(input, cursor + 1);
  const [argumentValue, argumentEnd] = parseValue(input, cursor);
  if (
    typeof argumentValue !== "string" &&
    !(Array.isArray(argumentValue) &&
      argumentValue.every((entry) => typeof entry === "string"))
  ) {
    throw new Error("tw() expects a string or an array of strings");
  }

  cursor = parseCallTerminator(
    input,
    argumentEnd,
    "tw() accepts a single string or array argument",
    "Expected ')' after tw() call",
  );

  return [{
    kind: "tailwind-call",
    classes: argumentValue,
  }, cursor];
}

function parseCallTerminator(
  input: string,
  index: number,
  extraArgumentError: string,
  missingTerminatorError: string,
): number {
  let cursor = skipWhitespace(input, index);

  if (input[cursor] === ",") {
    cursor = skipWhitespace(input, cursor + 1);
    if (input[cursor] !== ")") {
      throw new Error(extraArgumentError);
    }
  }

  if (input[cursor] !== ")") {
    throw new Error(missingTerminatorError);
  }

  return cursor + 1;
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
    if (identifier === "true") {
      return [true, identifierEnd];
    }
    if (identifier === "false") {
      return [false, identifierEnd];
    }
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
    if (cursor < input.length && input[cursor] === ".") {
      const [reference, referenceEnd] = parseIdentifierReference(
        input,
        identifier,
        identifierEnd,
      );
      cursor = skipWhitespace(input, referenceEnd);
      if (
        reference.path.length === 2 &&
        reference.path[0] === "tv" &&
        reference.path[1] === "eval" &&
        input[cursor] === "("
      ) {
        return parseThemeEval(input, cursor);
      }
      if (input[cursor] !== "(") {
        return [reference, referenceEnd];
      }
    }
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
        const fallbackStart = skipWhitespace(input, cursor + 1);
        if (input[fallbackStart] !== ")") {
          const [fallbackValue, fallbackEnd] = parseValue(input, fallbackStart);
          if (
            typeof fallbackValue !== "string" &&
            typeof fallbackValue !== "number"
          ) {
            throw new Error("cv() fallback must be a string or number");
          }
          fallback = fallbackValue;
          cursor = fallbackEnd;
        } else {
          cursor = cursor + 1;
        }
      }

      cursor = parseCallTerminator(
        input,
        cursor,
        "cv() accepts at most two arguments",
        "Expected ')' after cv() call",
      );

      return [cv(variableName, fallback), cursor];
    }

    if (identifier === "font") {
      return parseFontCall(input, identifierEnd);
    }

    if (identifier === "tw") {
      return parseTailwindCall(input, identifierEnd);
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
      if (!quoted && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
        value[key] = {
          kind: "identifier-ref",
          path: [key],
        };

        if (input[index] === ",") {
          index += 1;
          continue;
        }

        if (input[index] === "}") {
          return { value, end: index + 1 };
        }
      }
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

function isFontCallReference(value: unknown): value is FontCallReference {
  return (
    isPlainObject(value) &&
    value.kind === "font-call" &&
    Array.isArray(value.families)
  );
}

function isTailwindCallReference(
  value: unknown,
): value is TailwindCallReference {
  return (
    isPlainObject(value) &&
    value.kind === "tailwind-call" &&
    "classes" in value
  );
}

function normalizeTailwindClassNames(
  classNames: readonly string[] | undefined,
): string[] | undefined {
  if (!classNames || classNames.length === 0) {
    return undefined;
  }

  const normalized = classNames
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function createResolvedStyleDefinition(
  declaration: StyleDeclaration = {},
  tailwindClassNames?: readonly string[],
): ResolvedStyleDefinition {
  const normalizedTailwind = normalizeTailwindClassNames(tailwindClassNames);
  return normalizedTailwind
    ? {
      kind: RESOLVED_STYLE_KIND,
      declaration,
      tailwindClassNames: normalizedTailwind,
    }
    : {
      kind: RESOLVED_STYLE_KIND,
      declaration,
    };
}

function isResolvedStyleDefinition(
  value: unknown,
): value is ResolvedStyleDefinition {
  return (
    isPlainObject(value) &&
    value.kind === RESOLVED_STYLE_KIND &&
    "declaration" in value &&
    isStyleDeclarationObject(value.declaration) &&
    (!("tailwindClassNames" in value) ||
      Array.isArray(value.tailwindClassNames))
  );
}

function mergeResolvedStyleDefinitions(
  base: ResolvedStyleDefinition,
  next: ResolvedStyleDefinition,
): ResolvedStyleDefinition {
  return createResolvedStyleDefinition(
    mergeStyleDeclarations(base.declaration, next.declaration),
    [
      ...(base.tailwindClassNames ?? []),
      ...(next.tailwindClassNames ?? []),
    ],
  );
}

function hasStyleDeclarations(declaration: StyleDeclaration): boolean {
  for (const value of Object.values(declaration)) {
    if (isStyleLeaf(value)) {
      return true;
    }
    if (isStyleDeclarationObject(value) && hasStyleDeclarations(value)) {
      return true;
    }
  }
  return false;
}

function prefixNestedTailwindClassNames(
  key: string,
  classNames: readonly string[] | undefined,
): string[] | null | undefined {
  if (!classNames || classNames.length === 0) {
    return undefined;
  }

  const variant = toTailwindVariantForNestedKey(key);
  if (!variant) {
    return null;
  }

  return prefixTailwindVariantClasses(classNames, variant);
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

function identifierReferenceToThemeVar(
  value: unknown,
): ReturnType<typeof cv> | null {
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
  if (
    !isPlainObject(value) ||
    isCssVarRef(value) ||
    isTailwindClassValue(value) ||
    isResolvedStyleDefinition(value)
  ) {
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
  allowTailwind = true,
): ResolvedStyleDefinition | null {
  if (Array.isArray(value)) {
    let merged = createResolvedStyleDefinition();
    for (const item of value) {
      const declaration = normalizeApplyValue(item, options, allowTailwind);
      if (!declaration) {
        return null;
      }
      merged = mergeResolvedStyleDefinitions(merged, declaration);
    }
    return merged;
  }

  if (isResolvedStyleDefinition(value)) {
    if (!allowTailwind && (value.tailwindClassNames?.length ?? 0) > 0) {
      return null;
    }
    return createResolvedStyleDefinition(
      value.declaration,
      value.tailwindClassNames,
    );
  }

  if (isTailwindClassValue(value)) {
    return allowTailwind
      ? createResolvedStyleDefinition({}, value.classNames)
      : null;
  }

  if (typeof value === "string") {
    const utility = options.utilities?.[value];
    if (!utility) {
      return createResolvedStyleDefinition();
    }
    return createResolvedStyleDefinition(
      utility.declaration,
      utility.tailwindClassNames,
    );
  }

  if (isPlainObject(value) && !isCssVarRef(value) && "rules" in value) {
    const rules = normalizeApplyValue(value.rules, options, allowTailwind);
    if (!rules) {
      return null;
    }
    const declaration = hasStyleDeclarations(rules.declaration) &&
        typeof value.layer === "string" &&
        value.layer.trim().length > 0
      ? {
        [`@layer ${value.layer.trim()}`]: rules.declaration,
      }
      : rules.declaration;
    return createResolvedStyleDefinition(
      declaration,
      rules.tailwindClassNames,
    );
  }

  return normalizeStyleDeclaration(value, options, allowTailwind);
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
  allowTailwind = true,
): ResolvedStyleDefinition | null {
  if (isResolvedStyleDefinition(value)) {
    if (!allowTailwind && (value.tailwindClassNames?.length ?? 0) > 0) {
      return null;
    }
    return createResolvedStyleDefinition(
      value.declaration,
      value.tailwindClassNames,
    );
  }

  if (isTailwindClassValue(value)) {
    return allowTailwind
      ? createResolvedStyleDefinition({}, value.classNames)
      : null;
  }

  if (Array.isArray(value)) {
    let merged = createResolvedStyleDefinition();
    for (const item of value) {
      const declaration = normalizeStyleDeclaration(
        item,
        options,
        allowTailwind,
      );
      if (!declaration) {
        return null;
      }
      merged = mergeResolvedStyleDefinitions(merged, declaration);
    }
    return merged;
  }

  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value) || isCssVarRef(value)) {
    return null;
  }

  let mergedDeclaration: StyleDeclaration = {};
  let tailwindClassNames: string[] | undefined;

  for (const [key, declarationValue] of Object.entries(value)) {
    if (key === "@apply") {
      const declaration = normalizeApplyValue(
        declarationValue,
        options,
        allowTailwind,
      );
      if (!declaration) {
        return null;
      }
      mergedDeclaration = mergeStyleDeclarations(
        mergedDeclaration,
        declaration.declaration,
      );
      tailwindClassNames = [
        ...(tailwindClassNames ?? []),
        ...(declaration.tailwindClassNames ?? []),
      ];
      continue;
    }

    if (key === "@set") {
      const declaration = normalizeSetValue(declarationValue, options);
      if (!declaration) {
        return null;
      }
      mergedDeclaration = mergeStyleDeclarations(
        mergedDeclaration,
        declaration,
      );
      continue;
    }

    if (isStyleLeaf(declarationValue)) {
      const normalizedLeaf = normalizeStyleLeafValue(declarationValue);
      if (normalizedLeaf === null) {
        return null;
      }
      (mergedDeclaration as Record<string, StyleValue>)[key] = normalizedLeaf;
      continue;
    }

    const nested = normalizeStyleDeclaration(
      declarationValue,
      options,
      allowTailwind,
    );
    if (!nested) {
      return null;
    }
    mergedDeclaration[key] = nested.declaration;
    const prefixedTailwind = prefixNestedTailwindClassNames(
      key,
      nested.tailwindClassNames,
    );
    if (prefixedTailwind === null) {
      return null;
    }
    tailwindClassNames = [
      ...(tailwindClassNames ?? []),
      ...(prefixedTailwind ?? []),
    ];
  }

  return createResolvedStyleDefinition(mergedDeclaration, tailwindClassNames);
}

function normalizeStyleSheet(
  value: unknown,
  options: ParseCtOptions,
  allowTailwind = true,
): NormalizedStyleSheet | null {
  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const sheet: NormalizedStyleSheet = {};

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
      const normalizedApply = normalizeApplyValue(
        declaration,
        options,
        allowTailwind,
      );
      if (!normalizedApply) {
        return null;
      }
      continue;
    }
    const normalized = normalizeStyleDeclaration(
      declaration,
      options,
      allowTailwind,
    );
    if (!normalized) {
      return null;
    }
    sheet[key] = normalized;
  }

  return sheet;
}

function toDeclarationStyleSheet(styles: NormalizedStyleSheet): StyleSheet {
  const declarations: StyleSheet = {};
  for (const [key, style] of Object.entries(styles)) {
    declarations[key] = style.declaration;
  }
  return declarations;
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
      if ((varsDeclaration.tailwindClassNames?.length ?? 0) > 0) {
        return null;
      }
      const vars: Record<string, StyleValue> = {};
      for (
        const [name, declarationValue] of Object.entries(
          varsDeclaration.declaration,
        )
      ) {
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
    if ((declaration.tailwindClassNames?.length ?? 0) > 0) {
      return null;
    }
    const vars: Record<string, StyleValue> = {};
    for (
      const [name, declarationValue] of Object.entries(declaration.declaration)
    ) {
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

function toColorSchemeThemeName(scope: string): "default" | "dark" | null {
  const trimmed = scope.trim();
  if (
    trimmed.length === 0 || trimmed === "default" || trimmed === "root" ||
    trimmed === ":root"
  ) {
    return "default";
  }
  return trimmed === "dark" ? "dark" : null;
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

    if (options.themeMode === "color-scheme") {
      const themeName = toColorSchemeThemeName(scope);
      if (themeName === null) {
        return null;
      }

      if (themeName === "default") {
        root.push(vars);
        continue;
      }

      const mediaKey = "@media (prefers-color-scheme: dark)";
      const mediaRule = (global[mediaKey] as
        | Record<string, StyleDeclaration | StyleValue>
        | undefined) ??
        {};
      const currentRoot =
        (mediaRule[":root"] as Record<string, StyleValue> | undefined) ?? {};
      mediaRule[":root"] = { ...currentRoot, ...vars };
      global[mediaKey] = mediaRule as StyleDeclaration;
      continue;
    }

    const selector = toThemeScopeSelector(scope);
    if (selector === null) {
      root.push(vars);
      continue;
    }

    const scopeKey = `@scope (${selector})`;
    const scopeRule = (global[scopeKey] as
      | Record<string, StyleDeclaration | StyleValue>
      | undefined) ??
      {};
    const currentScope =
      (scopeRule[":scope"] as Record<string, StyleValue> | undefined) ?? {};
    scopeRule[":scope"] = { ...currentScope, ...vars };
    global[scopeKey] = scopeRule as StyleDeclaration;
  }

  return { root, global };
}

function normalizeSimpleStyleSheet(
  value: unknown,
  options: ParseCtOptions,
): NormalizedStyleSheet | null {
  const wrappedValue = isPlainObject(value) && SIMPLE_STYLE_KEY in value
    ? (value as Record<string, unknown>)[SIMPLE_STYLE_KEY]
    : value;
  const normalized = normalizeStyleDeclaration(wrappedValue, options, true);
  if (!normalized) {
    return null;
  }

  return {
    [SIMPLE_STYLE_KEY]: normalized,
  };
}

function normalizeSimpleVariantSheet(
  value: unknown,
  options: ParseCtOptions,
): { variant?: VariantSheet; variantGlobal?: VariantGlobalSheet } | null {
  if (isIdentifierReference(value)) {
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const variantSheet: VariantSheet = {};

  for (const [groupName, group] of Object.entries(value)) {
    if (!isPlainObject(group)) {
      return null;
    }

    const normalizedGroup: Record<string, NormalizedStyleSheet> = {};
    for (const [variantName, declaration] of Object.entries(group)) {
      const normalizedVariant = normalizeSimpleStyleSheet(
        declaration,
        options,
      );
      if (!normalizedVariant) {
        return null;
      }
      normalizedGroup[variantName] = normalizedVariant;
    }

    if (Object.keys(normalizedGroup).length > 0) {
      variantSheet[groupName] = normalizedGroup;
    }
  }

  return {
    variant: Object.keys(variantSheet).length > 0 ? variantSheet : undefined,
    variantGlobal: undefined,
  };
}

function normalizeVariantSheet(
  value: unknown,
  base: NormalizedStyleSheet,
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

    const normalizedGroup: Record<string, NormalizedStyleSheet> = {};
    const normalizedGlobalGroup: Record<string, StyleSheet> = {};

    for (const [variantName, variant] of Object.entries(group)) {
      if (!isPlainObject(variant)) {
        return null;
      }

      const normalizedVariant: NormalizedStyleSheet = {};
      const normalizedGlobalVariant: StyleSheet = {};
      const quotedKeys = getQuotedKeys(variant);

      for (const [key, declaration] of Object.entries(variant)) {
        const normalizedDeclaration = normalizeStyleDeclaration(
          declaration,
          options,
          true,
        );
        if (!normalizedDeclaration) {
          return null;
        }

        if (quotedKeys.has(key)) {
          if ((normalizedDeclaration.tailwindClassNames?.length ?? 0) > 0) {
            return null;
          }
          normalizedGlobalVariant[key] = normalizedDeclaration.declaration;
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
    if (typeof variantName !== "string" && typeof variantName !== "boolean") {
      return null;
    }
    const normalizedVariantName = String(variantName);
    if (variants) {
      const group = variants[groupName];
      if (!group || !(normalizedVariantName in group)) {
        return null;
      }
    }
    selection[groupName] = variantName;
  }

  return selection;
}

/**
 * Validate and normalize a parsed config object into a {@link CtConfig}.
 * Allowed top-level keys: `simple`, `global`, `themes`, `root`, `rootVars`,
 * `base`, `variant`, `defaults`.
 * Returns `null` when the input cannot be validated.
 */
export function parseCtConfig(
  value: Record<string, unknown>,
  options: ParseCtOptions = {},
): CtConfig | null {
  const allowed = new Set([
    "simple",
    "global",
    "themes",
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

  const simple = value.simple === true;
  if ("simple" in value && typeof value.simple !== "boolean") {
    return null;
  }

  let global: StyleSheet | undefined;
  let root: RootVarEntry[] | undefined;
  let base: NormalizedStyleSheet = {};
  let variant: VariantSheet | undefined;
  let variantGlobal: VariantGlobalSheet | undefined;
  let defaults: VariantSelection | undefined;
  const rootEntries: RootVarEntry[] = [];

  if ("themes" in value) {
    const normalizedThemes = normalizeImportedThemes(
      value.themes,
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
    const normalized = normalizeStyleSheet(value.global, parseOptions, false);
    if (!normalized) {
      return null;
    }
    global = {
      ...(global ?? {}),
      ...toDeclarationStyleSheet(normalized),
    };
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
    const normalized = simple
      ? normalizeSimpleStyleSheet(value.base, parseOptions)
      : normalizeStyleSheet(value.base, parseOptions, true);
    if (!normalized) {
      return null;
    }
    base = normalized;
  }

  if ("variant" in value) {
    const normalized = simple
      ? normalizeSimpleVariantSheet(value.variant, parseOptions)
      : normalizeVariantSheet(value.variant, base, parseOptions);
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
    simple,
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

export function parseCtBuilderOptions(
  value: unknown,
): { simple: boolean } | null {
  if (value === undefined) {
    return { simple: false };
  }

  if (!isPlainObject(value)) {
    return null;
  }

  for (const key of Object.keys(value)) {
    if (key !== "simple") {
      return null;
    }
  }

  if ("simple" in value && typeof value.simple !== "boolean") {
    return null;
  }

  return { simple: value.simple === true };
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

  if (isFontCallReference(value)) {
    const resolvedFamilies = resolveParsedValue(
      value.families,
      resolveIdentifier,
      keepUnresolvedIdentifiers,
    );
    if (resolvedFamilies === UNRESOLVED || !Array.isArray(resolvedFamilies)) {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
    if (!resolvedFamilies.every((entry) => typeof entry === "string")) {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
    try {
      return font(resolvedFamilies);
    } catch {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
  }

  if (isTailwindCallReference(value)) {
    const resolvedClasses = resolveParsedValue(
      value.classes,
      resolveIdentifier,
      keepUnresolvedIdentifiers,
    );
    if (
      resolvedClasses === UNRESOLVED ||
      (typeof resolvedClasses !== "string" &&
        !(Array.isArray(resolvedClasses) &&
          resolvedClasses.every((entry) => typeof entry === "string")))
    ) {
      return keepUnresolvedIdentifiers ? value : UNRESOLVED;
    }
    try {
      return tw(resolvedClasses);
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
      const remainder = source.slice(cursor).trim();
      if (remainder === "as const") {
        return parsed;
      }
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

function maskStringsAndComments(input: string): string {
  const chars = input.split("");
  let inString: "" | '"' | "'" | "`" = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const next = chars[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        continue;
      }
      chars[i] = " ";
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        chars[i] = " ";
        chars[i + 1] = " ";
        inBlockComment = false;
        i += 1;
        continue;
      }
      if (char !== "\n") {
        chars[i] = " ";
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        if (char !== "\n") {
          chars[i] = " ";
        }
        escaped = false;
        continue;
      }
      if (char === "\\") {
        chars[i] = " ";
        escaped = true;
        continue;
      }
      if (char === inString) {
        chars[i] = " ";
        inString = "";
        continue;
      }
      if (char !== "\n") {
        chars[i] = " ";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      chars[i] = " ";
      chars[i + 1] = " ";
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      chars[i] = " ";
      inString = char;
    }
  }

  return chars.join("");
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
  initializerStart: number;
  initializerEnd: number;
  optionsSource?: string;
  hasStaticOptions: boolean;
  simple: boolean;
  assignments: NewCtAssignment[];
};

function findClosingParenIndex(input: string, openParenIndex: number): number {
  let parenDepth = 0;

  for (let i = openParenIndex; i < input.length; i += 1) {
    const char = input[i];
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Find `const x = new ct(...)` declarations and their subsequent property
 * assignments (`x.base = ...`, `x.global = ...`, `x.root = ...`, etc.) for
 * static extraction.
 */
export function findNewCtDeclarations(code: string): NewCtDeclaration[] {
  const declarations: NewCtDeclaration[] = [];
  const searchable = maskStringsAndComments(code);
  const matcher =
    /\b(const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+ct\s*\(/g;

  for (
    let match = matcher.exec(searchable);
    match;
    match = matcher.exec(searchable)
  ) {
    const varName = match[2];
    const declStart = match.index;
    const initializerStart = searchable.indexOf("new", declStart);
    const openParenIndex = matcher.lastIndex - 1;
    const closeParenIndex = findClosingParenIndex(searchable, openParenIndex);
    if (initializerStart < 0 || closeParenIndex < 0) {
      continue;
    }
    const declEnd = closeParenIndex + 1;
    const optionsSource = code.slice(openParenIndex + 1, closeParenIndex)
      .trim();
    const staticOptionsValue = optionsSource.length > 0
      ? parseStaticExpression(optionsSource)
      : undefined;
    const parsedOptions = parseCtBuilderOptions(staticOptionsValue) ?? {
      simple: false,
    };

    const assignments: NewCtAssignment[] = [];
    const assignmentMatcher = new RegExp(
      `\\b${varName}\\.(base|global|themes|root|rootVars|variant|defaults)\\s*=\\s*`,
      "g",
    );
    assignmentMatcher.lastIndex = declEnd;

    for (
      let aMatch = assignmentMatcher.exec(searchable);
      aMatch;
      aMatch = assignmentMatcher.exec(searchable)
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
      let iMatch = importMatcher.exec(searchable);
      iMatch;
      iMatch = importMatcher.exec(searchable)
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

    declarations.push({
      varName,
      start: declStart,
      initializerStart,
      initializerEnd: declEnd,
      optionsSource: optionsSource.length > 0 ? optionsSource : undefined,
      hasStaticOptions: optionsSource.length === 0 || staticOptionsValue !== null,
      simple: parsedOptions.simple,
      assignments,
    });
  }

  return declarations;
}
