import { cleanStrokes } from "./strokeCleaner.js";
import { detectRings } from "./ringDetector.js";
import { classifyStrokesAgainstRing } from "./coordinateNormalizer.js";
import { buildSymbolCandidates } from "./strokeGrouper.js";
import { recognizeCandidates } from "./symbolRecognizer.js";
import { GLYPH_WARNINGS } from "./glyphWarnings.js";
import { clamp, formatNumber, mean, vectorFromAngleDeg, distance } from "../utils/geometry.js";

function roundedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(roundedDeep);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundedDeep(item)]));
  }
  return formatNumber(value);
}

// Assuming a sigil has to be in the center of the ring, so reward the score a little bit
function primarySigilScore(sigil) {
  const layerBonus = sigil.layer === "center" ? 0.12 : sigil.radiusNorm <= 0.45 ? 0.06 : 0;
  return sigil.confidence + layerBonus;
}

function averagePoint(points) {
  const count = Math.max(1, points.length);
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / count,
    y: points.reduce((sum, point) => sum + point.y, 0) / count
  };
}

function findStrokeRingId(stroke, rings, config) {
  if (!rings?.length) {
    return null;
  }

  const centroid = averagePoint(stroke.points);
  const innerFirst = [...rings].sort((a, b) => a.radius - b.radius);
  const boundaryScale = config.layers.boundaryMax;

  for (const ring of innerFirst) {
    if (distance(centroid, ring.center) <= ring.radius * boundaryScale) {
      return ring.ringId;
    }
  }

  return null;
}

function classifyStrokesAgainstRings(strokes, rings, config) {
  if (!rings?.length) {
    return strokes.map((stroke) => ({
      strokeId: stroke.id,
      classification: "unbounded",
      insideRatio: 0,
      outsideRatio: 0,
      boundaryRatio: 0,
      usedByParser: false,
      canJoinSymbol: false,
      ringId: null,
      ringDepth: -1
    }));
  }

  const ringMap = new Map(rings.map((ring) => [ring.ringId, ring]));
  const ringClassifications = new Map(
    rings.map((ring) => [
      ring.ringId,
      new Map(
        classifyStrokesAgainstRing(strokes, ring, config)
          .map((classification) => ({
            ...classification,
            ringId: ring.ringId,
            ringDepth: ring.depth
          }))
          .map((classification) => [classification.strokeId, classification])
      )
    ])
  );

  return strokes.map((stroke) => {
    let ringId = null;

    for (const ring of rings) {
      const classification = ringClassifications.get(ring.ringId)?.get(stroke.id);
      if (classification?.classification === "ring") {
        ringId = ring.ringId;
        break;
      }
    }

    if (!ringId) {
      ringId = findStrokeRingId(stroke, rings, config);
    }

    if (!ringId) {
      return {
        strokeId: stroke.id,
        classification: "outside",
        insideRatio: 0,
        outsideRatio: 1,
        boundaryRatio: 0,
        usedByParser: false,
        canJoinSymbol: false,
        ringId: null,
        ringDepth: -1
      };
    }

    const classification = ringClassifications.get(ringId)?.get(stroke.id);
    return classification ?? {
      strokeId: stroke.id,
      classification: "outside",
      insideRatio: 0,
      outsideRatio: 1,
      boundaryRatio: 0,
      usedByParser: false,
      canJoinSymbol: false,
      ringId,
      ringDepth: ringMap.get(ringId)?.depth ?? -1
    };
  });
}

function recognizedSigils(recognitions) {
  return recognitions
    .filter((recognition) => recognition.recognized && recognition.kind === "sigil")
    .sort((a, b) => b.confidence - a.confidence);
}

function selectPrimarySigil(sigils) {
  return [...sigils].sort((a, b) => primarySigilScore(b) - primarySigilScore(a))[0] ?? null;
}

function summarizeUnknowns(candidates, recognitions) {
  const byCandidate = new Map(recognitions.map((recognition) => [recognition.candidateId, recognition]));
  return candidates
    .filter((candidate) => !byCandidate.get(candidate.candidateId)?.recognized)
    .map((candidate) => {
      const recognition = byCandidate.get(candidate.candidateId);
      return {
        candidateId: candidate.candidateId,
        strokeIds: candidate.strokeIds,
        layer: candidate.layer,
        radiusNorm: candidate.radiusNorm,
        angleDeg: candidate.angleDeg,
        reason: recognition?.recognitionStatus ?? "no_confident_match",
        bestGuess: recognition?.diagnostics?.bestGuess ?? null
      };
    });
}

