# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow

**Do not stage any changes to git.** You will manually stage any changes before asking me to write the commit message and commit the code.

## Project Overview

**css-ts** is a TypeScript-first CSS object API library with a Vite plugin that extracts static styles to real stylesheets during build. It provides both a runtime API for dynamic styles and compile-time extraction for optimal bundle size.

### Key Characteristics
- **Dual runtime**: Type-safe CSS object API at runtime with compile-time extraction plugin
- **Two declaration styles**: Config-object API (`ct({...})`) and builder API (`new ct()` with property assignment)
- **Multiple environments**: Works with npm, Deno, SvelteKit, and plain Vite projects
- **Static analysis**: Vite plugin performs static extraction with AST parsing
- **Fallback mechanism**: Dynamic expressions fall back to runtime injection when static extraction fails

## Build and Development Commands

The project uses [mise](https://mise.jq.rs/) for task management (configured in `mise.toml`).

### TypeScript Compilation
```bash
mise run build        # Compile src/ → dist/ (runs: deno task build)
```

### Running Tests
```bash
mise run test         # Run all tests (runs: deno task test)
```

To run specific tests:
```bash
deno test --node-modules-dir=auto -A vite_test.ts --filter "test name"
```

### Publishing to JSR
```bash
mise run test_publish # Dry-run publish to JSR registry
mise run publish      # Publish to JSR registry
```

### Python Setup Tool
The `tools/` directory contains a CLI utility for configuring css-ts in projects:
```bash
uv tool install --editable .                          # Install from local repo
uv run css-ts-setup --npm --cwd /path/to/project     # Configure npm project
uv run css-ts-setup --deno --cwd /path/to/project    # Configure Deno project
```

This tool automatically updates vite.config.ts, package.json/deno.json, and installs dependencies.

## Architecture and Code Organization

### Core Modules

#### `src/index.ts` - Public API Entrypoint
Exports the unified `ct` API combining runtime, Vite plugin, and CSS variable utilities. Defines the `Ct` type which includes a construct signature (`new(): CtBuilder`) alongside the original call signature.

#### `src/runtime.ts` - Runtime Style System
Handles style compilation and runtime CSS injection:
- **Core types**: `StyleDeclarationInput`, `StyleSheetInput`, `CtConfig`, `CtBuilder`
- **`compileConfig()`**: Internal helper that normalizes config and builds the accessor object with CSS class name generation, variant class maps, and runtime injection
- **`createCtBuilder()`**: Creates a Proxy-wrapped function for the `new ct()` builder pattern with lazy compilation, config property setters, and direct accessor delegation
- **`ct()`**: The main export — uses `new.target` detection to dispatch between config-object mode (`compileConfig`) and builder mode (`createCtBuilder`)
- **Variant system**: Supports conditional style variants with `VariantSelection` types
- **Runtime injection**: Dynamically injects CSS via `<style>` tags when static extraction fails

#### `src/parser.ts` - Static Analysis Parser
Analyzes JavaScript/TypeScript code to extract static style declarations:
- **AST parsing**: Custom recursive descent parser (not using a library)
- **Module analysis**: Tracks imports and const initializers (`ModuleStaticInfo`)
- **Expression resolution**: Resolves identifier references and imported constants
- **Supported patterns**:
  - Object literals with string/number/`cv()` values
  - Nested pseudo-selectors (`hover`, `before`, `:focus-visible`, etc.)
  - Nested at-rules (`@media`, `@container`)
  - Declaration arrays (merged left-to-right)
  - Named imports from relative and `$lib/` paths
  - Namespace imports with member access (e.g., `import * as S; S.styles`)
- **Key functions**:
  - `findCtCalls()` - Locate all `ct()` calls in source (regex: `/\bct\s*\(/g`)
  - `findNewCtDeclarations()` - Locate `const x = new ct()` declarations and their subsequent property assignments (`x.base = ...`, `x.global = ...`, etc.)
  - `findExpressionTerminator()` - Find where a JS expression ends by tracking balanced brackets, strings, and comments
  - `parseCtCallArguments()` - Extract and parse `ct()` arguments
  - `parseCtConfig()` - Validate a parsed config object (allowed keys: `global`, `base`, `variant`, `defaults`)
  - `parseStaticExpression()` - Recursively parse expressions

#### `src/vite.ts` - Vite Plugin
Integrates with Vite to perform build-time extraction:
- **Virtual module**: Serves `virtual:css-ts/styles.css` containing extracted styles
- **Transform hooks**: Rewrites source files to import the virtual CSS
- **Dual extraction**: Processes both `ct({...})` calls and `new ct()` + assignment patterns
- **Svelte integration**: Injects `<style>` blocks for Svelte components (not just global)
- **Module tracking**: Caches parsed module info (`ModuleStaticInfo`) to avoid re-parsing
- **Resolution**: Handles import resolution for relative paths and `$lib/` aliases
- **Key functions**:
  - `cssTsPlugin()` - Create Vite plugin instance
  - `parseModuleStaticInfo()` - Extract module metadata (imports, const initializers, exports) for resolution
  - `findMatchingBrace()` - Locate CSS rule boundaries
  - `addSvelteStyleBlock()` - Inject Svelte `<style>` blocks
  - `toSvelteGlobalRule()` - Convert CSS rules to Svelte `:global()` syntax

#### `src/shared.ts` - Shared Utilities
Common types and utilities used across modules:
- **Type system**: `StyleValue`, `StyleDeclaration`, `StyleSheet`, `CssVarRef`
- **Class generation**: `createClassName()` - Deterministic hash-based class naming
- **CSS generation**: `toCssRules()`, `toCssGlobalRules()`, `toCssDeclaration()`
- **Formatting**: `camelToKebab()` for property names, `formatStyleValue()` for values
- **CSS variables**: `cv()` creates `CssVarRef` objects with optional fallbacks
- **Hash function**: `hashString()` generates stable fingerprints for class names

### Test File
**`vite_test.ts`** - Deno test suite covering:
- Svelte component transformation and style injection
- Virtual CSS module generation
- CSS variable (`cv()`) formatting
- Parser for static expression extraction (both `ct({...})` and `new ct()` patterns)
- Runtime style compilation and variant selection
- `new ct()` builder: factory access, direct access, variants/defaults
- `new ct()` Vite extraction: base styles, global/variant/defaults sections
- At-rule handling (@media, @container, @layer)

### Python Tooling
**`tools/css_ts_setup.py`** - Project configuration utility using `click` and `rich`:
- Detects npm vs. Deno project layout
- Updates vite.config files (TypeScript/JavaScript)
- Modifies package.json or deno.json
- Installs/updates package references

## Key Design Patterns

### Two Declaration Styles, One Compilation Path

Both APIs ultimately compile through the same `compileConfig()` function:

1. **Config-object**: `ct({ base, global, variant, defaults })` → calls `compileConfig()` immediately
2. **Builder**: `new ct()` → returns a `CtBuilder` Proxy → calls `compileConfig()` lazily on first access

At build time, the Vite plugin transforms **both** patterns into the same precompiled form:
`ct({ base: ..., variant: ... }, { base: { key: "ct_hash" }, variant: { ... } })`

### CtBuilder Proxy Architecture

The builder returned by `new ct()` is a `Proxy` wrapping a plain function:

- **`apply` trap**: Handles `styles()` — compiles config and returns the accessor
- **`set` trap**: Handles `styles.base = {...}` — stores config, invalidates cache
- **`get` trap**: For `base`/`global`/`variant`/`defaults`, returns the stored config value. For any other string key, compiles and delegates to the accessor (enabling `styles.myButton()`)

### Static vs. Dynamic Execution
The architecture has two execution paths:
1. **Build-time**: Parser extracts static `ct()` calls and `new ct()` declarations → CSS rules → virtual module
2. **Runtime**: Non-static expressions fall back to runtime injection in the browser

The Vite plugin uses string-based regex scanning (not a full parser) to identify extractable patterns while maintaining code simplicity.

### Static Extraction of `new ct()` Patterns

The Vite plugin's transform hook runs two extraction passes:

1. **`findCtCalls()`** — scans for `ct({...})` calls
2. **`findNewCtDeclarations()`** — scans for `const x = new ct()` followed by `x.base = ...`, `x.global = ...`, etc.

For `new ct()` patterns, the transform:
- Replaces `const x = new ct()` with `const x = ct({ base: ..., global: ... }, compiledConfig)`
- Blanks out each property assignment statement
- The resulting code is identical to a precompiled config-object call

### Module Resolution
The Vite plugin maintains a cache (`moduleInfoCache`) of parsed module metadata:
- Tracks imports and const declarations per source file via `parseModuleStaticInfo()`
- Uses `IdentifierResolver` to resolve references during parsing
- Handles SvelteKit `$lib/` aliases via path resolution
- Supports namespace imports (`import * as S from "..."`) with member access

### CSS Generation Strategy
- **Class naming**: Deterministic hash-based names (`ct_<hash>`) ensure consistency
- **Rule format**: Compact CSS without whitespace for smaller bundle size
- **Svelte integration**: Special handling to wrap rules in `:global()` for Svelte scoping
- **At-rule nesting**: Preserves `@media` and `@container` structure while wrapping selectors

### Type Safety
- Runtime types are strict (`StyleDeclarationInput`, `CtConfig` generic overloads)
- `CtBuilder` type combines callable signature, config property setters, and accessor intersection
- Variant system enforces variant keys match base stylesheet keys
- Parser maintains type information through recursive descent

## Important Implementation Notes

1. **Parser limitations**: Only handles object literals and simple expressions. Spread operators, dynamic computed properties, and complex expressions are skipped and fall back to runtime.

2. **Import resolution**: The parser specifically handles:
   - Relative imports: `import { x } from "./file"`
   - SvelteKit imports: `import { x } from "$lib/styles"`
   - Namespace imports: `import * as S from "..."`
   But NOT bare package imports in non-npm contexts.

3. **Svelte-specific behavior**:
   - Component styles injected as `<style>` blocks, not global
   - Rules automatically wrapped in `:global()` selector wrapper
   - At-rules like `@media` are kept outside `:global()` for proper nesting

4. **CSS variables**: `cv("--name", fallback)` creates references that serialize to `var(--name, fallback)` with automatic unit formatting for numbers.

5. **Variant defaults**: If a variant group has a default selection, it's applied even when variants object is empty (e.g., `styles().button()` applies defaults).

6. **Declaration arrays**: Arrays in style declarations are merged left-to-right at both compile and runtime, enabling mixin-like composition.

7. **Builder reserved names**: The property names `base`, `global`, `variant`, and `defaults` are reserved on `CtBuilder` instances. Style keys with these names can still be accessed via the factory pattern (`styles().base()`) but not via the direct pattern.

8. **Builder lazy compilation**: `compileConfig()` is only called when the builder is first accessed (via `styles()` or `styles.key()`). Setting a config property after access invalidates the cache, triggering recompilation on next access.

9. **`new ct()` static extraction scope**: The `findNewCtDeclarations()` scanner only detects `const`/`let` declarations and module-level property assignments. Assignments inside conditionals, loops, or functions are not extracted and fall back to runtime.
