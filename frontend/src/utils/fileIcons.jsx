import React from 'react';
import { Folder, FileText, Image as ImageIcon, Video, Music, File } from 'lucide-react';

export const getFileIcon = (file, size = 48) => {
  if (file.type === 'folder') {
    return <Folder size={size} color="#0ea5e9" fill="rgba(14, 165, 233, 0.4)" strokeWidth={1} />;
  }
  
  const ext = file.ext?.toLowerCase();
  
  if (['.txt', '.md', '.json', '.js', '.jsx', '.html', '.css', '.py'].includes(ext)) {
    return <FileText size={size} color="#94a3b8" strokeWidth={1.2} />;
  }
  
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
    return <ImageIcon size={size} color="#10b981" strokeWidth={1.2} />;
  }
  
  if (['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
    return <Video size={size} color="#f59e0b" strokeWidth={1.2} />;
  }
  
  if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) {
    return <Music size={size} color="#8b5cf6" strokeWidth={1.2} />;
  }
  
  return <File size={size} color="#64748b" strokeWidth={1.2} />;
};
