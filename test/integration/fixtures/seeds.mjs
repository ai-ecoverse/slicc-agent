const FIRST = ['GH_TOKEN', 'UNI_KEY', 'NPM_TOKEN'];
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const encoder = new TextEncoder();

export function seeded(vectors) {
  const byName = new Map();
  for (const item of vectors.cases)
    for (const secret of item.secrets)
      if (!byName.has(secret.name)) byName.set(secret.name, secret);
  const values = [
    ...FIRST.map((name) => byName.get(name)),
    ...[...byName.values()].filter((secret) => !FIRST.includes(secret.name)),
  ];
  const cases = vectors.cases.map((item) => {
    const input = item.inputHex === undefined ? encoder.encode(item.input) : hex(item.inputHex);
    const output = item.outputHex === undefined ? encoder.encode(item.output) : hex(item.outputHex);
    return {
      name: item.name,
      secrets: item.secrets,
      hits: item.hits,
      text: item.inputHex === undefined,
      input,
      output,
      ...(item.inputHex === undefined ? { inputText: item.input, outputText: item.output } : {}),
    };
  });
  return { values, cases };
}
