import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { cssTsPlugin } from "./src/vite.ts";
import ct from "./src/runtime.ts";
import { parseCtCallArguments } from "./src/parser.ts";
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

  const source = `<script lang="ts">\nimport ct from "css-ts";\nconst styles = ct({ card: { display: "grid", gap: "1rem" } });\n</script>\n\n<div class={styles().card()}>hi</div>`;

  const transformed = transform(source, "/app/src/routes/+page.svelte");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assert(code.includes('import "virtual:css-ts/styles.css";'));
  assert(code.includes("<style>"));
  assertMatch(code, /:global\(\.ct_[a-z0-9]+\)\{display:grid;gap:1rem\}/);
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
  }`);

  assert(parsed !== null);
  assertEquals(
    (parsed.base.mainNavigation as Record<string, unknown>).fontSize,
    "1.25rem",
  );
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

  const moduleCode = `import ct from "css-ts";\nexport const styles = ct({ card: { display: "grid", gap: "1rem" } });`;
  const transformed = transform(moduleCode, "/app/src/lib/styles.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const loaded = load(VIRTUAL_ID);
  assertEquals(typeof loaded, "string");
  assertMatch(loaded as string, /\.ct_[a-z0-9]+\{display:grid;gap:1rem\}/);
});

Deno.test("extracts quoted nested selectors and nested @media/@container at build time", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct from "css-ts";\n` +
    `export const styles = ct({\n` +
    `  mainNavigation: {\n` +
    `    fontSize: "1.25rem",\n` +
    `    "ul": {\n` +
    `      display: "flex",\n` +
    `      "@media (width < 20rem)": {\n` +
    `        "ul": { display: "grid" }\n` +
    `      },\n` +
    `      "@container nav (inline-size > 30rem)": {\n` +
    `        "a:hover": { textDecoration: "underline" }\n` +
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

  const moduleCode = `import ct from "css-ts";\nexport const styles = ct({ card: { display: "grid" } });`;
  const transformed = transform(moduleCode, "/app/src/lib/no-reload.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);
});

Deno.test("extracts cv() CSS variable usage at build time", () => {
  const plugin = cssTsPlugin();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const moduleCode =
    `import ct, { cv } from "css-ts";\n` +
    `export const styles = ct({ card: { backgroundColor: cv("--background") } });`;
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
    `export const styles = ct({ card: { padding: cv("--space", 8), fontWeight: cv("--weight", 600) } });`;
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
    `  headerText: { display: "grid" },\n` +
    `  mainHeader: {},\n` +
    `}, {\n` +
    `  variant: {\n` +
    `    red: { headerText: { backgroundColor: "red" } },\n` +
    `  },\n` +
    `});`;
  const transformed = transform(moduleCode, "/app/src/lib/variants.ts");
  assert(transformed && typeof transformed === "object" && "code" in transformed);

  const code = transformed.code as string;
  assertMatch(code, /variants/);

  const loaded = load(VIRTUAL_ID);
  assertEquals(typeof loaded, "string");
  const css = loaded as string;
  assertMatch(css, /\.ct_[a-z0-9]+\{display:grid\}/);
  assertMatch(css, /\.ct_[a-z0-9]+\{background-color:red\}/);
});

Deno.test("runtime works without a document global", () => {
  const globals = globalThis as Record<string, unknown>;
  const originalDocument = globals.document;
  if (originalDocument !== undefined) {
    delete globals.document;
  }

  try {
    const styles = ct({ card: { display: "grid", gap: "1rem" } });
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
