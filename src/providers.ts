import type { Provider } from '@earendil-works/pi-ai';
import { antLingProvider } from '@earendil-works/pi-ai/providers/ant-ling';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { basetenProvider } from '@earendil-works/pi-ai/providers/baseten';
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { fireworksProvider } from '@earendil-works/pi-ai/providers/fireworks';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { huggingfaceProvider } from '@earendil-works/pi-ai/providers/huggingface';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';
import { metaProvider } from '@earendil-works/pi-ai/providers/meta';
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax';
import { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { qwenTokenPlanProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan';
import { qwenTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn';
import { qwenTokenPlanIndividualProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-individual';
import { togetherProvider } from '@earendil-works/pi-ai/providers/together';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { xiaomiProvider } from '@earendil-works/pi-ai/providers/xiaomi';
import { xiaomiTokenPlanAmsProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-ams';
import { xiaomiTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-cn';
import { xiaomiTokenPlanSgpProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp';
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai';
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn';

export interface KeyProvider {
  id: string;
  make: () => Provider;
  env: string;
  description: string;
  keyUrl: string;
  cors: boolean;
}

export const KEY_PROVIDERS: readonly KeyProvider[] = [
  {
    id: 'anthropic',
    make: anthropicProvider,
    env: 'ANTHROPIC_API_KEY',
    description: 'Claude models, with an API key from the Claude Console.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    cors: true,
  },
  {
    id: 'openai',
    make: openaiProvider,
    env: 'OPENAI_API_KEY',
    description: 'GPT models, with an API key from the OpenAI platform.',
    keyUrl: 'https://platform.openai.com/api-keys',
    cors: true,
  },
  {
    id: 'mistral',
    make: mistralProvider,
    env: 'MISTRAL_API_KEY',
    description: 'Mistral and Devstral models from La Plateforme.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    cors: true,
  },
  {
    id: 'groq',
    make: groqProvider,
    env: 'GROQ_API_KEY',
    description: 'Open models on Groq’s fast inference.',
    keyUrl: 'https://console.groq.com/keys',
    cors: true,
  },
  {
    id: 'deepseek',
    make: deepseekProvider,
    env: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek’s own models.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    cors: true,
  },
  {
    id: 'together',
    make: togetherProvider,
    env: 'TOGETHER_API_KEY',
    description: 'Open models hosted by Together AI.',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    cors: true,
  },
  {
    id: 'huggingface',
    make: huggingfaceProvider,
    env: 'HF_TOKEN',
    description: 'Open models through Hugging Face’s inference router.',
    keyUrl: 'https://huggingface.co/settings/tokens',
    cors: true,
  },
  {
    id: 'xiaomi',
    make: xiaomiProvider,
    env: 'XIAOMI_API_KEY',
    description: 'Xiaomi’s MiMo models.',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    cors: true,
  },
  {
    id: 'xiaomi-token-plan-ams',
    make: xiaomiTokenPlanAmsProvider,
    env: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    description: 'MiMo models on a Xiaomi token plan, served from Amsterdam.',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    cors: true,
  },
  {
    id: 'xiaomi-token-plan-cn',
    make: xiaomiTokenPlanCnProvider,
    env: 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    description: 'MiMo models on a Xiaomi token plan, served from China.',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    cors: true,
  },
  {
    id: 'xiaomi-token-plan-sgp',
    make: xiaomiTokenPlanSgpProvider,
    env: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    description: 'MiMo models on a Xiaomi token plan, served from Singapore.',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    cors: true,
  },
  {
    id: 'cerebras',
    make: cerebrasProvider,
    env: 'CEREBRAS_API_KEY',
    description: 'Open models on Cerebras inference.',
    keyUrl: 'https://cloud.cerebras.ai',
    cors: false,
  },
  {
    id: 'openrouter',
    make: openrouterProvider,
    env: 'OPENROUTER_API_KEY',
    description: 'Hundreds of models from many labs through one key.',
    keyUrl: 'https://openrouter.ai/settings/keys',
    cors: false,
  },
  {
    id: 'fireworks',
    make: fireworksProvider,
    env: 'FIREWORKS_API_KEY',
    description: 'Open models hosted by Fireworks AI.',
    keyUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    cors: false,
  },
  {
    id: 'baseten',
    make: basetenProvider,
    env: 'BASETEN_API_KEY',
    description: 'Open models hosted by Baseten.',
    keyUrl: 'https://app.baseten.co/settings/api_keys',
    cors: false,
  },
  {
    id: 'moonshotai',
    make: moonshotaiProvider,
    env: 'MOONSHOT_API_KEY',
    description: 'Kimi models from Moonshot AI.',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    cors: false,
  },
  {
    id: 'moonshotai-cn',
    make: moonshotaiCnProvider,
    env: 'MOONSHOT_API_KEY',
    description: 'Kimi models from Moonshot AI’s China platform.',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    cors: false,
  },
  {
    id: 'xai',
    make: xaiProvider,
    env: 'XAI_API_KEY',
    description: 'Grok models from xAI.',
    keyUrl: 'https://console.x.ai',
    cors: false,
  },
  {
    id: 'meta',
    make: metaProvider,
    env: 'META_API_KEY',
    description: 'Meta’s Muse models.',
    keyUrl: 'https://developer.meta.ai',
    cors: false,
  },
  {
    id: 'vercel-ai-gateway',
    make: vercelAIGatewayProvider,
    env: 'AI_GATEWAY_API_KEY',
    description: 'Models from many labs through Vercel’s AI Gateway.',
    keyUrl: 'https://vercel.com/docs/ai-gateway/authentication',
    cors: false,
  },
  {
    id: 'minimax',
    make: minimaxProvider,
    env: 'MINIMAX_API_KEY',
    description: 'MiniMax’s models.',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    cors: false,
  },
  {
    id: 'minimax-cn',
    make: minimaxCnProvider,
    env: 'MINIMAX_CN_API_KEY',
    description: 'MiniMax’s models from its China platform.',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    cors: false,
  },
  {
    id: 'zai',
    make: zaiProvider,
    env: 'ZAI_API_KEY',
    description: 'GLM models on Z.AI’s coding plan.',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    cors: false,
  },
  {
    id: 'zai-coding-cn',
    make: zaiCodingCnProvider,
    env: 'ZAI_CODING_CN_API_KEY',
    description: 'GLM models on Zhipu’s coding plan in China.',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    cors: false,
  },
  {
    id: 'nvidia',
    make: nvidiaProvider,
    env: 'NVIDIA_API_KEY',
    description: 'Open models on NVIDIA’s API catalog.',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    cors: false,
  },
  {
    id: 'kimi-coding',
    make: kimiCodingProvider,
    env: 'KIMI_API_KEY',
    description: 'Kimi models on the Kimi Code subscription.',
    keyUrl: 'https://www.kimi.com/code/console',
    cors: false,
  },
  {
    id: 'ant-ling',
    make: antLingProvider,
    env: 'ANT_LING_API_KEY',
    description: 'Ling and Ring models from Ant Group.',
    keyUrl: 'https://www.ant-ling.com',
    cors: false,
  },
  {
    id: 'opencode',
    make: opencodeProvider,
    env: 'OPENCODE_API_KEY',
    description: 'Models curated for coding agents by OpenCode Zen.',
    keyUrl: 'https://opencode.ai/auth',
    cors: false,
  },
  {
    id: 'opencode-go',
    make: opencodeGoProvider,
    env: 'OPENCODE_API_KEY',
    description: 'Open models on the OpenCode Go subscription.',
    keyUrl: 'https://opencode.ai/auth',
    cors: false,
  },
  {
    id: 'qwen-token-plan',
    make: qwenTokenPlanProvider,
    env: 'QWEN_TOKEN_PLAN_API_KEY',
    description: 'Qwen models on an Alibaba Cloud token plan.',
    keyUrl: 'https://modelstudio.console.alibabacloud.com',
    cors: false,
  },
  {
    id: 'qwen-token-plan-cn',
    make: qwenTokenPlanCnProvider,
    env: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    description: 'Qwen models on an Alibaba Cloud token plan in China.',
    keyUrl: 'https://bailian.console.aliyun.com',
    cors: false,
  },
  {
    id: 'qwen-token-plan-individual',
    make: qwenTokenPlanIndividualProvider,
    env: 'QWEN_TOKEN_PLAN_API_KEY',
    description: 'Qwen models on an individual Alibaba Cloud token plan.',
    keyUrl: 'https://modelstudio.console.alibabacloud.com',
    cors: false,
  },
];

export type ProviderAuth = 'api-key' | 'oauth' | 'fields' | 'local';

export interface Listing {
  description: string;
  keyUrl?: string;
  auth: ProviderAuth;
  corsFree: boolean;
  vaultName: string;
}

const upper = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function vaultNames(entries: readonly KeyProvider[]): Map<string, string> {
  const uses = Map.groupBy(entries, (entry) => entry.env);
  return new Map(
    entries.map((entry) => [
      entry.id,
      (uses.get(entry.env) as KeyProvider[]).length > 1 ? `${upper(entry.id)}_API_KEY` : entry.env,
    ])
  );
}

const named = vaultNames(KEY_PROVIDERS);

export const LISTINGS: ReadonlyMap<string, Listing> = new Map<string, Listing>([
  [
    'amazon-bedrock',
    {
      description: 'Claude and other models on AWS, with a Bedrock API key.',
      keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
      auth: 'fields',
      corsFree: true,
      vaultName: 'AWS_BEARER_TOKEN_BEDROCK',
    },
  ],
  [
    'adobe',
    {
      description: 'Models through Adobe’s LLM proxy, with your Adobe ID.',
      auth: 'oauth',
      corsFree: true,
      vaultName: 'ADOBE_IMS_TOKEN',
    },
  ],
  ...KEY_PROVIDERS.map((entry): [string, Listing] => [
    entry.id,
    {
      description: entry.description,
      keyUrl: entry.keyUrl,
      auth: 'api-key',
      corsFree: !entry.cors,
      vaultName: named.get(entry.id) as string,
    },
  ]),
]);

export const ADDED_FIRST: readonly string[] = ['amazon-bedrock', 'adobe'];

export const VAULT_KNOWN: ReadonlySet<string> = new Set(
  [...LISTINGS.keys()].filter((id) => id !== 'adobe')
);
