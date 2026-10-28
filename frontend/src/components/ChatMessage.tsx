import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal } from '../lib/openExternal';

// Markdown links open outside the app (new tab / Chrome from the iOS PWA)
// instead of navigating this tab away from the session.
const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  ),
};

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  id?: string;
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface ChatMessageProps {
  message: Record<string, unknown>;
  isStreaming?: boolean;
  onQuestionResponse?: (toolUseId: string, answers: Record<string, string>) => void;
  answeredQuestions?: Set<string>;
  toolResults?: Record<string, unknown>;
}

function formatToolResult(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text' && c?.text) return c.text;
      return JSON.stringify(c, null, 2);
    }).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

function ToolCallBlock({ block, result }: { block: ContentBlock; result?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [showTab, setShowTab] = useState<'input' | 'output'>('output');
  const hasResult = result !== undefined;

  return (
    <div className="my-2 border border-[#2d2d4a] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm bg-[#1a1a2e] hover:bg-[#2d2d4a] transition-colors"
      >
        <svg
          className={`w-3 h-3 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M6 4l8 6-8 6V4z" />
        </svg>
        <span className="text-[#4fd1c5] font-mono text-xs">{block.name || 'tool'}</span>
        {block.type === 'tool_result' && (
          <span className="text-slate-500 text-xs ml-auto">result</span>
        )}
        {hasResult && block.type === 'tool_use' && (
          <span className="text-green-500/60 text-xs ml-auto">done</span>
        )}
      </button>
      {expanded && (
        <div>
          {/* Tabs for tool_use blocks that have results */}
          {block.type === 'tool_use' && hasResult && (
            <div className="flex border-b border-[#2d2d4a]">
              <button
                onClick={() => setShowTab('output')}
                className={`px-3 py-1 text-xs transition-colors ${
                  showTab === 'output'
                    ? 'text-[#4fd1c5] border-b border-[#4fd1c5]'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Output
              </button>
              <button
                onClick={() => setShowTab('input')}
                className={`px-3 py-1 text-xs transition-colors ${
                  showTab === 'input'
                    ? 'text-[#4fd1c5] border-b border-[#4fd1c5]'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Input
              </button>
            </div>
          )}
          <pre className="px-3 py-2 text-xs text-slate-300 bg-[#151528] overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
            {block.type === 'tool_result'
              ? formatToolResult(block.content)
              : block.type === 'tool_use' && hasResult && showTab === 'output'
                ? formatToolResult(result)
                : JSON.stringify(block.input, null, 2)
            }
          </pre>
        </div>
      )}
    </div>
  );
}

function AskUserQuestionBlock({
  block,
  onResponse,
  isAnswered,
}: {
  block: ContentBlock;
  onResponse?: (toolUseId: string, answers: Record<string, string>) => void;
  isAnswered: boolean;
}) {
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(isAnswered);

  const input = block.input as { questions?: Question[] } | undefined;
  const questions = input?.questions;
  if (!questions || questions.length === 0) {
    return <ToolCallBlock block={block} />;
  }

  const handleSelect = (questionText: string, optionLabel: string) => {
    if (submitted) return;
    setSelectedAnswers(prev => ({ ...prev, [questionText]: optionLabel }));
  };

  const handleSubmit = () => {
    if (submitted || !block.id || !onResponse) return;
    const answers = { ...selectedAnswers };
    if (Object.keys(answers).length === 0) return;
    setSubmitted(true);
    onResponse(block.id, answers);
  };

  const allAnswered = questions.every(q => selectedAnswers[q.question]);

  return (
    <div className="my-3 border border-[#3d3d5a] rounded-lg overflow-hidden bg-[#1e1e38]">
      {questions.map((q, qi) => (
        <div key={qi} className={qi > 0 ? 'border-t border-[#2d2d4a]' : ''}>
          <div className="px-4 pt-3 pb-2">
            {q.header && (
              <span className="text-xs font-medium text-[#4fd1c5] bg-[#4fd1c5]/10 px-2 py-0.5 rounded mb-1.5 inline-block">
                {q.header}
              </span>
            )}
            <p className="text-sm text-slate-200 mt-1">{q.question}</p>
          </div>
          <div className="px-3 pb-3 flex flex-col gap-1.5">
            {q.options.map((opt, oi) => {
              const isSelected = selectedAnswers[q.question] === opt.label;
              return (
                <button
                  key={oi}
                  onClick={() => handleSelect(q.question, opt.label)}
                  disabled={submitted}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                    isSelected
                      ? 'border-[#4fd1c5] bg-[#4fd1c5]/15 text-slate-100'
                      : submitted
                        ? 'border-[#2d2d4a] bg-[#1a1a2e] text-slate-500 opacity-50'
                        : 'border-[#2d2d4a] bg-[#1a1a2e] hover:border-[#4fd1c5]/50 hover:bg-[#252540] text-slate-300'
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  {opt.description && (
                    <div className="text-xs text-slate-400 mt-0.5">{opt.description}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!submitted && (
        <div className="px-3 pb-3 border-t border-[#2d2d4a] pt-2">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors bg-[#4fd1c5] text-[#1a1a2e] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#38b2ac]"
          >
            Submit
          </button>
        </div>
      )}
      {submitted && (
        <div className="px-4 pb-3 pt-1 text-xs text-slate-500">
          Answered: {Object.values(selectedAnswers).join(', ') || '(previously answered)'}
        </div>
      )}
    </div>
  );
}

export default function ChatMessage({ message, isStreaming, onQuestionResponse, answeredQuestions, toolResults }: ChatMessageProps) {
  const type = message.type as string;

  // User message
  if (type === 'user') {
    const text = message.text as string | undefined;
    // Skip user messages without text (internal tool_result messages from Claude)
    if (!text) return null;
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[85%] bg-[#1a3a4a] text-slate-200 rounded-2xl rounded-br-md px-4 py-2 text-sm">
          {text}
        </div>
      </div>
    );
  }

  // Assistant message
  if (type === 'assistant') {
    const content = (message.message as Record<string, unknown>)?.content as ContentBlock[] | undefined;
    if (!content) return null;

    return (
      <div className="mb-3">
        <div className="max-w-full">
          {content.map((block, i) => {
            if (block.type === 'text' && block.text) {
              return (
                <div key={i} className="chat-markdown text-sm text-slate-200">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {block.text}
                  </ReactMarkdown>
                  {isStreaming && i === content.length - 1 && (
                    <span className="inline-block w-0.5 h-4 bg-[#4fd1c5] animate-pulse ml-0.5 align-text-bottom" />
                  )}
                </div>
              );
            }
            if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
              return (
                <AskUserQuestionBlock
                  key={i}
                  block={block}
                  onResponse={onQuestionResponse}
                  isAnswered={answeredQuestions?.has(block.id || '') || false}
                />
              );
            }
            if (block.type === 'tool_use' || block.type === 'tool_result') {
              return (
                <ToolCallBlock
                  key={i}
                  block={block}
                  result={block.type === 'tool_use' && block.id ? toolResults?.[block.id] : undefined}
                />
              );
            }
            return null;
          })}
        </div>
      </div>
    );
  }

  // Result message (end of turn)
  if (type === 'result') {
    return null;
  }

  // System init
  if (type === 'system') {
    return (
      <div className="text-center text-xs text-slate-500 mb-3 py-1">
        Session started
      </div>
    );
  }

  // Process exit
  if (type === 'process_exit') {
    return (
      <div className="text-center text-xs text-red-400 mb-3 py-1">
        Claude process exited (code: {message.code as number})
      </div>
    );
  }

  return null;
}
