declare module "node:fs" {
  export function existsSync(...args: any[]): boolean;
}

declare module "node:fs/promises" {
  export function access(...args: any[]): Promise<void>;
  export function readFile(...args: any[]): Promise<any>;
  export function writeFile(...args: any[]): Promise<void>;
}

declare module "node:child_process" {
  export function execSync(...args: any[]): unknown;
}

declare module "node:path" {
  const path: {
    join: (...parts: any[]) => string;
    resolve: (...parts: any[]) => string;
    basename: (...args: any[]) => string;
    relative: (...args: any[]) => string;
  };
  export default path;
}

declare module "node:process" {
  const process: {
    argv: string[];
    cwd(): string;
    exit(code?: number): never;
    env: Record<string, string | undefined>;
  };
  export default process;
}

declare const process: {
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  env: Record<string, string | undefined>;
};
