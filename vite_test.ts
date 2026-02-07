import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { cssTsPlugin } from "./src/vite.ts";
import ct from "./src/runtime.ts";
import { findNewCtDeclarations, parseCtCallArguments } from "./src/parser.ts";
import { cv, toCssDeclaration, toCssRules } from "./src/shared.ts";

const VIRTUAL_ID = "\0virtual:css-ts/styles.css";

function asHook(
  hook: unknown,
): (...args: any[]) => unknown {
  if (typeof hook === "function") {
    return hook as (...args: any[]) => unknown;
  }
  if (hook && typeof hook === "object" && "handler" in hook) {
    return (hook as { handler: (...args: any[]) => unknown }).handler;
  }
  throw new Error("Expected plugin hook");
}

Deno.test("injects component CSS for direct ct usage in svelte", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);

  const source =
    `<script lang="ts">\nimport ct from "css-ts";\n` +
    `const styles = ct({ base: { card: { display: "grid", gap: "1rem" } } });\n` +
    `</script>\n\n<div class={styles().card()}>hi</div>`;

  const transformed = transform(source, "/app/src/routes/+page.svelte");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assert(code.includes('import "virtual:css-ts/styles.css";'));
  assert(code.includes("<style>"));
  assertMatch(code, /:global\(\.ct_[a-z0-9]+\)\{display:grid;gap:1rem\}/);
});

Deno.test("svelte style block keeps @media outside :global wrappers", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);

  const source =
    `<script lang="ts">\n` +
    `import ct from "css-ts";\n` +
    `const styles = ct({\n` +
    `  base: {\n` +
    `    container: {\n` +
    `      display: "grid",\n` +
    `      "@media (width < 70rem)": {\n` +
    `        gap: 0,\n` +
    `      },\n` +
    `    },\n` +
    `  }\n` +
    `});\n` +
    `</script>\n\n` +
    `<main class={styles().container()}></main>`;

  const transformed = transform(source, "/app/src/lib/components/Container.svelte");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assert(!code.includes(":global(@media"));
  assertMatch(
    code,
    /@media \(width < 70rem\)\{:global\(\.ct_[a-z0-9]+\)\{gap:0px\}\}/,
  );
});

Deno.test("cv() formats css variable references", () => {
  assertEquals(toCssDeclaration("backgroundColor", cv("--background")), "background-color:var(--background)");
  assertEquals(
    toCssDeclaration("backgroundColor", cv("--background", "#111")),
    "background-color:var(--background, #111)",
  );
  assertEquals(
    toCssDeclaration("padding", cv("--space", 8)),
    "padding:var(--space, 8px)",
  );
  assertEquals(
    toCssDeclaration("fontWeight", cv("--weight", 600)),
    "font-weight:var(--weight, 600)",
  );
});

Deno.test("toCssRules supports nested selectors and nested @media/@container blocks", () => {
  const rules = toCssRules("test", {
    fontSize: "1.25rem",
    ul: {
      display: "flex",
      flexWrap: "wrap",
      gap: "0.5rem",
      "@media (width < 20rem)": {
        ul: { display: "grid" },
      },
      "@container nav (inline-size > 30rem)": {
        "a:hover": { textDecoration: "underline" },
      },
    },
    li: {
      flex: 1,
    },
    hover: {
      opacity: 0.8,
    },
  });

  assert(rules.includes(".test{font-size:1.25rem}"));
  assert(rules.includes(".test ul{display:flex;flex-wrap:wrap;gap:0.5rem}"));
  assert(rules.includes("@media (width < 20rem){.test ul ul{display:grid}}"));
  assert(rules.includes("@container nav (inline-size > 30rem){.test ul a:hover{text-decoration:underline}}"));
  assert(rules.includes(".test li{flex:1}"));
  assert(rules.includes(".test:hover{opacity:0.8}"));
});

