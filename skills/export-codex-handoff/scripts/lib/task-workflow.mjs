import path from "node:path";

import {
  prepareCompressionTask as prepareCompressionTaskCore,
} from "./task-workflow-core.mjs";

export {
  acceptMapReceipt,
  checkMapDispatch,
  checkReduceStage,
  claimMapDispatch,
  completeMapDispatch,
  prepareFrameStage,
  prepareReduceStage,
  publishHandoff,
  recordMapGenerationMetric,
  validateFrameStage,
  validateMapStage,
} from "./task-workflow-core.mjs";

export async function prepareCompressionTask(options, dependencies = {}) {
  const prepared = await prepareCompressionTaskCore(options, dependencies);
  return {
    ...prepared,
    evidenceIndexWorkPath: path.join(prepared.workDir, "evidence-index.json"),
  };
}
