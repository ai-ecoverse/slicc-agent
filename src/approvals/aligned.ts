export const JUDGE_ALLOW = 0.8;
export const JUDGE_LOW = 0.2;
export const JUDGE_EPSILON = 1e-9;

export const clears = (p: number, bar: number): boolean => p >= bar + JUDGE_EPSILON;

export const reaches = (p: number, bar: number): boolean => p >= bar - JUDGE_EPSILON;

export const fits = (aligned: number | boolean | undefined): boolean =>
  aligned === true || (typeof aligned === 'number' && clears(aligned, JUDGE_ALLOW));
