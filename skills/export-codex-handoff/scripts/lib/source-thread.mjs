import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

import {
  createEvidenceEntry,
  createToolReceipt,
  hashFileRevision,
  stringifyEvidenceValue,
} from "./evidence-addressing.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENTIAL_CONFIRMATION_PATTERNS = [
  /^(?:同意|确认|对|继续)$/u,
  /^(?:同意|确认|对|继续)(?:修改|采用|按|照|执行|继续)?(?:这个|这份|该|上述|上面)(?:方案|提议|建议|修改|做法)?(?:做|执行|修改|改)?$/u,
  /^(?:修改这个|按这个做|照这个做|就按这个|继续这个|执行这个)$/u,
  /^(?:yes|agreed|continue|do\s+it)$/iu,
  /^(?:yes|agreed|continue)(?:\s+(?:with\s+)?(?:this|that|it|continue|do\s+it))$/iu,
];

export class ExportHandoffError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ExportHandoffError";
    this.code = code;
    this.details = details;
  }
}

export function resolveCodexHome(env = process.env, userHome = os.homedir()) {
  return path.resolve(env.CODEX_HOME || path.join(userHome, ".codex"));
}

export function validateSessionId(sessionId) {
  if (!UUID_PATTERN.test(sessionId ?? "")) {
    throw new ExportHandoffError(
      "INVALID_SESSION_ID",
      `Expected a Codex session UUID, received: ${sessionId ?? "<missing>"}`,
    );
  }
  return sessionId.toLowerCase();
}

export function isReferentialConfirmation(text) {
  if (typeof text !== "string") return false;
  const normalized = text
    .normalize("NFKC")
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .replace(/[，、。！？；;,:：!?.]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > 48) return false;
  const compact = normalized.replace(/\s+/gu, "");
  return REFERENTIAL_CONFIRMATION_PATTERNS.some((pattern) => (
    pattern.test(pattern.flags.includes("i") ? normalized : compact)
  ));
}

async function collectMatchingRollouts(root, sessionId, storageKind, output) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectMatchingRollouts(entryPath, sessionId, storageKind, output);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      entry.name.toLowerCase().includes(sessionId)
    ) {
      output.push({ path: entryPath, storageKind });
    }
  }
}

export async function findSourceThread(sessionId, options = {}) {
  const normalizedId = validateSessionId(sessionId);
  const codexHome = path.resolve(options.codexHome || resolveCodexHome());
  const candidates = [];
  const roots = [
    [path.join(codexHome, "sessions"), "active"],
    [path.join(codexHome, "archived_sessions"), "archived"],
  ];
  for (const [root, storageKind] of roots) {
    await collectMatchingRollouts(root, normalizedId, storageKind, candidates);
  }
  if (candidates.length === 0) {
    throw new ExportHandoffError(
      "SESSION_NOT_FOUND",
      `No Codex rollout JSONL found for session ${normalizedId} under ${codexHome}`,
    );
  }
  if (candidates.length > 1) {
    throw new ExportHandoffError(
      "AMBIGUOUS_SESSION",
      `Multiple rollout JSONL files matched session ${normalizedId}`,
      candidates.map((candidate) => candidate.path),
    );
  }
  return { sessionId: normalizedId, codexHome, ...candidates[0] };
}

function extractMessageParts(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item, index) => {
    if (typeof item?.text === "string" && item.text) {
      return [{
        text: item.text,
        payloadPath: `/payload/content/${index}/text`,
        value: item.text,
        indivisible: false,
      }];
    }
    if (item?.type === "input_image" || item?.type === "output_image") {
      return [{
        text: "[image content omitted from textual evidence]",
        payloadPath: `/payload/content/${index}`,
        value: item,
        indivisible: true,
      }];
    }
    return [];
  });
}

