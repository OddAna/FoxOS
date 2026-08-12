import React, { useState, useEffect, useRef } from 'react';
import { Save, CheckCircle } from 'lucide-react';
import { apiFetch } from '../api';

const TextEditorApp = ({ filePath, initialLine = null }) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const editorRef = useRef(null);
  const highlightedLocationRef = useRef(null);

  useEffect(() => {
    const fetchContent = async () => {
      try {
        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
        const response = await apiFetch(`/api/static${encodedPath}`);
        const text = await response.text();
        setContent(text);
      } catch (err) {
        console.error(err);
        setError('Dosya yüklenirken hata oluştu.');
      } finally {
        setLoading(false);
      }
    };
    if (filePath) {
      fetchContent();
    }
  }, [filePath]);

  useEffect(() => {
    if (loading || !Number.isInteger(initialLine) || initialLine < 1 || !editorRef.current) return;
    const locationKey = `${filePath}:${initialLine}`;
    if (highlightedLocationRef.current === locationKey) return;
    const lines = content.split('\n');
    const lineIndex = Math.min(initialLine - 1, Math.max(0, lines.length - 1));
    const start = lines.slice(0, lineIndex).reduce((total, line) => total + line.length + 1, 0);
    const end = start + (lines[lineIndex]?.length || 0);
    editorRef.current.focus();
    editorRef.current.setSelectionRange(start, end);
    editorRef.current.scrollTop = Math.max(0, lineIndex * 21 - 84);
    highlightedLocationRef.current = locationKey;
  }, [content, filePath, initialLine, loading]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filePath, content }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error(err);
      setError('Dosya kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', backgroundColor: '#1e1e1e', color: '#d4d4d4' }}>
      {/* Top Header */}
      <div style={{ 
        height: '40px', 
        borderBottom: '1px solid #333', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        padding: '0 16px', 
        fontSize: '13px', 
        color: '#ccc',
        backgroundColor: '#252526'
      }}>
        <span>{filePath}</span>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {error && <span style={{ color: '#f44336', fontSize: '12px' }}>{error}</span>}
          {saved && <span style={{ color: '#4caf50', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><CheckCircle size={14} /> Kaydedildi</span>}
          <div 
            onClick={handleSave}
            title="Kaydet (CTRL+S)"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 12px',
              backgroundColor: saving ? '#444' : '#0ea5e9',
              color: '#fff',
              borderRadius: '4px',
              cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              fontWeight: 'bold',
              transition: 'background 0.2s'
            }}
          >
            <Save size={14} />
            {saving ? 'Kaydediliyor...' : 'Kaydet'}
          </div>
        </div>
      </div>
      
      {/* Editor Content */}
      <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
        {loading ? (
          <div style={{ color: '#888', fontSize: '14px' }}>Yükleniyor...</div>
        ) : (
          <textarea
            ref={editorRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                handleSave();
              }
            }}
            placeholder="Bir şeyler yazmaya başla..."
            style={{
              width: '100%',
              height: '100%',
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              fontFamily: 'Consolas, Monaco, monospace',
              fontSize: '14px',
              lineHeight: '1.5',
              resize: 'none',
              outline: 'none',
              whiteSpace: 'pre-wrap'
            }}
          />
        )}
      </div>
    </div>
  );
};

export default TextEditorApp;
