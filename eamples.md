# css.config.ts Examples

This project now supports a root-level `css.config.ts` file for global CSS concerns.

## Quick Start

Create `/css.config.ts`:

```ts
import "./src/global.css";

export default {
  imports: ["./src/theme.css"],
  breakpoints: {
    sm: "40rem",
    md: "48rem",
    lg: "64rem",
  },
  utilities: {
    cardBase: {
      borderRadius: "0.75rem",
      padding: "1rem",
      backgroundColor: "#4f4f4f",
      color: "black",
    },
  },
};
```

## Feature: Global stylesheet imports

Two supported ways:

1. Side-effect imports in `css.config.ts`
```ts
import "./src/global.css";
```

2. `imports` array on default export
```ts
export default {
  imports: ["./src/theme.css"],
};
```

Both are emitted into the virtual CSS bundle as `@import` rules.

## Feature: Breakpoint aliases

Define aliases in `breakpoints`:

```ts
export default {
  breakpoints: {
    md: "48rem",
  },
};
```

Use alias in style objects with `@<name>`:

```ts
import ct from "@kt-tools/css-ts";

const styles = ct({
  base: {
    pageWrapper: {
      display: "grid",
      "@md": {
        gridTemplateColumns: "1fr 1fr",
      },
    },
  },
});
```

`"@md"` expands to:
```css
@media (width >= 48rem) { ... }
```

If an alias is not found, it remains a normal at-rule key.

## Feature: Global utility classes

Define shared declarations in `utilities`:

```ts
export default {
  utilities: {
    cardBase: {
      borderRadius: "0.75rem",
      padding: "1rem",
    },
    mutedText: {
      color: "#666",
      fontSize: "0.875rem",
    },
  },
};
```

Generated classes:

- `cardBase` -> `.u-card-base`
- `mutedText` -> `.u-muted-text`

These are emitted globally in the virtual stylesheet.

## Feature: `@apply` merge list inside class declarations

`@apply` merges declarations in order (left-to-right for arrays, top-to-bottom in object flow).

```ts
import ct from "@kt-tools/css-ts";

const baseColors = {
  backgroundColor: "#4f4f4f",
  color: "black",
};

const singleColumn = {
  gridTemplateRows: ["auto", "1fr", "auto"],
};

const styles = ct({
  base: {
    pageWrapper: {
      display: "grid",
      "@apply": [baseColors, singleColumn],
      color: "#00aaff", // overrides baseColors.color
    },
  },
});
```

`@apply` accepts:

- declaration objects
- arrays of declaration objects
- utility names from `css.config.ts`:

```ts
const styles = ct({
  base: {
    pageWrapper: {
      "@apply": ["cardBase"],
      display: "grid",
    },
  },
});
```

## Feature: Space-delimited property arrays

Property arrays serialize to space-delimited CSS values:

```ts
const styles = ct({
  base: {
    pageWrapper: {
      display: "grid",
      gridTemplateRows: ["auto", "1fr", "auto"],
    },
  },
});
```

Output:
```css
grid-template-rows: auto 1fr auto;
```

## Notes

- `css.config.ts` is loaded from project root.
- Supported config filenames: `css.config.ts`, `.mts`, `.js`, `.mjs`, `.cts`, `.cjs`.
- Current breakpoint shorthand is `@alias` (for example `@md`), mapped to `@media (width >= value)`.
