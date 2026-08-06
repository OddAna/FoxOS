import React from 'react';
import { APPLICATION_STATUS, applicationOperationalState } from '../utils/applicationStatus';

const ApplicationStatus = ({ application, pendingAction, compact = false }) => {
  const state = applicationOperationalState(application, pendingAction);
  const status = APPLICATION_STATUS[state] || APPLICATION_STATUS.stopped;
  const labelColor = state === 'stopped' ? '#aaa' : status.color;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: compact ? '6px' : '8px', color: labelColor, fontSize: '13px' }}>
      <span
        style={{
          width: compact ? '8px' : '10px',
          height: compact ? '8px' : '10px',
          flex: `0 0 ${compact ? '8px' : '10px'}`,
          borderRadius: '50%',
          background: status.color,
          boxShadow: '0 2px 5px rgba(0,0,0,0.4)'
        }}
      />
      <span>{status.label}</span>
    </div>
  );
};

export default ApplicationStatus;
