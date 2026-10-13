export type Report = (text: string) => void;

interface Failure {
  code?: unknown;
  message?: unknown;
}

function refusal(value: unknown): Failure | null {
  const error = (value as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return { message: error };
  return error && typeof error === 'object' ? (error as Failure) : null;
}

function reasonOf(error: unknown): Failure {
  return error && typeof error === 'object' ? (error as Failure) : { message: error };
}

export function failure(action: string, error: Failure): string {
  if (error.code === 'EACCES') return `This page is view-only, so it can't ${action}.`;
  const reason = String(error.message ?? '').replace(/[\s.]+$/, '');
  return reason ? `Couldn't ${action}: ${reason}.` : `Couldn't ${action}.`;
}

export const warn: Report = (text) => console.warn(text);

export function attempt(
  call: Promise<unknown>,
  action: string,
  report: Report,
  undo?: () => void
): void {
  const failed = (error: Failure) => {
    undo?.();
    report(failure(action, error));
  };
  void call
    .then(
      (value) => {
        const refused = refusal(value);
        if (refused) failed(refused);
      },
      (error: unknown) => failed(reasonOf(error))
    )
    .catch(warn);
}
