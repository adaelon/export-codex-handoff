export const MIDDLE_ONLY_MARKER = "MIDDLE_ONLY_FAILURE_MARKER";

export const EXACT_IDENTIFIERS = [
  { kind: "uuid", value: "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7" },
  { kind: "hash", value: "9f86d081884c7d659a2feaa0c55ad015" },
  { kind: "url", value: "https://example.test/a?b=1&c=two" },
  { kind: "path", value: "C:\\workspace\\src\\export-handoff.mjs" },
  { kind: "ip", value: "192.0.2.44" },
  { kind: "port", value: "4317" },
  { kind: "symbol", value: "buildEvidencePack" },
];

export function largeToolOutput() {
  const identifiers = EXACT_IDENTIFIERS.map(({ kind, value }) => `${kind}=${value}`).join("\n");
  return [
    `HEAD-${"h".repeat(400)}`,
    identifiers,
    MIDDLE_ONLY_MARKER,
    `TAIL-${"t".repeat(400)}`,
  ].join("\n");
}

export const SLICE1_EXPECTATIONS = {
  claims: [
    {
      claimId: "middle-tool-failure",
      text: MIDDLE_ONLY_MARKER,
      anchors: ["call-output-anchor"],
    },
  ],
  ignoredTurns: [],
  exactIdentifiers: EXACT_IDENTIFIERS,
  archivalEvents: [
    { kind: "attempt", text: "large tool output retained by anchor" },
  ],
};
