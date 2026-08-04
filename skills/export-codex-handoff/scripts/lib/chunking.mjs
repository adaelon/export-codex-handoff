import {
  canonicalStringify,
  extractExactIdentifiers,
  sha256Text,
} from "./evidence-addressing.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

function measured(value) {
  let evidenceChars = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = { ...value, evidenceChars };
    const next = JSON.stringify(candidate).length;
    if (next === evidenceChars) return candidate;
    evidenceChars = next;
  }
  return { ...value, evidenceChars: JSON.stringify({ ...value, evidenceChars }).length };
}

function fragmentId(parentTurnId, unitId, sourceRangeUtf16) {
  return `fragment-${sha256Text(canonicalStringify({
    parentTurnId,
    unitId,
    sourceRangeUtf16,
  }))}`;
}

function exactIdentifierSpans(text) {
  const spans = [];
  for (const identifier of extractExactIdentifiers(text)) {
    let start = text.indexOf(identifier.value);
    while (start !== -1) {
      spans.push({ start, end: start + identifier.value.length });
      start = text.indexOf(identifier.value, start + identifier.value.length);
    }
  }
  return spans.sort((left, right) => left.start - right.start || left.end - right.end);
}

function messageUnit(turnId, kind, message, index) {
  const anchors = [...new Set([
    ...(message.source?.anchorId ? [message.source.anchorId] : []),
    ...(message.anchors || []),
  ])];
  const range = message.source?.rangeUtf16 || { start: 0, end: message.text.length };
  return {
    unitId: `${turnId}:${kind}:${String(index + 1).padStart(4, "0")}`,
    parentTurnId: turnId,
    kind,
    timestamp: message.timestamp ?? null,
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    anchors,
    source: message.source || null,
    sourceRangeUtf16: { ...range },
    text: message.text,
    indivisible: false,
  };
}

function valueUnit(turnId, kind, value, index, anchors = []) {
  return {
    unitId: `${turnId}:${kind}:${String(index + 1).padStart(4, "0")}`,
    parentTurnId: turnId,
    kind,
    anchors: [...anchors],
    sourceRangeUtf16: null,
    value,
    indivisible: true,
  };
}

function turnEvidenceUnits(turn) {
  const units = [valueUnit(turn.turnId, "turn_metadata", {
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    status: turn.status ?? "unknown",
    context: turn.context ?? null,
  }, 0)];
  if (turn.termination?.anchors?.length > 0) {
    units.push(valueUnit(
      turn.turnId,
      "turn_termination",
      turn.termination,
      0,
      turn.termination.anchors,
    ));
  }

  for (const [index, message] of (turn.userMessages || []).entries()) {
    units.push(messageUnit(turn.turnId, "user_goal", message, index));
  }
  for (const [index, message] of (turn.assistantMessages || []).entries()) {
    const kind = message.phase === "final_answer" ? "assistant_result" : "assistant_message";
    units.push(messageUnit(turn.turnId, kind, message, index));
  }
  for (const [index, receipt] of (turn.toolReceipts || []).entries()) {
    units.push(valueUnit(
      turn.turnId,
      "tool_receipt",
      receipt,
      index,
      receipt.outputAnchor ? [receipt.outputAnchor] : [],
    ));
  }
  if ((turn.tools || []).length > 0) {
    units.push(valueUnit(turn.turnId, "tool_links", turn.tools, 0));
  }
  for (const [index, patch] of (turn.patches || []).entries()) {
    const anchors = (patch.receiptIds || [])
      .map((receiptId) => (turn.toolReceipts || []).find((item) => item.receiptId === receiptId))
      .filter(Boolean)
      .map((receipt) => receipt.outputAnchor);
    units.push(valueUnit(turn.turnId, "patch_receipt", patch, index, anchors));
  }
  return units;
}

function createFragment(unit, ordinal, range, text = undefined) {
  const fragment = {
    fragmentId: fragmentId(unit.parentTurnId, unit.unitId, range || { ordinal }),
    parentTurnId: unit.parentTurnId,
    unitId: unit.unitId,
    ordinal,
    kind: unit.kind,
    anchors: [...unit.anchors],
    sourceRangeUtf16: range ? { ...range } : null,
    sourceUnitRangeUtf16: unit.sourceRangeUtf16 ? { ...unit.sourceRangeUtf16 } : null,
    indivisible: unit.indivisible,
    ...(text !== undefined ? { text } : { value: unit.value }),
  };
  return measured(fragment);
}

