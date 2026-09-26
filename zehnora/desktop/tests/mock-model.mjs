// OpenAI-compatible mock model server for tests: streams SSE chunks with content, reasoning and tool calls.
import http from 'node:http';

const chunk = (delta, finish = null) => ({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}

/** Default scenario used by the Electron end-to-end test. */
export function scenario(body) {
  const messages = body.messages;
  const last = messages[messages.length - 1];
  const task = lastUser(messages);
  if (last.role === 'tool') {
    const results = messages.filter((m) => m.role === 'tool').map((m) => m.content);
    return { content: `Done. Tool said: ${results[results.length - 1].split('\n')[0]}` };
  }
  if (/create hello/i.test(task)) {
    return { reasoning: 'I will write the file.', tool_calls: [{ name: 'write_file', arguments: JSON.stringify({ path: 'hello/hello.txt', content: 'hello from zehnora\n' }) }] };
  }
  if (/delete hello/i.test(task)) {
    return { tool_calls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'rm -rf hello', reason: 'remove the test folder' }) }] };
  }
  if (/search web/i.test(task)) {
    return { tool_calls: [{ name: 'web_search', arguments: JSON.stringify({ query: 'Electron safeStorage API documentation', max_results: 5 }) }] };
  }
  if (/github/i.test(task)) {
    return { tool_calls: [{ name: 'github_search', arguments: JSON.stringify({ query: 'fastapi example', max_results: 3 }) }] };
  }
  if (/list files/i.test(task)) {
    return { tool_calls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'ls -la' }) }] };
  }
  return { reasoning: 'Simple greeting.', content: `Hello! You said: **${task}**\n\n\`\`\`js\nconsole.log("hi");\n\`\`\`` };
}

export async function startMockModel(handler = scenario, { apiKey = 'sk-test-0123456789abcdef' } = {}) {
  const requests = [];
  const keys = new Set([apiKey]);
  const accounts = new Map();
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const platform = (req, res, body) => {
    const cookie = req.headers.cookie ?? '';
    const session = /zehnora_session=([^;]+)/.exec(cookie)?.[1];
    const csrfOk = session && req.headers['x-csrf-token'] === `csrf-${session}`;
    const start = (email) => {
      const token = `s${accounts.size}${Date.now()}`;
      accounts.get(email).sessions.add(token);
      return json(res, req.url.endsWith('register') ? 201 : 200, { user: { email }, csrf_token: `csrf-${token}` }, {
        'set-cookie': [`zehnora_session=${token}; HttpOnly; Path=/`, `zehnora_csrf=csrf-${token}; Path=/`],
      });
    };
    const owner = [...accounts.entries()].find(([, a]) => a.sessions.has(session))?.[0];
    if (req.url === '/platform/v1/auth/register') {
      if (accounts.has(body.email)) return json(res, 409, { error: { message: 'An account with this email already exists.' } });
      accounts.set(body.email, { password: body.password, sessions: new Set(), credits: 2000 });
      return start(body.email);
    }
    if (req.url === '/platform/v1/auth/login') {
      const account = accounts.get(body.email);
      if (!account || account.password !== body.password) return json(res, 401, { error: { message: 'Email or password is incorrect.' } });
      return start(body.email);
    }
    if (!owner) return json(res, 401, { error: { message: 'Login required.' } });
    if (req.url === '/platform/v1/keys' && req.method === 'POST') {
      if (!csrfOk) return json(res, 403, { error: { message: 'Missing or invalid CSRF token.' } });
      const secret = `sk-mock${Math.random().toString(36).slice(2)}${Date.now()}`;
      keys.add(secret);
      return json(res, 201, { secret, key: { name: body.name } });
    }
    if (req.url === '/platform/v1/me') return json(res, 200, { user: { email: owner }, wallet: { available_credits: accounts.get(owner).credits } });
    if (req.url === '/platform/v1/auth/logout') return json(res, 200, { ok: true });
    return json(res, 404, { error: { message: 'not found' } });
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/platform/v1/')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => platform(req, res, raw ? JSON.parse(raw) : {}));
      return;
    }
    if (!keys.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'zehnora-coder' }] }));
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const reply = await handler(body, requests.length);
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: reply.error ?? 'error' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send(chunk({ role: 'assistant' }));
      for (const part of (reply.reasoning ?? '').match(/.{1,6}/gs) ?? []) send(chunk({ reasoning_content: part }));
      for (const part of (reply.content ?? '').match(/.{1,5}/gs) ?? []) send(chunk({ content: part }));
      (reply.tool_calls ?? []).forEach((call, index) => {
        const id = `call_${requests.length}_${index}`;
        const half = Math.ceil(call.arguments.length / 2);
        send(chunk({ tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: call.arguments.slice(0, half) } }] }));
        send(chunk({ tool_calls: [{ index, function: { arguments: call.arguments.slice(half) } }] }));
      });
      send(chunk({}, reply.tool_calls?.length ? 'tool_calls' : reply.finish ?? 'stop'));
      send({ id: 'mock', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, consoleUrl: `http://127.0.0.1:${port}`, accounts, apiKey, requests, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockModel();
  console.log(`mock model at ${mock.url} key ${mock.apiKey}`);
}