function createTurn(turnId, timestamp) {
  return {
    turnId,
    startedAt: timestamp ?? null,
    completedAt: null,
    status: "unknown",
    context: null,
    userMessages: [],
    fallbackUserMessages: [],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
    termination: null,
    eventTimeline: [],
  };
}

function increment(counter, key, amount = 1) {
  counter[key] = (counter[key] || 0) + amount;
}

function toolStatus(payload) {
  if (payload?.is_error === true || payload?.isError === true || payload?.output?.isError === true) {
    return "error";
  }
  return "ok";
}

function messageEvidence(message) {
  return {
    timestamp: message.timestamp ?? null,
    text: message.text,
    anchors: [...(message.anchors || [])],
    source: message.source ? {
      ...message.source,
      rangeUtf16: { ...message.source.rangeUtf16 },
    } : null,
  };
}

function deriveSourceContinuation(turns) {
  const finalTurn = turns.at(-1);
  const currentGoalMessage = finalTurn?.userMessages?.at(-1) || null;
  if (!currentGoalMessage) return null;
  const finalGoalOrdinal = currentGoalMessage.source?.eventOrdinal ?? Number.POSITIVE_INFINITY;
  const precedingAssistant = turns
    .flatMap((turn) => turn.assistantMessages || [])
    .filter((message) => (
      typeof message?.text === "string" &&
      message.text.trim() &&
      (message.source?.eventOrdinal ?? Number.POSITIVE_INFINITY) < finalGoalOrdinal
    ))
    .at(-1) || null;
  const acceptedProposal = isReferentialConfirmation(currentGoalMessage.text)
    ? precedingAssistant
    : null;
  const terminationOrdinal = finalTurn.termination?.eventOrdinal ?? Number.POSITIVE_INFINITY;
  const lastAssistant = turns
    .flatMap((turn) => turn.assistantMessages || [])
    .filter((message) => (
      typeof message?.text === "string" &&
      message.text.trim() &&
      (message.source?.eventOrdinal ?? Number.POSITIVE_INFINITY) < terminationOrdinal
    ))
    .at(-1) || null;
  return {
    currentGoal: messageEvidence(currentGoalMessage),
    acceptedProposal: acceptedProposal ? {
      ...messageEvidence(acceptedProposal),
      phase: acceptedProposal.phase ?? null,
    } : null,
    terminalEvidence: {
      turnId: finalTurn.turnId,
      startedAt: finalTurn.startedAt ?? null,
      terminatedAt: finalTurn.completedAt ?? null,
      status: finalTurn.status ?? "unknown",
      abortReason: finalTurn.termination?.abortReason ?? null,
      terminationAnchors: [...(finalTurn.termination?.anchors || [])],
      lastAssistant: lastAssistant ? {
        ...messageEvidence(lastAssistant),
        phase: lastAssistant.phase ?? null,
      } : null,
      orderedEvents: finalTurn.eventTimeline.map((event) => structuredClone(event)),
    },
  };
}

