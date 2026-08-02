import { useState, useEffect } from 'react';
import SessionList from './components/SessionList';
import TerminalView from './components/TerminalView';

interface Selection {
  session: string;
  context?: string;
}

function readUrl(): Selection | null {
  const params = new URLSearchParams(window.location.search);
  const session = params.get('session');
  if (!session) return null;
  const context = params.get('context') || undefined;
  return { session, context };
}

function writeUrl(sel: Selection | null) {
  if (!sel) {
    window.history.pushState({}, '', '/');
    return;
  }
  const qs = new URLSearchParams();
  qs.set('session', sel.session);
  if (sel.context) qs.set('context', sel.context);
  window.history.pushState({}, '', `?${qs.toString()}`);
}

function App() {
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    setSelection(readUrl());
  }, []);

  const handleSelectSession = (session: string, context?: string) => {
    const sel: Selection = { session, context };
    setSelection(sel);
    writeUrl(sel);
  };

  const handleBack = () => {
    setSelection(null);
    writeUrl(null);
  };

  useEffect(() => {
    const handlePopState = () => setSelection(readUrl());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (!selection) {
    return <SessionList onSelectSession={handleSelectSession} />;
  }

  return (
    <TerminalView
      sessionName={selection.session}
      context={selection.context}
      onBack={handleBack}
    />
  );
}

export default App;
