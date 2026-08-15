import React, { useEffect, useState } from 'react';
import { Settings, Globe, Monitor, Shield, User, Bell, Server, Box, Link2 } from 'lucide-react';
import MigrationSettings from './MigrationSettings';
import ApplicationManager from './ApplicationManager';
import ConnectionsSettings from './ConnectionsSettings';
import NotificationSettings from './NotificationSettings';
import GeneralSettings from './GeneralSettings';
import AppearanceSettings from './AppearanceSettings';
import LanguageRegionSettings from './LanguageRegionSettings';
import SecuritySettings from './SecuritySettings';
import { useI18n } from '../contexts/LocaleContext';

const SettingsApp = ({ target }) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState(target && target.tab || 'general');
  const [applicationTarget, setApplicationTarget] = useState(target || null);

  useEffect(() => {
    if (target && target.tab) {
      setActiveTab(target.tab);
      setApplicationTarget(target);
    }
  }, [target]);

  const tabs = [
    { id: 'general', icon: <Settings size={18} />, label: t('settings.tabs.general') },
    { id: 'display', icon: <Monitor size={18} />, label: t('settings.tabs.display') },
    { id: 'language', icon: <Globe size={18} />, label: t('settings.tabs.language') },
    { id: 'security', icon: <Shield size={18} />, label: t('settings.tabs.security') },
    { id: 'notifications', icon: <Bell size={18} />, label: t('settings.tabs.notifications') },
    { id: 'users', icon: <User size={18} />, label: t('settings.tabs.users') },
    { id: 'connections', icon: <Link2 size={18} />, label: t('settings.tabs.connections') },
    { id: 'applications', icon: <Box size={18} />, label: t('settings.tabs.applications') },
    { id: 'migration', icon: <Server size={18} />, label: t('settings.tabs.migration') },
  ];

  const navigateToTab = (tabId) => {
    setActiveTab(tabId);
    if (tabId === 'applications') setApplicationTarget(null);
  };

  return (
    <div className="settings-app" style={{ display: 'flex', height: '100%', width: '100%', color: '#fff' }}>
      {/* Sidebar */}
      <div className="settings-sidebar" style={{
        width: '200px', 
        background: 'rgba(0,0,0,0.3)', 
        borderRight: '1px solid rgba(255,255,255,0.1)',
        padding: '16px 8px'
      }}>
        {tabs.map(tab => (
          <div 
            key={tab.id}
            className="settings-tab"
            onClick={() => navigateToTab(tab.id)}
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
      <div className="settings-content" data-settings-content style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '24px' }}>
          {tabs.find(t => t.id === activeTab)?.label}
        </h2>
        
        {activeTab === 'general' && (
          <GeneralSettings onNavigate={navigateToTab} />
        )}
        {activeTab === 'display' && <AppearanceSettings target={target} />}
        {activeTab === 'language' && <LanguageRegionSettings />}
        {activeTab === 'security' && <SecuritySettings />}

        {activeTab === 'migration' && <MigrationSettings />}
        {activeTab === 'connections' && <ConnectionsSettings />}
        {activeTab === 'applications' && <ApplicationManager target={applicationTarget} />}
        {activeTab === 'notifications' && <NotificationSettings />}

        {activeTab !== 'general' && activeTab !== 'display' && activeTab !== 'language' && activeTab !== 'security' && activeTab !== 'migration' && activeTab !== 'connections' && activeTab !== 'applications' && activeTab !== 'notifications' && (
          <p style={{ color: '#888', fontSize: '14px' }}>{t('settings.comingSoon')}</p>
        )}
      </div>
    </div>
  );
};

export default SettingsApp;
