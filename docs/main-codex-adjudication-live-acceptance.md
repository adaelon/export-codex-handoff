# Main Codex Adjudication Live Acceptance — 2026-08-12

Status: PASSED

## Acceptance target

A fresh run through the installed `export-codex-handoff` Skill must capture a pre-worker execution-
surface diagnostic, keep one Compression Run, let Main Codex choose an allowed action without user
adjudication, atomically publish a normal or explicit Degraded Handoff pair, and leave the request,
decision, application, unresolved diagnostic, and Evidence Index independently auditable.

## Fresh installed-Skill run

- Skill directory: `C:\Users\Lenovo\.codex\skills\export-codex-handoff`.
- Fault injection: zero fresh MAP Worker slots before the first claim; captured diagnostic
  `MAP_WORKER_UNAVAILABLE`.
- Main Codex action: `publish_degraded`; no MAP Worker was claimed and no clean Compression Run was
  started.
- Result: `PUBLISHED` after three immutable events in the same run.
- Runner result: 1/1 passing; test duration 1,993.526 ms and total runner duration 2,089.008 ms.
- Retained root:
  `C:\Users\Lenovo\AppData\Local\Temp\codex-ma5-live-acceptance-20260812-221036930`.
- Machine-readable receipt: `ma5-live-acceptance.json` under that root; the managed `workDir`,
  published Handoff, and published Evidence Index remain beside it.

## Immutable adjudication binding

```text
runId: adjudication-run-86d5e4a0264f547ac39744f9a1b4747c5bd15604cfca6eb2b3640183ee5f3a7f
requestId: adjudication-request-2c732f63-00ca-4a66-972a-dd7c485700ab
requestDigest: sha256:b4072ff6e8c675de5d1eb7b5f85d8840027bd4524abffd812038caaa3ecec207
decisionId: adjudication-decision-ddcd88da-82fb-45c3-a2e9-f70f2c8ed764
decisionDigest: sha256:a62273e02e867331540a015102667550294651d0537be5789e6f0530a995cce0
applicationId: adjudication-application-62baeb21-5c3d-4873-bd5b-6958ab89c155
applicationDigest: sha256:bc23e63ac7804c30baea85040eb3da08760eb9eff09333d92dab406e389b4b1e
eventHeadDigest: sha256:80b163886be1d03078d8450e90d272b6920d26d111325812083132cd6695ffd0
```

Replay reports the request and application as `APPLIED`, the decision action as
`publish_degraded`, and the publication effect as `degraded_handoff_published`. The Handoff retains
the byte-exact goal and names `MAP_WORKER_UNAVAILABLE` as unresolved.

## Publication and evidence verification

- Handoff: 1,948 characters;
  `sha256:ca662d52e3708e4145fa0f100bde3d8b19fc5e31239d3f10c90d2382c0608509`.
- Evidence Index: 1,738 characters;
  file digest `sha256:389051fed2a4b49045750833ea761d742314d7a304bc8aea66529a2ee55e8bba`;
  structural digest `sha256:a58d4a6c0ac5cd1ec7d9f15f3ab5ad1fb4f0d3c8627cdbfc05c675e2b979dab4`.
- `verify-evidence`: valid, 1/1 Source Thread anchor retained, zero omitted anchors, evidence scope
  `complete`.
- The independently recomputed Handoff and Evidence Index file digests match the receipt.
- Cleanup status: `kept`, so the three-event chain and all bound documents remain inspectable.

## Repository closure evidence

- MA5 plus retained TR3 operator-contract tests: 9/9 passing.
- Isolated Git-index snapshot for the MA5 commit: 250/250 passing, zero failures and zero skips,
  70,385.870 ms; it excludes the preserved uncommitted TR6 test and implementation.
- Coexisting worktree Node suite: 251/251 passing, zero failures and zero skips, 72,521.779 ms on
  the final post-documentation run.
- Repository and installed Skill: 87/87 relative files match byte-for-byte; package digest
  `sha256:01f4634e79612ac446ffac73f72d2c65c0195a4062b1c331dc410cbd952e3d8f`.

This acceptance proves the MA5 same-run adjudication and explicit-degradation guarantee at the
pre-worker capacity boundary. It does not claim semantic MAP execution, action-ready continuation
consumption, process survival, machine survival, or availability of an otherwise unwritable
publication target.
