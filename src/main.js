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
let askOnAmbiguousRecognition = false;
let pendingAmbiguousCandidate = null;
let resolvedAmbiguousCandidateIds = new Set();
let promptedAmbiguousCandidateIds = new Set();
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

function showAmbiguityPanel(recognition) {
  if (!elements.ambiguityPanel || !elements.ambiguityOptions) {
    return;
  }

  pendingAmbiguousCandidate = recognition;
  elements.ambiguityMessage.textContent = `Ambiguous symbol near radius ${Math.round(
    recognition.radiusNorm * 100
  )}%: choose the best match.`;
  elements.ambiguityOptions.innerHTML = "";

  const topMatches = recognition.diagnostics?.topMatches ?? [];
  for (const match of topMatches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ambiguity-option-button";
    button.textContent = `${match.kind} ${match.id} (${Math.round(match.confidence * 100)}%)`;
    button.addEventListener("click", () => {
      applyAmbiguitySelection(recognition.candidateId, match);
    });
    elements.ambiguityOptions.appendChild(button);
  }

  elements.ambiguityPanel.classList.remove("hidden");
}

function hideAmbiguityPanel() {
  if (!elements.ambiguityPanel) {
    return;
  }
  elements.ambiguityPanel.classList.add("hidden");
  pendingAmbiguousCandidate = null;
}

function applyAmbiguitySelection(candidateId, selectedMatch) {
  hideAmbiguityPanel();
  if (!pipeline?.recognitions) {
    return;
  }

  const recognition = pipeline.recognitions.find((item) => item.candidateId === candidateId);
  if (!recognition) {
    return;
  }

  const entry = dictionary[`${selectedMatch.kind}s`]?.find((item) => item.id === selectedMatch.id);
  if (!entry) {
    return;
  }

  recognition.recognized = true;
  recognition.kind = selectedMatch.kind;
  recognition.id = selectedMatch.id;
  recognition.displayName = entry.displayName ?? selectedMatch.id;
  recognition.element = entry.element ?? null;
  recognition.semantic = entry.semantic ?? null;
  recognition.confidence = selectedMatch.confidence;
  recognition.recognitionStatus = "valid";
  recognition.diagnostics.bestGuess = selectedMatch;

  resolvedAmbiguousCandidateIds.add(candidateId);
  promptedAmbiguousCandidateIds.add(candidateId);

  pipeline.glyphAST = buildGlyphAST({
    rings: pipeline.glyphAST.rings,
    ring: pipeline.glyphAST.ring,
    ringTree: pipeline.glyphAST.ringTree,
    candidates: pipeline.candidates,
    recognitions: pipeline.recognitions,
    config: CONFIG
  });

  spellIR = compileSpell({ glyphAST: pipeline.glyphAST, dictionary, config: CONFIG });
  updateSummary({ elements, store, capture, pipeline, spellIR });
  updateDiagnostics({ elements, store, pipeline, spellIR });
}

function skipAmbiguityForCandidate(candidateId) {
  promptedAmbiguousCandidateIds.add(candidateId);
  hideAmbiguityPanel();
}

function shouldPromptAmbiguousRecognition(recognition) {
  if (!recognition || recognition.recognitionStatus !== "ambiguous") {
    return false;
  }
  if (resolvedAmbiguousCandidateIds.has(recognition.candidateId)) {
    return false;
  }
  if (promptedAmbiguousCandidateIds.has(recognition.candidateId)) {
    return false;
  }
  const matches = recognition.diagnostics?.topMatches ?? [];
  if (matches.length < 2) {
    return false;
  }
  const minConfidence = CONFIG.recognition.minConfidence ?? 0.48;
  const bestConfidence = matches[0].confidence ?? 0;
  return bestConfidence >= minConfidence * 0.6;
}

function resolveAmbiguousRecognitions(currentPipeline) {
  if (!askOnAmbiguousRecognition || skipAmbiguousOnNextRecompute || !currentPipeline?.recognitions?.length) {
    skipAmbiguousOnNextRecompute = false;
    hideAmbiguityPanel();
    return currentPipeline;
  }

  const ambiguousRecognition = currentPipeline.recognitions.find((recognition) =>
    shouldPromptAmbiguousRecognition(recognition)
  );

  if (!ambiguousRecognition) {
    hideAmbiguityPanel();
    return currentPipeline;
  }

  showAmbiguityPanel(ambiguousRecognition);
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

  elements.ambiguousPromptToggle.addEventListener("change", () => {
    askOnAmbiguousRecognition = elements.ambiguousPromptToggle.checked;
    if (!askOnAmbiguousRecognition) {
      hideAmbiguityPanel();
    }
  });

  elements.ambiguityDismissButton.addEventListener("click", () => {
    if (!pendingAmbiguousCandidate) {
      hideAmbiguityPanel();
      return;
    }
    skipAmbiguityForCandidate(pendingAmbiguousCandidate.candidateId);
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
