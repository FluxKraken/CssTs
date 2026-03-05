const source = `function add(a, b) { return a + b + Number(offset); }`;
const scope = { offset: 5 };

const proxyScope = new Proxy(scope, {
  has(target, key) { return true; },
  get(target, key) {
    if (key in target) return target[key];
    if (key === Symbol.unscopables) return undefined;
    if (typeof key === "string" && key in globalThis) return globalThis[key];
    return key;
  }
});

try {
  const fn = new Function("__scope", `with (__scope) { return (${source}); }`);
  console.log(fn(proxyScope)(2, 3));
} catch (err) {
  console.error(err);
}
