const encoder = new TextEncoder();

const sse = (events) => events.map((event) => `${event}\n\n`).join('');

const anthropic = sse(
  [
    {
      type: 'message_start',
      message: {
        id: 'm',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'x',
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello from Claude.' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`)
);

const chunk = (choice, extra = {}) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'x',
  choices: [choice],
  ...extra,
});
const openai = sse([
  `data: ${JSON.stringify(chunk({ index: 0, delta: { role: 'assistant', content: 'Hello from GPT.' }, finish_reason: null }))}`,
  `data: ${JSON.stringify(chunk({ index: 0, delta: {}, finish_reason: 'stop' }, { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))}`,
  'data: [DONE]',
]);

export const proxyConfig = {
  clientId: 'client',
  scopes: 'openid',
  imsEnvironment: 'prod',
  models: [
    { id: 'claude-x', name: 'Claude X' },
    { id: 'gpt-y', name: 'GPT Y', api: 'openai' },
  ],
};

const REQUIRED = ['x-session-id', 'x-slicc-version'];

export function adobeProxyAnswer(url, method, headers) {
  const path = new URL(url).pathname;
  const missing = REQUIRED.find((name) => !headers.get(name));
  if (method !== 'OPTIONS' && missing) {
    return {
      status: 403,
      type: 'application/json',
      body: JSON.stringify({
        error: { type: 'missing_required_header', message: `Missing required header: ${missing}` },
      }),
    };
  }
  if (path === '/v1/config')
    return { status: 200, type: 'application/json', body: JSON.stringify(proxyConfig) };
  if (headers.get('authorization') !== 'Bearer tok') {
    return {
      status: 401,
      type: 'application/json',
      body: JSON.stringify({
        error: { type: 'authentication_error', message: 'Token verification failed' },
      }),
    };
  }
  if (path === '/v1/usage')
    return {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({ usage: { weekly: { percent: 5, resetsAt: 'r' } } }),
    };
  if (path === '/v1/messages') return { status: 200, type: 'text/event-stream', body: anthropic };
  if (path === '/v1/chat/completions')
    return { status: 200, type: 'text/event-stream', body: openai };
  return { status: 404, type: 'application/json', body: '{}' };
}

export function adobeProxyFetch(seen = []) {
  return async (input, init = {}) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    const answer = adobeProxyAnswer(request.url, request.method, request.headers);
    return new Response(encoder.encode(answer.body), {
      status: answer.status,
      headers: { 'content-type': answer.type },
    });
  };
}
