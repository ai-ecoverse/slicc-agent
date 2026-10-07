import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openAgent, serveAgent } from '../../../src/index.ts';

const answers = new URL(self.location.href).searchParams.getAll('answer');
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(answers.map((answer) => fauxAssistantMessage(answer)));
serveAgent(self, openAgent({ models, model: { provider: 'faux', modelId: 'faux-1' } }));
