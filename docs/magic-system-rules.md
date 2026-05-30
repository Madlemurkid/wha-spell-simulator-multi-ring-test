# Witch Hat Atelier Magic System Rules

This document records the canonical magic system rules for the `wha-spell-simulator` project. It is intended as a developer-facing reference to keep parser, compiler, and renderer behavior aligned with the multi-ring nested spell model.

## Core Concepts

- **Ring**: A circular boundary drawn on the page. A ring may be in one of three states:
  - `prepared` / open: the ring outline is partially drawn and recognizable.
  - `sealed` / complete: the ring closure is detected and the ring is considered complete.
  - `invalid`: a malformed or unsupported ring configuration, such as multiple separate rings on the same glyph.
- **Nested Rings**: Rings may be concentric and nested, creating hierarchical scope.
  - Outer rings are larger and may contain inner rings.
  - Inner rings are scoped contents that can carry their own sigils and signs.
  - Each ring must be assigned a unique `ringId` (`r1`, `r2`, ...), with the largest outer ring as `r1`.
- **Ring Tree**: Rings are represented as a nested tree, where each ring may have `children` and a `parentRingId`.
  - Depth is defined relative to the outermost ring: outermost rings have `depth: 0`, innermost child rings have higher depths.

## Sigils and Spell Elements

- **Sigil**: A central magical symbol inside a ring.
  - Each ring may contain one sigil as its primary symbol.
  - In a nested-ring layout, multiple sigils are allowed if they reside in separate ring scopes.
  - Sigils contribute spell element data, confidence, and semantic modifiers.
- **Primary Sigil**: The main active sigil for the entire spell.
  - It is selected from recognized sigils by score/confidence.
  - Primary sigil element defines the spell's root element.
- **Compound Spell**:
  - If multiple recognized sigils exist in nested rings, the spell may form a compound element.
  - Compound elements are represented as sorted, joined names like `fire+water`.

## Signs and Modifiers

- **Sign**: A non-sigil glyph inside a ring that modifies the spell.
  - Signs are interpreted relative to their ring scope and orientation.
  - They affect spell parameters such as force, focus, spread, range, duration, and manifestation.
- **Scope-specific behavior**:
  - Signs within a ring only modify the effect of that ring's sigil and its local ring effect.
  - Outer ring signs may still influence the overall spell quality or manifestational context.

## Compiler Semantics

- **SpellIR** should reflect both global and ring-scoped information:
  - `element`: the primary spell element.
  - `compoundElement`: combined nested sigil elements if present.
  - `sigils`: recognized sigils from all valid rings.
  - `ringEffects`: an array of per-ring effect summaries, each including ring-specific force, focus, spread, range, duration, and direction.
- **Validation Rules**:
  - Multiple separate rings (non-nested / independent rings) are invalid and generate `unsupportedMultipleRings`.
  - Multiple sigils are allowed if they occupy distinct nested ring scopes.
  - A spell is invalid if no valid primary sigil can be chosen, or if the primary sigil confidence is too low.

## Nested Ring Detection

- **Containment rule**: A ring `A` contains ring `B` if:
  - `distance(A.center, B.center) + B.radius <= A.radius + tolerance`
  - `tolerance` is based on ring boundary tolerance and scale.
- **Ring tree construction**:
  - Sort rings by descending radius.
  - Assign each ring to the smallest larger ring that contains it.
  - Root rings have no parent and form the top-level tree.

## Rendering Guidance

- Rings may be visualized with guides to show nested structure.
- Multi-ring guides should clearly show boundaries and scope relationships.
- Inner ring content should be drawn inside its parent ring without overlapping unrelated rings.

## Developer Notes

- Keep `ringDetector` responsible for geometry and containment.
- Keep `drawingClassifier` responsible for mapping candidate strokes into ring-scoped candidates, sigils, and signs.
- Keep `spellBuilder` responsible for compiling `GlyphAST` into a structured `SpellIR` with ring-scoped effects.
- Avoid rejecting nested sigils unless they violate separate-ring scope rules.
- Preserve compatibility with legacy single-ring behavior where possible.

## Terminology

- `GlyphAST`: parsed glyph structure containing rings, candidates, recognitions, and warnings.
- `SpellIR`: compiled spell result used by effects and renderer.
- `ringId`: unique ring identifier used across stages.
- `ringDepth`: hierarchical depth of a ring in the nested tree.
- `unsupportedMultipleRings`: a rejection condition for independent/unrelated ring layouts.
- `ringTree`: nested representation of all detected rings and their containment relationships.

---

This file is the reference for all future work on nested magic rendering, parsing, and compilation in the `wha-spell-simulator` project.