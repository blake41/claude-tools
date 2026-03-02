import { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, type Editor } from 'tldraw';
import 'tldraw/tldraw.css';
import { renderBreadboard } from './shapes';
import type { LayoutResult } from '../../types';

export default function App() {
  const editorRef = useRef<Editor | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);

  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => setStatus('connected');
    ws.onclose = () => setStatus('disconnected');

    ws.onmessage = (event) => {
      const layout: LayoutResult = JSON.parse(event.data);
      const editor = editorRef.current;
      if (editor) {
        renderBreadboard(editor, layout);
      }
    };

    return () => ws.close();
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw onMount={handleMount} />
      <div
        style={{
          position: 'fixed',
          bottom: 12,
          left: 12,
          padding: '4px 10px',
          borderRadius: 6,
          fontSize: 12,
          fontFamily: 'system-ui',
          background: status === 'connected' ? '#e8f5e9' : status === 'connecting' ? '#fff3e0' : '#ffebee',
          color: status === 'connected' ? '#2e7d32' : status === 'connecting' ? '#e65100' : '#c62828',
          zIndex: 9999,
        }}
      >
        {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting...' : 'Disconnected'}
      </div>
    </div>
  );
}
