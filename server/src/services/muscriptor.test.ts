import test from 'node:test';
import assert from 'node:assert/strict';
import { partialMidiFromEvents } from './muscriptor.js';
import { parseMidiFile } from './midiParser.js';

test('partialMidiFromEvents keeps completed notes and drops the open one', () => {
  const mid = partialMidiFromEvents([
    { type: 'progress', completed: 0, total: 2 },
    { type: 'note_start', index: 0, pitch: 60, time: 0.5, instrument: 'acoustic_piano' },
    { type: 'note_start', index: 1, pitch: 36, time: 1, instrument: 'drums' },
    { type: 'note_end', index: 1, time: 1.01 },
    { type: 'note_end', index: 0, time: 1.5 },
    { type: 'note_start', index: 2, pitch: 40, time: 2, instrument: 'electric_bass' },
  ]);
  assert.ok(mid);
  const parsed = parseMidiFile(mid);
  assert.equal(parsed.noteCount, 2);
  const piano = parsed.notes.find(n => n.pitch === 60)!;
  assert.equal(piano.channel, 0);
  assert.ok(Math.abs(piano.start - 0.5) < 0.002 && Math.abs(piano.duration - 1) < 0.002);
  assert.equal(parsed.notes.find(n => n.pitch === 36)!.channel, 9);
});

test('partialMidiFromEvents is null when no note completed', () => {
  assert.equal(partialMidiFromEvents([{ type: 'note_start', index: 0, pitch: 60, time: 0, instrument: 'voice' }]), null);
});
