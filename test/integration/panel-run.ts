import { type Panels, panelCommand } from '@ai-ecoverse/slicc-spectrum/ui';
import type { PageRun } from '../../src/spectrum/page-port.ts';

export const bios =
  (app: { panels: Panels }): PageRun =>
  (argv, caller) =>
    panelCommand(app, argv, caller);