export async function parseSourceThread(rolloutPath, options = {}) {
  const maxToolChars = options.maxToolChars ?? 12_000;
  const revision = await hashFileRevision(rolloutPath);
  const turnsById = new Map();
  const turnOrder = [];
  const toolsByCallId = new Map();
  const evidenceEntries = [];
  const ignored = {};
  let activeTurnId = null;
  let sessionMeta = null;
  let lineNumber = 0;
  let eventOrdinal = 0;
  let sourceChars = 0;

  const ensureTurn = (turnId, timestamp) => {
    if (!turnId) return null;
    if (!turnsById.has(turnId)) {
      turnsById.set(turnId, createTurn(turnId, timestamp));
      turnOrder.push(turnId);
    }
    return turnsById.get(turnId);
  };

  const anchorValue = ({ turnId, payloadPath, callId, value }) => {
    const entry = createEvidenceEntry({
      sourceKind: "source_thread",
      sourceRevision: revision.sourceRevision,
      turnId,
      eventOrdinal,
      rolloutLine: lineNumber,
      payloadPath,
      callId,
      value,
      locator: { kind: "rollout_payload" },
    });
    evidenceEntries.push(entry);
    return entry;
  };

  const sourceBoundary = (entry, indivisible) => ({
    anchorId: entry.anchor.anchorId,
    eventOrdinal: entry.anchor.eventOrdinal,
    rolloutLine: entry.anchor.rolloutLine,
    payloadPath: entry.anchor.payloadPath,
    rangeUtf16: { ...entry.anchor.rangeUtf16 },
    indivisible,
  });

  const input = fs.createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    sourceChars += line.length + 1;
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new ExportHandoffError(
        "INVALID_ROLLOUT_JSONL",
        `Could not parse rollout JSONL at line ${lineNumber}: ${error.message}`,
      );
    }
    eventOrdinal += 1;

    const payload = record.payload || {};
    if (record.type === "session_meta") {
      sessionMeta = payload;
      continue;
    }
    if (record.type === "turn_context") {
      const turn = ensureTurn(payload.turn_id, record.timestamp);
      if (turn) {
        turn.context = {
          cwd: payload.cwd ?? null,
          model: payload.model ?? null,
          summary: payload.summary ?? null,
        };
      }
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_started") {
      activeTurnId = payload.turn_id;
      const turn = ensureTurn(activeTurnId, payload.started_at || record.timestamp);
      turn.status = "in_progress";
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      const turn = ensureTurn(payload.turn_id, payload.started_at || record.timestamp);
      const terminationEntry = anchorValue({
        turnId: turn.turnId,
        payloadPath: "/payload",
        value: payload,
      });
      turn.status = "completed";
      turn.completedAt = payload.completed_at || record.timestamp;
      turn.termination = {
        eventOrdinal,
        timestamp: record.timestamp ?? null,
        terminatedAt: turn.completedAt,
        abortReason: null,
        anchors: [terminationEntry.anchor.anchorId],
      };
      if (activeTurnId === payload.turn_id) activeTurnId = null;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "turn_aborted") {
      const turn = ensureTurn(payload.turn_id, payload.started_at || record.timestamp);
      const terminationEntry = anchorValue({
        turnId: turn.turnId,
        payloadPath: "/payload",
        value: payload,
      });
      turn.status = "aborted";
      turn.completedAt = payload.completed_at || record.timestamp;
      turn.termination = {
        eventOrdinal,
        timestamp: record.timestamp ?? null,
        terminatedAt: turn.completedAt,
        abortReason: typeof payload.reason === "string" && payload.reason
          ? payload.reason
          : null,
        anchors: [terminationEntry.anchor.anchorId],
      };
      if (activeTurnId === payload.turn_id) activeTurnId = null;
      continue;
    }

    const activeTurn = ensureTurn(activeTurnId, record.timestamp);
    if (record.type === "response_item" && payload.type === "message") {
      if (payload.role === "developer" || payload.role === "system") {
        increment(ignored, "frameworkMessages");
        continue;
      }
      if (!activeTurn) {
        increment(ignored, "orphanMessages");
        continue;
      }
      const parts = extractMessageParts(payload.content);
      if (parts.length === 0) continue;
      if (payload.role === "user") {
        const contentEntry = anchorValue({
          turnId: activeTurn.turnId,
          payloadPath: "/payload/content",
          value: payload.content,
        });
        for (const part of parts) {
          const entry = anchorValue({
            turnId: activeTurn.turnId,
            payloadPath: part.payloadPath,
            value: part.value,
          });
          activeTurn.userMessages.push({
            timestamp: record.timestamp ?? null,
            text: part.text,
            anchors: [contentEntry.anchor.anchorId, entry.anchor.anchorId],
            source: sourceBoundary(entry, part.indivisible),
          });
        }
      }
      if (payload.role === "assistant") {
        for (const part of parts) {
          const entry = anchorValue({
            turnId: activeTurn.turnId,
            payloadPath: part.payloadPath,
            value: part.value,
          });
          const assistantMessage = {
            timestamp: record.timestamp ?? null,
            text: part.text,
            phase: payload.phase ?? null,
            anchors: [entry.anchor.anchorId],
            source: sourceBoundary(entry, part.indivisible),
          };
          activeTurn.assistantMessages.push(assistantMessage);
          activeTurn.eventTimeline.push({
            kind: "assistant_message",
            eventOrdinal,
            timestamp: record.timestamp ?? null,
            phase: assistantMessage.phase,
            text: assistantMessage.text,
            anchors: [...assistantMessage.anchors],
          });
        }
      }
      continue;
    }

    if (
      record.type === "response_item" &&
      (payload.type === "function_call" || payload.type === "custom_tool_call")
    ) {
      if (!activeTurn) {
        increment(ignored, "orphanToolCalls");
        continue;
      }
      const callId = payload.call_id || payload.id || `line-${lineNumber}`;
      const usesArguments = payload.arguments !== undefined && payload.arguments !== null;
      const inputValue = usesArguments ? payload.arguments : payload.input;
      const inputEntry = anchorValue({
        turnId: activeTurn.turnId,
        payloadPath: usesArguments ? "/payload/arguments" : "/payload/input",
        callId,
        value: inputValue,
      });
      const tool = {
        callId,
        type: payload.type,
        name: payload.name || "unknown",
        timestamp: record.timestamp ?? null,
        turnId: activeTurn.turnId,
        inputReceipt: createToolReceipt({
          entry: inputEntry,
          toolName: payload.name || "unknown",
          callId,
          status: "unknown",
          valueKind: "input",
          value: inputValue,
          maxChars: maxToolChars,
        }),
        outputReceipt: null,
      };
      activeTurn.tools.push(tool);
      activeTurn.eventTimeline.push({
        kind: "tool_receipt",
        eventOrdinal,
        timestamp: record.timestamp ?? null,
        toolName: tool.name,
        callId,
        status: tool.inputReceipt.status,
        valueKind: tool.inputReceipt.valueKind,
        receiptId: tool.inputReceipt.receiptId,
        outputAnchor: tool.inputReceipt.outputAnchor,
      });
      toolsByCallId.set(callId, tool);
      continue;
    }

    if (
      record.type === "response_item" &&
      (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")
    ) {
      const tool = toolsByCallId.get(payload.call_id);
      if (tool) {
        const outputEntry = anchorValue({
          turnId: tool.turnId,
          payloadPath: "/payload/output",
          callId: tool.callId,
          value: payload.output,
        });
        tool.outputReceipt = createToolReceipt({
          entry: outputEntry,
          toolName: tool.name,
          callId: tool.callId,
          status: toolStatus(payload),
          valueKind: "output",
          value: payload.output,
          maxChars: maxToolChars,
        });
        const outputTurn = turnsById.get(tool.turnId);
        outputTurn?.eventTimeline.push({
          kind: "tool_receipt",
          eventOrdinal,
          timestamp: record.timestamp ?? null,
          toolName: tool.name,
          callId: tool.callId,
          status: tool.outputReceipt.status,
          valueKind: tool.outputReceipt.valueKind,
          receiptId: tool.outputReceipt.receiptId,
          outputAnchor: tool.outputReceipt.outputAnchor,
        });
      } else increment(ignored, "orphanToolOutputs");
      continue;
    }

    if (record.type === "event_msg" && payload.type === "patch_apply_end") {
      if (activeTurn) {
        const callId = payload.call_id || `patch-line-${lineNumber}`;
        const receipts = [];
        for (const valueKind of ["stdout", "stderr", "changes"]) {
          if (payload[valueKind] === undefined || payload[valueKind] === null) continue;
          const entry = anchorValue({
            turnId: activeTurn.turnId,
            payloadPath: `/payload/${valueKind}`,
            callId,
            value: payload[valueKind],
          });
          receipts.push(createToolReceipt({
            entry,
            toolName: "patch_apply",
            callId,
            status: payload.success === false ? "error" : payload.success === true ? "ok" : "unknown",
            valueKind,
            value: payload[valueKind],
            maxChars: maxToolChars,
          }));
        }
        activeTurn.toolReceipts.push(...receipts);
        activeTurn.patches.push({
          timestamp: record.timestamp ?? null,
          success: payload.success ?? null,
          status: payload.status ?? null,
          receiptIds: receipts.map((receipt) => receipt.receiptId),
        });
      }
      continue;
    }

    if (record.type === "event_msg" && payload.type === "user_message") {
      if (activeTurn && typeof payload.message === "string") {
        const entry = anchorValue({
          turnId: activeTurn.turnId,
          payloadPath: "/payload/message",
          value: payload.message,
        });
        activeTurn.fallbackUserMessages.push({
          timestamp: record.timestamp ?? null,
          text: payload.message,
          anchors: [entry.anchor.anchorId],
          source: sourceBoundary(entry, false),
        });
      }
      continue;
    }
    if (record.type === "response_item" && payload.type === "reasoning") {
      increment(ignored, "encryptedReasoning");
      continue;
    }
    if (record.type === "event_msg" && payload.type === "token_count") {
      increment(ignored, "tokenStatistics");
      continue;
    }
    if (record.type === "event_msg" && payload.type === "agent_message") {
      increment(ignored, "duplicateAgentMessages");
      continue;
    }
    increment(ignored, "otherEvents");
  }

  const turns = [];
  for (const turnId of turnOrder) {
    const turn = turnsById.get(turnId);
    if (turn.userMessages.length === 0 && turn.fallbackUserMessages.length > 0) {
      turn.userMessages = turn.fallbackUserMessages;
      increment(ignored, "fallbackUserMessagesUsed", turn.fallbackUserMessages.length);
    } else {
      increment(ignored, "duplicateUserMessages", turn.fallbackUserMessages.length);
    }
    delete turn.fallbackUserMessages;
    if (turn.userMessages.length === 0) {
      increment(ignored, "emptyTurns");
      continue;
    }

    turn.tools = turn.tools.map((tool) => {
      const receipts = [tool.inputReceipt, tool.outputReceipt].filter(Boolean);
      turn.toolReceipts.push(...receipts);
      return {
        callId: tool.callId,
        type: tool.type,
        name: tool.name,
        timestamp: tool.timestamp,
        inputReceiptId: tool.inputReceipt.receiptId,
        outputReceiptId: tool.outputReceipt?.receiptId ?? null,
      };
    });
    turn.eventTimeline.sort((left, right) => left.eventOrdinal - right.eventOrdinal);
    turns.push(turn);
  }

  if (!sessionMeta) {
    throw new ExportHandoffError(
      "MISSING_SESSION_META",
      `Rollout has no session_meta record: ${rolloutPath}`,
    );
  }
  if (turns.length === 0) {
    throw new ExportHandoffError("NO_USER_TURNS", `Rollout has no user turns: ${rolloutPath}`);
  }

  const sourceContinuation = deriveSourceContinuation(turns);
  for (const turn of turns) delete turn.eventTimeline;

  return {
    rolloutPath: path.resolve(rolloutPath),
    sourceChars,
    sourceBytes: revision.sourceBytes,
    sourceRevision: revision.sourceRevision,
    session: {
      id: sessionMeta.session_id || sessionMeta.id || null,
      cwd: sessionMeta.cwd || null,
      startedAt: sessionMeta.timestamp || null,
      cliVersion: sessionMeta.cli_version || null,
      source: sessionMeta.source || null,
      historyMode: sessionMeta.history_mode || null,
    },
    turns,
    evidenceEntries,
    ignored,
    sourceContinuation,
  };
}
