/// <reference lib="dom" />

import type { ReactNode } from "react";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ImportedThemesInput } from "./shared.js";

const DEFAULT_THEME_STORAGE_KEY = "css-ts:theme";

const ROOT_THEME_NAMES = new Set(["", "default", "root", ":root"]);

/**
 * Runtime shape accepted by {@link ThemeProvider} for automatic theme discovery.
 */
export type ThemeSource = {
  themes?: ImportedThemesInput;
};

/**
 * Storage back-end used by {@link ThemeProvider}.
 */
export type ThemeStorageMode = "session" | "local" | false;

/**
 * Context value exposed by {@link useTheme}.
 */
export type ThemeContextValue = {
  /** Currently active theme name from the registered theme map. */
  theme: string;
  /** Ordered theme names resolved from the registered theme map. */
  themes: readonly string[];
  /** Set the current theme by name. */
  setTheme: (theme: string) => void;
  /** Advance to the next registered theme name. */
  toggleTheme: () => void;
};

/**
 * Props accepted by {@link ThemeProvider}.
 */
export type ThemeProviderProps = {
  children?: ReactNode;
  /** Styles builder or config object containing a `themes` map. */
  styles?: ThemeSource;
  /** Explicit theme map; overrides `styles.themes` when provided. */
  themes?: ImportedThemesInput;
  /** Initial fallback theme used before storage is read on the client. */
  defaultTheme?: string;
  /** Optional keyboard shortcut such as `mod+shift+t`. */
  hotkey?: string;
  /** Storage backend used to persist the active theme. Defaults to `session`. */
  storage?: ThemeStorageMode;
  /** Storage key used when persistence is enabled. */
  storageKey?: string;
};

/**
 * Internal normalized theme entry used by the provider.
 */
export type ManagedThemeEntry = {
  name: string;
  className: string | null;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isRootThemeName(themeName: string): boolean {
  return ROOT_THEME_NAMES.has(themeName.trim().toLowerCase());
}

function toManagedThemeClassName(themeName: string): string | null {
  const trimmed = themeName.trim();

  if (isRootThemeName(trimmed)) {
    return null;
  }

  if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\.[A-Za-z_-][A-Za-z0-9_-]*$/.test(trimmed)) {
    return trimmed.slice(1);
  }

  throw new Error(
    `ThemeProvider can only manage default/root themes and class-backed theme scopes. Received "${themeName}".`,
  );
}

/**
 * Normalize an imported theme map into entries that can be managed by the provider.
 */
export function resolveManagedThemeEntries(
  themes: ImportedThemesInput | undefined,
): ManagedThemeEntry[] {
  const themeNames = themes && Object.keys(themes).length > 0
    ? Object.keys(themes)
    : ["default"];

  return themeNames.map((themeName) => ({
    name: themeName,
    className: toManagedThemeClassName(themeName),
  }));
}

function resolveDefaultThemeName(
  entries: readonly ManagedThemeEntry[],
  preferredTheme: string | undefined,
): string {
  if (
    preferredTheme &&
    entries.some((entry) => entry.name === preferredTheme)
  ) {
    return preferredTheme;
  }

  const rootTheme = entries.find((entry) => entry.className === null);
  return rootTheme?.name ?? entries[0]?.name ?? "default";
}

function resolveStorage(
  storageMode: ThemeStorageMode,
): Storage | null {
  if (storageMode === false || typeof window === "undefined") {
    return null;
  }

  try {
    return storageMode === "local"
      ? window.localStorage
      : window.sessionStorage;
  } catch {
    return null;
  }
}

function readStoredTheme(
  entries: readonly ManagedThemeEntry[],
  storageMode: ThemeStorageMode,
  storageKey: string,
): string | null {
  const storage = resolveStorage(storageMode);
  if (!storage) {
    return null;
  }

  const storedTheme = storage.getItem(storageKey);
  if (!storedTheme) {
    return null;
  }

  return entries.some((entry) => entry.name === storedTheme)
    ? storedTheme
    : null;
}

function persistTheme(
  theme: string,
  storageMode: ThemeStorageMode,
  storageKey: string,
): void {
  const storage = resolveStorage(storageMode);
  if (!storage) {
    return;
  }

  storage.setItem(storageKey, theme);
}

function applyThemeClassNames(
  entries: readonly ManagedThemeEntry[],
  activeTheme: string,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  const managedClassNames = entries
    .map((entry) => entry.className)
    .filter((className): className is string => className !== null);

  if (managedClassNames.length > 0) {
    root.classList.remove(...managedClassNames);
  }

  const activeEntry = entries.find((entry) => entry.name === activeTheme);
  if (activeEntry?.className) {
    root.classList.add(activeEntry.className);
  }
}

/**
 * Return the next theme name in the registered theme order.
 */
