import * as pdfjsLib from "/assets/vendor/pdf.mjs";
import { marked } from "marked";
import DOMPurify from "dompurify";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/vendor/pdf.worker.mjs";

marked.setOptions({ gfm: true, breaks: true });

// Cap DPR for fit-to-width pages (full DPR is costly with little gain for type).
const MAX_PDF_PIXEL_RATIO = 2;

const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 12;

const MOBILE_MAX_WIDTH = 768;
// Phone landscape often exceeds MOBILE_MAX_WIDTH; pair with max height. Do not use (hover: none) alone —
// iOS Safari often reports hover: hover / pointer: fine.
const MOBILE_LANDSCAPE_MAX_HEIGHT = 520;
// Upper bound for phone-landscape width (CSS px); keeps short ultrawide desktop windows off mobile layout.
const MOBILE_LANDSCAPE_MAX_WIDTH = 960;

function mobileLayoutMediaQuery() {
  return `(max-width: ${MOBILE_MAX_WIDTH}px), ((max-height: ${MOBILE_LANDSCAPE_MAX_HEIGHT}px) and (max-width: ${MOBILE_LANDSCAPE_MAX_WIDTH}px))`;
}

const THEME_STORAGE_KEY = "dockerReaderTheme";
const THEMES = [
  { id: "dark", label: "Dark", hint: "Dimmed, low-glare interface" },
  { id: "light", label: "Light", hint: "Bright, paper-like interface" },
];

// mobileReaderHistoryPushed: reader opened with pushState (back → in-app library, not browser exit).
// pendingLibrarySearchFocus: defer focusing library search until mobile library screen is visible.
const state = {
  me: null,
  docs: [],
  currentDoc: null,
  pdfDoc: null,
  page: 1,
  renderTask: null,
  pageCache: new Map(),
  renderVersion: 0,
  progressSaveTimer: null,
  currentDocId: null,
  viewerShell: null,
  zoomPercent: 100,
  pendingScrollRestore: null,
  mobileChromeTimer: null,
  mobileReaderHistoryPushed: false,
  pendingLibrarySearchFocus: false,
};

let resizeRenderTimer = null;

// Session LRU of parsed PDFs; evicted docs are destroyed to drop worker transports.
const PDF_DOC_CACHE_MAX = 3;
const pdfDocCache = new Map();

function getCachedPdfDoc(docId) {
  if (!pdfDocCache.has(docId)) return null;
  const pdf = pdfDocCache.get(docId);
  pdfDocCache.delete(docId);
  pdfDocCache.set(docId, pdf);
  return pdf;
}

async function putCachedPdfDoc(docId, pdf) {
  if (pdfDocCache.has(docId)) {
    pdfDocCache.delete(docId);
  }
  pdfDocCache.set(docId, pdf);
  while (pdfDocCache.size > PDF_DOC_CACHE_MAX) {
    const oldest = pdfDocCache.keys().next().value;
    const evicted = pdfDocCache.get(oldest);
    pdfDocCache.delete(oldest);
    try {
      await evicted?.destroy?.();
    } catch {
      /* ignore */
    }
  }
}

async function clearPdfDocCache() {
  for (const pdf of pdfDocCache.values()) {
    try {
      await pdf?.destroy?.();
    } catch {
      /* ignore */
    }
  }
  pdfDocCache.clear();
}

let notesEditTargetId = null;
let notesPaletteSelectedNoteId = null;
let notesPaletteSelectedPage = 1;

function renderNoteMarkdown(md) {
  const html = marked.parse(String(md || ""), { async: false });
  return DOMPurify.sanitize(html);
}

function isNotesEditOpen() {
  return document.querySelector("#notesEditOverlay")?.classList.contains("is-open") || false;
}

function isNotesPaletteOpen() {
  return document.querySelector("#notesPaletteOverlay")?.classList.contains("is-open") || false;
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function isEventInViewerStage(target) {
  const stage = document.querySelector("#viewerStage");
  if (!stage || !(target instanceof Node)) return false;
  return stage.contains(target);
}

// Block browser zoom (pinch/Ctrl+wheel); PDF uses in-app zoomPercent and stage pinch only.
function installNoBrowserZoom() {
  document.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (isEventInViewerStage(event.target)) return;
      event.preventDefault();
    },
    { passive: false, capture: true },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      if (isEventInViewerStage(event.target)) return;
      const k = event.key;
      if (k === "+" || k === "-" || k === "=" || k === "0" || k === "Add" || k === "Subtract") {
        event.preventDefault();
      }
    },
    true,
  );

  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
}

function touchDistance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function installMobileViewerPinch(stage) {
  let pinch = null;
  let raf = 0;

  stage.addEventListener(
    "touchmove",
    (event) => {
      if (!isMobileLayout() || !state.pdfDoc) {
        pinch = null;
        return;
      }
      if (event.touches.length !== 2) {
        pinch = null;
        return;
      }
      event.preventDefault();
      const d = touchDistance(event.touches[0], event.touches[1]);
      if (!pinch) {
        pinch = { startDist: Math.max(d, 1), startZoom: state.zoomPercent };
        return;
      }
      const ratio = d / pinch.startDist;
      const next = Math.round(pinch.startZoom * ratio);
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
      if (clamped === state.zoomPercent) return;
      state.zoomPercent = clamped;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        void renderPage();
      });
    },
    { passive: false },
  );

  const endPinch = () => {
    pinch = null;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    queueProgressSave();
  };
  stage.addEventListener("touchend", endPinch);
  stage.addEventListener("touchcancel", endPinch);
}

const MOBILE_AXIS_LOCK_THRESHOLD_PX = 10;
const MOBILE_AXIS_LOCK_RATIO = 1.2;

function mobileReaderAxisLockGate() {
  return (
    isMobileLayout() &&
    document.body.classList.contains("mobile-screen-reader") &&
    Boolean(state.pdfDoc)
  );
}

/** Dominant-axis touch pan: once vertical intent is clear, take over scrolling so horizontal drift does not occur (mobile reader, zoomed). */
function installMobileScrollAxisLock(stage) {
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let lockedAxis = /** @type {null | "y" | "x" | "free"} */ (null);

  const resetGesture = () => {
    lockedAxis = null;
  };

  stage.addEventListener(
    "touchstart",
    (event) => {
      if (!mobileReaderAxisLockGate()) {
        resetGesture();
        return;
      }
      if (event.touches.length !== 1) {
        resetGesture();
        return;
      }
      const t = event.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      lastY = t.clientY;
      lockedAxis = null;
    },
    { passive: true },
  );

  stage.addEventListener(
    "touchmove",
    (event) => {
      if (!mobileReaderAxisLockGate()) {
        resetGesture();
        return;
      }
      if (event.touches.length !== 1) {
        resetGesture();
        return;
      }
      if (stage.scrollWidth <= stage.clientWidth + 1) {
        resetGesture();
        return;
      }

      const t = event.touches[0];
      if (lockedAxis === null) {
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.hypot(dx, dy) < MOBILE_AXIS_LOCK_THRESHOLD_PX) {
          lastY = t.clientY;
          return;
        }
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        const r = MOBILE_AXIS_LOCK_RATIO;
        if (ady > r * adx) {
          lockedAxis = "y";
        } else if (adx > r * ady) {
          lockedAxis = "x";
        } else {
          lockedAxis = "free";
        }
      }

      if (lockedAxis === "y") {
        event.preventDefault();
        const dy = t.clientY - lastY;
        lastY = t.clientY;
        const maxTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
        stage.scrollTop = Math.max(0, Math.min(maxTop, stage.scrollTop - dy));
        return;
      }

      lastY = t.clientY;
    },
    { passive: false },
  );

  const endAxisGesture = () => {
    resetGesture();
  };
  stage.addEventListener("touchend", endAxisGesture);
  stage.addEventListener("touchcancel", endAxisGesture);
}

const app = document.querySelector("#app");

initTheme();

function icoSearch() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.25" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M15.2 15.2 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`;
}
function icoPlus() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`;
}
function icoMenu() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`;
}
function icoChevLeft() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function icoChevRight() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function icoChevLeftTiny() {
  return `<svg class="rail-handle-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function icoChevRightTiny() {
  return `<svg class="rail-handle-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function icoLogout() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M15 12H6M12 9l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
// Lucide palette icon — https://lucide.dev/icons/palette (ISC)
function icoPalette() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`;
}

// Lucide zoom-in — https://lucide.dev/icons/zoom-in (ISC)
function icoZoomIn() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/></svg>`;
}

// Lucide zoom-out — https://lucide.dev/icons/zoom-out (ISC)
function icoZoomOut() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/></svg>`;
}

// Lucide sticky-note — https://lucide.dev/icons/sticky-note (ISC)
function icoNotes() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/></svg>`;
}

function icoDots() {
  return `<svg class="rail-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.75" fill="currentColor"/><circle cx="12" cy="12" r="1.75" fill="currentColor"/><circle cx="19" cy="12" r="1.75" fill="currentColor"/></svg>`;
}

function normalizeTheme(raw) {
  const t = String(raw || "").toLowerCase();
  if (t === "dark" || t === "light") return t;
  return null;
}

function getStoredTheme() {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  const t = normalizeTheme(theme) || "dark";
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* ignore */
  }
}

function initTheme() {
  const stored = getStoredTheme();
  document.documentElement.dataset.theme = stored || "dark";
}

