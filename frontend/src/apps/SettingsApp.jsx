import React, { useState } from 'react';
import { Settings, Globe, Monitor, Shield, User, Bell, Server } from 'lucide-react';
import MigrationSettings from './MigrationSettings';

const SettingsApp = () => {
  const [activeTab, setActiveTab] = useState('general');

  const tabs = [
    { id: 'general', icon: <Settings size={18} />, label: 'Genel' },
    { id: 'display', icon: <Monitor size={18} />, label: 'Ekran' },
    { id: 'language', icon: <Globe size={18} />, label: 'Dil & Bölge' },
    { id: 'security', icon: <Shield size={18} />, label: 'Güvenlik' },
    { id: 'notifications', icon: <Bell size={18} />, label: 'Bildirimler' },
    { id: 'users', icon: <User size={18} />, label: 'Kullanıcılar' },
    { id: 'migration', icon: <Server size={18} />, label: 'Sunucu Geçişi' },
  ];

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', color: '#fff' }}>
      {/* Sidebar */}
      <div style={{ 
        width: '200px', 
        background: 'rgba(0,0,0,0.3)', 
        borderRight: '1px solid rgba(255,255,255,0.1)',
        padding: '16px 8px'
      }}>
        {tabs.map(tab => (
          <div 
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '8px 12px',
              borderRadius: '8px',
              cursor: 'pointer',
              background: activeTab === tab.id ? 'rgba(255,255,255,0.15)' : 'transparent',
              marginBottom: '4px',
              fontSize: '13px'
            }}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </div>
        ))}
      </div>
      
      {/* Content */}
      <div data-settings-content style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '24px' }}>
          {tabs.find(t => t.id === activeTab)?.label}
        </h2>
        
        {activeTab === 'general' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}>
              <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#ccc' }}>Sistem Hakkında</h3>
              <p style={{ fontSize: '16px', fontWeight: '500' }}>FoxOS v0.0.1 alpha</p>
              <p style={{ fontSize: '13px', color: '#888', marginTop: '4px', lineHeight: 1.5 }}>
                Linux host yönetim ajanı. Bu bir Linux dağıtımı değildir ve sunucuya Ubuntu kurmaz.
              </p>
            </div>
          </div>
        )}

        {activeTab === 'migration' && <MigrationSettings />}

        {activeTab !== 'general' && activeTab !== 'migration' && (
          <p style={{ color: '#888', fontSize: '14px' }}>Bu bölüm yakında eklenecek.</p>
        )}
      </div>
    </div>
  );
};

export default SettingsApp;
