import {
  drawCandidateDebug,
  drawRingDebug,
  drawStrokeIdDebug,
  drawStrokes,
  drawGlowingStrokes
} from "./glyphOverlayRenderer.js";
import { drawGuides, drawMultiRingGuides, drawPaper } from "./paperRenderer.js";
import { SpellEffectRenderer } from "./spellEffectRenderer.js";

function getActivatedStrokeIds(pipeline) {
  if (!pipeline) {
    return new Set();
  }

  const { ring, primarySigil, signs } = pipeline.glyphAST;
  return new Set([
    ...(ring?.strokeIds ?? []),
    ...(primarySigil?.strokeIds ?? []),
    ...((signs ?? []).flatMap((sign) => sign.strokeIds ?? []))
  ]);
}

export class CanvasRenderer {
  constructor({ glyphCanvas, effectCanvas, config }) {
    this.glyphCanvas = glyphCanvas;
    this.glyphCtx = glyphCanvas.getContext("2d");
    this.effectRenderer = new SpellEffectRenderer(effectCanvas, config);
    this.config = config;
  }

  renderGlyph({ strokes, currentStroke, pipeline, showGuides, showMultiRingGuides, showDebug, viewTransform }) {
    const width = this.glyphCanvas.width;
    const height = this.glyphCanvas.height;
    drawPaper(this.glyphCtx, width, height);

    const transform = viewTransform ?? { scale: 1, offsetX: 0, offsetY: 0 };
    this.glyphCtx.save();
    this.glyphCtx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);

    if (showGuides) {
      const rings = pipeline?.glyphAST?.rings ?? (pipeline?.ring ? [pipeline.ring] : []);
      if (showMultiRingGuides && rings.length > 1) {
        drawMultiRingGuides(this.glyphCtx, rings, width, height, this.config);
      } else {
        drawGuides(this.glyphCtx, pipeline?.ring, width, height, this.config);
      }
    }

    drawStrokes(this.glyphCtx, strokes, currentStroke, this.config);

    if (showGuides && pipeline?.ring?.found) {
      drawRingDebug(this.glyphCtx, pipeline.ring);
    }

    if (showDebug) {
      drawCandidateDebug(this.glyphCtx, pipeline?.candidates, pipeline?.recognitions);
      drawStrokeIdDebug(this.glyphCtx, strokes);
    }

    this.glyphCtx.restore();
  }

  renderActivatedGlyph({ activatedAt, duration, strokes, pipeline, timestamp, viewTransform }) {
    const activatedStrokeIds = getActivatedStrokeIds(pipeline);
    const glowDuration = Math.max(250, duration * 1000);
    this.glyphCtx.save();
    const transform = viewTransform ?? { scale: 1, offsetX: 0, offsetY: 0 };
    this.glyphCtx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
    drawGlowingStrokes(
      this.glyphCtx,
      activatedAt,
      activatedStrokeIds,
      strokes,
      glowDuration,
      timestamp
    );
    this.glyphCtx.restore();
  }
    const activatedStrokeIds = getActivatedStrokeIds(pipeline);
    const glowDuration = Math.max(250, duration * 1000);
    drawGlowingStrokes(
      this.glyphCtx,
      activatedAt,
      activatedStrokeIds,
      strokes,
      glowDuration,
      timestamp
    );
  }

  renderEffect({ spellIR, ring, timestamp, showGuides, viewTransform }) {
    this.effectRenderer.render(spellIR, ring, timestamp, { showGuides }, viewTransform);
  }
}
