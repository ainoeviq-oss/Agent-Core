# Fidelity Model

## Structural evidence

Current V1 evidence includes source/target slide counts plus target-observable object counts where the target API exposes them.

States:

```text
preserved
preserved_with_substitution
approximated
flattened
unsupported
unknown
```

Confidence is withheld for mock/unavailable targets.

## Visual evidence

`fidelity visual` normalizes the target raster to source dimensions and computes a deterministic per-pixel mismatch ratio. A diff PNG can be emitted.

Visual equality is not structural equality. A flattened slide may look perfect while losing editability, therefore visual similarity never upgrades a target to “native” or “editable”.

## Future semantic scoring

Typography, animation, media, and editability scores may be added only when the corresponding property is actually inspected. Unknown data must not be converted into a confidence score by assumption.
