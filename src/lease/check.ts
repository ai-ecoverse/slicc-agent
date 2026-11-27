const MAX_URL_BYTES = 2048;
const MAX_REASON_BYTES = 256;
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;
const encoder = new TextEncoder();

export const REFUSALS = {
  unavailable: "Proposals aren't available here.",
  scoop: "Proposals only work in a cone's current conversation.",
  frozen: 'This cone is frozen.',
  gone: 'This cone is gone.',
  seat: 'A guest seat is open on this cone.',
  gated: "This run can't propose a browser lease.",
  open: 'A proposal is already waiting for the owner.',
  hourly: 'This cone already sent six proposals in the last hour.',
  restarted: "The agent restarted; nothing was sent. Propose again if it's still needed.",
  urlLong: 'That URL is too long.',
  urlChars: "That URL contains characters that aren't allowed.",
  urlInvalid: "That URL isn't valid.",
  urlHttps: 'Only https URLs can be proposed.',
  urlUserinfo: "That URL can't include a username or password.",
  urlQuery: "That URL can't include a query.",
  urlFragment: "That URL can't include a fragment.",
  reasonLong: 'That reason is too long.',
  reasonChars: "That reason contains characters that aren't allowed.",
} as const;

export function sentText(proposal: number): string {
  return `Proposal ${proposal} sent to the owner. Nothing has started, and you won't receive its status or any page content.`;
}

export function checkUrl(raw: string): string | undefined {
  if (encoder.encode(raw).length > MAX_URL_BYTES) return REFUSALS.urlLong;
  if (FORBIDDEN.test(raw)) return REFUSALS.urlChars;
  if (raw.includes('?')) return REFUSALS.urlQuery;
  if (raw.includes('#')) return REFUSALS.urlFragment;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return REFUSALS.urlInvalid;
  }
  if (url.protocol !== 'https:') return REFUSALS.urlHttps;
  if (url.username || url.password) return REFUSALS.urlUserinfo;
  if (url.search !== '') return REFUSALS.urlQuery;
  if (url.hash !== '') return REFUSALS.urlFragment;
  return undefined;
}

export function checkReason(raw: string): string | undefined {
  if (encoder.encode(raw).length > MAX_REASON_BYTES) return REFUSALS.reasonLong;
  if (FORBIDDEN.test(raw)) return REFUSALS.reasonChars;
  return undefined;
}
