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
let currentZoom = 1;
let askOnAmbiguousRecognition = false;

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

async function resolveAmbiguousRecognitions(currentPipeline) {
  if (!askOnAmbiguousRecognition || !currentPipeline?.recognitions?.length) {
    return currentPipeline;
  }

  const ambiguousCandidates = currentPipeline.recognitions.filter(
    (recognition) => recognition.recognitionStatus === "ambiguous"
  );
  if (!ambiguousCandidates.length) {
    return currentPipeline;
  }

  let madeChoice = false;
  for (const recognition of ambiguousCandidates) {
    const topMatches = recognition.diagnostics?.topMatches?.slice(0, 4) ?? [];
    if (!topMatches.length) {
      continue;
    }

    const optionsText = topMatches
      .map(
        (match, index) =>
          `${index + 1}) ${match.kind} ${match.id} (${Math.round(match.confidence * 100)}%)`
      )
      .join("\n");
    const promptText =
      `Ambiguous symbol detected in layer ${recognition.layer} near radius ${Math.round(
        recognition.radiusNorm * 100
      )}%. Choose the best match or leave blank to keep the current unknown result:\n\n${optionsText}`;
    const selection = window.prompt(promptText, "1");
    const choice = Number(selection) - 1;
    if (!Number.isFinite(choice) || choice < 0 || choice >= topMatches.length) {
      continue;
    }

    const selected = topMatches[choice];
    const entry = dictionary[`${selected.kind}s`]?.find((item) => item.id === selected.id);
    if (!entry) {
      continue;
    }

    recognition.recognized = true;
    recognition.kind = selected.kind;
    recognition.id = entry.id;
    recognition.displayName = entry.displayName ?? entry.id;
    recognition.element = entry.element ?? null;
    recognition.semantic = entry.semantic ?? null;
    recognition.confidence = selected.confidence;
    recognition.diagnostics.bestGuess = selected;
    recognition.recognitionStatus = "valid";
    madeChoice = true;
  }

  if (madeChoice) {
    currentPipeline.glyphAST = buildGlyphAST({
      rings: currentPipeline.glyphAST.rings,
      ring: currentPipeline.glyphAST.ring,
      ringTree: currentPipeline.glyphAST.ringTree,
      candidates: currentPipeline.candidates,
      recognitions: currentPipeline.recognitions,
      config: CONFIG
    });
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
  pipeline = await resolveAmbiguousRecognitions(pipeline);
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
    showDebug: elements.diagnosticsToggle.checked
  });

  if (spellIR.active) {
    renderer.renderActivatedGlyph({
      activatedAt: spellIR.activatedAt,
      duration: spellIR.duration,
      strokes: store.getStrokes(),
      pipeline,
      timestamp
    });
  }
  
  renderer.renderEffect({
    spellIR,
    ring: pipeline?.ring,
    timestamp,
    showGuides: elements.guidesToggle.checked
  });
  requestAnimationFrame(animationFrame);
}

function setupControls() {
  elements.undoButton.addEventListener("click", () => {
    store.undo();
    previousRing = null;
    recompute();
  });

  elements.clearButton.addEventListener("click", () => {
    store.clear();
    previousRing = null;
    recompute();
  });

  elements.zoomRange.addEventListener("input", () => {
    const newZoom = Number(elements.zoomRange.value) || 1;
    const scaleRatio = newZoom / currentZoom;
    currentZoom = newZoom;
    const center = {
      x: elements.glyphCanvas.width / 2,
      y: elements.glyphCanvas.height / 2
    };
    store.scaleAroundPoint(scaleRatio, scaleRatio, center);
    capture.setZoom(currentZoom);
    elements.zoomValue.textContent = `${Math.round(currentZoom * 100)}%`;
    previousRing = null;
    recompute();
  });

  elements.ambiguousPromptToggle.addEventListener("change", () => {
    askOnAmbiguousRecognition = elements.ambiguousPromptToggle.checked;
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
  capture.setZoom(currentZoom);
  elements.zoomValue.textContent = `${Math.round(currentZoom * 100)}%`;

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