export function getNextThemeName(
  entries: readonly ManagedThemeEntry[],
  currentTheme: string,
): string {
  if (entries.length === 0) {
    return "default";
  }

  const currentIndex = entries.findIndex((entry) => entry.name === currentTheme);
  if (currentIndex === -1) {
    return entries[0].name;
  }

  return entries[(currentIndex + 1) % entries.length].name;
}

type HotkeyConfig = {
  key: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

function normalizeHotkeyKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  switch (normalized) {
    case "esc":
      return "escape";
    case "return":
      return "enter";
    case "space":
    case "spacebar":
      return " ";
    default:
      return normalized;
  }
}

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function parseHotkey(hotkey: string): HotkeyConfig | null {
  const parts = hotkey
    .split("+")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (parts.length === 0) {
    return null;
  }

  const keyToken = parts.pop();
  if (!keyToken) {
    return null;
  }

  const hotkeyConfig: HotkeyConfig = {
    key: normalizeHotkeyKey(keyToken),
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
  };

  for (const modifier of parts) {
    switch (modifier) {
      case "alt":
      case "option":
        hotkeyConfig.alt = true;
        break;
      case "cmd":
      case "command":
      case "meta":
        hotkeyConfig.meta = true;
        break;
      case "ctrl":
      case "control":
        hotkeyConfig.ctrl = true;
        break;
      case "shift":
        hotkeyConfig.shift = true;
        break;
      case "mod":
        if (isApplePlatform()) {
          hotkeyConfig.meta = true;
        } else {
          hotkeyConfig.ctrl = true;
        }
        break;
      default:
        throw new Error(`Unsupported hotkey modifier "${modifier}".`);
    }
  }

  return hotkeyConfig;
}

function matchesHotkey(event: KeyboardEvent, hotkey: HotkeyConfig): boolean {
  return (
    event.key.toLowerCase() === hotkey.key &&
    event.altKey === hotkey.alt &&
    event.ctrlKey === hotkey.ctrl &&
    event.metaKey === hotkey.meta &&
    event.shiftKey === hotkey.shift
  );
}

/**
 * React provider that reads registered themes from CSS-TS and manages the active theme class.
 */
export function ThemeProvider({
  children,
  styles,
  themes,
  defaultTheme,
  hotkey,
  storage = "session",
  storageKey = DEFAULT_THEME_STORAGE_KEY,
}: ThemeProviderProps) {
  const managedThemes = useMemo(
    () => resolveManagedThemeEntries(themes ?? styles?.themes),
    [styles?.themes, themes],
  );
  const themeNames = useMemo(
    () => managedThemes.map((entry) => entry.name),
    [managedThemes],
  );

  const [theme, setThemeState] = useState(() =>
    resolveDefaultThemeName(managedThemes, defaultTheme)
  );
  const [hasLoadedStoredTheme, setHasLoadedStoredTheme] = useState(false);

  useEffect(() => {
    if (managedThemes.some((entry) => entry.name === theme)) {
      return;
    }

    setThemeState(resolveDefaultThemeName(managedThemes, defaultTheme));
  }, [defaultTheme, managedThemes, theme]);

  useEffect(() => {
    const storedTheme = readStoredTheme(managedThemes, storage, storageKey);
    if (storedTheme) {
      setThemeState(storedTheme);
    }

    setHasLoadedStoredTheme(true);
  }, [managedThemes, storage, storageKey]);

  useEffect(() => {
    if (!hasLoadedStoredTheme) {
      return;
    }

    applyThemeClassNames(managedThemes, theme);
    persistTheme(theme, storage, storageKey);
  }, [hasLoadedStoredTheme, managedThemes, storage, storageKey, theme]);

  useEffect(() => {
    if (!hotkey || typeof window === "undefined") {
      return;
    }

    const parsedHotkey = parseHotkey(hotkey);
    if (!parsedHotkey) {
      return;
    }
    const hotkeyConfig = parsedHotkey;

    function onKeyDown(event: KeyboardEvent): void {
      if (!matchesHotkey(event, hotkeyConfig)) {
        return;
      }

      event.preventDefault();
      setThemeState((currentTheme) => getNextThemeName(managedThemes, currentTheme));
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hotkey, managedThemes]);

  function setTheme(nextTheme: string): void {
    if (!managedThemes.some((entry) => entry.name === nextTheme)) {
      throw new Error(
        `Unknown theme "${nextTheme}". Registered themes: ${themeNames.join(", ")}.`,
      );
    }

    setThemeState(nextTheme);
  }

  function toggleTheme(): void {
    setThemeState((currentTheme) => getNextThemeName(managedThemes, currentTheme));
  }

  return createElement(
    ThemeContext.Provider,
    {
      value: {
        theme,
        themes: themeNames,
        setTheme,
        toggleTheme,
      },
    },
    children,
  );
}

/**
 * Access the active CSS-TS theme controller.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider.");
  }

  return context;
}