Deno.test("parser accepts quoted nested selectors and nested @media/@container", () => {
  const parsed = parseCtCallArguments(`{
    base: {
      mainNavigation: {
        fontSize: "1.25rem",
        "ul": {
          display: "flex",
          "@media (width < 20rem)": {
            "ul": { display: "grid" }
          },
          "@container nav (inline-size > 30rem)": {
            "a:hover": { textDecoration: "underline" }
          }
        }
      }
    }
  }`);

  assert(parsed !== null);
  assertEquals(
    (parsed.base.mainNavigation as Record<string, unknown>).fontSize,
    "1.25rem",
  );
});

Deno.test("parser merges style declaration arrays in ct config", () => {
  const parsed = parseCtCallArguments(`{
    base: {
      myButton: [
        { fontSize: "1.25rem", padding: "1rem" },
        { background: "black", color: "white", padding: "0.5rem" }
      ]
    }
  }`);

  assert(parsed !== null);
  assertEquals(parsed.base.myButton.fontSize, "1.25rem");
  assertEquals(parsed.base.myButton.background, "black");
  assertEquals(parsed.base.myButton.color, "white");
  assertEquals(parsed.base.myButton.padding, "0.5rem");
});

Deno.test("parser accepts defaults variant selections", () => {
  const parsed = parseCtCallArguments(`{
    base: {
      myButton: {}
    },
    variant: {
      size: {
        sm: { myButton: { fontSize: "0.8rem" } },
        md: { myButton: { fontSize: "1rem" } }
      }
    },
    defaults: {
      size: "md"
    }
  }`);

  assert(parsed !== null);
  assertEquals(parsed.defaults, { size: "md" });
});

Deno.test("injects virtual stylesheet import in svelte files that only import ct styles", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);

  const source = `<script lang="ts">\nimport { styles } from "./styles.ts";\n</script>\n\n<div class={styles().card()}>hi</div>`;

  const transformed = transform(source, "/app/src/routes/+page.svelte");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assert(code.includes('<script lang="ts">\nimport "virtual:css-ts/styles.css";'));
});

Deno.test("extracts css from ts module and serves it through the virtual stylesheet", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `export const styles = ct({ base: { card: { display: "grid", gap: "1rem" } } });`;
  const transformed = transform(moduleCode, "/app/src/lib/styles.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const loaded = load(VIRTUAL_ID);
  assertEquals(typeof loaded, "string");
  assertMatch(loaded as string, /\.ct_[a-z0-9]+\{display:grid;gap:1rem\}/);
});

Deno.test("extracts merged declaration arrays at build time", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `export const styles = ct({\n` +
    `  base: {\n` +
    `    myButton: [\n` +
    `      { fontSize: "1.25rem", padding: "1rem" },\n` +
    `      { background: "black", color: "white", padding: "0.5rem" },\n` +
    `    ]\n` +
    `  }\n` +
    `});`;
  const transformed = transform(moduleCode, "/app/src/lib/array-styles.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const css = load(VIRTUAL_ID) as string;
  assertMatch(
    css,
    /\.ct_[a-z0-9]+\{font-size:1\.25rem;padding:0\.5rem;background:black;color:white\}/,
  );
});

