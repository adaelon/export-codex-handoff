import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

async function packageFiles(root) {
  const entries = [];
  async function visit(directory) {
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath);
      } else if (child.isFile()) {
        const relativePath = slashPath(path.relative(root, absolutePath));
        const content = await fs.promises.readFile(absolutePath);
        entries.push({ relativePath, digest: sha256(content) });
      }
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

export async function comparePackageTrees(sourceDir, mirrorDir) {
  const [sourceEntries, mirrorEntries] = await Promise.all([
    packageFiles(sourceDir),
    packageFiles(mirrorDir),
  ]);
  const source = new Map(sourceEntries.map((entry) => [entry.relativePath, entry.digest]));
  const mirror = new Map(mirrorEntries.map((entry) => [entry.relativePath, entry.digest]));
  const onlyInSource = [...source.keys()].filter((item) => !mirror.has(item));
  const onlyInMirror = [...mirror.keys()].filter((item) => !source.has(item));
  const changed = [...source.keys()].filter((item) => (
    mirror.has(item) && mirror.get(item) !== source.get(item)
  ));
  const canonical = sourceEntries
    .map((entry) => `${entry.relativePath}\0${entry.digest}\n`)
    .join("");
  return {
    matches: onlyInSource.length === 0 && onlyInMirror.length === 0 && changed.length === 0,
    fileCount: sourceEntries.length,
    packageDigest: `sha256:${sha256(canonical)}`,
    onlyInSource,
    onlyInMirror,
    changed,
  };
}

function messageText(payload) {
  if (payload?.type !== "message" || payload.role !== "assistant") return "";
  return (payload.content || [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function toolArguments(payload) {
  if (payload?.type !== "function_call") return null;
  try {
    const parsed = JSON.parse(payload.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolDescriptor(payload, args) {
  return `${payload.name || ""}\n${JSON.stringify(args)}`;
}

function isBroadSearch(payload, args) {
  const descriptor = toolDescriptor(payload, args);
  return (
    /(?:^|[\s"'])rg(?:\.exe)?(?:[\s"']|$)/iu.test(descriptor) ||
    /(?:^|[\s"'])grep(?:[\s"']|$)/iu.test(descriptor) ||
    /Get-ChildItem[^\r\n;]*-Recurse/iu.test(descriptor) ||
    /\b(?:search_query|image_query|find_files|workspace_search)\b/iu.test(descriptor)
  );
}

function isFullFileReread(payload, args) {
  const name = String(payload.name || "").toLowerCase();
  const descriptor = toolDescriptor(payload, args);
  if (/Get-Content[^\r\n;]*-(?:Raw|ReadCount\s+0)/iu.test(descriptor)) return true;
  if (/(?:^|[;\r\n]\s*)(?:cat|type)\s+[^|;\r\n]+/iu.test(descriptor)) return true;
  if (!["read_file", "open_file", "view_file"].includes(name)) return false;
  const hasBound = [
    "line_start",
    "line_end",
    "start_line",
    "end_line",
    "offset",
    "limit",
    "range",
  ].some((key) => args[key] !== undefined && args[key] !== null);
  return !hasBound;
}

function isEvidenceRead(payload, args) {
  const name = String(payload.name || "").toLowerCase();
  const descriptor = toolDescriptor(payload, args);
  return (
    ["read_file", "open_file", "view_file", "read_mcp_resource"].includes(name) ||
    /\b(?:Get-Content|Select-String|rg|grep|cat|type)\b/iu.test(descriptor) ||
    isBroadSearch(payload, args)
  );
}

function responseItems(records) {
  return records
    .filter((record) => record?.type === "response_item" && record.payload)
    .map((record, ordinal) => ({ ordinal, payload: record.payload }));
}

export function analyzeActionReadyContinuation(records, options) {
  if (!Array.isArray(records)) throw new TypeError("Continuation rollout records must be an array");
  const contract = options?.consumerContract;
  if (!contract || contract.mode !== "synthesize_first") {
    throw new TypeError("Action-ready live acceptance requires a synthesize_first consumer contract");
  }
  const draftMarkers = options?.draftMarkers || [];
  const deliverableMarkers = options?.deliverableMarkers || [];
  const items = responseItems(records);
  const messages = items
    .map((item) => ({ ...item, text: messageText(item.payload) }))
    .filter((item) => item.text);
  const tools = items
    .filter((item) => item.payload.type === "function_call")
    .map((item) => ({ ...item, args: toolArguments(item.payload) }));
  const substantiveDraft = messages.find((item) => (
    item.text.length >= 40 && draftMarkers.every((marker) => item.text.includes(marker))
  ));
  const firstToolOrdinal = tools[0]?.ordinal ?? Number.POSITIVE_INFINITY;
  const draftOrdinal = substantiveDraft?.ordinal ?? Number.POSITIVE_INFINITY;
  const readEvents = tools.filter((item) => isEvidenceRead(item.payload, item.args));
  const preDraftEvidenceReads = readEvents.filter((item) => item.ordinal < draftOrdinal).length;
  const broadSearches = tools.filter((item) => isBroadSearch(item.payload, item.args)).length;
  const fullFileRereads = tools.filter((item) => isFullFileReread(item.payload, item.args)).length;
  const targetedReads = readEvents.filter((item) => (
    !isBroadSearch(item.payload, item.args) && !isFullFileReread(item.payload, item.args)
  )).length;
  const assistantText = messages.map((item) => item.text).join("\n");
  const missingDeliverables = deliverableMarkers.filter((marker) => !assistantText.includes(marker));
  const substantiveDraftBeforeFirstToolCall = Boolean(
    substantiveDraft && substantiveDraft.ordinal < firstToolOrdinal,
  );
  const diagnosticCodes = [];
  if (!substantiveDraftBeforeFirstToolCall) diagnosticCodes.push("DRAFT_NOT_FIRST");
  if (preDraftEvidenceReads !== contract.preDraftEvidenceReads) {
    diagnosticCodes.push("PRE_DRAFT_EVIDENCE_READ");
  }
  if (contract.forbidBroadSearch && broadSearches > 0) {
    diagnosticCodes.push("BROAD_SEARCH_FORBIDDEN");
  }
  if (contract.forbidFullFileReread && fullFileRereads > 0) {
    diagnosticCodes.push("FULL_FILE_REREAD_FORBIDDEN");
  }
  if (targetedReads > contract.maxTargetedReads) diagnosticCodes.push("TARGETED_READ_LIMIT");
  if (missingDeliverables.length > 0) diagnosticCodes.push("DELIVERABLE_INCOMPLETE");
  return {
    accepted: diagnosticCodes.length === 0,
    substantiveDraftBeforeFirstToolCall,
    preDraftEvidenceReads,
    broadSearches,
    fullFileRereads,
    targetedReads,
    missingDeliverables,
    diagnosticCodes,
    firstDraftOrdinal: Number.isFinite(draftOrdinal) ? draftOrdinal : null,
    firstToolOrdinal: Number.isFinite(firstToolOrdinal) ? firstToolOrdinal : null,
  };
}
