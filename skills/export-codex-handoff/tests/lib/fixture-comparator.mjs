function keyOf(item) {
  return item.claimId || `${item.kind}:${item.value ?? item.text}`;
}

export function compareFixtureItems(actual, expected) {
  const expectedByKey = new Map(expected.map((item) => [keyOf(item), item]));
  const actualByKey = new Map();
  const duplicates = [];

  for (const item of actual) {
    const key = keyOf(item);
    if (actualByKey.has(key)) duplicates.push(key);
    else actualByKey.set(key, item);
  }

  const missing = [];
  const mutated = [];
  for (const [key, expectedItem] of expectedByKey) {
    const actualItem = actualByKey.get(key);
    if (!actualItem) {
      missing.push(key);
      continue;
    }
    if (JSON.stringify(actualItem) !== JSON.stringify(expectedItem)) mutated.push(key);
  }

  const unsupported = [...actualByKey.keys()].filter((key) => !expectedByKey.has(key));
  return { missing, mutated, unsupported, duplicates };
}
