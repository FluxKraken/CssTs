#!/usr/bin/env python3
"""
Configure @kt-tools/css-ts for SvelteKit + Vite projects.

This tool supports npm-based and Deno-based project layouts.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import click
from rich.console import Console

Mode = Literal["deno", "npm"]

README_VERSIONS = {
    "kit": "^2.50.2",
    "vite_plugin_svelte": "^6.2.4",
    "svelte": "^5.49.2",
    "vite": "^7.3.1",
}

VITE_CONFIG_CANDIDATES = (
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.mts",
    "vite.config.cjs",
)

DENO_CONFIG_CANDIDATES = ("deno.json", "deno.jsonc")

console = Console()


@dataclass
class UpdateResult:
    changed: bool = False
    notes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def strip_json_comments(value: str) -> str:
    output: list[str] = []
    in_string = False
    in_single = False
    in_multi = False
    i = 0

    while i < len(value):
        char = value[i]
        nxt = value[i + 1] if i + 1 < len(value) else ""

        if in_single:
            if char == "\n":
                in_single = False
                output.append(char)
            i += 1
            continue

        if in_multi:
            if char == "*" and nxt == "/":
                in_multi = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if char == "\\" and nxt:
                output.append(char)
                output.append(nxt)
                i += 2
                continue
            if char == '"':
                in_string = False
            output.append(char)
            i += 1
            continue

        if char == '"':
            in_string = True
            output.append(char)
            i += 1
            continue

        if char == "/" and nxt == "/":
            in_single = True
            i += 2
            continue

        if char == "/" and nxt == "*":
            in_multi = True
            i += 2
            continue

        output.append(char)
        i += 1

    return "".join(output)


def parse_json_like(value: str) -> dict[str, object]:
    return json.loads(strip_json_comments(value))


def find_first(root: Path, candidates: tuple[str, ...]) -> Path | None:
    for name in candidates:
        candidate = root / name
        if candidate.exists():
            return candidate
    return None


def ensure_object(target: dict[str, object], key: str) -> dict[str, str]:
    current = target.get(key)
    if not isinstance(current, dict):
        target[key] = {}
    return target[key]  # type: ignore[return-value]


def insert_import(source: str, import_line: str) -> str:
    matches = list(re.finditer(r"^import[^;\n]*;?\s*$", source, flags=re.MULTILINE))
    if not matches:
        return f"{import_line}\n{source}"
    last = matches[-1]
    return f"{source[: last.end()]}\n{import_line}{source[last.end() :]}"


def read_css_ts_specifier() -> str:
    deno_json = Path(__file__).resolve().parents[1] / "deno.json"
    try:
        parsed = json.loads(deno_json.read_text(encoding="utf-8"))
        version = parsed.get("version")
        if isinstance(version, str) and version:
            return f"npm:@jsr/kt-tools__css-ts@^{version}"
    except Exception:
        pass
    return "npm:@jsr/kt-tools__css-ts"


def update_deno_config(root: Path) -> UpdateResult:
    result = UpdateResult()
    deno_path = find_first(root, DENO_CONFIG_CANDIDATES)
    if not deno_path:
        result.warnings.append("No deno.json/deno.jsonc found. Skipped Deno import map updates.")
        return result

    original = deno_path.read_text(encoding="utf-8")
    try:
        config = parse_json_like(original)
    except Exception:
        result.warnings.append(f"Failed to parse {deno_path.name}. Skipped import map updates.")
        return result

    imports = ensure_object(config, "imports")
    required_imports = {
        "@kt-tools/css-ts": read_css_ts_specifier(),
        "@sveltejs/kit": f"npm:@sveltejs/kit@{README_VERSIONS['kit']}",
        "@sveltejs/vite-plugin-svelte": f"npm:@sveltejs/vite-plugin-svelte@{README_VERSIONS['vite_plugin_svelte']}",
        "svelte": f"npm:svelte@{README_VERSIONS['svelte']}",
        "vite": f"npm:vite@{README_VERSIONS['vite']}",
    }

    changed = False
    for key, value in required_imports.items():
        if key not in imports:
            imports[key] = value
            changed = True

    if config.get("nodeModulesDir") != "auto":
        config["nodeModulesDir"] = "auto"
        changed = True

    if changed:
        deno_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        result.changed = True
        result.notes.append(f"Updated {deno_path.name} with import map entries and nodeModulesDir.")
        if deno_path.suffix == ".jsonc":
            result.warnings.append(f"Rewrote {deno_path.name} as JSON (comments removed).")

    return result


def update_package_json(root: Path) -> UpdateResult:
    result = UpdateResult()
    pkg_path = root / "package.json"
    if not pkg_path.exists():
        result.warnings.append("No package.json found. Skipped npm dependency updates.")
        return result

    try:
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    except Exception:
        result.warnings.append("Failed to parse package.json. Skipped dependency updates.")
        return result

    deps = ensure_object(pkg, "dependencies")
    if "@kt-tools/css-ts" not in deps:
        deps["@kt-tools/css-ts"] = read_css_ts_specifier()
        pkg_path.write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8")
        result.changed = True
        result.notes.append("Added @kt-tools/css-ts to dependencies in package.json.")

    return result


def update_vite_config(root: Path, deno_mode: bool) -> UpdateResult:
    result = UpdateResult()
    vite_path = find_first(root, VITE_CONFIG_CANDIDATES)
    if not vite_path:
        result.warnings.append("No vite.config file found. Skipped Vite plugin updates.")
        return result

    updated = vite_path.read_text(encoding="utf-8")
    changed = False

    if "@kt-tools/css-ts" not in updated:
        updated = insert_import(updated, 'import ct from "@kt-tools/css-ts";')
        changed = True

    if "ct.vite" not in updated:
        replaced = re.sub(r"sveltekit\s*\(\s*\)", "ct.vite(), sveltekit()", updated, count=1)
        if replaced != updated:
            updated = replaced
            changed = True
        elif re.search(r"plugins\s*:\s*\[", updated):
            updated = re.sub(r"plugins\s*:\s*\[", "plugins: [ct.vite(), ", updated, count=1)
            changed = True
        else:
            result.warnings.append("Could not find a plugins array in vite.config. Add ct.vite() manually.")

    if deno_mode and "@jsr/kt-tools__css-ts" not in updated:
        alias_snippet = (
            "  resolve: {\n"
            "    alias: {\n"
            '      "@kt-tools/css-ts": "@jsr/kt-tools__css-ts",\n'
            "    },\n"
            "  },\n"
        )
        if re.search(r"resolve\s*:\s*{", updated):
            if re.search(r"alias\s*:\s*{", updated):
                updated = re.sub(
                    r"alias\s*:\s*{",
                    'alias: {\n      "@kt-tools/css-ts": "@jsr/kt-tools__css-ts",',
                    updated,
                    count=1,
                )
                changed = True
            else:
                updated = re.sub(
                    r"resolve\s*:\s*{",
                    'resolve: {\n    alias: {\n      "@kt-tools/css-ts": "@jsr/kt-tools__css-ts",\n    },',
                    updated,
                    count=1,
                )
                changed = True
        else:
            define_match = re.search(r"defineConfig\(\s*{", updated)
            if define_match:
                insert_pos = define_match.end()
                updated = f"{updated[:insert_pos]}\n{alias_snippet}{updated[insert_pos:]}"
                changed = True
            else:
                result.warnings.append("Could not insert Vite resolve.alias entry. Add it manually.")

    if changed:
        vite_path.write_text(updated, encoding="utf-8")
        result.changed = True
        result.notes.append(f"Updated {vite_path.name} with CSS-TS Vite plugin configuration.")

    return result


def detect_package_manager(root: Path) -> Literal["pnpm", "yarn", "bun", "npm"]:
    if (root / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (root / "yarn.lock").exists():
        return "yarn"
    if (root / "bun.lockb").exists():
        return "bun"
    return "npm"


def run_command(command: list[str], cwd: Path) -> bool:
    try:
        subprocess.run(command, cwd=str(cwd), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False


def run_package_install(root: Path) -> bool:
    if not (root / "package.json").exists():
        return False
    pm = detect_package_manager(root)
    if pm == "pnpm":
        cmd = ["npx", "--yes", "jsr", "add", "--pnpm", "@kt-tools/css-ts"]
    elif pm == "yarn":
        cmd = ["npx", "--yes", "jsr", "add", "--yarn", "@kt-tools/css-ts"]
    elif pm == "bun":
        cmd = ["npx", "--yes", "jsr", "add", "--bun", "@kt-tools/css-ts"]
    else:
        cmd = ["npx", "--yes", "jsr", "add", "--npm", "@kt-tools/css-ts"]
    return run_command(cmd, root)


def run_deno_add(root: Path) -> bool:
    return run_command(["deno", "add", "jsr:@kt-tools/css-ts"], root)


def resolve_mode(root: Path, requested_mode: Mode | None) -> Mode | None:
    if requested_mode:
        return requested_mode

    has_deno = (root / "deno.json").exists() or (root / "deno.jsonc").exists()
    has_package = (root / "package.json").exists()

    if has_deno and not has_package:
        return "deno"
    if has_package:
        return "npm"
    if has_deno:
        return "deno"
    return None


@click.command(context_settings={"help_option_names": ["-h", "--help"]})
@click.option("--deno", "deno_mode", is_flag=True, help="Configure for SvelteKit + Deno + Vite.")
@click.option("--npm", "npm_mode", is_flag=True, help="Configure for SvelteKit + npm + Vite.")
@click.option("--no-install", is_flag=True, help="Skip dependency installation.")
@click.option(
    "--cwd",
    type=click.Path(file_okay=False, dir_okay=True, path_type=Path),
    default=lambda: Path.cwd(),
    show_default=True,
    help="Run in a specific project directory.",
)
def cli(deno_mode: bool, npm_mode: bool, no_install: bool, cwd: Path) -> None:
    """Setup helper for @kt-tools/css-ts projects."""
    if deno_mode and npm_mode:
        raise click.ClickException("Choose either --deno or --npm, not both.")

    requested_mode: Mode | None = "deno" if deno_mode else "npm" if npm_mode else None
    root = cwd.resolve()

    mode = resolve_mode(root, requested_mode)
    if mode is None:
        raise click.ClickException(
            "Could not determine project type (no package.json or deno.json found). Use --npm or --deno."
        )

    summary: list[str] = []
    warnings: list[str] = []

    if mode == "deno":
        for result in (update_deno_config(root), update_vite_config(root, deno_mode=True)):
            if result.changed:
                summary.extend(result.notes)
            warnings.extend(result.warnings)
        if not no_install and run_deno_add(root):
            summary.append("Installed @kt-tools/css-ts via deno add.")
    else:
        for result in (update_package_json(root), update_vite_config(root, deno_mode=False)):
            if result.changed:
                summary.extend(result.notes)
            warnings.extend(result.warnings)
        if not no_install and run_package_install(root):
            summary.append("Installed @kt-tools/css-ts via jsr add.")

    console.print("\n[bold green]css-ts setup complete[/]")
    if summary:
        for line in summary:
            console.print(f"[green]-[/] {line}")
    if warnings:
        console.print("\n[bold yellow]Warnings[/]")
        for line in warnings:
            console.print(f"[yellow]-[/] {line}")


if __name__ == "__main__":
    cli()
