import { useSession } from '../App';

export default function Docs() {
  const { me } = useSession();
  const base = me?.api_base_url ?? 'https://api.<OWNER_DOMAIN>/v1';
  const curl = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $ROSHVYN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "roshvyn-coder", "messages": [{"role": "user", "content": "Say hello"}]}'`;
  const openai = `import os
from openai import OpenAI

client = OpenAI(base_url=os.environ["ROSHVYN_BASE_URL"], api_key=os.environ["ROSHVYN_API_KEY"])
reply = client.chat.completions.create(
    model="roshvyn-coder",
    messages=[{"role": "user", "content": "Write a Python function that validates a non-empty task title."}],
)
print(reply.choices[0].message.content)`;
  const lc = `import os
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="roshvyn-coder",
    base_url=os.environ["ROSHVYN_BASE_URL"],
    api_key=os.environ["ROSHVYN_API_KEY"],
    use_responses_api=False,
)
response = llm.invoke("Write a Python function that validates a non-empty task title.")
print(response.content)`;
  return (
    <>
      <header className="page-head"><h1>Quickstart</h1></header>
      <section className="card">
        <h2>API base URL</h2>
        <div className="row"><code className="secret-value">{base}</code>
          <button onClick={() => navigator.clipboard.writeText(base)}>Copy</button></div>
        <p className="muted small">Use this as <code>base_url</code>. Do not add <code>/chat/completions</code> to it. Requests run on our own model and GPU, through a standard OpenAI-compatible format; they are not sent to OpenAI.</p>
        <p className="small">Set these environment variables first:</p>
        <pre>{`export ROSHVYN_BASE_URL="${base}"\nexport ROSHVYN_API_KEY="<your key from the API keys page>"`}</pre>
      </section>
      <section className="card"><h2>curl</h2><pre>{curl}</pre></section>
      <section className="card"><h2>OpenAI Python SDK</h2><pre>{openai}</pre></section>
      <section className="card"><h2>LangChain ChatOpenAI</h2><pre>{lc}</pre>
        <p className="muted small">Supported: <code>/v1/models</code> and <code>/v1/chat/completions</code> (text, streaming, tool calls). Not supported yet: <code>/v1/responses</code>, embeddings, images.</p>
      </section>
      <section className="card">
        <h2>Errors</h2>
        <table><tbody>
          <tr><td>401</td><td>Invalid, revoked or expired key</td></tr>
          <tr><td>402</td><td>Insufficient credits (checked before generation)</td></tr>
          <tr><td>403</td><td>Account disabled or model not permitted</td></tr>
          <tr><td>429</td><td>Model at capacity; retry later</td></tr>
          <tr><td>503</td><td>Model or billing service unavailable</td></tr>
        </tbody></table>
      </section>
    </>
  );
}
