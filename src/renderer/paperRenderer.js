import { degreesToRadians } from "../utils/geometry.js";

export function drawPaper(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#f7dfac");
  gradient.addColorStop(0.45, "#f4df9f");
  gradient.addColorStop(1, "#fae8a5");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawRingGuides(ctx, ring, config, alpha = 0.14, dash = [8, 10]) {
  const guideRadii = [
    ring.radius * config.layers.centerMax,
    ring.radius * config.layers.middleMax,
    ring.radius * config.layers.outerMax,
    ring.radius
  ];

  ctx.save();
  ctx.strokeStyle = `rgba(92, 74, 54, ${alpha})`;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);

  for (const guideRadius of guideRadii) {
    ctx.beginPath();
    ctx.arc(ring.center.x, ring.center.y, guideRadius, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

export function drawGuides(ctx, ring, width, height, config) {
  const center = ring?.found ? ring.center : { x: width / 2, y: height / 2 };
  const radius = ring?.found ? ring.radius : Math.min(width, height) * 0.36;
  const guideRadii = [
    radius * config.layers.centerMax,
    radius * config.layers.middleMax,
    radius * config.layers.outerMax,
    radius
  ];

  ctx.save();
  ctx.strokeStyle = config.renderer.guideColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 10]);
  for (const guideRadius of guideRadii) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, guideRadius, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.setLineDash([5, 16]);
  for (let angle = 0; angle < 360; angle += 45) {
    const radians = degreesToRadians(angle);
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(center.x + Math.cos(radians) * radius, center.y - Math.sin(radians) * radius);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawMultiRingGuides(ctx, rings, width, height, config) {
  const validRings = rings.filter((ring) => ring?.found);
  if (!validRings.length) {
    drawGuides(ctx, null, width, height, config);
    return;
  }

  const baseCenter = validRings[0].center;
  const alphas = [0.20, 0.16, 0.12, 0.08];

  for (let index = 0; index < validRings.length; index += 1) {
    const ring = validRings[index];
    drawRingGuides(ctx, ring, config, alphas[index % alphas.length], index % 2 === 0 ? [10, 12] : [5, 14]);
  }

  ctx.save();
  ctx.strokeStyle = "rgba(92, 74, 54, 0.16)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 10]);
  for (let angle = 0; angle < 360; angle += 45) {
    const radians = degreesToRadians(angle);
    ctx.beginPath();
    ctx.moveTo(baseCenter.x, baseCenter.y);
    ctx.lineTo(baseCenter.x + Math.cos(radians) * validRings[0].radius, baseCenter.y - Math.sin(radians) * validRings[0].radius);
    ctx.stroke();
  }
  ctx.restore();
}
