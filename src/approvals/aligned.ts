export const JUDGE_ALLOW = 0.8;

export const fits = (aligned: number | boolean | undefined): boolean =>
  aligned === true || (typeof aligned === 'number' && aligned >= JUDGE_ALLOW);
