# Serial Review Panel

Run these passes serially in one Trae session. Each pass starts from the revised draft and uses only its assigned perspective.

## Finding Format

```yaml
level: blocking | suggestion
location: section and item
issue: concrete defect
evidence_refs: string[]
fix: exact correction
```

## Pass 1: Evidence Review

Check facts, ownership, timestamps, `[start,end)` membership, statuses, evidence links, merge decisions, prior-action attribution, and duplicate counting. Treat fact/time errors, out-of-window evidence, duplicate attribution, missing evidence, and privacy leakage as `blocking`.

## Pass 2: Reflection Review

Check that positives and optimizations follow from evidence. Every optimization must name the observed pattern, impact, proposed change, and verification method. Treat unsupported judgment and generic/non-actionable optimization as `blocking`.

## Pass 3: Alignment Review

Check that each topic is suitable for a Mentor/Leader One-on-One, provides enough context, asks for a clear result, and is ordered by importance. Vague questions and topics with no evidence references are `blocking`.

## Revision Limit

Apply findings after all three passes, then rerun the affected passes. Allow no more than two revision rounds. Any remaining `blocking` finding stops publication and triggers the failure contract; suggestions may remain when explicitly recorded in the run result.
