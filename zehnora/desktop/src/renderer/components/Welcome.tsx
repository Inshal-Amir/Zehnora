import type { ReactElement } from 'react';
import type { Mode } from '../../shared/types';
import type { IconName } from './Icon';
import { Icon } from './Icon';

const SUGGESTIONS: Record<Mode, { icon: IconName; title: string; prompt: string }[]> = {
  chat: [
    { icon: 'globe', title: 'Latest news', prompt: 'What are the most important tech news stories this week? Use web search and cite sources.' },
    { icon: 'spark', title: 'Explain a concept', prompt: 'Explain how transformers in large language models work, in simple words with an example.' },
    { icon: 'github', title: 'Find a GitHub project', prompt: 'Find popular open-source GitHub projects for building a self-hosted chat app and compare the top 3.' },
    { icon: 'edit', title: 'Write something', prompt: 'Write a short professional email asking my supervisor for a meeting next week.' },
  ],
  work: [
    { icon: 'folder', title: 'Create a web app', prompt: 'Create a new React + TypeScript app with Vite called "todo-app" in the working folder, add a simple todo list, install dependencies, start the dev server and check that the page loads.' },
    { icon: 'cpu', title: 'Database in Docker', prompt: 'Set up a PostgreSQL 17 database in Docker with a named volume on port 5432, create a database called "appdb", and give me the connection string.' },
    { icon: 'github', title: 'Clone and run a repo', prompt: 'Find a small, popular FastAPI example project on GitHub, clone it into the working folder, install its dependencies and run it.' },
    { icon: 'terminal', title: 'Check my system', prompt: 'Check this computer: OS, memory, disk space, and which developer tools (git, node, python, docker, gh) are installed. Tell me what is missing for full-stack development.' },
  ],
};

export function Welcome({ mode, onPick }: { mode: Mode; onPick(prompt: string): void }): ReactElement {
  return (
    <div className="welcome">
      <div className="welcome-mark">Z</div>
      <h1>{mode === 'chat' ? 'How can I help today?' : 'What should we build?'}</h1>
      <p>{mode === 'chat' ? 'Ask anything. Zehnora can search the web and GitHub for you.' : 'Zehnora works on your computer: files, terminal, git and GitHub, Docker and databases.'}</p>
      <div className="suggestions">
        {SUGGESTIONS[mode].map((item) => (
          <button key={item.title} type="button" className="suggestion" onClick={() => onPick(item.prompt)}>
            <Icon name={item.icon} size={16} />
            <span className="suggestion-title">{item.title}</span>
            <span className="suggestion-text">{item.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
