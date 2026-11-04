import type { Context } from '@earendil-works/chord';
import type { IntentSources } from './intent.ts';
import type { Approval } from './record.ts';

export interface Attendance {
  attend(): () => void;
  attended(): boolean;
}

export function attendance(): Attendance {
  const links = new Set<symbol>();
  return {
    attend() {
      const link = Symbol('owner device');
      links.add(link);
      return () => void links.delete(link);
    },
    attended: () => links.size > 0,
  };
}

export interface PresenceSources {
  attended(): boolean;
  agents?: Pick<IntentSources['agents'], 'state'>;
}

export function ownerPresent(sources: PresenceSources) {
  return async (_item: Approval, _context: Context): Promise<boolean> => sources.attended();
}
