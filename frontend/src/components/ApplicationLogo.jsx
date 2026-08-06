import React, { useEffect, useState } from 'react';
import { Server } from 'lucide-react';

const DEFAULT_APP_LOGO = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/docker.svg';

const ApplicationLogo = ({ app, size = 40 }) => {
  const [sourceIndex, setSourceIndex] = useState(0);
  const installationState = app.installation && app.installation.state;
  const defaultLogo = installationState === 'host-service' ? null : DEFAULT_APP_LOGO;
  const logoSources = [app.logoUrl, defaultLogo].filter((source, index, sources) => (
    source && sources.indexOf(source) === index
  ));

  useEffect(() => {
    setSourceIndex(0);
  }, [app.logoUrl, installationState]);

  if (logoSources[sourceIndex]) {
    return (
      <img
        src={logoSources[sourceIndex]}
        alt={`${app.name} logosu`}
        draggable={false}
        onError={() => setSourceIndex((current) => current + 1)}
        style={{ width: size, height: size, objectFit: 'contain', display: 'block' }}
      />
    );
  }

  return app.icon || <Server size={size} color="#0ea5e9" />;
};

export default ApplicationLogo;
