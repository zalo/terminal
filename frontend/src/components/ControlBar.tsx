import { useCallback } from 'react';

interface ControlBarProps {
  onKey: (key: string) => void;
  onCopy: () => Promise<void>;
  onPaste: () => Promise<void>;
  onToggleInput: () => void;
  inputVisible: boolean;
}

export default function ControlBar({ onKey, onCopy, onPaste, onToggleInput, inputVisible }: ControlBarProps) {
  const sendCtrlKey = useCallback(
    (char: string) => {
      const code = char.toUpperCase().charCodeAt(0) - 64;
      onKey(String.fromCharCode(code));
    },
    [onKey]
  );

  return (
    <div className="flex items-center gap-1 px-2 py-2 bg-[#252540] border-b border-[#2d2d4a] overflow-x-auto flex-shrink-0">
      {/* X / Up / Down */}
      <div className="flex gap-1 pr-2 border-r border-[#2d2d4a]">
        <button
          className="control-btn bg-red-900 hover:bg-red-800 border-red-700"
          onClick={() => sendCtrlKey('C')}
          title="Terminate (Ctrl+C)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          className="control-btn"
          onClick={() => onKey('\x1b[A')}
          title="Up arrow (previous command)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <button
          className="control-btn"
          onClick={() => onKey('\x1b[B')}
          title="Down arrow (next command)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Rich Text / Paste */}
      <div className="flex gap-1 px-2 border-r border-[#2d2d4a]">
        <button
          className={`control-btn ${inputVisible ? 'active' : ''}`}
          onClick={onToggleInput}
          title="Toggle text input (for dictation)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button
          className="control-btn"
          onClick={onCopy}
          title="Copy selection (opens select mode if nothing is selected)"
        >
          Copy
        </button>
        <button
          className="control-btn"
          onClick={onPaste}
          title="Paste from clipboard"
        >
          Paste
        </button>
      </div>

      {/* Tab / C-b / Esc */}
      <div className="flex gap-1 px-2 border-r border-[#2d2d4a]">
        <button
          className="control-btn"
          onClick={() => onKey('\t')}
          title="Tab (autocomplete)"
        >
          Tab
        </button>
        <button
          className="control-btn"
          onClick={() => sendCtrlKey('B')}
          title="Ctrl+B (tmux prefix)"
        >
          C-b
        </button>
        <button
          className="control-btn"
          onClick={() => onKey('\x1b')}
          title="Escape"
        >
          Esc
        </button>
      </div>

      {/* Left / Right */}
      <div className="flex gap-1 pl-1">
        <button
          className="control-btn"
          onClick={() => onKey('\x1b[D')}
          title="Left arrow"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          className="control-btn"
          onClick={() => onKey('\x1b[C')}
          title="Right arrow"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
