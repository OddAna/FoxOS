const MANAGED_LABEL = 'com.foxos.managed';
const APP_ID_LABEL = 'com.foxos.app.id';

function containerName(appId) {
  return 'foxos-app-' + appId;
}

function validateInstallOptions(catalogApp, input = {}) {
  const rawPort = input.hostPort === undefined || input.hostPort === ''
    ? String(catalogApp.defaultPort)
    : String(input.hostPort);

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('Port must be a whole number');
  }

  const hostPort = Number(rawPort);
  if (!Number.isSafeInteger(hostPort) || hostPort < 1024 || hostPort > 65535) {
    throw new Error('Port must be between 1024 and 65535');
  }

  const bindAddress = input.bindAddress || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bindAddress)) {
    throw new Error('Bind address must be private or public');
  }

  return { hostPort, bindAddress };
}

function createContainerPayload(catalogApp, options) {
  const privatePort = catalogApp.containerPort + '/tcp';
  const binds = [
    ...(catalogApp.volumes || []).map((volume) => volume.name + ':' + volume.target),
    ...(catalogApp.binds || [])
  ];

  return {
    Image: catalogApp.image,
    Labels: {
      [MANAGED_LABEL]: 'true',
      [APP_ID_LABEL]: catalogApp.id,
      'com.foxos.app.name': catalogApp.name
    },
    Env: [...(catalogApp.environment || [])],
    ExposedPorts: { [privatePort]: {} },
    HostConfig: {
      Binds: binds,
      PortBindings: {
        [privatePort]: [{
          HostIp: options.bindAddress,
          HostPort: String(options.hostPort)
        }]
      },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }
    }
  };
}

function managedContainerForApp(containers, appId) {
  return containers.find((container) => (
    container.Labels &&
    container.Labels[MANAGED_LABEL] === 'true' &&
    container.Labels[APP_ID_LABEL] === appId
  )) || null;
}

function stateForCatalogApp(catalogApp, containers) {
  const container = managedContainerForApp(containers, catalogApp.id);
  if (!container) {
    return {
      ...catalogApp,
      installed: false,
      state: 'not-installed',
      status: null,
      containerId: null,
      hostPort: null,
      bindAddress: null
    };
  }

  const port = (container.Ports || []).find((candidate) => (
    candidate.PrivatePort === catalogApp.containerPort && candidate.Type === 'tcp'
  ));

  return {
    ...catalogApp,
    installed: true,
    state: container.State || 'unknown',
    status: container.Status || null,
    containerId: container.Id,
    hostPort: port && port.PublicPort ? port.PublicPort : null,
    bindAddress: port && port.IP ? port.IP : null
  };
}

function imagePullPath(image) {
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? image.slice(0, lastColon) : image;
  const tag = hasTag ? image.slice(lastColon + 1) : 'latest';
  return '/images/create?fromImage=' + encodeURIComponent(repository) + '&tag=' + encodeURIComponent(tag);
}

module.exports = {
  APP_ID_LABEL,
  MANAGED_LABEL,
  containerName,
  createContainerPayload,
  imagePullPath,
  managedContainerForApp,
  stateForCatalogApp,
  validateInstallOptions
};