function createFragmentSegment(sessionId, segmentNumber, fragments) {
  return measured({
    segmentId: `fragment-map-${String(segmentNumber).padStart(3, "0")}`,
    stage: "fragment_map",
    sourceSessionId: sessionId,
    parentTurnId: fragments[0].parentTurnId,
    expectedFragmentIds: fragments.map((fragment) => fragment.fragmentId),
    fragments,
  });
}

function safeEnd(text, start, proposedEnd, spans) {
  let end = proposedEnd;
  if (
    end > start &&
    end < text.length &&
    /[\uD800-\uDBFF]/u.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/u.test(text[end])
  ) {
    end -= 1;
  }
  for (const span of spans) {
    if (span.start < end && end < span.end) {
      end = span.start;
      break;
    }
  }
  return end;
}

function splitTextUnit(unit, state, maxChunkChars) {
  const fragments = [];
  const text = unit.text;
  const protectedSpans = exactIdentifierSpans(text);
  let start = 0;
  while (start < text.length) {
    let low = start + 1;
    let high = text.length;
    let best = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const range = { start, end: middle };
      const fragment = createFragment(unit, state.fragmentOrdinal, range, text.slice(start, middle));
      const segment = createFragmentSegment(
        state.sessionId,
        state.nextSegmentNumber,
        [fragment],
      );
      if (segment.evidenceChars <= maxChunkChars) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === start) {
      throw new ExportHandoffError(
        "OVERSIZE_EVIDENCE_UNSPLITTABLE",
        `${unit.unitId} cannot fit inside maxChunkChars=${maxChunkChars}`,
      );
    }

    let end = safeEnd(text, start, best, protectedSpans);
    if (end === start) {
      const containing = protectedSpans.find((span) => span.start <= start && span.end > start);
      if (!containing) {
        throw new ExportHandoffError(
          "OVERSIZE_EVIDENCE_UNSPLITTABLE",
          `${unit.unitId} has no safe UTF-16 split boundary`,
        );
      }
      const protectedFragment = createFragment(
        unit,
        state.fragmentOrdinal,
        { start, end: containing.end },
        text.slice(start, containing.end),
      );
      const protectedSegment = createFragmentSegment(
        state.sessionId,
        state.nextSegmentNumber,
        [protectedFragment],
      );
      if (protectedSegment.evidenceChars > maxChunkChars) {
        throw new ExportHandoffError(
          "OVERSIZE_EVIDENCE_UNSPLITTABLE",
          `${unit.unitId} contains an over-budget exact identifier`,
        );
      }
      end = containing.end;
    }

    const fragment = createFragment(
      unit,
      state.fragmentOrdinal,
      { start, end },
      text.slice(start, end),
    );
    const segment = createFragmentSegment(
      state.sessionId,
      state.nextSegmentNumber,
      [fragment],
    );
    if (segment.evidenceChars > maxChunkChars) {
      throw new ExportHandoffError(
        "OVERSIZE_EVIDENCE_UNSPLITTABLE",
        `${unit.unitId} safe fragment exceeds maxChunkChars=${maxChunkChars}`,
      );
    }
    fragments.push(fragment);
    state.fragmentOrdinal += 1;
    start = end;
  }
  return fragments;
}

function fragmentUnits(units, state, maxChunkChars) {
  const output = [];
  for (const unit of units) {
    const range = unit.sourceRangeUtf16 ? { ...unit.sourceRangeUtf16 } : null;
    const fragment = createFragment(
      unit,
      state.fragmentOrdinal,
      range,
      unit.text,
    );
    const segment = createFragmentSegment(
      state.sessionId,
      state.nextSegmentNumber,
      [fragment],
    );
    if (segment.evidenceChars <= maxChunkChars) {
      output.push(fragment);
      state.fragmentOrdinal += 1;
      continue;
    }
    if (unit.indivisible) {
      throw new ExportHandoffError(
        "OVERSIZE_EVIDENCE_UNSPLITTABLE",
        `${unit.unitId} is indivisible and exceeds maxChunkChars=${maxChunkChars}`,
      );
    }
    output.push(...splitTextUnit(unit, state, maxChunkChars));
  }
  return output;
}

