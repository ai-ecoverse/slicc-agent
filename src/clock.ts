export interface Clock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
}
