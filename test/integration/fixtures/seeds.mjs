const FIRST = ['GH_TOKEN', 'UNI_KEY', 'NPM_TOKEN'];
const DIGITS = '0123456789abcdef';
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const encoder = new TextEncoder();

const next = (state) => (Math.imul(1664525, state) + 1013904223) >>> 0;

export function proxyId(index, seed = 0x51cc5eed) {
  let state = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  let out = '';
  while (out.length < 24) {
    state = next(state);
    for (let shift = 0; shift < 32 && out.length < 24; shift += 4)
      out += DIGITS[(state >>> shift) & 15];
  }
  return `fnox_proxy_${out.replace(/(.)\1{15,}/g, (run, ch) => `${run.slice(0, 15)}${ch === '0' ? 'a' : '0'}${run.slice(16)}`)}`;
}

export function withoutLongRuns(text) {
  return text.replace(/(.)\1{15,}/gu, (run, ch) => {
    const alt = ch === '0' ? 'a' : '0';
    let out = '';
    for (let i = 0; i < run.length; i++) out += i > 0 && i % 15 === 0 ? alt : ch;
    return out;
  });
}

export function seeded(vectors) {
  const byName = new Map();
  for (const item of vectors.cases)
    for (const secret of item.secrets)
      if (!byName.has(secret.name)) byName.set(secret.name, secret);
  const ordered = [
    ...FIRST.map((name) => byName.get(name)),
    ...[...byName.values()].filter((secret) => !FIRST.includes(secret.name)),
  ];
  const values = ordered.map((secret, index) => ({
    ...secret,
    placeholder: proxyId(index),
    value: withoutLongRuns(secret.value),
  }));
  const byRemapped = new Map(values.map((secret) => [secret.name, secret]));
  const cases = vectors.cases.map((item) => {
    const secrets = item.secrets.map((secret) => byRemapped.get(secret.name) ?? secret);
    const input = item.inputHex === undefined ? encoder.encode(item.input) : hex(item.inputHex);
    const output = item.outputHex === undefined ? encoder.encode(item.output) : hex(item.outputHex);
    return {
      name: item.name,
      secrets,
      hits: item.hits,
      text: item.inputHex === undefined,
      input,
      output,
      ...(item.inputHex === undefined ? { inputText: item.input, outputText: item.output } : {}),
    };
  });
  return { values, cases };
}