function fragmentTurn(turn, state, maxChunkChars) {
  return fragmentUnits(turnEvidenceUnits(turn), state, maxChunkChars);
}

function packFragmentSegments(fragments, state, maxChunkChars) {
  const segments = [];
  let pending = [];

  const flush = () => {
    if (pending.length === 0) return;
    const segment = createFragmentSegment(
      state.sessionId,
      state.nextSegmentNumber,
      pending,
    );
    if (segment.evidenceChars > maxChunkChars) {
      throw new ExportHandoffError(
        "OVERSIZE_EVIDENCE_UNSPLITTABLE",
        `${segment.segmentId} exceeds maxChunkChars=${maxChunkChars}`,
      );
    }
    segments.push(segment);
    state.nextSegmentNumber += 1;
    pending = [];
  };

  for (const fragment of fragments) {
    const candidate = createFragmentSegment(
      state.sessionId,
      state.nextSegmentNumber,
      [...pending, fragment],
    );
    if (candidate.evidenceChars <= maxChunkChars) {
      pending.push(fragment);
      continue;
    }
    flush();
    pending.push(fragment);
  }
  flush();
  return segments;
}

function createNormalSegment(sessionId, segmentNumber, turns) {
  return measured({
    segmentId: `segment-${String(segmentNumber).padStart(3, "0")}`,
    stage: "segment_map",
    sourceSessionId: sessionId,
    expectedTurnIds: turns.map((turn) => turn.turnId),
    turns,
  });
}

function workspaceObservationValue(workspace, payloadPath) {
  const fields = {
    "/checkpoint/content": workspace?.checkpoint?.content,
    "/git/branchAndStatus": workspace?.git?.branchAndStatus,
    "/git/recentCommits": workspace?.git?.recentCommits,
    "/git/unstagedDiffStat": workspace?.git?.unstagedDiffStat,
    "/git/stagedDiffStat": workspace?.git?.stagedDiffStat,
    "/git/unstagedNames": workspace?.git?.unstagedNames,
    "/git/stagedNames": workspace?.git?.stagedNames,
  };
  if (payloadPath === "/git/probe") {
    return workspace?.git?.status === "not_repository"
      ? workspace.git.reason
      : "true";
  }
  return fields[payloadPath] ?? "Observation retained by Critical Anchor policy.";
}

function createWorkspaceSegment(sessionId, segmentNumber, observations) {
  return measured({
    segmentId: `workspace-map-${String(segmentNumber).padStart(3, "0")}`,
    stage: "workspace_map",
    sourceSessionId: sessionId,
    observations,
  });
}

function collectPlanAnchors(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPlanAnchors(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "anchors" && Array.isArray(nested)) {
      for (const anchorId of nested) output.add(anchorId);
    } else if (key === "outputAnchor" && typeof nested === "string") {
      output.add(nested);
    } else {
      collectPlanAnchors(nested, output);
    }
  }
  return output;
}

