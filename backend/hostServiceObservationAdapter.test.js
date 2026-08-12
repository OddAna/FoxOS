const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_JOURNAL_BYTES,
  SYSTEMD_OBSERVATION_PROPERTIES,
  hostServiceObservationDefinition
} = require('./hostServiceObservationAdapter');

test('host service properties use one exact unit and a fixed cgroup field allowlist', () => {
  const definition = hostServiceObservationDefinition('properties', 'example@worker.service');
  assert.deepEqual(definition.candidates, ['/usr/bin/systemctl', '/bin/systemctl']);
  assert.deepEqual(definition.args.slice(0, 3), ['show', 'example@worker.service', '--no-pager']);
  assert.equal(
    definition.args[3],
    `--property=${SYSTEMD_OBSERVATION_PROPERTIES.join(',')}`
  );
  assert.equal(definition.args.includes('cat'), false);
  assert.equal(SYSTEMD_OBSERVATION_PROPERTIES.includes('Environment'), false);
  assert.equal(SYSTEMD_OBSERVATION_PROPERTIES.includes('ExecStart'), false);
});

test('host service journal reads only bounded JSON fields for the exact unit', () => {
  const definition = hostServiceObservationDefinition('journal', 'example.service', { tail: 160 });
  assert.deepEqual(definition.candidates, ['/usr/bin/journalctl', '/bin/journalctl']);
  assert.equal(definition.args.includes('--unit=example.service'), true);
  assert.equal(definition.args.includes('--lines=160'), true);
  assert.equal(definition.args.includes('--output=json'), true);
  assert.equal(definition.args.includes('--output-fields=MESSAGE,PRIORITY,__REALTIME_TIMESTAMP'), true);
  assert.equal(definition.maxBuffer, MAX_JOURNAL_BYTES);
});

test('host service observation rejects option-like units, arbitrary operations and unbounded tails', () => {
  assert.equal(hostServiceObservationDefinition('journal', '--root.service', { tail: 160 }), null);
  assert.equal(hostServiceObservationDefinition('journal', 'example.service', { tail: 501 }), null);
  assert.equal(hostServiceObservationDefinition('journal', 'example.service', { tail: '20;id' }), null);
  assert.equal(hostServiceObservationDefinition('cat', 'example.service', { tail: 160 }), null);
});
