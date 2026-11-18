import { fits } from './aligned.ts';
import type { Approval } from './record.ts';

export function verdictOf(item: Approval) {
  const { verdict, judging, verdictError } = item;
  return {
    ...(verdict
      ? {
          verdict: {
            ...(verdict.level ? { level: verdict.level } : {}),
            ...(verdict.aligned === undefined ? {} : { aligned: fits(verdict.aligned) }),
            reason: verdict.reason,
          },
        }
      : {}),
    ...(judging ? { judging: true } : {}),
    ...(verdictError ? { verdictError } : {}),
  };
}