function calculateDirectionalBias(signs) {
  if (!signs.length) {
    return { x: 0, y: 0 };
  }

  const vector = signs.reduce(
    (sum, sign) => {
      const direction = vectorFromAngleDeg(sign.angleDeg);
      const weight = sign.confidence * sign.neatness * Math.max(0.3, sign.sizeNorm + sign.lengthNorm);
      return {
        x: sum.x + direction.x * weight,
        y: sum.y + direction.y * weight
      };
    },
    { x: 0, y: 0 }
  );

  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude < 0.001) {
    return { x: 0, y: 0 };
  }
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude
  };
}

function calculateGlobalMetrics(ring, recognitions, unknowns) {
  const recognized = recognitions.filter((recognition) => recognition.recognized);
  const neatnessAverage = mean([
    ring.neatness ?? 0,
    ...recognized.map((recognition) => recognition.neatness ?? 0.6)
  ].filter((value) => value > 0));
  const signs = recognized.filter((recognition) => recognition.kind === "sign");
  const directionalBias = calculateDirectionalBias(signs);
  const unknownPenalty = clamp(unknowns.length / 6);
  const contaminatedPenalty = clamp(
    recognitions.filter((recognition) => recognition.recognitionStatus === "contaminated").length / 4
  );
  const ambiguousPenalty = clamp(
    recognitions.filter((recognition) => recognition.recognitionStatus === "ambiguous").length / 5
  );
  const messyPenalty = clamp(
    recognitions.filter((recognition) => recognition.recognitionStatus === "valid_messy").length / 8
  );

  return {
    neatness: clamp(neatnessAverage || 0),
    radialSymmetry: clamp(1 - Math.hypot(directionalBias.x, directionalBias.y) * 0.35),
    instability: clamp(
      0.22 +
        unknownPenalty * 0.34 +
        contaminatedPenalty * 0.22 +
        ambiguousPenalty * 0.12 +
        messyPenalty * 0.08 +
        (1 - (ring.neatness ?? 0.4)) * 0.36
    )
  };
}

function stripCandidate(candidate) {
  const { strokes, ...publicCandidate } = candidate;
  return publicCandidate;
}

function stripRecognitionDiagnostics(recognition) {
  if (!recognition) {
    return null;
  }
  const { diagnostics, ...publicRecognition } = recognition;
  return publicRecognition;
}

function flattenRingTree(rings) {
  const nodes = [];
  const visit = (ring) => {
    nodes.push(ring);
    (ring.children ?? []).forEach(visit);
  };
  rings.forEach(visit);
  return nodes;
}

export function buildGlyphAST({ rings, ring, ringTree, candidates, recognitions, config }) {
  const sigils = recognizedSigils(recognitions);
  const supportedSigils = sigils;
  const unsupportedMultipleSigils = [];
  const ringTreeData = buildRingTreeData(ringTree, candidates, recognitions);
  const primarySigil = selectPrimarySigil(supportedSigils);
  const signs = recognitions
    .filter((recognition) => recognition.recognized && recognition.kind === "sign")
    .map(stripRecognitionDiagnostics);
  const unknowns = summarizeUnknowns(candidates, recognitions);
  const globalMetrics = calculateGlobalMetrics(ring, recognitions, unknowns);
  const warnings = warningList(ring, primarySigil, unsupportedMultipleSigils, unknowns, recognitions);

  return roundedDeep({
    type: "GlyphAST",
    version: config.appVersion,
    rings,
    ring,
    ringTree: ringTreeData,
    candidates: candidates.map(stripCandidate),
    primarySigil: stripRecognitionDiagnostics(primarySigil),
    sigils: sigils.map(stripRecognitionDiagnostics),
    unsupportedMultipleSigils,
    signs,
    unknowns,
    globalMetrics,
    warnings
  });
}