function getThemePaletteElements() {
  const overlay = document.querySelector("#themePaletteOverlay");
  const input = document.querySelector("#themePaletteInput");
  const list = document.querySelector("#themePaletteList");
  if (!(overlay instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !(list instanceof HTMLElement)) {
    return null;
  }
  return { overlay, input, list };
}

function getPageJumpElements() {
  const overlay = document.querySelector("#pageJumpOverlay");
  const input = document.querySelector("#pageJumpInput");
  const form = document.querySelector("#pageJumpForm");
  if (!(overlay instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
    return null;
  }
  return { overlay, input, form };
}

function getBookPaletteElements() {
  const overlay = document.querySelector("#bookPaletteOverlay");
  const input = document.querySelector("#bookPaletteInput");
  const list = document.querySelector("#bookPaletteList");
  if (!(overlay instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !(list instanceof HTMLElement)) {
    return null;
  }
  return { overlay, input, list };
}

function getNotesPaletteElements() {
  const overlay = document.querySelector("#notesPaletteOverlay");
  const input = document.querySelector("#notesPaletteInput");
  const list = document.querySelector("#notesPaletteList");
  const listHead = document.querySelector("#notesPaletteListHead");
  const actionsHead = document.querySelector("#notesPaletteActionsHead");
  const preview = document.querySelector("#notesPalettePreview");
  const backBtn = document.querySelector("#notesPaletteBackBtn");
  if (
    !(overlay instanceof HTMLElement) ||
    !(input instanceof HTMLInputElement) ||
    !(list instanceof HTMLElement) ||
    !(listHead instanceof HTMLElement) ||
    !(actionsHead instanceof HTMLElement) ||
    !(preview instanceof HTMLElement) ||
    !(backBtn instanceof HTMLButtonElement)
  ) {
    return null;
  }
  return { overlay, input, list, listHead, actionsHead, preview, backBtn };
}

function getSessionPaletteElements() {
  const overlay = document.querySelector("#sessionPaletteOverlay");
  const list = document.querySelector("#sessionPaletteList");
  if (!(overlay instanceof HTMLElement) || !(list instanceof HTMLElement)) {
    return null;
  }
  return { overlay, list };
}

function isThemePaletteOpen() {
  const overlay = document.querySelector("#themePaletteOverlay");
  return overlay?.classList.contains("is-open") || false;
}

function isMainCommandPaletteOpen() {
  return document.querySelector("#mainCommandPaletteOverlay")?.classList.contains("is-open") || false;
}

function isAnyPaletteOpen() {
  const selectors = [
    "#mainCommandPaletteOverlay",
    "#themePaletteOverlay",
    "#pageJumpOverlay",
    "#bookPaletteOverlay",
    "#notesPaletteOverlay",
    "#sessionPaletteOverlay",
    "#notesEditOverlay",
  ];
  return selectors.some((selector) => document.querySelector(selector)?.classList.contains("is-open"));
}

function fuzzyScore(term, query) {
  if (!query) return 0;
  let qi = 0;
  let score = 0;
  for (let i = 0; i < term.length && qi < query.length; i += 1) {
    if (term[i] !== query[qi]) continue;
    score += 1;
    if (i > 0 && qi > 0 && term[i - 1] === query[qi - 1]) {
      score += 1;
    }
    qi += 1;
  }
  if (qi < query.length) return -1;
  return score;
}

function getThemeMatches(rawQuery) {
  const query = String(rawQuery || "").trim().toLowerCase();
  const withScore = THEMES.map((theme, idx) => {
    const haystack = `${theme.label} ${theme.id} ${theme.hint}`.toLowerCase();
    return {
      theme,
      idx,
      score: fuzzyScore(haystack, query),
    };
  }).filter((item) => query.length === 0 || item.score >= 0);
  withScore.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return withScore.map((item) => item.theme);
}

function getBookMatches(rawQuery, books) {
  const query = String(rawQuery || "").trim().toLowerCase();
  const withScore = books
    .map((book, idx) => {
      const title = String(book.title || "Untitled");
      const haystack = `${title} ${book.id || ""}`.toLowerCase();
      return {
        book,
        idx,
        score: fuzzyScore(haystack, query),
      };
    })
    .filter((item) => query.length === 0 || item.score >= 0);
  withScore.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return withScore.map((item) => item.book);
}

function shouldMarqueeBookTitle(title) {
  return String(title || "").trim().length > 42;
}

function renderThemePaletteOptions(options, activeIndex) {
  const els = getThemePaletteElements();
  if (!els) return;
  const currentTheme = normalizeTheme(document.documentElement.dataset.theme) || "dark";
  if (!options.length) {
    els.list.innerHTML = `<li class="theme-palette-item"><div class="theme-palette-hint">No matching themes.</div></li>`;
    return;
  }
  const safeIndex = Math.max(0, Math.min(activeIndex, options.length - 1));
  els.list.innerHTML = options
    .map((theme, idx) => {
      const isActiveRow = idx === safeIndex;
      const isCurrentTheme = theme.id === currentTheme;
      return `<li class="theme-palette-item">
        <button type="button" class="theme-palette-option${isActiveRow ? " is-active" : ""}" data-theme-id="${theme.id}" role="option" aria-selected="${isActiveRow ? "true" : "false"}">
          <span class="theme-palette-name">${theme.label}</span>
          <span class="theme-palette-hint">${isCurrentTheme ? "Current" : theme.hint}</span>
        </button>
      </li>`;
    })
    .join("");
}

function wireThemePalette() {
  const els = getThemePaletteElements();
  if (!els) return;
  let options = getThemeMatches("");
  let activeIndex = 0;

  const repaint = () => {
    if (!options.length) {
      renderThemePaletteOptions(options, 0);
      return;
    }
    activeIndex = Math.max(0, Math.min(activeIndex, options.length - 1));
    renderThemePaletteOptions(options, activeIndex);
  };

  const close = () => {
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    els.input.value = "";
    options = getThemeMatches("");
    activeIndex = 0;
    repaint();
  };

  const open = () => {
    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    options = getThemeMatches(els.input.value);
    activeIndex = 0;
    repaint();
    requestAnimationFrame(() => {
      els.input.focus();
      els.input.select();
    });
  };

  const chooseTheme = (themeId) => {
    const t = normalizeTheme(themeId);
    if (!t) return;
    applyTheme(t);
    close();
  };

  document.querySelector("#themeBtn")?.addEventListener("click", open);

  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) close();
  });

  els.list.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-theme-id]") : null;
    const themeId = target?.getAttribute("data-theme-id");
    if (!themeId) return;
    chooseTheme(themeId);
  });

  els.input.addEventListener("input", () => {
    options = getThemeMatches(els.input.value);
    activeIndex = 0;
    repaint();
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      focusThemePalettePrimaryControl();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!options.length) return;
      activeIndex = (activeIndex + 1) % options.length;
      repaint();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      activeIndex = (activeIndex - 1 + options.length) % options.length;
      repaint();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!options.length) return;
      chooseTheme(options[activeIndex]?.id);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!isThemePaletteOpen()) return;
    if (event.key === "Escape" && event.target !== els.input) {
      event.preventDefault();
      close();
      focusThemePalettePrimaryControl();
    }
  });

  document.addEventListener("openThemePalette", open);
  repaint();
}

function wirePageJumpPalette() {
  const els = getPageJumpElements();
  if (!els) return;

  const close = () => {
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    els.input.value = "";
  };

  const open = () => {
    if (!state.pdfDoc) return;
    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    els.input.value = String(state.page || "");
    requestAnimationFrame(() => {
      els.input.focus();
      els.input.select();
    });
  };

  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) {
      close();
    }
  });

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await jumpToPage(els.input.value);
    close();
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  });

  document.addEventListener("keydown", (event) => {
    if (!els.overlay.classList.contains("is-open")) return;
    if (event.key !== "Escape" || event.target === els.input) return;
    event.preventDefault();
    close();
  });

  document.addEventListener("openPageJumpPalette", open);
}

function isMobileLibraryCommandContext() {
  return isMobileLayout() && document.body.classList.contains("mobile-screen-library");
}

const MAIN_COMMAND_REGISTRY_READER = [
  {
    id: "library",
    label: "Library…",
    hint: "Open, add, or search PDFs",
    keywords: "home shelf list documents recent book open upload",
    enabled: () => Boolean(state.me),
    run: () => document.dispatchEvent(new Event("openLibraryPalette")),
  },
  {
    id: "theme",
    label: "Theme",
    hint: "Change appearance",
    keywords: "palette dark light color appearance",
    enabled: () => true,
    run: () => document.dispatchEvent(new Event("openThemePalette")),
  },
  {
    id: "page",
    label: "Go to page…",
    hint: "Jump to page number",
    keywords: "jump navigate page number",
    enabled: () => Boolean(state.pdfDoc),
    run: () => document.dispatchEvent(new Event("openPageJumpPalette")),
  },
  {
    id: "notes",
    label: "Notes",
    hint: "Page notes for this book",
    keywords: "markdown annotations",
    enabled: () => Boolean(state.pdfDoc && state.currentDocId),
    run: () => document.dispatchEvent(new Event("openNotesPalette")),
  },
  {
    id: "logout",
    label: "Log out",
    hint: "End session",
    keywords: "sign out exit account",
    enabled: () => true,
    run: () => document.dispatchEvent(new Event("openSessionPalette")),
  },
];

const MAIN_COMMAND_REGISTRY_LIBRARY = [
  {
    id: "addPdf",
    label: "Add PDF…",
    hint: "Upload a document",
    keywords: "upload import file",
    enabled: () => true,
    run: () => document.querySelector("#uploadInput")?.click(),
  },
  {
    id: "openDoc",
    label: "Open document…",
    hint: "Search and open a PDF",
    keywords: "library book list switch finder",
    enabled: () => true,
    run: () => document.dispatchEvent(new Event("openLibraryPalette")),
  },
  {
    id: "theme",
    label: "Theme",
    hint: "Change appearance",
    keywords: "palette dark light color appearance",
    enabled: () => true,
    run: () => document.dispatchEvent(new Event("openThemePalette")),
  },
  {
    id: "logout",
    label: "Log out",
    hint: "End session",
    keywords: "sign out exit account",
    enabled: () => true,
    run: () => document.dispatchEvent(new Event("openSessionPalette")),
  },
];

function getMainCommandRegistry() {
  if (isMobileLibraryCommandContext()) {
    return MAIN_COMMAND_REGISTRY_LIBRARY;
  }
  return MAIN_COMMAND_REGISTRY_READER;
}

const SUB_PALETTE_OVERLAY_SELECTORS = [
  "#themePaletteOverlay",
  "#pageJumpOverlay",
  "#bookPaletteOverlay",
  "#notesPaletteOverlay",
  "#sessionPaletteOverlay",
];

function forceCloseSubPalettesForMainCommand() {
  for (const sel of SUB_PALETTE_OVERLAY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement) || !el.classList.contains("is-open")) continue;
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
  }
  const ti = document.querySelector("#themePaletteInput");
  if (ti instanceof HTMLInputElement) ti.value = "";
  const pi = document.querySelector("#pageJumpInput");
  if (pi instanceof HTMLInputElement) pi.value = "";
  const bi = document.querySelector("#bookPaletteInput");
  if (bi instanceof HTMLInputElement) bi.value = "";
  const ni = document.querySelector("#notesPaletteInput");
  if (ni instanceof HTMLInputElement) ni.value = "";
  document.dispatchEvent(new Event("resetNotesPaletteUI"));
}

function getMainCommandPaletteElements() {
  const overlay = document.querySelector("#mainCommandPaletteOverlay");
  const input = document.querySelector("#mainCommandPaletteInput");
  const list = document.querySelector("#mainCommandPaletteList");
  if (!(overlay instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !(list instanceof HTMLElement)) {
    return null;
  }
  return { overlay, input, list };
}

function getMainCommandMatches(rawQuery) {
  const query = String(rawQuery || "").trim().toLowerCase();
  const cmds = getMainCommandRegistry().filter((c) => (typeof c.enabled === "function" ? c.enabled() : true));
  const withScore = cmds.map((cmd, idx) => {
    const haystack = `${cmd.label} ${cmd.id} ${cmd.hint} ${cmd.keywords || ""}`.toLowerCase();
    return { cmd, idx, score: fuzzyScore(haystack, query) };
  }).filter((item) => query.length === 0 || item.score >= 0);
  withScore.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return withScore.map((item) => item.cmd);
}

function renderMainCommandOptions(options, activeIndex) {
  const els = getMainCommandPaletteElements();
  if (!els) return;
  if (!options.length) {
    els.list.innerHTML = `<li class="theme-palette-item"><div class="theme-palette-hint">No matching commands.</div></li>`;
    return;
  }
  const safeIndex = Math.max(0, Math.min(activeIndex, options.length - 1));
  els.list.innerHTML = options
    .map((cmd, idx) => {
      const isActive = idx === safeIndex;
      return `<li class="theme-palette-item">
        <button type="button" class="theme-palette-option${isActive ? " is-active" : ""}" data-command-id="${cmd.id}" role="option" aria-selected="${isActive ? "true" : "false"}">
          <span class="theme-palette-name">${cmd.label}</span>
          <span class="theme-palette-hint">${cmd.hint}</span>
        </button>
      </li>`;
    })
    .join("");
}

let mainPalettePreviousFocus = null;
let closeMainCommandPaletteImpl = () => {};

function wireMainCommandPalette() {
  const els = getMainCommandPaletteElements();
  if (!els) return;
  let options = getMainCommandMatches("");
  let activeIndex = 0;

  const restoreFocusAfterClose = () => {
    document.querySelector("#mobileReaderOverflowBtn")?.setAttribute("aria-expanded", "false");
    document.querySelector("#mobileLibraryMenuBtn")?.setAttribute("aria-expanded", "false");
    const el = mainPalettePreviousFocus;
    mainPalettePreviousFocus = null;
    if (el instanceof HTMLElement && document.contains(el)) {
      el.focus();
      return;
    }
    if (isMobileLayout()) {
      if (document.body.classList.contains("mobile-screen-library")) {
        document.querySelector("#mobileLibraryMenuBtn")?.focus();
      } else if (isMobileLandscapeReader()) {
        document.querySelector("#mobileLibraryMenuBtn")?.focus();
      } else {
        document.querySelector("#mobileReaderOverflowBtn")?.focus();
      }
    }
  };

  const repaint = () => {
    options = getMainCommandMatches(els.input.value);
    if (!options.length) {
      renderMainCommandOptions([], 0);
      return;
    }
    activeIndex = Math.max(0, Math.min(activeIndex, options.length - 1));
    renderMainCommandOptions(options, activeIndex);
  };

  const close = () => {
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    els.input.value = "";
    options = getMainCommandMatches("");
    activeIndex = 0;
    repaint();
    restoreFocusAfterClose();
  };

  closeMainCommandPaletteImpl = close;

  const open = () => {
    mainPalettePreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    options = getMainCommandMatches(els.input.value);
    activeIndex = 0;
    repaint();
    if (isMobileLayout()) {
      if (document.body.classList.contains("mobile-screen-library")) {
        document.querySelector("#mobileLibraryMenuBtn")?.setAttribute("aria-expanded", "true");
      } else {
        document.querySelector("#mobileReaderOverflowBtn")?.setAttribute("aria-expanded", "true");
      }
    }
    requestAnimationFrame(() => {
      els.input.focus();
      els.input.select?.();
    });
  };

  const runCommand = (cmdId) => {
    const def = getMainCommandRegistry().find((c) => c.id === cmdId);
    if (!def) return;
    close();
    requestAnimationFrame(() => {
      try {
        def.run();
      } catch {
        /* ignore */
      }
    });
  };

  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) close();
  });

  els.list.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-command-id]") : null;
    const id = target?.getAttribute("data-command-id");
    if (!id) return;
    runCommand(id);
  });

  els.input.addEventListener("input", () => {
    activeIndex = 0;
    repaint();
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!options.length) return;
      activeIndex = (activeIndex + 1) % options.length;
      renderMainCommandOptions(options, activeIndex);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      activeIndex = (activeIndex - 1 + options.length) % options.length;
      renderMainCommandOptions(options, activeIndex);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!options.length) return;
      runCommand(options[activeIndex]?.id);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!els.overlay.classList.contains("is-open")) return;
    if (event.key === "Escape" && event.target !== els.input) {
      event.preventDefault();
      close();
    }
  });

  document.addEventListener("openMainCommandPalette", open);
  repaint();
}

