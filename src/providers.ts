import type { Provider } from '@earendil-works/pi-ai';
import { antLingProvider } from '@earendil-works/pi-ai/providers/ant-ling';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { azureProvider } from '@earendil-works/pi-ai/providers/azure';
import { basetenProvider } from '@earendil-works/pi-ai/providers/baseten';
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
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

export interface FieldInput {
  name: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  help?: string;
  customBase?: true;
}

export interface FieldSpec extends FieldInput {
  env(value: string): Record<string, string> | string;
}

export interface KeyProvider {
  id: string;
  make: () => Provider;
  env: string;
  description: string;
  keyUrl: string;
  cors: boolean;
  fields?: readonly FieldSpec[];
}

const RESOURCE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const DEPLOYMENTS = /^[^=,\s]+\s*=\s*[^=,\s]+(\s*,\s*[^=,\s]+\s*=\s*[^=,\s]+)*$/;

export function httpsBase(value: string): URL | undefined {
  const url = URL.parse(value);
  if (url?.protocol !== 'https:' || url.username || url.password) return undefined;
  return url.port === '' || url.port === '443' ? url : undefined;
}

function azureEndpoint(value: string): Record<string, string> | string {
  if (RESOURCE.test(value)) return { AZURE_OPENAI_RESOURCE_NAME: value };
  const url = httpsBase(value);
  if (!url)
    return 'Enter your Azure resource name, or its endpoint as an https:// address without a port or a user name.';
  return { AZURE_OPENAI_BASE_URL: url.href.replace(/\/+$/, '') };
}

export const AZURE = 'azure';

export function azureBase(env: Readonly<Record<string, string>>): string | undefined {
  if (env.AZURE_OPENAI_BASE_URL) return env.AZURE_OPENAI_BASE_URL;
  const name = env.AZURE_OPENAI_RESOURCE_NAME;
  return name ? `https://${name}.openai.azure.com/openai/v1` : undefined;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const ACCOUNT = /^[0-9a-f]{32}$/i;
const GATEWAY = /^[A-Za-z0-9_-]{1,64}$/;

const checked =
  (pattern: RegExp, env: string, problem: string) =>
  (value: string): Record<string, string> | string =>
    pattern.test(value) ? { [env]: value } : problem;

export const REGION_FIELD: FieldSpec = {
  name: 'region',
  label: 'Region',
  placeholder: 'us-west-2',
  help: 'The AWS region your Bedrock models run in. Leave it empty for us-west-2.',
  env: checked(REGION, 'AWS_REGION', 'Enter an AWS region such as us-west-2.'),
};

const ACCOUNT_FIELD: FieldSpec = {
  name: 'account',
  label: 'Account ID',
  required: true,
  placeholder: '0123456789abcdef0123456789abcdef',
  help: 'The 32-character ID on your Cloudflare dashboard’s account overview.',
  env: checked(
    ACCOUNT,
    'CLOUDFLARE_ACCOUNT_ID',
    'A Cloudflare account ID is 32 characters of 0–9 and a–f.'
  ),
};

export const KEY_PROVIDERS: readonly KeyProvider[] = [
  {
    id: 'azure',
    make: azureProvider,
    env: 'AZURE_OPENAI_API_KEY',
    description: 'OpenAI models deployed in your own Azure OpenAI or AI Foundry resource.',
    keyUrl: 'https://portal.azure.com',
    cors: true,
    fields: [
      {
        name: 'endpoint',
        label: 'Endpoint',
        required: true,
        placeholder: 'my-resource or https://my-resource.openai.azure.com',
        help: 'Your resource’s name, or its endpoint address from Keys and Endpoint.',
        customBase: true,
        env: azureEndpoint,
      },
      {
        name: 'deployments',
        label: 'Deployments',
        placeholder: 'gpt-5.4=my-gpt',
        help: 'Only for deployments named differently from their model, as model=deployment, separated by commas.',
        env: (value) =>
          DEPLOYMENTS.test(value)
            ? { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: value }
            : 'Write each deployment as model=deployment, separated by commas.',
      },
    ],
  },
  {
    id: 'cloudflare-workers-ai',
    make: cloudflareWorkersAIProvider,
    env: 'CLOUDFLARE_API_KEY',
    description: 'Open models on Cloudflare Workers AI, in your Cloudflare account.',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    cors: false,
    fields: [ACCOUNT_FIELD],
  },
  {
    id: 'cloudflare-ai-gateway',
    make: cloudflareAIGatewayProvider,
    env: 'CLOUDFLARE_API_KEY',
    description: 'Models from many labs through your Cloudflare AI Gateway.',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    cors: false,
    fields: [
      ACCOUNT_FIELD,
      {
        name: 'gateway',
        label: 'Gateway ID',
        required: true,
        placeholder: 'my-gateway',
        help: 'The name of your gateway under AI › AI Gateway.',
        env: checked(
          GATEWAY,
          'CLOUDFLARE_GATEWAY_ID',
          'A gateway ID is letters, digits, - and _, up to 64 characters.'
        ),
      },
    ],
  },
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
  fields?: readonly FieldSpec[];
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
      fields: [REGION_FIELD],
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
      auth: entry.fields ? 'fields' : 'api-key',
      corsFree: !entry.cors,
      vaultName: named.get(entry.id) as string,
      ...(entry.fields ? { fields: entry.fields } : {}),
    },
  ]),
]);

export const ADDED_FIRST: readonly string[] = ['amazon-bedrock', 'adobe'];

export const VAULT_KNOWN: ReadonlySet<string> = new Set(
  [...LISTINGS.keys()].filter((id) => id !== 'adobe')
);
