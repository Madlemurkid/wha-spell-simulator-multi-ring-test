import { CONFIG } from "./config.js";
import { loadDictionary } from "./dictionary/dictionaryLoader.js";
import { DrawingCapture } from "./input/drawingCapture.js";
import { createStrokeStore } from "./input/strokeStore.js";
import { classifyDrawing, buildGlyphAST } from "./parser/drawingClassifier.js";
import { compileSpell } from "./compiler/spellBuilder.js";
import { CanvasRenderer } from "./renderer/canvasRenderer.js";
import { setupCanvasSizing as setupResponsiveCanvasSizing } from "./ui/canvasSizing.js";
import { updateDiagnostics, updateDiagnosticsMode } from "./ui/diagnosticsView.js";
import { getElements } from "./ui/elements.js";
import { renderDictionaryReference } from "./ui/dictionaryReferenceView.js";
import { updateStatus, updateSummary } from "./ui/spellSummaryView.js";
import { setupTabs } from "./ui/tabs.js";

const elements = getElements();
const store = createStrokeStore();
let dictionary = null;
let renderer = null;
let capture = null;
let pipeline = null;
let spellIR = null;
let previousRing = null;
let resizeObserver = null;
let currentViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
let skipAmbiguousOnNextRecompute = false;

function setupCanvasSizing() {
  resizeObserver = setupResponsiveCanvasSizing({
    elements,
    store,
    onCanvasResized: () => {
      previousRing = null;
      recompute();
    }
  });
}

function updateViewTransform({ scale, offsetX, offsetY }) {
  currentViewTransform.scale = scale;
  currentViewTransform.offsetX = offsetX;
  currentViewTransform.offsetY = offsetY;
  capture?.setViewTransform(currentViewTransform);
}

function resetViewTransform() {
  currentViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
  capture?.setViewTransform(currentViewTransform);
}

function resolveAmbiguousRecognitions(currentPipeline) {
  if (skipAmbiguousOnNextRecompute) {
    skipAmbiguousOnNextRecompute = false;
  }
  return currentPipeline;
}

async function recompute() {
  if (!dictionary) {
    return;
  }

  pipeline = classifyDrawing({
    strokes: store.getStrokes(),
    previousRing,
    dictionary,
    config: CONFIG
  });
  pipeline = resolveAmbiguousRecognitions(pipeline);
  previousRing = pipeline.ring;
  spellIR = compileSpell({ glyphAST: pipeline.glyphAST, dictionary, config: CONFIG });
  updateSummary({ elements, store, capture, pipeline, spellIR });
  updateDiagnostics({ elements, store, pipeline, spellIR });
}

function animationFrame(timestamp) {
  renderer.renderGlyph({
    strokes: store.getStrokes(),
    currentStroke: capture.getCurrentStroke(),
    pipeline,
    showGuides: elements.guidesToggle.checked,
    showMultiRingGuides: elements.multiRingGuidesToggle.checked,
    showDebug: elements.diagnosticsToggle.checked,
    viewTransform: currentViewTransform
  });

  if (spellIR.active) {
    renderer.renderActivatedGlyph({
      activatedAt: spellIR.activatedAt,
      duration: spellIR.duration,
      strokes: store.getStrokes(),
      pipeline,
      timestamp,
      viewTransform: currentViewTransform
    });
  }
  
  renderer.renderEffect({
    spellIR,
    ring: pipeline?.ring,
    timestamp,
    showGuides: elements.guidesToggle.checked,
    viewTransform: currentViewTransform
  });
  requestAnimationFrame(animationFrame);
}

function setupControls() {
  elements.undoButton.addEventListener("click", () => {
    store.undo();
    previousRing = null;
    skipAmbiguousOnNextRecompute = true;
    recompute();
  });

  elements.clearButton.addEventListener("click", () => {
    store.clear();
    previousRing = null;
    skipAmbiguousOnNextRecompute = true;
    recompute();
  });

  elements.zoomRange.addEventListener("input", () => {
    const newScale = Number(elements.zoomRange.value) || 1;
    const { scale, offsetX, offsetY } = currentViewTransform;
    const pivot = capture.getLastCanvasPoint() ?? {
      x: elements.glyphCanvas.width / 2,
      y: elements.glyphCanvas.height / 2
    };
    const worldX = (pivot.x - offsetX) / scale;
    const worldY = (pivot.y - offsetY) / scale;
    const newOffsetX = pivot.x - worldX * newScale;
    const newOffsetY = pivot.y - worldY * newScale;
    currentViewTransform = { scale: newScale, offsetX: newOffsetX, offsetY: newOffsetY };
    updateViewTransform(currentViewTransform);
    elements.zoomValue.textContent = `${Math.round(newScale * 100)}%`;
    previousRing = null;
    recompute();
  });

  elements.guidesToggle.addEventListener("change", () => {
    updateSummary({ elements, store, capture, pipeline, spellIR });
    updateDiagnostics({ elements, store, pipeline, spellIR });
  });

  elements.multiRingGuidesToggle.addEventListener("change", () => {
    // toggle visibility of multi-ring guide rendering
  });

  elements.diagnosticsToggle.addEventListener("change", () => {
    updateDiagnosticsMode(elements);
    updateDiagnostics({ elements, store, pipeline, spellIR });
  });

  updateDiagnosticsMode(elements);
}

async function init() {
  setupTabs(elements);
  setupControls();
  setupCanvasSizing();
  renderer = new CanvasRenderer({
    glyphCanvas: elements.glyphCanvas,
    effectCanvas: elements.effectCanvas,
    config: CONFIG
  });
  capture = new DrawingCapture(elements.glyphCanvas, store, CONFIG, {
    onPreview: () => {},
    onCommit: recompute
  });
  capture.setViewTransform(currentViewTransform);
  elements.zoomValue.textContent = `${Math.round(currentViewTransform.scale * 100)}%`;

  try {
    dictionary = await loadDictionary();
    renderDictionaryReference(elements, dictionary);
    capture.enable();
    recompute();
    requestAnimationFrame(animationFrame);
  } catch (error) {
    console.error(error);
    updateStatus(elements, "Dictionary load failed", "invalid");
  }
}

init();
