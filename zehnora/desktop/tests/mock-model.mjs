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
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
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
  return { url: `http://127.0.0.1:${port}/v1`, apiKey, requests, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockModel();
  console.log(`mock model at ${mock.url} key ${mock.apiKey}`);
}