function buildRingTreeData(rings, candidates, recognitions) {
  const byRingId = new Map(rings.map((ring) => [ring.ringId, { ...ring, candidates: [], sigils: [], signs: [] }]));
  const recognitionMap = new Map(recognitions.map((recognition) => [recognition.candidateId, recognition]));

  for (const candidate of candidates) {
    const node = byRingId.get(candidate.ringId);
    if (node) {
      node.candidates.push(stripCandidate(candidate));
    }
  }

  for (const recognition of recognitions) {
    const node = byRingId.get(recognition.ringId);
    if (!node) {
      continue;
    }
    if (recognition.kind === "sigil") {
      node.sigils.push(stripRecognitionDiagnostics(recognition));
    } else if (recognition.kind === "sign") {
      node.signs.push(stripRecognitionDiagnostics(recognition));
    }
  }

  const treeNodes = Array.from(byRingId.values());
  const roots = treeNodes.filter((ring) => !ring.parentRingId);
  const nodeMap = new Map(treeNodes.map((node) => [node.ringId, node]));

  for (const node of treeNodes) {
    if (node.parentRingId) {
      const parent = nodeMap.get(node.parentRingId);
      if (parent) {
        parent.children = parent.children ?? [];
        parent.children.push(node);
      }
    }
  }

  return roots;
}

function warningList(ring, primarySigil, unsupportedMultipleSigils, unknowns, recognitions) {
  const warnings = [];
  if (!ring.found) {
    warnings.push(GLYPH_WARNINGS.noRingDetected);
  } else if (!ring.complete) {
    warnings.push(GLYPH_WARNINGS.ringIncomplete);
  }
  if (ring.unsupportedNestedRings?.length) {
    warnings.push(GLYPH_WARNINGS.unsupportedNestedRing);
  }
  if (ring.unsupportedMultipleRings?.length) {
    warnings.push(GLYPH_WARNINGS.unsupportedMultipleRings);
  }
  if (unsupportedMultipleSigils.length) {
    warnings.push(GLYPH_WARNINGS.unsupportedMultipleSigils);
  }
  if (!primarySigil) {
    warnings.push(GLYPH_WARNINGS.missingPrimarySigil);
  }
  if (unknowns.some((unknown) => unknown.radiusNorm <= 0.36)) {
    warnings.push(GLYPH_WARNINGS.centerUnknownContamination);
  }
  if (recognitions.some((recognition) => recognition.recognized && recognition.nearBoundary)) {
    warnings.push(GLYPH_WARNINGS.symbolNearLayerBoundary);
  }
  if (recognitions.some((recognition) => recognition.recognitionStatus === "contaminated")) {
    warnings.push(GLYPH_WARNINGS.symbolContaminated);
  }
  if (recognitions.some((recognition) => recognition.recognitionStatus === "ambiguous")) {
    warnings.push(GLYPH_WARNINGS.symbolAmbiguous);
  }
  if (recognitions.some((recognition) => recognition.recognitionStatus === "valid_messy")) {
    warnings.push(GLYPH_WARNINGS.symbolMessy);
  }
  return warnings;
}

export function classifyDrawing({ strokes, previousRing = null, dictionary, config }) {
  const cleanedStrokes = cleanStrokes(strokes, config);
  const ringResult = detectRings(cleanedStrokes, previousRing, config);
  const rings = ringResult.rings;
  const ringTree = ringResult.ringTree ?? [];
  const ring = rings[0] ?? {
    found: false,
    complete: false,
    completeness: 0,
    activationEvent: false,
    strokeIds: [],
    unsupportedNestedRings: [],
    unsupportedMultipleRings: []
  };

  if (!ring.found) {
    const glyphAST = {
      type: "GlyphAST",
      version: config.appVersion,
      rings: [],
      ring,
      candidates: [],
      primarySigil: null,
      sigils: [],
      unsupportedMultipleSigils: [],
      signs: [],
      unknowns: [],
      globalMetrics: {
        neatness: 0,
        radialSymmetry: 0,
        instability: 1
      },
      warnings: [GLYPH_WARNINGS.noRingDetected]
    };
    return {
      cleanedStrokes,
      ring,
      classifications: [],
      candidates: [],
      recognitions: [],
      glyphAST
    };
  }

  const classifications = classifyStrokesAgainstRings(cleanedStrokes, rings, config);
  const candidates = rings.flatMap((ring) => {
    const ringClassifications = classifications.filter((classification) => classification.ringId === ring.ringId);
    const ringStrokeIds = new Set(ringClassifications.map((classification) => classification.strokeId));
    const ringStrokes = cleanedStrokes.filter((stroke) => ringStrokeIds.has(stroke.id));
    return buildSymbolCandidates(ringStrokes, ringClassifications, ring, config);
  });

  const recognitions = recognizeCandidates(candidates, dictionary, config);
  const glyphAST = buildGlyphAST({ rings, ring, ringTree, candidates, recognitions, config });

  return {
    cleanedStrokes,
    ring,
    classifications: roundedDeep(classifications),
    candidates,
    recognitions: roundedDeep(recognitions),
    glyphAST
  };
}
