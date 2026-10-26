/** A tab opened before a new release still names the old build's page files; the server no longer has them, so
 * opening a page fails ("Failed to fetch dynamically imported module"). Reload once to get the new build. */
const KEY = "flora.staleBuildReloadAt";
const WINDOW_MS = 30_000;   // never loop: at most one reload in this time

export function isStaleBuildError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|Loading chunk/i.test(text);
}

/** Reloads the page for a stale build; false when it already did so just now (then the error is real). */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage blocked: reload anyway, once per page load */
  }
  window.location.reload();
  return true;
}

export function installStaleBuildReload(): void {
  // Vite reports a failed preload of a page's files before the import itself fails.
  window.addEventListener("vite:preloadError", event => {
    if (reloadForNewBuild()) event.preventDefault();
  });
}
