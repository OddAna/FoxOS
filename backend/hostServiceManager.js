const HOST_SERVICE_ACTIONS = new Set(['start', 'stop', 'restart']);
const HOST_SERVICE_BOOT_STATES = new Set(['enabled', 'disabled']);
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const UNIT_PATTERN = /^[A-Za-z0-9_.@-]+\.service$/;

class HostServiceError extends Error {
  constructor(message, statusCode = 400, code = 'host-service-error') {
    super(message);
    this.name = 'HostServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function bootEnabled(runtime = {}) {
  return ['enabled', 'enabled-runtime', 'linked', 'linked-runtime'].includes(
    String(runtime.unitFileState || '').toLowerCase()
  );
}

function createHostServiceManager({ resourceRegistry, hostCommand }) {
  if (
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    typeof resourceRegistry.scan !== 'function' || typeof hostCommand !== 'function'
  ) {
    throw new Error('Host service manager requires registry and fixed host command adapters');
  }

  const activeOperations = new Set();

  function resource(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId || ''))) {
      throw new HostServiceError('Sunucu servisi kimliği geçersiz.', 400, 'invalid-host-service-id');
    }
    const snapshot = resourceRegistry.getLatest();
    const current = snapshot && (snapshot.resources || []).find((entry) => entry.id === resourceId);
    if (!current || current.kind !== 'host-service' || current.provider !== 'linux-host') {
      throw new HostServiceError('Sunucu servisi artık bulunamıyor.', 404, 'host-service-not-found');
    }
    const unit = current.runtime && current.runtime.unit;
    if (!UNIT_PATTERN.test(String(unit || ''))) {
      throw new HostServiceError('Servisin systemd birimi doğrulanamadı.', 409, 'host-service-unit-invalid');
    }
    return current;
  }

  function settings(resourceId) {
    const current = resource(resourceId);
    const runtime = current.runtime || {};
    return {
      resourceId: current.id,
      engine: 'systemd',
      unit: runtime.unit,
      state: runtime.state || 'stopped',
      status: runtime.status || null,
      activeState: runtime.activeState || null,
      subState: runtime.subState || null,
      unitFileState: runtime.unitFileState || 'unknown',
      bootEnabled: bootEnabled(runtime),
      serverOwned: true
    };
  }

  async function invoke(resourceId, operation, command) {
    if (activeOperations.has(resourceId)) {
      throw new HostServiceError(
        'Bu sunucu servisinde başka bir işlem sürüyor.',
        409,
        'host-service-operation-in-progress'
      );
    }
    const before = resource(resourceId);
    activeOperations.add(resourceId);
    try {
      const result = await hostCommand(command, before.runtime.unit);
      if (!result || result.success !== true) {
        throw new HostServiceError(
          'systemd işlemi tamamlanamadı.',
          502,
          'host-service-command-failed'
        );
      }
      await resourceRegistry.scan();
      return {
        success: true,
        operation,
        before: {
          state: before.runtime.state || 'stopped',
          status: before.runtime.status || null,
          unitFileState: before.runtime.unitFileState || 'unknown'
        },
        settings: settings(resourceId)
      };
    } finally {
      activeOperations.delete(resourceId);
    }
  }

  async function lifecycle(resourceId, action) {
    if (!HOST_SERVICE_ACTIONS.has(action)) {
      throw new HostServiceError('Sunucu servisi işlemi geçersiz.', 400, 'invalid-host-service-action');
    }
    return invoke(resourceId, action, action);
  }

  async function setBootState(resourceId, requestedState) {
    if (!HOST_SERVICE_BOOT_STATES.has(requestedState)) {
      throw new HostServiceError('Otomatik başlatma ayarı geçersiz.', 400, 'invalid-host-service-boot-state');
    }
    return invoke(resourceId, 'boot-state', requestedState === 'enabled' ? 'enable' : 'disable');
  }

  return { lifecycle, setBootState, settings };
}

module.exports = {
  HOST_SERVICE_ACTIONS,
  HOST_SERVICE_BOOT_STATES,
  HostServiceError,
  bootEnabled,
  createHostServiceManager
};
