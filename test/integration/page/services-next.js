import {
  CONTROL_READS,
  CONTROL_METHODS as controlMethods,
  CONTRACTS as current,
  AgentTranscript as currentTranscript,
  OWNER_DEVICE_METHODS,
  OWNER_SETTINGS_METHODS,
  SETTINGS_MEMBER,
  SETTINGS_METHODS,
  transcriptMember,
  TRANSCRIPT_STATES as transcriptStates,
} from '../../../src/services.ts';
import { contract, fingerprints } from '../../../src/serving.ts';
import { CHORD_PROTOCOL, WIRE } from '../../../src/wire.ts';

export * from '../../../src/services.ts';

export const CONTROL_METHODS = [...controlMethods, 'echo'];

export const AgentControl = contract(
  'slicc.agent.control',
  {
    control: { methods: CONTROL_METHODS },
    view: { methods: [...CONTROL_READS, ...OWNER_DEVICE_METHODS] },
  },
  { added: { 2: ['echo'] } }
);

const follower = typeof window === 'object';

export const TRANSCRIPT_STATES = follower ? [...transcriptStates, 'extra'] : transcriptStates;

export const AgentTranscript = follower
  ? contract(
      'slicc.agent.transcript',
      { transcript: { state: TRANSCRIPT_STATES.map(transcriptMember) } },
      { added: { 2: ['extra'] } }
    )
  : currentTranscript;

export const AgentSettings = contract(
  'slicc.agent.settings',
  {
    owner: { state: [SETTINGS_MEMBER], methods: OWNER_SETTINGS_METHODS },
    settings: { state: [SETTINGS_MEMBER], methods: SETTINGS_METHODS },
    view: { state: [SETTINGS_MEMBER] },
  },
  { since: 2 }
);

const AgentExtra = contract('slicc.agent.extra', { extra: { methods: ['ping'] } });

const replaced = new Map(
  [AgentControl, AgentTranscript, AgentSettings].map((made) => [made.name, made])
);

export const CONTRACTS = [...current.map((made) => replaced.get(made.name) ?? made), AgentExtra];

export const CONTRACT_PRINTS = fingerprints(CONTRACTS);

export const helloOf = (server) => ({
  wire: WIRE,
  chord: CHORD_PROTOCOL,
  contracts: CONTRACT_PRINTS,
  ...(server === undefined ? {} : { server }),
});
