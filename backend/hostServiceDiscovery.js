const fs = require('node:fs');
const path = require('node:path');

const UNIT_PATTERN = /^[A-Za-z0-9_.@-]+\.service$/;
const INTERFACE_PATTERN = /^[A-Za-z0-9_.-]{1,15}$/;

function outputOf(result) {
  return result && result.success !== false ? String(result.output || '') : '';
}

function parseUnitFiles(value) {
  const units = new Map();
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([^\s]+\.service)\s+([^\s]+)(?:\s+([^\s]+))?/);
    if (match && UNIT_PATTERN.test(match[1])) {
      units.set(match[1], { unit: match[1], unitFileState: match[2], preset: match[3] || null });
    }
  }
  return units;
}

function parseActiveUnits(value) {
  const units = new Map();
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([^\s]+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (match && UNIT_PATTERN.test(match[1])) {
      units.set(match[1], {
        unit: match[1],
        loadState: match[2],
        activeState: match[3],
        subState: match[4],
        description: match[5].slice(0, 256) || null
      });
    }
  }
  return units;
}

function listDirectAdminUnits(hostRoot) {
  const directory = path.join(hostRoot, 'etc', 'systemd', 'system');
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && UNIT_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function listWireGuardConfigs(hostRoot) {
  const directory = path.join(hostRoot, 'etc', 'wireguard');
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
      .map((entry) => entry.name.slice(0, -5))
      .filter((name) => INTERFACE_PATTERN.test(name))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function unitEnabledAtBoot(hostRoot, unit) {
  const systemdRoot = path.join(hostRoot, 'etc', 'systemd', 'system');
  try {
    return fs.readdirSync(systemdRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /\.(?:wants|requires)$/.test(entry.name))
      .some((entry) => {
        try {
          fs.lstatSync(path.join(systemdRoot, entry.name, unit));
          return true;
        } catch {
          return false;
        }
      });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function unitRuntime(unit, unitFiles, activeUnits) {
  const file = unitFiles.get(unit) || {};
  const active = activeUnits.get(unit) || {};
  return {
    unit,
    state: active.activeState === 'active' ? 'running' : 'stopped',
    status: [active.activeState || 'inactive', active.subState || 'dead'].join(':'),
    activeState: active.activeState || 'inactive',
    subState: active.subState || 'dead',
    unitFileState: file.unitFileState || 'unknown',
    description: active.description || null,
    inspection: 'complete'
  };
}

async function createHostServiceDiscovery({ hostRoot, hostRead }) {
  if (!hostRoot || typeof hostRead !== 'function') {
    throw new Error('Host service discovery requires host root and read adapter');
  }
  const [unitFileResult, activeUnitResult, interfaceResult, versionResult] = await Promise.all([
    hostRead('systemd-unit-files'),
    hostRead('systemd-units'),
    hostRead('wireguard-interfaces'),
    hostRead('wireguard-version')
  ]);
  const unitFiles = parseUnitFiles(outputOf(unitFileResult));
  const activeUnits = parseActiveUnits(outputOf(activeUnitResult));
  const adminUnits = listDirectAdminUnits(hostRoot);
  const configuredInterfaces = listWireGuardConfigs(hostRoot);
  const activeInterfaces = outputOf(interfaceResult).trim().split(/\s+/).filter((entry) => INTERFACE_PATTERN.test(entry));
  const version = outputOf(versionResult).trim().split(/\r?\n/)[0].split(' - ')[0].slice(0, 128) || null;
  const wireGuardInterfaces = Array.from(new Set([
    ...configuredInterfaces,
    ...activeInterfaces,
    ...Array.from(unitFiles.keys()).flatMap((unit) => {
      const match = unit.match(/^wg-quick@([A-Za-z0-9_.-]{1,15})\.service$/);
      return match ? [match[1]] : [];
    })
  ])).sort();
  const resources = [];

  for (const interfaceName of wireGuardInterfaces) {
    const unit = `wg-quick@${interfaceName}.service`;
    const runtime = unitRuntime(unit, unitFiles, activeUnits);
    if (runtime.unitFileState === 'unknown' && unitEnabledAtBoot(hostRoot, unit)) {
      runtime.unitFileState = 'enabled';
    }
    if (activeInterfaces.includes(interfaceName)) {
      runtime.state = 'running';
      runtime.activeState = 'active';
      runtime.status = runtime.subState === 'dead' ? 'active:interface-up' : runtime.status;
    }
    resources.push({
      sourceKind: 'host-service',
      provider: 'linux-host',
      externalId: `wireguard:${interfaceName}`,
      name: `WireGuard (${interfaceName})`,
      providerKind: 'network-service',
      serviceType: 'wireguard',
      runtime: { ...runtime, version },
      configuration: {
        interface: interfaceName,
        filePresent: configuredInterfaces.includes(interfaceName),
        contentsRead: false
      }
    });
  }

  for (const unit of adminUnits.filter((entry) => !entry.startsWith('wg-quick@'))) {
    resources.push({
      sourceKind: 'host-service',
      provider: 'linux-host',
      externalId: `systemd:${unit}`,
      name: unit.replace(/\.service$/, ''),
      providerKind: /(?:cloudflared|tunnel|proxy)/i.test(unit) ? 'proxy' : 'service',
      serviceType: 'systemd',
      runtime: unitRuntime(unit, unitFiles, activeUnits),
      configuration: { unitFilePresent: true, contentsRead: false }
    });
  }

  return {
    source: 'linux-host',
    configured: true,
    readOnly: true,
    resources: resources.sort((left, right) => left.name.localeCompare(right.name)),
    inventory: {
      systemdUnitFiles: unitFiles.size,
      localAdminUnits: adminUnits.length,
      wireGuardInterfaces: wireGuardInterfaces.length
    },
    guarantees: {
      hostCommands: 'fixed-read-only',
      configurationContentsRead: false,
      wireGuardKeysIncluded: false,
      wireGuardPeersIncluded: false
    }
  };
}

module.exports = {
  createHostServiceDiscovery,
  listDirectAdminUnits,
  listWireGuardConfigs,
  parseActiveUnits,
  parseUnitFiles,
  unitEnabledAtBoot
};
