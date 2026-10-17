import * as bedrock from '@earendil-works/pi-ai/api/bedrock-converse-stream';
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import './main-worker.js';

setBedrockProviderModule(bedrock);