function chunkCriticalEvidence(evidencePack, state, maxChunkChars) {
  const requiredAnchors = new Set(
    evidencePack.preservationLedger?.requiredAnchors || [],
  );
  const segments = [];
  const turnAggregates = [];
  const reduceStages = [];

  for (const turn of evidencePack.turns) {
    const selectedUnits = turnEvidenceUnits(turn).filter((unit) => (
      unit.anchors.some((anchorId) => requiredAnchors.has(anchorId))
    ));
    if (selectedUnits.length === 0) continue;

    state.fragmentOrdinal = 0;
    const fragments = fragmentUnits(selectedUnits, state, maxChunkChars);
    validateTurnFragments(fragments, {
      parentTurnId: turn.turnId,
      expectedFragmentIds: fragments.map((fragment) => fragment.fragmentId),
    });
    const fragmentSegments = packFragmentSegments(fragments, state, maxChunkChars);
    segments.push(...fragmentSegments);
    const aggregateId = `turn-aggregate-${String(turnAggregates.length + 1).padStart(3, "0")}`;
    turnAggregates.push({
      segmentId: aggregateId,
      stage: "turn_aggregate_map",
      parentTurnId: turn.turnId,
      expectedTurnIds: [turn.turnId],
      expectedFragmentIds: fragments.map((fragment) => fragment.fragmentId),
      childSegmentIds: fragmentSegments.map((item) => item.segmentId),
    });
    reduceStages.push({ stage: "turn_aggregate_map", segmentId: aggregateId });
  }

  const requiredWorkspaceAnchors = (evidencePack.evidenceAnchors || [])
    .filter((anchor) => (
      anchor.sourceKind === "workspace" && requiredAnchors.has(anchor.anchorId)
    ));
  let pendingObservations = [];
  const flushWorkspace = () => {
    if (pendingObservations.length === 0) return;
    const segment = createWorkspaceSegment(
      state.sessionId,
      state.nextSegmentNumber,
      pendingObservations,
    );
    if (segment.evidenceChars > maxChunkChars) {
      throw new ExportHandoffError(
        "OVERSIZE_EVIDENCE_UNSPLITTABLE",
        `${segment.segmentId} exceeds maxChunkChars=${maxChunkChars}`,
      );
    }
    segments.push(segment);
    reduceStages.push({ stage: segment.stage, segmentId: segment.segmentId });
    state.nextSegmentNumber += 1;
    pendingObservations = [];
  };
  for (const anchor of requiredWorkspaceAnchors) {
    const observation = measured({
      payloadPath: anchor.payloadPath,
      anchors: [anchor.anchorId],
      value: workspaceObservationValue(evidencePack.workspace, anchor.payloadPath),
    });
    const candidate = createWorkspaceSegment(
      state.sessionId,
      state.nextSegmentNumber,
      [...pendingObservations, observation],
    );
    if (candidate.evidenceChars <= maxChunkChars) {
      pendingObservations.push(observation);
      continue;
    }
    flushWorkspace();
    const single = createWorkspaceSegment(
      state.sessionId,
      state.nextSegmentNumber,
      [observation],
    );
    if (single.evidenceChars > maxChunkChars) {
      throw new ExportHandoffError(
        "OVERSIZE_EVIDENCE_UNSPLITTABLE",
        `Workspace observation ${anchor.payloadPath} exceeds maxChunkChars=${maxChunkChars}`,
      );
    }
    pendingObservations.push(observation);
  }
  flushWorkspace();

  const plannedAnchors = collectPlanAnchors(segments);
  const missingAnchors = [...requiredAnchors].filter((anchorId) => (
    !plannedAnchors.has(anchorId)
  ));
  if (missingAnchors.length > 0) {
    throw new ExportHandoffError(
      "CRITICAL_EVIDENCE_UNAVAILABLE",
      "One or more Critical Anchors cannot be routed to a continuation MAP segment",
      { missingAnchors },
    );
  }
  if (segments.length === 0) {
    throw new ExportHandoffError(
      "NO_EVIDENCE_CHUNKS",
      "Continuation planning selected no Critical Anchor evidence",
    );
  }
  return { segments, turnAggregates, reduceStages };
}

export function validateTurnFragments(fragments, expected) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    throw new ExportHandoffError(
      "INCOMPLETE_FRAGMENT_COVERAGE",
      `No fragments supplied for ${expected.parentTurnId}`,
    );
  }
  const ids = fragments.map((fragment) => fragment?.fragmentId);
  if (new Set(ids).size !== ids.length) {
    throw new ExportHandoffError("DUPLICATE_FRAGMENT", "Fragment IDs must be unique");
  }
  if (
    ids.length !== expected.expectedFragmentIds.length ||
    ids.some((id) => !expected.expectedFragmentIds.includes(id))
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_FRAGMENT_COVERAGE",
      `Fragments for ${expected.parentTurnId} are incomplete`,
    );
  }
  if (ids.some((id, index) => id !== expected.expectedFragmentIds[index])) {
    throw new ExportHandoffError("REORDERED_FRAGMENT", "Fragments must remain in source order");
  }

  let previous = null;
  for (const [index, fragment] of fragments.entries()) {
    if (fragment.parentTurnId !== expected.parentTurnId || fragment.ordinal !== index) {
      throw new ExportHandoffError("REORDERED_FRAGMENT", "Fragment ordinals are not contiguous");
    }
    const range = fragment.sourceRangeUtf16;
    if (range) {
      const unitRange = fragment.sourceUnitRangeUtf16;
      if (!unitRange || range.start < unitRange.start || range.end > unitRange.end || range.end <= range.start) {
        throw new ExportHandoffError(
          "INCOMPLETE_FRAGMENT_RANGE",
          `Invalid source range for ${fragment.fragmentId}`,
        );
      }
      if (previous?.unitId === fragment.unitId && previous.sourceRangeUtf16) {
        if (range.start < previous.sourceRangeUtf16.end) {
          throw new ExportHandoffError(
            "OVERLAPPING_FRAGMENT_RANGE",
            `Fragment ${fragment.fragmentId} overlaps its predecessor`,
          );
        }
        if (range.start !== previous.sourceRangeUtf16.end) {
          throw new ExportHandoffError(
            "INCOMPLETE_FRAGMENT_RANGE",
            `Fragment ${fragment.fragmentId} leaves a source gap`,
          );
        }
      } else if (range.start !== unitRange.start) {
        throw new ExportHandoffError(
          "INCOMPLETE_FRAGMENT_RANGE",
          `Fragment ${fragment.fragmentId} does not start at its unit boundary`,
        );
      }
      const next = fragments[index + 1];
      if (next?.unitId !== fragment.unitId && range.end !== unitRange.end) {
        throw new ExportHandoffError(
          "INCOMPLETE_FRAGMENT_RANGE",
          `Fragment ${fragment.fragmentId} does not exhaust its unit`,
        );
      }
    }
    previous = fragment;
  }
  return fragments;
}

