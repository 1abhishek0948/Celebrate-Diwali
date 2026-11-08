// ---------------------------------------------------------------------------
// Mobile orientation helpers.
//
// Browsers only allow an orientation lock while the page is fullscreen, and
// iOS Safari does not expose the Screen Orientation API at all. Callers pair
// this with the #rotate-device overlay so unsupported browsers still get a
// clear "rotate your phone" message.
// ---------------------------------------------------------------------------

export function isMobileDevice() {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(hover: none) and (pointer: coarse)")
    ?.matches;
  return !!coarse || ("ontouchstart" in window && window.innerWidth <= 1024);
}

function fullscreenElement() {
  return (
    document.fullscreenElement || document.webkitFullscreenElement || null
  );
}

// Must be called directly from a user gesture (e.g. the Play button) so the
// fullscreen request is allowed. The lock is attempted even if fullscreen was
// rejected: some browsers allow it without fullscreen.
export async function enterLandscape() {
  if (!isMobileDevice()) return false;

  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (request && !fullscreenElement()) {
    try {
      await request.call(el);
    } catch {
      /* denied / unsupported: fall through and try the lock anyway */
    }
  }
  return lockLandscape();
}

export async function lockLandscape() {
  try {
    const orientation = globalThis.screen?.orientation;
    if (!orientation?.lock) return false;
    await orientation.lock("landscape");
    return true;
  } catch {
    return false;
  }
}