function closeMainCommandPaletteIfOpen() {
  const els = getMainCommandPaletteElements();
  if (!els?.overlay.classList.contains("is-open")) return;
  closeMainCommandPaletteImpl();
}

function docIdFromBook(book) {
  if (!book || typeof book !== "object") return "";
  return String(book.id || book.docId || "").trim();
}

const LIBRARY_PALETTE_ACTION_ADD = "add";
const LIBRARY_PALETTE_ACTION_SEARCH = "search";

function getLibraryPaletteRows(rawQuery, books) {
  const query = String(rawQuery || "").trim().toLowerCase();
  const rows = [];
  const actionDefs = [
    {
      action: LIBRARY_PALETTE_ACTION_ADD,
      label: "Add PDF…",
      hint: "Upload a document",
      hay: "add pdf upload import file new document",
    },
    {
      action: LIBRARY_PALETTE_ACTION_SEARCH,
      label: "Search in PDFs…",
      hint: "Full-text search across your library",
      hay: "search full text find content library query",
    },
  ];
  for (const def of actionDefs) {
    if (query.length === 0 || fuzzyScore(def.hay, query) >= 0) {
      rows.push({ kind: "action", action: def.action, label: def.label, hint: def.hint });
    }
  }
  for (const book of getBookMatches(rawQuery, books)) {
    rows.push({ kind: "book", book });
  }
  return rows;
}

function renderLibraryPaletteRows(rows, activeIndex) {
  const els = getBookPaletteElements();
  if (!els) return;
  if (!rows.length) {
    els.list.innerHTML = `<li class="theme-palette-item"><div class="theme-palette-hint">No matching items.</div></li>`;
    return;
  }
  const safeIndex = Math.max(0, Math.min(activeIndex, rows.length - 1));
  els.list.innerHTML = rows
    .map((row, idx) => {
      const isActive = idx === safeIndex;
      if (row.kind === "action") {
        return `<li class="theme-palette-item library-palette-row-action">
        <button type="button" class="theme-palette-option${isActive ? " is-active" : ""}" data-library-action="${row.action}" role="option" aria-selected="${isActive ? "true" : "false"}">
          <span class="theme-palette-name">${row.label}</span>
          <span class="theme-palette-hint">${row.hint}</span>
        </button>
      </li>`;
      }
      const book = row.book;
      const title = String(book.title || "Untitled");
      const bid = docIdFromBook(book);
      const marqueeClass = shouldMarqueeBookTitle(title) ? " is-marquee" : "";
      return `<li class="theme-palette-item">
        <button type="button" class="theme-palette-option${isActive ? " is-active" : ""}" data-book-id="${bid}" role="option" aria-selected="${isActive ? "true" : "false"}">
          <span class="theme-palette-main">
            <span class="book-title-viewport${marqueeClass}">
              <span class="book-title-track">
                <span class="book-title-copy">${title}</span>
                <span class="book-title-copy book-title-copy-ghost" aria-hidden="true">${title}</span>
              </span>
            </span>
          </span>
          <span class="theme-palette-hint">${bid}</span>
        </button>
      </li>`;
    })
    .join("");
}

function wireBookPalette() {
  const els = getBookPaletteElements();
  if (!els) return;
  let books = [];
  let options = [];
  let activeIndex = 0;

  const repaint = () => {
    activeIndex = options.length ? Math.max(0, Math.min(activeIndex, options.length - 1)) : 0;
    renderLibraryPaletteRows(options, activeIndex);
  };

  const close = () => {
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    els.input.value = "";
    options = getLibraryPaletteRows("", books);
    activeIndex = 0;
    repaint();
  };

  const chooseBook = async (bookId) => {
    const id = String(bookId || "").trim();
    if (!id) return;
    // Close overlay before load so layout/render matches rail-open path (no blur layer during fit/paint).
    close();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await openDocument(id);
  };

  const runLibraryPaletteOpenSearchChrome = () => {
    if (isMobileLayout() && document.body.classList.contains("mobile-screen-reader")) {
      state.pendingLibrarySearchFocus = true;
      goToMobileLibraryFromReader();
      if (document.body.classList.contains("mobile-screen-library")) {
        flushPendingLibrarySearchFocus();
      }
      return;
    }
    expandAndFocusLibrarySearchField();
  };

  const runLibraryAction = (action) => {
    if (action === LIBRARY_PALETTE_ACTION_ADD) {
      close();
      requestAnimationFrame(() => {
        document.querySelector("#uploadInput")?.click();
      });
      return;
    }
    if (action === LIBRARY_PALETTE_ACTION_SEARCH) {
      close();
      requestAnimationFrame(() => {
        runLibraryPaletteOpenSearchChrome();
      });
    }
  };

  const open = async () => {
    if (!state.me) return;
    const result = await api("/api/library");
    if (!result.ok) return;
    books = result.data.documents || [];
    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    options = getLibraryPaletteRows(els.input.value, books);
    activeIndex = 0;
    repaint();
    requestAnimationFrame(() => {
      els.input.focus();
      els.input.select?.();
    });
  };

  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) close();
  });

  els.list.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-library-action], [data-book-id]") : null;
    if (!target) return;
    const action = target.getAttribute("data-library-action");
    if (action) {
      runLibraryAction(action);
      return;
    }
    const bookId = target.getAttribute("data-book-id");
    if (bookId) void chooseBook(bookId);
  });

  els.input.addEventListener("input", () => {
    options = getLibraryPaletteRows(els.input.value, books);
    activeIndex = 0;
    repaint();
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!options.length) return;
      activeIndex = (activeIndex + 1) % options.length;
      repaint();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      activeIndex = (activeIndex - 1 + options.length) % options.length;
      repaint();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!options.length) return;
      const row = options[activeIndex];
      if (!row) return;
      if (row.kind === "action") {
        runLibraryAction(row.action);
        return;
      }
      void chooseBook(docIdFromBook(row.book));
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!els.overlay.classList.contains("is-open")) return;
    if (event.key !== "Escape" || event.target === els.input) return;
    event.preventDefault();
    close();
  });

  document.addEventListener("openLibraryPalette", () => {
    void open();
  });

  document.addEventListener("openBookPalette", () => {
    void open();
  });
}

const NOTE_PALETTE_ADD = "__add__";

function getNotesPaletteListRows(rawQuery, noteMetas) {
  const query = String(rawQuery || "").trim().toLowerCase();
  const page = state.page || 1;
  const addLabel = `Add note on page ${page}`;
  const addHay = `${addLabel} new create add`.toLowerCase();
  const rows = [];
  if (query.length === 0 || fuzzyScore(addHay, query) >= 0) {
    rows.push({ kind: "add", rowKey: NOTE_PALETTE_ADD, page, label: addLabel });
  }
  const withScore = noteMetas.map((meta, idx) => {
    const hay = `page ${meta.page} ${meta.preview || ""} ${meta.id}`.toLowerCase();
    const score = query.length === 0 ? 0 : fuzzyScore(hay, query);
    return { meta, idx, score };
  }).filter((x) => query.length === 0 || x.score >= 0);
  withScore.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  for (const x of withScore) {
    rows.push({
      kind: "note",
      rowKey: x.meta.id,
      id: x.meta.id,
      page: x.meta.page,
      preview: x.meta.preview || "",
    });
  }
  return rows;
}

function renderNotesPaletteListRows(els, rows, activeIndex) {
  if (!rows.length) {
    els.list.innerHTML = `<li class="theme-palette-item"><div class="theme-palette-hint">No matching notes.</div></li>`;
    return;
  }
  const safeIndex = Math.max(0, Math.min(activeIndex, rows.length - 1));
  els.list.innerHTML = rows
    .map((r, idx) => {
      const isActive = idx === safeIndex;
      if (r.kind === "add") {
        return `<li class="theme-palette-item">
        <button type="button" class="theme-palette-option${isActive ? " is-active" : ""}" data-notes-row-key="${r.rowKey}" role="option" aria-selected="${isActive ? "true" : "false"}">
          <span class="theme-palette-name">${r.label}</span>
          <span class="theme-palette-hint">New markdown note</span>
        </button>
      </li>`;
      }
      const hint = String(r.preview || "(empty)").slice(0, 80);
      return `<li class="theme-palette-item">
        <button type="button" class="theme-palette-option${isActive ? " is-active" : ""}" data-notes-row-key="${r.rowKey}" role="option" aria-selected="${isActive ? "true" : "false"}">
          <span class="theme-palette-name">Page ${r.page}</span>
          <span class="theme-palette-hint">${hint}</span>
        </button>
      </li>`;
    })
    .join("");
}

function renderNotesPaletteActionRows(els, activeIndex) {
  const page = notesPaletteSelectedPage;
  const actions = [
    { key: "jump", label: "Go to page", hint: `Page ${page}` },
    { key: "edit", label: "Edit", hint: "Markdown" },
    { key: "delete", label: "Delete", hint: "Remove this note" },
  ];
  const safeIndex = Math.max(0, Math.min(activeIndex, actions.length - 1));
  els.list.innerHTML = actions
    .map((a, idx) => {
      const isActive = idx === safeIndex;
      return `<li class="theme-palette-item">
        <button type="button" class="theme-palette-option${isActive ? " is-active" : ""}" data-notes-action="${a.key}" role="option" aria-selected="${isActive ? "true" : "false"}">
          <span class="theme-palette-name">${a.label}</span>
          <span class="theme-palette-hint">${a.hint}</span>
        </button>
      </li>`;
    })
    .join("");
}

let closeNotesPaletteImpl = () => {};

function closeNotesPalette() {
  closeNotesPaletteImpl();
}

function wireSessionPalette() {
  const els = getSessionPaletteElements();
  if (!els) return;

  const render = (activeIndex) => {
    const rows = [{ key: "logout", label: "Log out", hint: "End your session" }];
    const safeIndex = Math.max(0, Math.min(activeIndex, rows.length - 1));
    els.list.innerHTML = rows
      .map((r, idx) => {
        const isActive = idx === safeIndex;
        return `<li class="theme-palette-item">
        <button type="button" class="theme-palette-option${isActive ? " is-active" : ""}" data-session-action="${r.key}" role="option" aria-selected="${isActive ? "true" : "false"}">
          <span class="theme-palette-name">${r.label}</span>
          <span class="theme-palette-hint">${r.hint}</span>
        </button>
      </li>`;
      })
      .join("");
  };

  let activeIndex = 0;

  const close = () => {
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    activeIndex = 0;
    render(0);
  };

  const runLogout = () => {
    close();
    requestAnimationFrame(() => {
      void doLogout();
    });
  };

  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) close();
  });

  els.list.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-session-action]") : null;
    const action = target?.getAttribute("data-session-action");
    if (action === "logout") runLogout();
  });

  document.addEventListener("keydown", (event) => {
    if (!els.overlay.classList.contains("is-open")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" && !isTypingTarget(event.target)) {
      event.preventDefault();
      const btn = els.list.querySelector(".theme-palette-option.is-active") || els.list.querySelector(".theme-palette-option");
      if (btn instanceof HTMLElement) btn.click();
    }
  });

  document.addEventListener("openSessionPalette", () => {
    if (!state.me) return;
    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    activeIndex = 0;
    render(0);
    requestAnimationFrame(() => {
      const first = els.list.querySelector(".theme-palette-option");
      if (first instanceof HTMLElement) first.focus();
    });
  });
}

