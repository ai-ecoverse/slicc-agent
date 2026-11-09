import type { DecidedBy } from './record.ts';

export const personal = (by: DecidedBy): boolean => by === 'owner' || by === 'follower';