Deno.test("resolves imported style objects and precompiles them", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const root = Deno.makeTempDirSync();

  try {
    const libDir = `${root}/src/lib`;
    Deno.mkdirSync(libDir, { recursive: true });
    Deno.writeTextFileSync(
      `${libDir}/styles.ts`,
      `export const commonColors = {\n` +
        `  background: "black",\n` +
        `  color: "white",\n` +
        `};\n` +
        `export const buttonStyles = {\n` +
        `  fontSize: "1.25rem",\n` +
        `  fontWeight: 600,\n` +
        `  padding: "1rem",\n` +
        `};\n`,
    );

    const moduleCode =
      `import ct from "css-ts";\n` +
      `import { buttonStyles, commonColors } from "$lib/styles";\n` +
      `export const styles = ct({\n` +
      `  base: {\n` +
      `    myButton: [buttonStyles, commonColors]\n` +
      `  },\n` +
      `  variant: {\n` +
      `    size: {\n` +
      `      lg: { myButton: { fontSize: "2rem" } }\n` +
      `    }\n` +
      `  }\n` +
      `});`;
    const transformed = transform(moduleCode, `${root}/src/routes/+page.ts`);
    assert(transformed && typeof transformed === "object" && "code" in transformed);

    const css = load(VIRTUAL_ID) as string;
    assertMatch(css, /\.ct_[a-z0-9]+\{font-size:1\.25rem;font-weight:600;padding:1rem;background:black;color:white\}/);
    assertMatch(css, /\.ct_[a-z0-9]+\{font-size:2rem\}/);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("resolves namespace-imported style objects and precompiles them", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const root = Deno.makeTempDirSync();

  try {
    const libDir = `${root}/src/lib`;
    Deno.mkdirSync(libDir, { recursive: true });
    Deno.writeTextFileSync(
      `${libDir}/styles.ts`,
      `export const darkBar = {\n` +
        `  backgroundColor: "oklch(from #00aaff 20% c h)",\n` +
        `  color: "white",\n` +
        `};\n` +
        `export const lightBar = {\n` +
        `  backgroundColor: "black",\n` +
        `  color: "white",\n` +
        `};\n`,
    );

    const moduleCode =
      `import ct from "css-ts";\n` +
      `import * as S from "$lib/styles";\n` +
      `export const styles = ct({\n` +
      `  base: {\n` +
      `    mainHeader: { display: "grid" }\n` +
      `  },\n` +
      `  variant: {\n` +
      `    theme: {\n` +
      `      dark: { mainHeader: [S.darkBar] },\n` +
      `      light: { mainHeader: [S.lightBar] }\n` +
      `    }\n` +
      `  }\n` +
      `});`;
    const transformed = transform(moduleCode, `${root}/src/routes/Header.ts`);
    assert(transformed && typeof transformed === "object" && "code" in transformed);

    const css = load(VIRTUAL_ID) as string;
    assertMatch(css, /\.ct_[a-z0-9]+\{background-color:oklch\(from #00aaff 20% c h\);color:white\}/);
    assertMatch(css, /\.ct_[a-z0-9]+\{background-color:black;color:white\}/);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("extracts quoted nested selectors and nested @media/@container at build time", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `export const styles = ct({\n` +
    `  base: {\n` +
    `    mainNavigation: {\n` +
    `      fontSize: "1.25rem",\n` +
    `      "ul": {\n` +
    `        display: "flex",\n` +
    `        "@media (width < 20rem)": {\n` +
    `          "ul": { display: "grid" }\n` +
    `        },\n` +
    `        "@container nav (inline-size > 30rem)": {\n` +
    `          "a:hover": { textDecoration: "underline" }\n` +
    `        }\n` +
    `      }\n` +
    `    }\n` +
    `  }\n` +
    `});`;
  const transformed = transform(moduleCode, "/app/src/lib/nested.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const loaded = load(VIRTUAL_ID);
  assertEquals(typeof loaded, "string");
  const css = loaded as string;
  assertMatch(css, /\.ct_[a-z0-9]+\{font-size:1\.25rem\}/);
  assertMatch(css, /\.ct_[a-z0-9]+ ul\{display:flex\}/);
  assertMatch(css, /@media \(width < 20rem\)\{\.ct_[a-z0-9]+ ul ul\{display:grid\}\}/);
  assertMatch(
    css,
    /@container nav \(inline-size > 30rem\)\{\.ct_[a-z0-9]+ ul a:hover\{text-decoration:underline\}\}/,
  );
});

Deno.test("does not trigger a websocket full-reload during transform", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const configureServer = asHook(plugin.configureServer);

  configureServer({
    moduleGraph: {
      getModuleById: () => ({}),
      invalidateModule: () => {},
    },
    ws: {
      send: (payload: { type?: string }) => {
        if (payload?.type === "full-reload") {
          throw new Error("unexpected full reload");
        }
      },
    },
  });

  const moduleCode =
    `import ct from "css-ts";\nexport const styles = ct({ base: { card: { display: "grid" } } });`;
  const transformed = transform(moduleCode, "/app/src/lib/no-reload.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);
});

Deno.test("extracts cv() CSS variable usage at build time", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct, { cv } from "css-ts";\n` +
    `export const styles = ct({ base: { card: { backgroundColor: cv("--background") } } });`;
  const transformed = transform(moduleCode, "/app/src/lib/vars.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const loaded = load(VIRTUAL_ID);
  assertEquals(typeof loaded, "string");
  assertMatch(loaded as string, /\.ct_[a-z0-9]+\{background-color:var\(--background\)\}/);
});

Deno.test("extracts cv() numeric fallback with property-aware units", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct, { cv } from "css-ts";\n` +
    `export const styles = ct({\n` +
    `  base: {\n` +
    `    card: { padding: cv("--space", 8), fontWeight: cv("--weight", 600) }\n` +
    `  }\n` +
    `});`;
  const transformed = transform(moduleCode, "/app/src/lib/vars-fallback.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const loaded = load(VIRTUAL_ID);
  assertEquals(typeof loaded, "string");
  assertMatch(
    loaded as string,
    /\.ct_[a-z0-9]+\{padding:var\(--space, 8px\);font-weight:var\(--weight, 600\)\}/,
  );
});

Deno.test("extracts variant styles and compiles variant class maps", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `export const styles = ct({\n` +
    `  base: {\n` +
    `    headerText: { display: "grid" },\n` +
    `    mainHeader: {},\n` +
    `  },\n` +
    `  variant: {\n` +
    `    theme: {\n` +
    `      red: { headerText: { backgroundColor: "red" } },\n` +
    `    },\n` +
    `  },\n` +
    `});`;
  const transformed = transform(moduleCode, "/app/src/lib/variants.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assertMatch(code, /variant/);

  const loaded = load(VIRTUAL_ID);
  assertEquals(typeof loaded, "string");
  const css = loaded as string;
  assertMatch(css, /\.ct_[a-z0-9]+\{display:grid\}/);
  assertMatch(css, /\.ct_[a-z0-9]+\{background-color:red\}/);
});

Deno.test("extracts css when defaults are present in ct config", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `export const styles = ct({\n` +
    `  base: {\n` +
    `    myButton: { padding: "1rem" }\n` +
    `  },\n` +
    `  variant: {\n` +
    `    size: {\n` +
    `      sm: { myButton: { fontSize: "0.8rem" } },\n` +
    `      md: { myButton: { fontSize: "1rem" } }\n` +
    `    }\n` +
    `  },\n` +
    `  defaults: {\n` +
    `    size: "md"\n` +
    `  }\n` +
    `});`;
  const transformed = transform(moduleCode, "/app/src/lib/default-variants.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assertMatch(code, /defaults/);

  const css = load(VIRTUAL_ID) as string;
  assertMatch(css, /\.ct_[a-z0-9]+\{padding:1rem\}/);
  assertMatch(css, /\.ct_[a-z0-9]+\{font-size:0\.8rem\}/);
  assertMatch(css, /\.ct_[a-z0-9]+\{font-size:1rem\}/);
});

Deno.test("runtime applies defaults to variant selection and allows overrides", () => {
  const styles = ct({
    base: {
      myButton: { padding: "1rem", fontSize: "1rem" },
    },
    variant: {
      size: {
        sm: { myButton: { fontSize: "0.8rem" } },
        md: { myButton: { fontSize: "1rem" } },
      },
    },
    defaults: {
      size: "md",
    },
  } as any);

  const withDefaults = styles().myButton();
  assertEquals(withDefaults, styles().myButton({}));
  assertEquals(withDefaults, styles().myButton({ size: "md" }));
  assert(withDefaults !== styles().myButton({ size: "sm" }));
});

Deno.test("runtime works without a document global", () => {
  const globals = globalThis as Record<string, unknown>;
  const originalDocument = globals.document;
  if (originalDocument !== undefined) {
    delete globals.document;
  }

  try {
    const styles = ct({ base: { card: { display: "grid", gap: "1rem" } } });
    const className = styles().card();
    assertMatch(className, /^ct_[a-z0-9]+$/);
  } finally {
    if (originalDocument !== undefined) {
      globals.document = originalDocument;
    } else {
      delete globals.document;
    }
  }
});

Deno.test("extracts global section rules at build time", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `export const styles = ct({\n` +
    `  global: {\n` +
    `    "@layer reset": {\n` +
    `      "html": { scrollBehavior: "smooth" }\n` +
    `    }\n` +
    `  },\n` +
    `  base: {\n` +
    `    card: { display: "grid" }\n` +
    `  }\n` +
    `});`;
  const transformed = transform(moduleCode, "/app/src/lib/global.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const css = load(VIRTUAL_ID) as string;
  assertMatch(css, /@layer reset\{html\{scroll-behavior:smooth\}\}/);
  assertMatch(css, /\.ct_[a-z0-9]+\{display:grid\}/);
});

// --- new ct() builder tests ---

Deno.test("new ct() runtime with factory access pattern", () => {
  const styles = new (ct as any)();
  styles.base = {
    myButton: {
      backgroundColor: "black",
      color: "white",
      fontSize: "1.25rem",
    },
  };

  const className = styles().myButton();
  assertMatch(className, /^ct_[a-z0-9]+$/);
});

Deno.test("new ct() runtime with direct accessor access", () => {
  const styles = new (ct as any)();
  styles.base = {
    myButton: {
      backgroundColor: "black",
      color: "white",
    },
  };

  const viaFactory = styles().myButton();
  const viaDirect = styles.myButton();
  assertEquals(viaFactory, viaDirect);
});

Deno.test("new ct() runtime with variants and defaults", () => {
  const styles = new (ct as any)();
  styles.base = {
    myButton: { padding: "1rem", fontSize: "1rem" },
  };
  styles.variant = {
    size: {
      sm: { myButton: { fontSize: "0.8rem" } },
      md: { myButton: { fontSize: "1rem" } },
    },
  };
  styles.defaults = { size: "md" };

  const withDefaults = styles().myButton();
  assertEquals(withDefaults, styles().myButton({}));
  assertEquals(withDefaults, styles().myButton({ size: "md" }));
  assert(withDefaults !== styles().myButton({ size: "sm" }));
});

Deno.test("parser findNewCtDeclarations detects new ct() pattern", () => {
  const code = `import ct from "css-ts";
const styles = new ct();
styles.base = { myButton: { backgroundColor: "black" } };
styles.global = { html: { margin: 0 } };`;

  const decls = findNewCtDeclarations(code);
  assertEquals(decls.length, 1);
  assertEquals(decls[0].varName, "styles");
  assertEquals(decls[0].assignments.length, 2);
  assertEquals(decls[0].assignments[0].property, "base");
  assertEquals(decls[0].assignments[1].property, "global");
});

Deno.test("vite extracts css from new ct() pattern", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `const styles = new ct();\n` +
    `styles.base = { card: { display: "grid", gap: "1rem" } };\n`;
  const transformed = transform(moduleCode, "/app/src/lib/new-ct.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assert(!code.includes("new ct()"));

  const css = load(VIRTUAL_ID) as string;
  assertMatch(css, /\.ct_[a-z0-9]+\{display:grid;gap:1rem\}/);
});

Deno.test("vite extracts new ct() with variants and global", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `const styles = new ct();\n` +
    `styles.global = { "@layer reset": { "html": { scrollBehavior: "smooth" } } };\n` +
    `styles.base = { card: { display: "grid" } };\n` +
    `styles.variant = { theme: { dark: { card: { backgroundColor: "black" } } } };\n` +
    `styles.defaults = { theme: "dark" };\n`;
  const transformed = transform(moduleCode, "/app/src/lib/new-ct-full.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const css = load(VIRTUAL_ID) as string;
  assertMatch(css, /@layer reset\{html\{scroll-behavior:smooth\}\}/);
  assertMatch(css, /\.ct_[a-z0-9]+\{display:grid\}/);
  assertMatch(css, /\.ct_[a-z0-9]+\{background-color:black\}/);
});
