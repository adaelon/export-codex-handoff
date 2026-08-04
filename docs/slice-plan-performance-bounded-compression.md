# Performance-bounded Compression Initiative

Status: implemented — live wall-clock acceptance pending  
Scope: reduce large-run wall time without weakening Source Thread isolation, evidence addressing, semantic coverage, or transactional publication.

## 1. Frozen intent

For the retained 7,368,652-character Source Thread sample, complete `prepare` through dual-file publication in at most ten minutes on the same highest-tier model configuration used for the reported run.

The implementation must also satisfy:

- at most 12 initial MAP Workers for the retained sample;
- at most 400,000 JSON characters across one Worker's evidence and Frame Projection;
- no raw MAP evidence read by the Compression Task coordinator;
- no mutation, migration, or deletion of the existing 391-segment Compression Run;
- all pre-existing deterministic tests remain green.

## 2. Measured baseline

The retained run at `C:\Users\Lenovo\AppData\Local\Temp\codex-handoff-task-ItsOzR` contains:

- 7,368,652 Source Thread characters and 2,030,898 Evidence Pack characters;
- 391 initial MAP segments, hence 131 waves with three Worker slots;
- 3,668 average evidence characters per segment under an 80,000-character budget;
- a 916,110-byte frozen Compression Frame with 2,793 exact identifiers and 376 required anchors;
- the full frame both at `framePath` and embedded inside every validated chunk.

Greedy planning over the retained Evidence Pack produces 10 initial MAP segments and four waves at a
140,000-character evidence budget. The actual serialized segment plus Frame Projection files remain
below 400,000 characters for this sample.

## 3. Runtime contracts

```text
FrameProjection {
  frameId: string
  frameDigest: sha256
  currentGoal: Claim
  explicitExclusions: Claim[]
  preservationProjection: {
    sourceRevision: sha256
    requiredAnchors: string[]
    exactIdentifiers: ExactIdentifier[]
    criticalCategories: CriticalCategory[]
  }
  segmentAnchorIds: string[]
  globalObligationCounts: {
    requiredAnchors: integer
    exactIdentifiers: integer
  }
}

MapDispatch {
  dispatchId: string
  segmentId: string
  chunkPath: string
  summaryPath: string
  contextPath: string
  contextDigest: sha256
  frameDigest: sha256
  attempt: 1 | 2
}
```

The deterministic validator rebuilds the Frame Projection from the frozen global frame and private chunk before accepting a MAP result. The Worker never needs the full Preservation Ledger.

Adjacent fragments from the same parent turn are greedily packed in source order. The serialized
segment, not the sum of fragment estimates, decides the 140,000-character evidence limit. The total
MAP-input gate counts the actual pretty-printed evidence and projection files read by the Worker.

After all child receipts are accepted, deterministic parent coverage concatenates fragment coverage in source order, preserves typed claims and archival entries, and creates one parent-turn entry. It performs no semantic rewriting and starts no aggregate Worker.

## 4. Slice order

### Slice P1: Fragment packing and Frame Projection

**Produces**: packed fragment segments, projection-bound dispatches, 140,000 evidence default, and 400,000 total MAP-input gate.

**Does not do**: change claim schemas, publication, or legacy work-directory interpretation.

**Done when**: a 391-fragment regression fixture plans at most 12 MAPs, chunks contain no full Compression Frame, and projection tampering fails deterministically.

### Slice P2: Deterministic parent coverage

**Produces**: parent-turn coverage derived from validated fragment receipts without a `turn_aggregate_map` dispatch.

**Does not do**: merge or rewrite semantic claims.

**Done when**: incomplete child coverage still fails closed, accepted children reach REDUCE after their raw chunks are removed, and no aggregate Worker is returned.

### Slice P3: Packaging and real-sample acceptance

**Produces**: updated Skill instructions, contracts, architecture, installed mirror, phase metrics, and real-sample planning evidence.

**Done when**: the full deterministic suite and both Skill validators pass, repository and installed file hashes match, and a fresh real Compression Run completes within ten minutes.

## 5. Failure policy

- `MAP_INPUT_TOO_LARGE`: stop before dispatch and report evidence, projection, and configured totals.
- projection mismatch: fail with `MAP_CONTEXT_CHANGED`; never fall back to the global frame in model context.
- incomplete fragment receipts: stop before deterministic parent coverage.
- existing v1 and pre-performance v2 directories retain their original paths and behavior.

## 6. Implemented evidence

- Repository and installed Skill suites pass 59/59 deterministic tests.
- Both Skill folders pass `quick_validate.py`; all 30 relative files and SHA-256 hashes match.
- Replanning the retained Evidence Pack produces 10 initial MAPs and 4 waves at three Worker slots.
- The retained sample's largest measured evidence body is 139,890 characters; its largest serialized
  evidence file is 160,563 characters, largest serialized Frame Projection is 227,191 characters,
  and largest actual combined MAP input is 356,414 characters.
- New runs create zero semantic parent-aggregate Workers.
- Publication reports `phaseTimingsMs.total`; live acceptance requires at most 600,000 ms.

Do not close this initiative until one fresh dedicated Compression Task publishes both artifacts
from the retained Source Thread with `phaseTimingsMs.total <= 600000`.
