const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*\.service$/;
const MIN_JOURNAL_TAIL = 20;
const MAX_JOURNAL_TAIL = 500;
const MAX_JOURNAL_BYTES = 512 * 1024;

const SYSTEMD_OBSERVATION_PROPERTIES = Object.freeze([
  'ActiveState',
  'SubState',
  'Result',
  'NRestarts',
  'ExecMainStatus',
  'OOMKilled',
  'CPUUsageNSec',
  'MemoryCurrent',
  'MemoryMax',
  'EffectiveMemoryMax',
  'TasksCurrent',
  'TasksMax',
  'IPIngressBytes',
  'IPEgressBytes',
  'IOReadBytes',
  'IOWriteBytes'
]);

function hostServiceObservationDefinition(operation, unit, options = {}) {
  if (!SYSTEMD_UNIT_PATTERN.test(String(unit || ''))) return null;
  if (operation === 'properties') {
    return {
      candidates: ['/usr/bin/systemctl', '/bin/systemctl'],
      args: [
        'show',
        unit,
        '--no-pager',
        `--property=${SYSTEMD_OBSERVATION_PROPERTIES.join(',')}`
      ],
      maxBuffer: 256 * 1024,
      timeout: 5000
    };
  }
  if (operation === 'journal') {
    const tail = Number(options.tail);
    if (!Number.isSafeInteger(tail) || tail < MIN_JOURNAL_TAIL || tail > MAX_JOURNAL_TAIL) {
      return null;
    }
    return {
      candidates: ['/usr/bin/journalctl', '/bin/journalctl'],
      args: [
        `--unit=${unit}`,
        `--lines=${tail}`,
        '--output=json',
        '--output-fields=MESSAGE,PRIORITY,__REALTIME_TIMESTAMP',
        '--utc',
        '--no-pager',
        '--quiet'
      ],
      maxBuffer: MAX_JOURNAL_BYTES,
      timeout: 10000
    };
  }
  return null;
}

module.exports = {
  MAX_JOURNAL_BYTES,
  MAX_JOURNAL_TAIL,
  MIN_JOURNAL_TAIL,
  SYSTEMD_OBSERVATION_PROPERTIES,
  SYSTEMD_UNIT_PATTERN,
  hostServiceObservationDefinition
};