export function chunkEvidencePack(evidencePack, options = {}) {
  const maxChunkChars = options.maxChunkChars ?? 140_000;
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < 4_000) {
    throw new ExportHandoffError("INVALID_CHUNK_BUDGET", "maxChunkChars must be an integer >= 4000");
  }

  const sessionId = evidencePack.source.sessionId;
  const state = {
    sessionId,
    nextSegmentNumber: 1,
    fragmentOrdinal: 0,
  };
  if (options.criticalOnly === true) {
    return chunkCriticalEvidence(evidencePack, state, maxChunkChars);
  }
  const segments = [];
  const turnAggregates = [];
  const reduceStages = [];
  let pendingTurns = [];

  const flush = () => {
    if (pendingTurns.length === 0) return;
    const segment = createNormalSegment(sessionId, state.nextSegmentNumber, pendingTurns);
    if (segment.evidenceChars > maxChunkChars) {
      throw new ExportHandoffError(
        "OVERSIZE_EVIDENCE_UNSPLITTABLE",
        `${segment.segmentId} exceeds maxChunkChars=${maxChunkChars}`,
      );
    }
    segments.push(segment);
    reduceStages.push({ stage: segment.stage, segmentId: segment.segmentId });
    state.nextSegmentNumber += 1;
    pendingTurns = [];
  };

  for (const turn of evidencePack.turns) {
    const candidate = createNormalSegment(
      sessionId,
      state.nextSegmentNumber,
      [...pendingTurns, turn],
    );
    if (candidate.evidenceChars <= maxChunkChars) {
      pendingTurns.push(turn);
      continue;
    }
    flush();
    const single = createNormalSegment(sessionId, state.nextSegmentNumber, [turn]);
    if (single.evidenceChars <= maxChunkChars) {
      pendingTurns.push(turn);
      continue;
    }

    state.fragmentOrdinal = 0;
    const fragments = fragmentTurn(turn, state, maxChunkChars);
    validateTurnFragments(fragments, {
      parentTurnId: turn.turnId,
      expectedFragmentIds: fragments.map((fragment) => fragment.fragmentId),
    });
    const fragmentSegments = packFragmentSegments(fragments, state, maxChunkChars);
    segments.push(...fragmentSegments);
    const aggregateId = `turn-aggregate-${String(turnAggregates.length + 1).padStart(3, "0")}`;
    const aggregate = {
      segmentId: aggregateId,
      stage: "turn_aggregate_map",
      parentTurnId: turn.turnId,
      expectedTurnIds: [turn.turnId],
      expectedFragmentIds: fragments.map((fragment) => fragment.fragmentId),
      childSegmentIds: fragmentSegments.map((item) => item.segmentId),
    };
    turnAggregates.push(aggregate);
    reduceStages.push({ stage: aggregate.stage, segmentId: aggregateId });
  }
  flush();

  if (segments.length === 0) {
    throw new ExportHandoffError("NO_EVIDENCE_CHUNKS", "Evidence Pack contains no user turns");
  }
  return { segments, turnAggregates, reduceStages };
}
