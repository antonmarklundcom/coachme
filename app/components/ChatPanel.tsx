'use client';

/**
 * ChatPanel — the UI for O2's `/api/chat` (plan.md §6 S2, §3 feature 7): "a
 * simple Q&A panel per repo, not a general chatbot". One question in, one
 * grounded answer out, advice only — the endpoint itself is read-only
 * (lib/chat.ts), and this panel never lets the reply do anything but display:
 * no markdown rendering of the model's own text, no re-parsing, nothing that
 * could turn a reply into a write. The only writes on this page come from
 * server actions the owner deliberately triggers elsewhere.
 */

import { useState, type FormEvent } from 'react';

interface Exchange {
  question: string;
  answer: string;
}

export function ChatPanel({ repoId, repoName }: { repoId: number; repoName: string }) {
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = question.trim();
    if (!q || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo_id: repoId, question: q }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.error === 'string' ? body.error : `chat failed (${res.status})`);
        return;
      }
      setHistory((h) => [...h, { question: q, answer: body.answer as string }]);
      setQuestion('');
    } catch {
      setError('could not reach /api/chat — check your connection and try again');
    } finally {
      setPending(false);
    }
  }

  return (
    <details className="chat">
      <summary>Ask about {repoName}</summary>
      <div className="chat-body">
        {history.length === 0 && !error && (
          <p className="note">
            Read-only advice, grounded in this repo&apos;s stored record. It cannot tick anything for you.
          </p>
        )}
        {history.map((ex, i) => (
          <div className="chat-exchange" key={i}>
            <p className="chat-q">{ex.question}</p>
            <p className="chat-a">{ex.answer}</p>
          </div>
        ))}
        {error && <p className="warn">{error}</p>}
        <form className="chat-form" onSubmit={ask}>
          <input
            className="text"
            type="text"
            placeholder="why is this blocked? what's the next step?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={pending}
            maxLength={1000}
          />
          <button type="submit" disabled={pending || !question.trim()}>
            {pending ? 'Asking…' : 'Ask'}
          </button>
        </form>
      </div>
    </details>
  );
}