function wireNotesPalette() {
  const els = getNotesPaletteElements();
  if (!els) return;

  let noteMetas = [];
  let listRows = [];
  let listActiveIndex = 0;
  let mode = "list";
  let actionActiveIndex = 0;

  const setListMode = () => {
    mode = "list";
    notesPaletteSelectedNoteId = null;
    els.listHead.hidden = false;
    els.actionsHead.hidden = true;
    els.preview.hidden = true;
    els.preview.innerHTML = "";
    els.input.disabled = false;
    els.input.setAttribute("aria-hidden", "false");
  };

  const setActionsMode = async (noteId) => {
    const meta = noteMetas.find((n) => n.id === noteId);
    let page = meta?.page;
    if (!Number.isFinite(page) || page < 1) {
      page = pageFromNoteId(noteId);
    }
    notesPaletteSelectedNoteId = noteId;
    notesPaletteSelectedPage = page;
    mode = "actions";
    els.listHead.hidden = true;
    els.actionsHead.hidden = false;
    els.preview.hidden = false;
    const titleEl = document.querySelector("#notesPaletteActionTitle");
    if (titleEl) titleEl.textContent = `Page ${page}`;
    const body = await fetchNoteBody(noteId);
    els.preview.innerHTML = renderNoteMarkdown(body);
    actionActiveIndex = 0;
    renderNotesPaletteActionRows(els, actionActiveIndex);
    requestAnimationFrame(() => {
      const first = els.list.querySelector(".theme-palette-option");
      if (first instanceof HTMLElement) first.focus();
    });
  };

  const repaintList = () => {
    listRows = getNotesPaletteListRows(els.input.value, noteMetas);
    if (!listRows.length) {
      els.list.innerHTML = `<li class="theme-palette-item"><div class="theme-palette-hint">No matching notes.</div></li>`;
      return;
    }
    listActiveIndex = Math.max(0, Math.min(listActiveIndex, listRows.length - 1));
    renderNotesPaletteListRows(els, listRows, listActiveIndex);
  };

  const close = () => {
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    els.input.value = "";
    setListMode();
    listRows = [];
    listActiveIndex = 0;
    repaintList();
  };

  closeNotesPaletteImpl = close;

  const open = async () => {
    if (!state.currentDocId || !state.pdfDoc) return;
    setListMode();
    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    noteMetas = await fetchNotesList("");
    listActiveIndex = 0;
    repaintList();
    requestAnimationFrame(() => {
      els.input.focus();
      els.input.select?.();
    });
  };

  document.addEventListener("resetNotesPaletteUI", () => {
    els.input.value = "";
    setListMode();
    listRows = [];
    listActiveIndex = 0;
    els.list.innerHTML = "";
  });

  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) close();
  });

  els.backBtn.addEventListener("click", () => {
    setListMode();
    listActiveIndex = 0;
    repaintList();
    requestAnimationFrame(() => {
      els.input.focus();
    });
  });

  els.list.addEventListener("click", (event) => {
    const t = event.target instanceof Element ? event.target.closest("[data-notes-row-key]") : null;
    const rowKey = t?.getAttribute("data-notes-row-key");
    if (rowKey) {
      if (rowKey === NOTE_PALETTE_ADD) {
        close();
        openNotesEditModal(true);
        return;
      }
      void setActionsMode(rowKey);
      return;
    }
    const act = event.target instanceof Element ? event.target.closest("[data-notes-action]") : null;
    const action = act?.getAttribute("data-notes-action");
    if (!action || !notesPaletteSelectedNoteId) return;
    if (action === "jump") {
      void jumpToPage(String(notesPaletteSelectedPage));
      close();
      return;
    }
    if (action === "edit") {
      openNotesEditModal(false);
      return;
    }
    if (action === "delete") {
      if (!confirm("Delete this note?")) return;
      void (async () => {
        const docId = state.currentDocId;
        if (!docId) return;
        const res = await api(`/api/doc/${encodeURIComponent(docId)}/notes/${encodeURIComponent(notesPaletteSelectedNoteId)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          alert(res.data?.error || "Could not delete.");
          return;
        }
        setListMode();
        noteMetas = await fetchNotesList("");
        listActiveIndex = 0;
        repaintList();
        requestAnimationFrame(() => els.input.focus());
      })();
    }
  });

  els.input.addEventListener("input", () => {
    listActiveIndex = 0;
    repaintList();
  });

  els.input.addEventListener("keydown", (event) => {
    if (mode !== "list") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      if (!listRows.length) return;
      listActiveIndex = (listActiveIndex + 1) % listRows.length;
      renderNotesPaletteListRows(els, listRows, listActiveIndex);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!listRows.length) return;
      listActiveIndex = (listActiveIndex - 1 + listRows.length) % listRows.length;
      renderNotesPaletteListRows(els, listRows, listActiveIndex);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!listRows.length) return;
      const row = listRows[listActiveIndex];
      if (!row) return;
      if (row.kind === "add" || row.rowKey === NOTE_PALETTE_ADD) {
        close();
        openNotesEditModal(true);
        return;
      }
      if (row.kind === "note" && row.id) void setActionsMode(row.id);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!els.overlay.classList.contains("is-open")) return;
    if (mode === "list") {
      if (event.key === "Escape" && event.target !== els.input) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setListMode();
      listActiveIndex = 0;
      repaintList();
      requestAnimationFrame(() => els.input.focus());
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      actionActiveIndex = (actionActiveIndex + 1) % 3;
      renderNotesPaletteActionRows(els, actionActiveIndex);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      actionActiveIndex = (actionActiveIndex - 1 + 3) % 3;
      renderNotesPaletteActionRows(els, actionActiveIndex);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const keys = ["jump", "edit", "delete"];
      const k = keys[actionActiveIndex];
      if (k === "jump") {
        void jumpToPage(String(notesPaletteSelectedPage));
        close();
      } else if (k === "edit") {
        openNotesEditModal(false);
      } else if (k === "delete") {
        els.list.querySelector(`[data-notes-action="delete"]`)?.click();
      }
    }
  });

  document.addEventListener("refreshNotesPalette", async () => {
    if (!els.overlay.classList.contains("is-open")) return;
    noteMetas = await fetchNotesList("");
    if (mode === "list") {
      repaintList();
    } else if (notesPaletteSelectedNoteId) {
      await setActionsMode(notesPaletteSelectedNoteId);
    }
  });

  document.addEventListener("openNotesPalette", () => {
    void open();
  });

  document.querySelector("#notesBtn")?.addEventListener("click", () => {
    document.dispatchEvent(new Event("openNotesPalette"));
  });
}

let mobileLayoutMq = null;
let mobileLandscapeMq = null;

function isMobileLayout() {
  return Boolean(mobileLayoutMq?.matches);
}

function isMobileLandscapeViewport() {
  return Boolean(mobileLandscapeMq?.matches);
}

function isMobileLandscapeReader() {
  return (
    isMobileLayout() &&
    document.body.classList.contains("mobile-landscape") &&
    document.body.classList.contains("mobile-screen-reader")
  );
}

function focusThemePalettePrimaryControl() {
  if (isMobileLandscapeReader()) {
    document.querySelector("#mobileLibraryMenuBtn")?.focus();
    return;
  }
  document.querySelector("#themeBtn")?.focus();
}

// Mobile landscape: move notes button beside left rail spacer; restore default placement when leaving.
function syncMobileLandscapeNotesPlacement() {
  const notesBtn = document.querySelector("#notesBtn");
  const leftInner = document.querySelector(".rail-inner-library");
  const rightInner = document.querySelector(".rail-inner-controls");
  const rightSpacer = rightInner?.querySelector(".rail-spacer");
  if (!notesBtn || !leftInner || !rightInner || !rightSpacer) return;

  if (isMobileLandscapeReader()) {
    let slot = document.getElementById("mobileLandscapeNotesSlot");
    if (!slot) {
      slot = document.createElement("div");
      slot.id = "mobileLandscapeNotesSlot";
      slot.className = "rail-spacer";
      slot.setAttribute("aria-hidden", "true");
    }
    const tools = leftInner.querySelector(".library-tools");
    const recentWrap = leftInner.querySelector(".recent-wrap");
    if (tools && recentWrap) {
      recentWrap.insertAdjacentElement("beforebegin", slot);
      slot.insertAdjacentElement("afterend", notesBtn);
    } else if (tools) {
      tools.insertAdjacentElement("afterend", slot);
      slot.insertAdjacentElement("afterend", notesBtn);
    }
    return;
  }

  document.getElementById("mobileLandscapeNotesSlot")?.remove();
  if (notesBtn.parentElement === rightInner && rightSpacer.nextElementSibling === notesBtn) return;
  rightSpacer.insertAdjacentElement("afterend", notesBtn);
}

// Mobile landscape: stack zoom buttons after right spacer; restore #railZoomNavPair when leaving.
function syncMobileLandscapeZoomPlacement() {
  const zoomOut = document.querySelector("#readerZoomOutBtn");
  const zoomIn = document.querySelector("#readerZoomInBtn");
  const pair = document.querySelector("#railZoomNavPair");
  const rightInner = document.querySelector(".rail-inner-controls");
  const rightSpacer = rightInner?.querySelector(".rail-spacer");
  if (!zoomOut || !zoomIn || !pair || !rightInner || !rightSpacer) return;

  if (isMobileLandscapeReader()) {
    let slot = document.getElementById("mobileLandscapeZoomSlot");
    if (!slot) {
      slot = document.createElement("div");
      slot.id = "mobileLandscapeZoomSlot";
      slot.className = "rail-nav-pair";
    }
    rightSpacer.insertAdjacentElement("afterend", slot);
    slot.appendChild(zoomOut);
    slot.appendChild(zoomIn);
    return;
  }

  document.getElementById("mobileLandscapeZoomSlot")?.remove();
  if (zoomOut.parentElement === pair && zoomIn.parentElement === pair) return;
  pair.appendChild(zoomOut);
  pair.appendChild(zoomIn);
}

function syncMobileLandscapeReaderChrome() {
  syncMobileLandscapeZoomPlacement();
  syncMobileLandscapeNotesPlacement();
}

function updateMobileLandscapeClass() {
  if (!isMobileLayout()) {
    document.body.classList.remove("mobile-landscape");
    syncMobileLandscapeReaderChrome();
    return;
  }
  const land = isMobileLandscapeViewport();
  document.body.classList.toggle("mobile-landscape", land);
  if (land && document.body.classList.contains("mobile-screen-reader")) {
    document.body.classList.remove("rail-left-expanded", "rail-right-expanded");
  }
  syncMobileLandscapeReaderChrome();
}

function updateLayoutMode() {
  document.body.classList.toggle("layout-mobile", isMobileLayout());
  if (!isMobileLayout()) {
    document.body.classList.remove("mobile-screen-library", "mobile-screen-reader", "mobile-landscape");
    const chrome = document.querySelector("#mobileReaderChrome");
    chrome?.classList.remove("is-hidden");
    clearMobileChromeHideTimer();
    closeMobileSheets();
    syncMobileLandscapeReaderChrome();
    return;
  }
  updateMobileLandscapeClass();
}

function setMobileScreen(screen) {
  if (!isMobileLayout()) return;
  if (screen === "library") {
    document.body.classList.add("rail-left-expanded");
  }
  document.body.classList.toggle("mobile-screen-library", screen === "library");
  document.body.classList.toggle("mobile-screen-reader", screen === "reader");
  if (screen === "reader") {
    showMobileReaderChrome();
  } else {
    clearMobileChromeHideTimer();
    document.querySelector("#mobileReaderChrome")?.classList.remove("is-hidden");
  }
  updateMobileLandscapeClass();
}

function clearMobileChromeHideTimer() {
  if (state.mobileChromeTimer) {
    clearTimeout(state.mobileChromeTimer);
    state.mobileChromeTimer = null;
  }
}

function scheduleMobileReaderChromeHide() {
  if (!isMobileLayout()) return;
  clearMobileChromeHideTimer();
  const chrome = document.querySelector("#mobileReaderChrome");
  if (!chrome) return;
  chrome.classList.remove("is-hidden");
}

function showMobileReaderChrome() {
  if (!isMobileLayout()) return;
  const chrome = document.querySelector("#mobileReaderChrome");
  if (!chrome) return;
  chrome.classList.remove("is-hidden");
  scheduleMobileReaderChromeHide();
}

function closeMobileSheets() {
  forceCloseSubPalettesForMainCommand();
  closeMainCommandPaletteIfOpen();
}

function syncUrlForMobileLibrary() {
  const u = new URL(window.location.href);
  u.searchParams.delete("doc");
  const q = u.searchParams.toString();
  history.replaceState({ screen: "library" }, "", q ? `${u.pathname}?${q}` : u.pathname);
}

function mobileLibraryUrlString() {
  const u = new URL(window.location.href);
  u.searchParams.delete("doc");
  return u.pathname + (u.searchParams.toString() ? `?${u.searchParams.toString()}` : "");
}

function readerHistoryBasePath() {
  return mobileLibraryUrlString() || "/";
}

function docIdFromHistoryOrLegacyQuery() {
  const st = history.state;
  if (st && st.screen === "reader" && st.docId != null && String(st.docId).trim() !== "") {
    return String(st.docId);
  }
  return new URLSearchParams(window.location.search).get("doc");
}

// Stack [library, reader] so mobile back() stays in-app; use with openDocument(..., { skipHistory: true }).
function seedMobileHistoryLibraryThenReader(docId) {
  if (!isMobileLayout() || !docId) return;
  const base = readerHistoryBasePath();
  history.replaceState({ screen: "library", appReader: true }, "", base);
  history.pushState({ screen: "reader", docId }, "", base);
  state.mobileReaderHistoryPushed = true;
}

function goToMobileLibraryFromReader() {
  if (!isMobileLayout()) return;
  if (document.body.classList.contains("mobile-screen-library")) return;
  closeNotesPalette();
  if (state.mobileReaderHistoryPushed) {
    history.back();
    return;
  }
  history.replaceState({ screen: "library", appReader: true }, "", mobileLibraryUrlString());
  state.mobileReaderHistoryPushed = false;
  setMobileScreen("library");
  clearMobileChromeHideTimer();
  document.querySelector("#mobileReaderChrome")?.classList.remove("is-hidden");
  flushPendingLibrarySearchFocus();
}

function expandAndFocusLibrarySearchField() {
  document.body.classList.add("rail-left-expanded");
  document.body.classList.add("rail-left-searching");
  requestAnimationFrame(() => {
    const input = document.querySelector("#searchInput");
    if (input instanceof HTMLElement) {
      input.focus();
      input.select?.();
    }
  });
}

function flushPendingLibrarySearchFocus() {
  if (!state.pendingLibrarySearchFocus) return;
  state.pendingLibrarySearchFocus = false;
  expandAndFocusLibrarySearchField();
}

function handleHistoryPop() {
  closeNotesPalette();
  const docId = docIdFromHistoryOrLegacyQuery();
  if (isMobileLayout()) {
    if (docId) {
      state.mobileReaderHistoryPushed = true;
      setMobileScreen("reader");
      void openDocument(docId, { skipHistory: true });
    } else {
      state.mobileReaderHistoryPushed = false;
      setMobileScreen("library");
      clearMobileChromeHideTimer();
      document.querySelector("#mobileReaderChrome")?.classList.remove("is-hidden");
      flushPendingLibrarySearchFocus();
    }
    return;
  }
  if (docId) {
    void openDocument(docId, { skipHistory: true });
  }
}

function handleLayoutModeChange() {
  updateLayoutMode();
  if (!isMobileLayout()) return;
  const docParam = docIdFromHistoryOrLegacyQuery();
  if (docParam) {
    state.mobileReaderHistoryPushed = true;
    setMobileScreen("reader");
    if (state.currentDocId !== docParam || !state.pdfDoc) {
      void openDocument(docParam, { skipHistory: true });
    }
    return;
  }
  if (state.currentDocId && state.pdfDoc) {
    history.replaceState({ screen: "reader", docId: state.currentDocId }, "", readerHistoryBasePath());
    state.mobileReaderHistoryPushed = false;
    setMobileScreen("reader");
    return;
  }
  state.mobileReaderHistoryPushed = false;
  setMobileScreen("library");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function ensureMobileLayoutMq() {
  if (mobileLayoutMq) return;
  mobileLayoutMq = window.matchMedia(mobileLayoutMediaQuery());
  mobileLandscapeMq = window.matchMedia("(orientation: landscape)");
  mobileLayoutMq.addEventListener("change", handleLayoutModeChange);
  mobileLandscapeMq.addEventListener("change", () => {
    requestAnimationFrame(() => requestAnimationFrame(() => updateLayoutMode()));
  });
  // WebKit can lag matchMedia on rotation; double rAF is a common iOS workaround.
  const syncAfterViewportChange = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => updateLayoutMode());
    });
  };
  window.addEventListener("orientationchange", syncAfterViewportChange);
}

// Boot doc id: server resume (openId) wins over ?doc= when they differ; ?doc=&forceDoc=1 forces query.
function pickResumeDocIdFromBoot(openId, docParam) {
  const q = new URLSearchParams(window.location.search);
  if (q.get("forceDoc") === "1" && docParam) return docParam;
  if (openId && docParam && openId !== docParam) return openId;
  return docParam || openId || null;
}

async function bootReaderAfterAuth(userPayload) {
  state.me = { id: userPayload.id, username: userPayload.username };
  showReader();
  ensureMobileLayoutMq();
  updateLayoutMode();
  await refreshRecent();
  const docParam = new URLSearchParams(window.location.search).get("doc");
  const openId = userPayload?.openDocId;
  const idToOpen = pickResumeDocIdFromBoot(openId, docParam);
  if (idToOpen) {
    if (isMobileLayout()) {
      seedMobileHistoryLibraryThenReader(idToOpen);
      setMobileScreen("reader");
    }
    await openDocument(idToOpen, { skipHistory: true });
  } else if (isMobileLayout()) {
    const u = new URL(window.location.href);
    u.searchParams.delete("doc");
    const q = u.searchParams.toString();
    history.replaceState({ screen: "library", appReader: true }, "", q ? `${u.pathname}?${q}` : u.pathname);
    state.mobileReaderHistoryPushed = false;
    setMobileScreen("library");
  }
  registerServiceWorker();
}

renderSkeleton();
wireGlobalActions();
bootstrap();

async function bootstrap() {
  try {
    const me = await api("/api/me");
    if (!me.ok) {
      showLogin();
      return;
    }
    await bootReaderAfterAuth(me.data);
  } catch {
    showLogin();
  }
}

function renderSkeleton() {
  app.innerHTML = `
    <section class="login hidden" id="loginView">
      <form class="login-card" id="loginForm">
        <h1 class="login-title">Docker Reader</h1>
        <p class="subtle">Quiet PDF reading for focused study.</p>
        <input id="loginUser" autocomplete="username" placeholder="username" required />
        <input id="loginPass" type="password" autocomplete="current-password" placeholder="password" required />
        <button type="submit">Enter</button>
        <p class="subtle" id="loginError"></p>
      </form>
    </section>

    <section class="app-layout hidden" id="readerView">
      <main class="viewer-shell" aria-label="Reader">
        <section class="viewer-stage" id="viewerStage">
          <p class="status" id="statusText">Open a document from search or recent.</p>
        </section>
      </main>

      <aside class="rail rail-left" id="railLeftPanel" aria-label="Library">
        <div class="rail-inner rail-inner-library">
          <header class="mobile-library-header">
            <div class="rail-search-slot" id="railSearchSlot">
              <input
                id="searchInput"
                class="rail-input rail-search-input"
                type="search"
                placeholder="Search PDFs…"
                autocomplete="off"
                aria-label="Search PDFs"
              />
              <button type="button" id="searchBtn" class="rail-btn rail-search-btn" aria-label="Search library">
                ${icoSearch()}
                <span class="rail-btn-text">Search</span>
              </button>
            </div>
            <button
              type="button"
              class="mobile-library-menu-btn rail-btn"
              id="mobileLibraryMenuBtn"
              aria-label="Library menu"
              aria-expanded="false"
              aria-haspopup="true"
            >
              ${icoDots()}
            </button>
          </header>
          <header class="rail-head">
            <h2 class="title rail-title">Library</h2>
          </header>

          <div class="library-tools">
            <label class="rail-btn rail-btn-upload add-pdf" id="addPdfLabel" aria-label="Add PDF">
              <input type="file" id="uploadInput" accept="application/pdf,.pdf" />
              <span class="add-pdf-face" id="addPdfFace">
                ${icoPlus()}
                <span class="rail-btn-text" id="addPdfFaceText">Add PDF</span>
              </span>
            </label>
          </div>

          <div class="recent-wrap">
            <ul class="recent-list" id="recentList"></ul>
          </div>
        </div>
        <button
          type="button"
          id="railLeftEdgeHandle"
          class="rail-edge-handle rail-edge-handle-library"
          aria-expanded="false"
          aria-controls="railLeftPanel"
        >
          <span class="rail-handle-icon-wrap" aria-hidden="true">
            <span class="rail-handle-phase rail-handle-phase-expanded">${icoChevLeftTiny()}</span>
            <span class="rail-handle-phase rail-handle-phase-collapsed">${icoChevRightTiny()}</span>
          </span>
        </button>
      </aside>

      <aside class="rail rail-right" id="railRightPanel" aria-label="Reader controls">
        <div class="rail-inner rail-inner-controls">
            <button type="button" id="railsToggleBtn" class="rail-btn rail-btn-toggle" title="Toggle right panel width" aria-label="Toggle right panel">
            ${icoMenu()}
            <span class="rail-btn-text">Panels</span>
          </button>

          <div class="rail-nav-pair">
            <button type="button" id="nextBtn" class="rail-btn rail-btn-nav" aria-label="Next page">
              ${icoChevRight()}
              <span class="rail-btn-text">Next</span>
            </button>
            <button type="button" id="prevBtn" class="rail-btn rail-btn-nav" aria-label="Previous page">
              ${icoChevLeft()}
              <span class="rail-btn-text">Prev</span>
            </button>
          </div>

          <div class="rail-page-box">
            <span class="rail-page-label" id="railPageBoxLabel">Page</span>
            <div class="rail-page-stack" role="group" aria-labelledby="railPageBoxLabel">
              <input id="pageNumberInput" class="rail-input rail-input-page-ghost" type="text" inputmode="numeric" spellcheck="false" placeholder="—" aria-label="Current page" />
              <span id="pageCountLabel" class="rail-page-total">—</span>
            </div>
          </div>

          <div class="rail-nav-pair" id="railZoomNavPair">
            <button type="button" id="readerZoomOutBtn" class="rail-btn rail-btn-nav" aria-label="Zoom out">
              ${icoZoomOut()}
              <span class="rail-btn-text">Zoom out</span>
            </button>
            <button type="button" id="readerZoomInBtn" class="rail-btn rail-btn-nav" aria-label="Zoom in">
              ${icoZoomIn()}
              <span class="rail-btn-text">Zoom in</span>
            </button>
          </div>

          <div class="rail-doc-box">
            <span class="rail-doc-label">Document</span>
            <div id="docTitle" class="rail-doc-title" title="">—</div>
          </div>

          <div class="rail-spacer"></div>

          <button type="button" id="notesBtn" class="rail-btn rail-btn-notes" aria-label="Notes" disabled>
            ${icoNotes()}
            <span class="rail-btn-text">Notes</span>
          </button>

          <button type="button" id="themeBtn" class="rail-btn rail-btn-theme" aria-label="Themes">
            ${icoPalette()}
            <span class="rail-btn-text">Theme</span>
          </button>

          <button type="button" id="logoutBtn" class="rail-btn rail-btn-logout" aria-label="Log out">
            ${icoLogout()}
            <span class="rail-btn-text">Log out</span>
          </button>
        </div>
        <button
          type="button"
          id="railRightEdgeHandle"
          class="rail-edge-handle rail-edge-handle-controls"
          aria-expanded="false"
          aria-controls="railRightPanel"
        >
          <span class="rail-handle-icon-wrap" aria-hidden="true">
            <span class="rail-handle-phase rail-handle-phase-expanded">${icoChevRightTiny()}</span>
            <span class="rail-handle-phase rail-handle-phase-collapsed">${icoChevLeftTiny()}</span>
          </span>
        </button>
      </aside>

      <nav class="mobile-reader-chrome" id="mobileReaderChrome" aria-label="Reader toolbar">
        <button type="button" class="mobile-rc-btn mobile-rc-back" id="mobileReaderBackBtn" aria-label="Back to library">
          ${icoChevLeft()}
          <span class="mobile-rc-text">Library</span>
        </button>
        <div class="mobile-rc-nav">
          <button type="button" id="mobileReaderPrevBtn" class="mobile-rc-btn" aria-label="Previous page">${icoChevLeft()}</button>
          <button type="button" id="mobileReaderPageBtn" class="mobile-rc-page" aria-label="Go to page">—</button>
          <button type="button" id="mobileReaderNextBtn" class="mobile-rc-btn" aria-label="Next page">${icoChevRight()}</button>
        </div>
        <div class="mobile-rc-zoom">
          <button type="button" id="mobileReaderZoomOutBtn" class="mobile-rc-btn" aria-label="Zoom out">${icoZoomOut()}</button>
          <button type="button" id="mobileReaderZoomInBtn" class="mobile-rc-btn" aria-label="Zoom in">${icoZoomIn()}</button>
        </div>
        <button
          type="button"
          class="mobile-rc-btn mobile-rc-overflow"
          id="mobileReaderOverflowBtn"
          aria-label="More options"
          aria-expanded="false"
          aria-haspopup="true"
        >
          ${icoDots()}
        </button>
      </nav>
    </section>

    <div class="theme-palette-overlay" id="mainCommandPaletteOverlay" aria-hidden="true">
      <div class="theme-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="theme-palette-head">
          <input
            id="mainCommandPaletteInput"
            class="rail-input theme-palette-input"
            type="search"
            placeholder="Type a command…"
            autocomplete="off"
            spellcheck="false"
            aria-label="Filter commands"
          />
        </div>
        <ul class="theme-palette-list" id="mainCommandPaletteList" role="listbox" aria-label="Commands"></ul>
      </div>
    </div>

    <div class="theme-palette-overlay" id="themePaletteOverlay" aria-hidden="true">
      <div class="theme-palette" role="dialog" aria-modal="true" aria-label="Themes">
        <div class="theme-palette-head">
          <input
            id="themePaletteInput"
            class="rail-input theme-palette-input"
            type="search"
            placeholder="Theme…"
            autocomplete="off"
            spellcheck="false"
            aria-label="Search themes"
          />
        </div>
        <ul class="theme-palette-list" id="themePaletteList" role="listbox" aria-label="Theme results"></ul>
      </div>
    </div>

    <div class="theme-palette-overlay" id="pageJumpOverlay" aria-hidden="true">
      <div class="theme-palette" role="dialog" aria-modal="true" aria-label="Go to page">
        <form class="theme-palette-head page-jump-form" id="pageJumpForm">
          <label class="page-jump-title" for="pageJumpInput">Go to page</label>
          <input
            id="pageJumpInput"
            class="rail-input theme-palette-input"
            type="text"
            inputmode="numeric"
            placeholder="Type a page number…"
            autocomplete="off"
            spellcheck="false"
            aria-label="Go to page"
          />
          <button type="submit" class="rail-btn page-jump-submit">Go</button>
        </form>
      </div>
    </div>

    <div class="theme-palette-overlay" id="bookPaletteOverlay" aria-hidden="true">
      <div class="theme-palette" role="dialog" aria-modal="true" aria-label="Library">
        <div class="theme-palette-head">
          <input
            id="bookPaletteInput"
            class="rail-input theme-palette-input"
            type="search"
            placeholder="Search library…"
            autocomplete="off"
            spellcheck="false"
            aria-label="Search library"
          />
        </div>
        <ul class="theme-palette-list" id="bookPaletteList" role="listbox" aria-label="Library"></ul>
      </div>
    </div>

    <div class="theme-palette-overlay" id="notesPaletteOverlay" aria-hidden="true">
      <div class="theme-palette notes-palette-dialog" role="dialog" aria-modal="true" aria-label="Notes">
        <div class="theme-palette-head" id="notesPaletteListHead">
          <input
            id="notesPaletteInput"
            class="rail-input theme-palette-input"
            type="search"
            placeholder="Search notes…"
            autocomplete="off"
            spellcheck="false"
            aria-label="Search notes"
          />
        </div>
        <div class="notes-palette-actions-head" id="notesPaletteActionsHead" hidden>
          <button type="button" class="rail-btn notes-palette-back-btn" id="notesPaletteBackBtn">Back</button>
          <span class="notes-palette-actions-title" id="notesPaletteActionTitle">Note</span>
        </div>
        <div class="notes-palette-preview markdown-body" id="notesPalettePreview" hidden></div>
        <ul class="theme-palette-list notes-palette-list" id="notesPaletteList" role="listbox" aria-label="Notes"></ul>
      </div>
    </div>

    <div class="theme-palette-overlay" id="sessionPaletteOverlay" aria-hidden="true">
      <div class="theme-palette" role="dialog" aria-modal="true" aria-label="Session">
        <div class="theme-palette-head session-palette-head">
          <span class="session-palette-label">Session</span>
        </div>
        <ul class="theme-palette-list" id="sessionPaletteList" role="listbox" aria-label="Session actions"></ul>
      </div>
    </div>

    <div class="notes-edit-overlay" id="notesEditOverlay" aria-hidden="true">
      <div class="notes-edit-backdrop" id="notesEditBackdrop"></div>
      <div class="notes-edit-dialog" role="dialog" aria-modal="true" aria-label="Edit note">
        <label class="notes-edit-label" for="notesEditTextarea">Markdown</label>
        <textarea id="notesEditTextarea" class="notes-edit-textarea" spellcheck="true"></textarea>
        <div class="notes-edit-actions">
          <button type="button" class="rail-btn" id="notesEditCancelBtn">Cancel</button>
          <button type="button" class="rail-btn" id="notesEditSaveBtn">Save</button>
        </div>
      </div>
    </div>
  `;
}

function wireGlobalActions() {
  installNoBrowserZoom();
  ensureMobileLayoutMq();
  updateLayoutMode();
  window.addEventListener("popstate", handleHistoryPop);
  document.querySelector("#loginForm").addEventListener("submit", doLogin);
  document.querySelector("#logoutBtn").addEventListener("click", () => {
    document.dispatchEvent(new Event("openSessionPalette"));
  });
  document.querySelector("#searchBtn").addEventListener("click", () => {
    if (!document.body.classList.contains("rail-left-expanded")) {
      document.body.classList.add("rail-left-expanded");
    }
    document.body.classList.add("rail-left-searching");
    requestAnimationFrame(() => {
      const input = document.querySelector("#searchInput");
      input?.focus();
      input?.select?.();
    });
  });
  const searchInputEl = document.querySelector("#searchInput");
  searchInputEl.addEventListener("input", () => {
    void search(searchInputEl.value);
  });
  searchInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      document.body.classList.remove("rail-left-searching");
      document.querySelector("#searchBtn")?.focus();
      return;
    }
    if (event.key === "Enter") {
      void search(event.target.value);
    }
  });
  document.querySelector("#searchInput").addEventListener("blur", () => {
    setTimeout(() => {
      const slot = document.querySelector("#railSearchSlot");
      if (slot && slot.contains(document.activeElement)) return;
      document.body.classList.remove("rail-left-searching");
    }, 0);
  });
  document.querySelector("#uploadInput").addEventListener("change", () => void uploadSelectedPdf());
  document.querySelector("#prevBtn").addEventListener("click", () => changePage(-1));
  document.querySelector("#nextBtn").addEventListener("click", () => changePage(1));
  document.querySelector("#pageNumberInput").addEventListener("keydown", handlePageInputKeydown);
  document.querySelector("#pageNumberInput").addEventListener("focus", handlePageInputFocus);
  document.querySelector("#pageNumberInput").addEventListener("click", handlePageInputFocus);
  document.querySelector("#pageNumberInput").addEventListener("blur", updatePageInfo);
  document.querySelector("#railsToggleBtn").addEventListener("click", () => {
    if (isMobileLandscapeReader()) return;
    document.body.classList.toggle("rail-right-expanded");
  });

  document.querySelector("#mobileLibraryMenuBtn")?.addEventListener("click", () => {
    document.dispatchEvent(new Event("openMainCommandPalette"));
  });

  document.querySelector("#mobileReaderBackBtn")?.addEventListener("click", () => {
    goToMobileLibraryFromReader();
  });
  document.querySelector("#mobileReaderPrevBtn")?.addEventListener("click", () => {
    showMobileReaderChrome();
    void changePage(-1);
  });
  document.querySelector("#mobileReaderNextBtn")?.addEventListener("click", () => {
    showMobileReaderChrome();
    void changePage(1);
  });
  document.querySelector("#mobileReaderPageBtn")?.addEventListener("click", () => {
    showMobileReaderChrome();
    document.dispatchEvent(new Event("openPageJumpPalette"));
  });
  document.querySelector("#mobileReaderZoomOutBtn")?.addEventListener("click", () => {
    showMobileReaderChrome();
    changeZoom(-1);
  });
  document.querySelector("#mobileReaderZoomInBtn")?.addEventListener("click", () => {
    showMobileReaderChrome();
    changeZoom(1);
  });
  document.querySelector("#readerZoomOutBtn")?.addEventListener("click", () => {
    changeZoom(-1);
  });
  document.querySelector("#readerZoomInBtn")?.addEventListener("click", () => {
    changeZoom(1);
  });
  document.querySelector("#mobileReaderOverflowBtn")?.addEventListener("click", () => {
    showMobileReaderChrome();
    document.dispatchEvent(new Event("openMainCommandPalette"));
  });

  const viewerStageEl = document.querySelector("#viewerStage");
  if (viewerStageEl) {
    installMobileViewerPinch(viewerStageEl);
    installMobileScrollAxisLock(viewerStageEl);
    viewerStageEl.addEventListener("pointerdown", () => {
      if (isMobileLayout() && document.body.classList.contains("mobile-screen-reader")) {
        showMobileReaderChrome();
      }
    });
  }

  const mobileChrome = document.querySelector("#mobileReaderChrome");
  mobileChrome?.addEventListener("pointerdown", (event) => {
    if (event.target === mobileChrome) return;
    if (isMobileLayout() && document.body.classList.contains("mobile-screen-reader")) {
      showMobileReaderChrome();
    }
  });

  document.querySelector("#notesEditBackdrop")?.addEventListener("click", () => closeNotesEditModal());
  document.querySelector("#notesEditCancelBtn")?.addEventListener("click", () => closeNotesEditModal());
  document.querySelector("#notesEditSaveBtn")?.addEventListener("click", () => void saveNotesEdit());

  wireThemePalette();
  wirePageJumpPalette();
  wireBookPalette();
  wireSessionPalette();
  wireNotesPalette();
  wireMainCommandPalette();
  wireRailBackdropToggles();
  wireRailEdgeHandles();
  window.addEventListener("resize", handleViewerResize);
  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushViewerPersistForUnload();
  });
  window.addEventListener("pagehide", () => flushViewerPersistForUnload());
}

function wireRailBackdropToggles() {
  const left = document.querySelector(".rail-left");
  const right = document.querySelector(".rail-right");
  left.addEventListener("click", (e) => {
    if (!isLeftRailBackdropClick(e.target)) return;
    if (isMobileLayout() && document.body.classList.contains("mobile-screen-library")) return;
    if (isMobileLandscapeReader()) return;
    document.body.classList.toggle("rail-left-expanded");
  });
  right.addEventListener("click", (e) => {
    if (!isRightRailBackdropClick(e.target)) return;
    if (isMobileLandscapeReader()) return;
    document.body.classList.toggle("rail-right-expanded");
  });
}

function isLeftRailBackdropClick(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("button, input, textarea, select, label, a, .recent-doc-btn")) return false;
  if (target.closest(".recent-list")) return false;
  if (target.closest(".library-tools")) return false;
  return Boolean(target.closest(".rail-left"));
}

function isRightRailBackdropClick(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("button, input, textarea, select, label, a")) return false;
  if (target.closest(".rail-page-box, .rail-doc-box")) return false;
  return Boolean(target.closest(".rail-right"));
}

function syncRailEdgeHandleState() {
  const leftHandle = document.querySelector("#railLeftEdgeHandle");
  const rightHandle = document.querySelector("#railRightEdgeHandle");
  if (!leftHandle && !rightHandle) return;
  const l = document.body.classList.contains("rail-left-expanded");
  const r = document.body.classList.contains("rail-right-expanded");
  if (leftHandle) {
    leftHandle.setAttribute("aria-expanded", l ? "true" : "false");
    leftHandle.setAttribute(
      "aria-label",
      l ? "Collapse library panel" : "Expand library panel",
    );
    leftHandle.title = l ? "Collapse library panel" : "Expand library panel";
  }
  if (rightHandle) {
    rightHandle.setAttribute("aria-expanded", r ? "true" : "false");
    rightHandle.setAttribute(
      "aria-label",
      r ? "Collapse reader tools panel" : "Expand reader tools panel",
    );
    rightHandle.title = r ? "Collapse reader tools panel" : "Expand reader tools panel";
  }
}

function wireRailEdgeHandles() {
  const left = document.querySelector("#railLeftEdgeHandle");
  const right = document.querySelector("#railRightEdgeHandle");
  left?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isMobileLayout()) return;
    document.body.classList.toggle("rail-left-expanded");
  });
  right?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isMobileLayout()) return;
    document.body.classList.toggle("rail-right-expanded");
  });
  syncRailEdgeHandleState();
  new MutationObserver(() => syncRailEdgeHandleState()).observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

function showLogin() {
  document.querySelector("#loginView").classList.remove("hidden");
  document.querySelector("#readerView").classList.add("hidden");
}

function showReader() {
  document.querySelector("#readerView").classList.remove("hidden");
  document.querySelector("#loginView").classList.add("hidden");
}

async function doLogin(event) {
  event.preventDefault();
  const username = document.querySelector("#loginUser").value.trim();
  const password = document.querySelector("#loginPass").value;
  const result = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!result.ok) {
    document.querySelector("#loginError").textContent = "Invalid login";
    return;
  }
  const u = result.data.user;
  await bootReaderAfterAuth({
    id: u.id,
    username: u.username,
    openDocId: result.data?.openDocId,
  });
}

async function doLogout() {
  closeMobileSheets();
  closeNotesEditModal();
  clearMobileChromeHideTimer();
  state.mobileReaderHistoryPushed = false;
  await api("/api/logout", { method: "POST" });
  state.me = null;
  cancelPageRender();
  state.pdfDoc = null;
  state.viewerShell = null;
  await clearPdfDocCache();
  showLogin();
}

async function uploadSelectedPdf() {
  const input = document.querySelector("#uploadInput");
  const label = document.querySelector("#addPdfLabel");
  const faceText = document.querySelector("#addPdfFaceText");
  if (!input.files?.length) return;
  const originalText = faceText.textContent;
  label.classList.add("is-busy");
  faceText.textContent = "Uploading…";
  try {
    const formData = new FormData();
    formData.append("file", input.files[0]);
    const result = await api("/api/upload", {
      method: "POST",
      body: formData,
      isJSON: false,
    });
    if (result.ok) {
      input.value = "";
      await refreshRecent();
      if (result.data?.document?.id) {
        await openDocument(result.data.document.id);
      }
    } else {
      alert(result.data?.error || "Upload failed.");
    }
  } catch (err) {
    alert("Upload failed: " + err.message);
  } finally {
    label.classList.remove("is-busy");
    faceText.textContent = originalText;
  }
}

async function search(query) {
  const q = String(query ?? "").trim();
  if (!q) {
    await refreshRecent();
    return;
  }
  const result = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (!result.ok) return;
  state.docs = result.data.documents || [];
  renderRecent(state.docs, true);
}

async function refreshRecent() {
  const result = await api("/api/library");
  if (!result.ok) return;
  const docs = result.data.documents || [];
  const items = docs.map((d) => ({
    id: d.id,
    docId: d.id,
    title: d.title,
  }));
  renderRecent(items, false);
}

function initialForDocTitle(title) {
  const s = String(title || "").trim();
  if (!s) return "?";
  const ch = s.match(/\p{L}/u)?.[0] || s[0];
  return ch.toUpperCase();
}

function renderRecent(items, searchMode) {
  const list = document.querySelector("#recentList");
  const wrap = document.querySelector(".rail-left .recent-wrap");
  if (wrap) {
    wrap.classList.remove("is-hidden");
  }
  list.innerHTML = "";
  const collection = items.slice(0, 80);
  if (!collection.length) {
    if (!searchMode && wrap) {
      wrap.classList.add("is-hidden");
      return;
    }
    const msg = searchMode ? "No matches." : "No PDFs in your library.";
    list.innerHTML = `<li class="recent-item recent-empty" role="status"><span class="recent-empty-hint">${msg}</span></li>`;
    return;
  }
  collection.forEach((item) => {
    const li = document.createElement("li");
    li.className = "recent-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-doc-btn";
    const title = item.title || "Untitled";
    button.textContent = title;
    button.title = title;
    button.dataset.initial = initialForDocTitle(title);
    button.addEventListener("click", () => {
      closeMobileSheets();
      void openDocument(item.id || item.docId);
    });
    li.appendChild(button);
    list.appendChild(li);
  });
}

async function openDocument(docId, opts = {}) {
  if (!docId) return;
  if (state.currentDocId && state.currentDocId !== docId) {
    closeNotesPalette();
  }
  state.pendingScrollRestore = null;
  const [meta, progressRes] = await Promise.all([
    api(`/api/doc/${encodeURIComponent(docId)}`),
    api(`/api/doc/${encodeURIComponent(docId)}/progress`),
  ]);
  if (!meta.ok) return;
  const skipHistory = opts.skipHistory === true;
  if (isMobileLayout()) {
    if (!skipHistory) {
      history.pushState({ screen: "reader", docId }, "", readerHistoryBasePath());
      state.mobileReaderHistoryPushed = true;
    }
    setMobileScreen("reader");
  }
  state.currentDoc = meta.data;
  state.currentDocId = docId;
  state.pdfDoc = null;
  state.viewerShell = null;
  state.page = 1;
  state.zoomPercent = 100;
  const titleEl = document.querySelector("#docTitle");
  const t = state.currentDoc.title || "Untitled";
  titleEl.textContent = t;
  titleEl.title = t;
  if (progressRes.ok) {
    const p = Number(progressRes.data?.page || 1);
    if (Number.isFinite(p) && p >= 1) {
      state.page = Math.floor(p);
    }
    let z = Number(progressRes.data?.zoomPercent);
    if (!Number.isFinite(z)) z = 100;
    state.zoomPercent = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z)));
    const st = Number(progressRes.data?.scrollTop);
    const sl = Number(progressRes.data?.scrollLeft);
    if (Number.isFinite(st) && Number.isFinite(sl)) {
      state.pendingScrollRestore = { top: Math.max(0, st), left: Math.max(0, sl) };
    }
  }
  updatePageInfo();
  clearTimeout(state.progressSaveTimer);
  state.progressSaveTimer = null;
  // POST focus early so server resume works if load is killed mid-flight (e.g. mobile).
  sendViewerPersist(buildInitialOpenPersistPayload());
  await loadPdf(docId, `/api/doc/${encodeURIComponent(docId)}/file`);
  if (isMobileLayout()) {
    showMobileReaderChrome();
  }
}

async function loadPdf(docId, fileUrl) {
  const stage = document.querySelector("#viewerStage");
  state.pdfDoc = null;
  state.viewerShell = null;
  cancelPageRender();
  state.pageCache.clear();

  let pdf = getCachedPdfDoc(docId);

  if (!pdf) {
    stage.classList.add("is-pdf-loading");
    stage.innerHTML = `<p class="status viewer-loading-msg">Loading PDF…</p>`;
    try {
      const loadingTask = pdfjsLib.getDocument({ url: fileUrl, withCredentials: true });
      pdf = await loadingTask.promise;
    } catch {
      state.pendingScrollRestore = null;
      stage.classList.remove("is-pdf-loading");
      stage.innerHTML = `<p class="status viewer-loading-msg">Failed to load PDF.</p>`;
      state.pdfDoc = null;
      updatePageInfo();
      return;
    }
    if (state.currentDocId !== docId) {
      try {
        await pdf.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    await putCachedPdfDoc(docId, pdf);
  }

  if (state.currentDocId !== docId) {
    return;
  }

  state.pdfDoc = pdf;
  stage.classList.remove("is-pdf-loading");
  ensureViewerShell(stage);
  clampCurrentPage();
  updatePageInfo();
  await renderPage();
  if (state.currentDocId !== docId) {
    return;
  }
  applyPendingScrollOrReset();
  queueProgressSave();
}

function cancelPageRender() {
  state.renderVersion += 1;
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
}

function getPdfOutputScale() {
  const pr = Math.min(window.devicePixelRatio || 1, MAX_PDF_PIXEL_RATIO);
  return {
    sx: pr,
    sy: pr,
    get scaled() {
      return pr !== 1;
    },
  };
}

function ensureViewerShell(stage) {
  if (state.viewerShell?.frame?.isConnected) {
    return state.viewerShell;
  }

  const frame = document.createElement("div");
  frame.className = "page-frame";

  const pageWrap = document.createElement("div");
  pageWrap.className = "page-wrap";

  const canvas = document.createElement("canvas");

  pageWrap.appendChild(canvas);
  frame.appendChild(pageWrap);
  stage.replaceChildren(frame);

  state.viewerShell = { frame, pageWrap, canvas };
  return state.viewerShell;
}

async function renderPage() {
  if (!state.pdfDoc) return;
  cancelPageRender();
  const renderVersion = state.renderVersion;
  const pageNumber = state.page;
  const stage = document.querySelector("#viewerStage");
  const page = await getPageProxy(pageNumber);
  if (renderVersion !== state.renderVersion) return;

  const baseViewport = page.getViewport({ scale: 1 });
  const fitScale = getFitPageScale(baseViewport.width, baseViewport.height);
  const scale = fitScale * (state.zoomPercent / 100);
  const viewport = page.getViewport({ scale });
  const outputScale = getPdfOutputScale();
  const w = viewport.width;
  const h = viewport.height;

  const { pageWrap, canvas } = ensureViewerShell(stage);
  pageWrap.style.width = `${w}px`;
  pageWrap.style.height = `${h}px`;

  const pw = Math.max(1, Math.floor(w * outputScale.sx));
  const ph = Math.max(1, Math.floor(h * outputScale.sy));
  canvas.width = pw;
  canvas.height = ph;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pw, ph);
  const transform = outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : null;

  const renderTask = page.render({
    canvasContext: ctx,
    viewport,
    transform,
  });
  state.renderTask = renderTask;
  try {
    await renderTask.promise;
  } catch {
    return;
  } finally {
    state.renderTask = null;
  }
  if (renderVersion !== state.renderVersion) return;

  syncShortPageVerticalCenter();
}

async function changePage(delta) {
  if (!state.pdfDoc) return;
  const next = state.page + delta;
  if (next < 1 || next > state.pdfDoc.numPages) return;
  state.page = next;
  updatePageInfo();
  queueProgressSave();
  resetViewerScroll();
  await renderPage();
}

function handlePageInputKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    void jumpToPage(event.target.value);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    void jumpToPage(state.page + 1);
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    void jumpToPage(state.page - 1);
  }
}

function handleViewerResize() {
  if (mobileLayoutMq?.matches) updateMobileLandscapeClass();
  if (!state.pdfDoc) return;
  clearTimeout(resizeRenderTimer);
  resizeRenderTimer = setTimeout(() => {
    updatePageInfo();
    void renderPage();
  }, 120);
}

function getFitPageScale(pageWidth, pageHeight) {
  const stage = document.querySelector("#viewerStage");
  if (!stage || !pageWidth || !pageHeight) {
    return 1;
  }

  const style = window.getComputedStyle(stage);
  const horizontalPadding =
    parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
  const verticalPadding =
    parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
  const availableWidth = Math.max(200, stage.clientWidth - horizontalPadding);
  const availableHeight = Math.max(200, stage.clientHeight - verticalPadding);
  const fitWidth = availableWidth / pageWidth;
  const fitHeight = availableHeight / pageHeight;

  return Math.min(fitWidth, fitHeight);
}

function pageFromNoteId(noteId) {
  const m = String(noteId).match(/^p0*(\d+)_/);
  if (!m) return state.page || 1;
  const p = parseInt(m[1], 10);
  return Number.isFinite(p) && p >= 1 ? p : state.page || 1;
}

async function fetchNotesList(query = "") {
  const id = state.currentDocId;
  if (!id) return [];
  const q = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const res = await api(`/api/doc/${encodeURIComponent(id)}/notes${q}`);
  if (!res.ok) return [];
  return Array.isArray(res.data.notes) ? res.data.notes : [];
}

async function fetchNoteBody(noteId) {
  const id = state.currentDocId;
  if (!id) return "";
  const res = await api(`/api/doc/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`);
  if (!res.ok) return "";
  return String(res.data.body || "");
}

function openNotesEditModal(isNew) {
  notesEditTargetId = isNew ? null : notesPaletteSelectedNoteId;
  const overlay = document.querySelector("#notesEditOverlay");
  const ta = document.querySelector("#notesEditTextarea");
  if (!(overlay instanceof HTMLElement) || !(ta instanceof HTMLTextAreaElement)) return;
  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");
  if (isNew) {
    ta.value = "";
    requestAnimationFrame(() => ta.focus());
    return;
  }
  const nid = notesPaletteSelectedNoteId;
  if (nid) {
    ta.value = "";
    void (async () => {
      ta.value = await fetchNoteBody(nid);
      ta.focus();
    })();
  }
}

function closeNotesEditModal() {
  const overlay = document.querySelector("#notesEditOverlay");
  if (!(overlay instanceof HTMLElement)) return;
  overlay.classList.remove("is-open");
  overlay.setAttribute("aria-hidden", "true");
  const ta = document.querySelector("#notesEditTextarea");
  if (ta instanceof HTMLTextAreaElement) ta.value = "";
  notesEditTargetId = null;
}

async function saveNotesEdit() {
  const ta = document.querySelector("#notesEditTextarea");
  if (!(ta instanceof HTMLTextAreaElement)) return;
  const body = ta.value;
  const docId = state.currentDocId;
  if (!docId) return;
  if (notesEditTargetId) {
    const res = await api(`/api/doc/${encodeURIComponent(docId)}/notes/${encodeURIComponent(notesEditTargetId)}`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      alert(res.data?.error || "Could not save note.");
      return;
    }
    closeNotesEditModal();
    document.dispatchEvent(new Event("refreshNotesPalette"));
    return;
  }
  const page = state.page || 1;
  const res = await api(`/api/doc/${encodeURIComponent(docId)}/notes`, {
    method: "POST",
    body: JSON.stringify({ page, body }),
  });
  if (!res.ok) {
    alert(res.data?.error || "Could not create note.");
    return;
  }
  closeNotesEditModal();
  if (res.data?.id) {
    notesPaletteSelectedNoteId = res.data.id;
  }
  document.dispatchEvent(new Event("refreshNotesPalette"));
}

async function api(url, options = {}) {
  const request = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: {},
    body: options.body,
  };
  if (options.isJSON !== false && options.body !== undefined) {
    request.headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, request);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function updatePageInfo() {
  const input = document.querySelector("#pageNumberInput");
  const countLabel = document.querySelector("#pageCountLabel");
  if (!state.pdfDoc) {
    input.value = "";
    input.disabled = true;
    input.placeholder = "—";
    input.size = 2;
    countLabel.textContent = "—";
    const nb = document.querySelector("#notesBtn");
    if (nb instanceof HTMLButtonElement) nb.disabled = true;
    return;
  }
  input.disabled = false;
  input.placeholder = "";
  input.value = String(state.page);
  countLabel.textContent = String(state.pdfDoc.numPages);
  const digitSlots = Math.max(
    String(state.page).length,
    String(state.pdfDoc.numPages).length,
    2
  );
  input.size = digitSlots;
  const mobilePageBtn = document.querySelector("#mobileReaderPageBtn");
  if (mobilePageBtn) {
    if (!state.pdfDoc) {
      mobilePageBtn.textContent = "—";
    } else {
      mobilePageBtn.textContent = `${state.page} / ${state.pdfDoc.numPages}`;
    }
  }
  const notesBtn = document.querySelector("#notesBtn");
  if (notesBtn instanceof HTMLButtonElement) {
    notesBtn.disabled = !state.currentDocId;
  }
}

function getPageProxy(pageNumber) {
  if (!state.pageCache.has(pageNumber)) {
    state.pageCache.set(pageNumber, state.pdfDoc.getPage(pageNumber));
  }
  return state.pageCache.get(pageNumber);
}

function clampCurrentPage() {
  if (!state.pdfDoc) return;
  state.page = Math.max(1, Math.min(state.pdfDoc.numPages, state.page));
}

async function jumpToPage(rawPage) {
  if (!state.pdfDoc) return;
  const page = parsePageInputValue(rawPage);
  if (!Number.isFinite(page)) {
    updatePageInfo();
    return;
  }
  const next = Math.max(1, Math.min(state.pdfDoc.numPages, Math.floor(page)));
  if (next === state.page) {
    updatePageInfo();
    return;
  }
  state.page = next;
  updatePageInfo();
  queueProgressSave();
  resetViewerScroll();
  await renderPage();
}

function buildViewerPersistPayload() {
  const stage = document.querySelector("#viewerStage");
  let scrollTop = 0;
  let scrollLeft = 0;
  if (stage instanceof HTMLElement) {
    scrollTop = stage.scrollTop;
    scrollLeft = stage.scrollLeft;
  }
  return {
    page: state.page,
    zoomPercent: state.zoomPercent,
    scrollTop,
    scrollLeft,
  };
}

// Progress payload from state only (stage may still show another doc until load finishes).
function buildInitialOpenPersistPayload() {
  let scrollTop = 0;
  let scrollLeft = 0;
  if (state.pendingScrollRestore) {
    scrollTop = state.pendingScrollRestore.top;
    scrollLeft = state.pendingScrollRestore.left;
  }
  return {
    page: state.page,
    zoomPercent: state.zoomPercent,
    scrollTop,
    scrollLeft,
  };
}

function persistPayloadForCurrentState() {
  if (state.pdfDoc) return buildViewerPersistPayload();
  return buildInitialOpenPersistPayload();
}

function sendViewerPersist(overridePayload) {
  if (!state.currentDocId) return;
  const payload = overridePayload ?? persistPayloadForCurrentState();
  const url = `/api/doc/${encodeURIComponent(state.currentDocId)}/progress`;
  fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function queueProgressSave() {
  if (!state.currentDocId) return;
  clearTimeout(state.progressSaveTimer);
  state.progressSaveTimer = setTimeout(() => {
    state.progressSaveTimer = null;
    sendViewerPersist();
  }, 400);
}

function flushViewerPersistForUnload() {
  if (!state.currentDocId) return;
  clearTimeout(state.progressSaveTimer);
  state.progressSaveTimer = null;
  const url = `/api/doc/${encodeURIComponent(state.currentDocId)}/progress`;
  try {
    fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(persistPayloadForCurrentState()),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

function handlePageInputFocus(event) {
  const input = event.target;
  requestAnimationFrame(() => {
    input.select();
  });
}

function resetViewerScroll() {
  const stage = document.querySelector("#viewerStage");
  if (!(stage instanceof HTMLElement)) return;
  stage.scrollTop = 0;
  stage.scrollLeft = 0;
}

function applyPendingScrollOrReset() {
  const pending = state.pendingScrollRestore;
  state.pendingScrollRestore = null;
  const stage = document.querySelector("#viewerStage");
  if (!(stage instanceof HTMLElement)) return;
  if (pending) {
    requestAnimationFrame(() => {
      stage.scrollTop = pending.top;
      stage.scrollLeft = pending.left;
    });
  } else {
    resetViewerScroll();
  }
}

// With flex-start on the scroll parent, nudge short pages vertically (center would break scrollTop alignment).
function syncShortPageVerticalCenter() {
  const stage = document.querySelector("#viewerStage");
  const frame = state.viewerShell?.frame;
  if (!(stage instanceof HTMLElement) || !(frame instanceof HTMLElement)) return;
  const style = getComputedStyle(stage);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const innerH = stage.clientHeight - padY;
  const fh = frame.offsetHeight;
  if (fh < innerH - 1) {
    frame.style.marginTop = `${Math.max(0, (innerH - fh) / 2)}px`;
  } else {
    frame.style.marginTop = "";
  }
}

function changeZoom(deltaSteps) {
  if (!state.pdfDoc) return;
  const d = Math.trunc(deltaSteps);
  if (!d) return;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoomPercent + d * ZOOM_STEP));
  if (next === state.zoomPercent) return;
  state.zoomPercent = next;
  void (async () => {
    await renderPage();
    queueProgressSave();
  })();
}

function scrollViewerVertical(direction) {
  const stage = document.querySelector("#viewerStage");
  if (!(stage instanceof HTMLElement) || !state.pdfDoc) return false;
  if (stage.scrollHeight <= stage.clientHeight + 1) return false;
  const step = Math.min(120, Math.max(48, Math.round(stage.clientHeight * 0.15)));
  stage.scrollTop = Math.max(0, Math.min(stage.scrollHeight - stage.clientHeight, stage.scrollTop + direction * step));
  return true;
}

function handleGlobalKeydown(event) {
  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.code === "Space" &&
    !isTypingTarget(event.target)
  ) {
    if (!state.me) return;
    event.preventDefault();
    if (isMainCommandPaletteOpen()) {
      closeMainCommandPaletteIfOpen();
      return;
    }
    forceCloseSubPalettesForMainCommand();
    document.dispatchEvent(new Event("openMainCommandPalette"));
    return;
  }

  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "k" &&
    !isTypingTarget(event.target)
  ) {
    event.preventDefault();
    document.dispatchEvent(new Event("openThemePalette"));
    return;
  }

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.toLowerCase() === "g" &&
    !isTypingTarget(event.target)
  ) {
    event.preventDefault();
    document.dispatchEvent(new Event("openPageJumpPalette"));
    return;
  }

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.toLowerCase() === "o" &&
    !isTypingTarget(event.target)
  ) {
    if (!state.me) return;
    event.preventDefault();
    document.dispatchEvent(new Event("openLibraryPalette"));
    return;
  }

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.toLowerCase() === "n" &&
    !isTypingTarget(event.target)
  ) {
    if (!state.pdfDoc || !state.currentDocId) return;
    event.preventDefault();
    document.dispatchEvent(new Event("openNotesPalette"));
    return;
  }

  if (event.key === "Escape") {
    if (isNotesEditOpen()) {
      event.preventDefault();
      closeNotesEditModal();
      return;
    }
  }

  if (isAnyPaletteOpen()) return;

  if (!isTypingTarget(event.target) && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === "\\") {
    event.preventDefault();
    toggleBothRailsFromShortcut();
    return;
  }

  if (!state.pdfDoc) return;

  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    focusPageField();
    return;
  }

  if (isTypingTarget(event.target)) return;

  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    const key = event.key.toLowerCase();
    if (event.shiftKey) {
      if (key === "k") {
        event.preventDefault();
        changeZoom(1);
        return;
      }
      if (key === "j") {
        event.preventDefault();
        changeZoom(-1);
        return;
      }
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      void changePage(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      void changePage(1);
      return;
    }
    if (event.key === "ArrowUp") {
      if (scrollViewerVertical(-1)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      if (scrollViewerVertical(1)) event.preventDefault();
      return;
    }
    if (key === "h") {
      event.preventDefault();
      void changePage(-1);
      return;
    }
    if (key === "l") {
      event.preventDefault();
      void changePage(1);
      return;
    }
    if (key === "k") {
      if (scrollViewerVertical(-1)) event.preventDefault();
      return;
    }
    if (key === "j") {
      if (scrollViewerVertical(1)) event.preventDefault();
      return;
    }
  }

  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key === "/") {
    event.preventDefault();
    focusPageField();
    return;
  }
}

function focusPageField() {
  const input = document.querySelector("#pageNumberInput");
  if (!input || input.disabled) return;
  input.focus();
}

function toggleBothRailsFromShortcut() {
  if (isMobileLandscapeReader()) return;
  const l = document.body.classList.contains("rail-left-expanded");
  const r = document.body.classList.contains("rail-right-expanded");
  if (l || r) {
    document.body.classList.remove("rail-left-expanded", "rail-right-expanded");
  } else {
    document.body.classList.add("rail-left-expanded", "rail-right-expanded");
  }
}

function parsePageInputValue(rawValue) {
  const match = String(rawValue).trim().match(/^\s*(\d+)/);
  if (!match) return NaN;
  return Number(match[1]);
}
