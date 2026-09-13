/**
 * What a shared submission may and may not contain.
 *
 * The tests that matter here are the negative ones. A leaderboard submission is the one place
 * this project sends a player's data somewhere else, so the failure worth catching is not "the
 * number is wrong" but "something got included that nobody agreed to share".
 */
import { describe, expect, it } from 'vitest';
import {
  buildSubmission,
  keepVirtueArtifacts,
  scrubIdentifiers,
  submissionFilename,
  SUBMISSION_SCHEMA,
  validateSubmission,
  type SubmissionInputs,
} from './submission';
import type { LegSummary } from './types';

const DENVER = 'America/Denver';
const PLAN_START = Math.floor(Date.UTC(2026, 8, 10, 1, 4) / 1000); // 2026-09-09 19:04 Denver

function leg(te: number, days: number, wait = 0, hold = 0): LegSummary {
  return {
    key: '2-sale-tier13',
    endTE: te,
    endTime: 0,
    durationSeconds: days * 86400,
    maxELR: (5 * 1e15) / 3600,
    sleepDelaySeconds: wait,
    shiftDelaySeconds: hold,
  } as unknown as LegSummary;
}

function inputs(over: Partial<SubmissionInputs> = {}): SubmissionInputs {
  return {
    chain: [182, 195, 228, 257, 285, 322, 490],
    seconds: 739.4764 * 86400,
    legs: [leg(182, 7.72, 6.5 * 3600, 0), leg(195, 36.09, 0, 8.9 * 3600)],
    planStart: PLAN_START,
    timezone: DENVER,
    currentTE: 177,
    finalTE: 490,
    effort: 'thorough',
    availability: { days: [], fromHour: 7, toHour: 23, timezone: DENVER },
    holdShifts: true,
    artifacts: [{ label: 'T4L Puzzle cube', count: 1 }],
    stones: [{ label: 'T4 Lunar stone', count: 9 }],
    chainsPriced: 10122,
    now: Date.UTC(2026, 8, 13, 12, 0),
    ...over,
  };
}

describe('buildSubmission', () => {
  it('carries only the agreed fields, and no others', () => {
    // A whitelist is only a whitelist if nothing else survives. If someone widens the input
    // type later, this is what notices.
    const s = buildSubmission(inputs());
    expect(Object.keys(s).sort()).toEqual(
      [
        'artifacts',
        'ascensions',
        'chain',
        'chainsPriced',
        'currentTE',
        'durationDays',
        'effort',
        'endLocal',
        'finalTE',
        'holdShifts',
        'legs',
        'schema',
        'startLocal',
        'stones',
        'submittedAt',
        'timezone',
        'waitingHours',
        'window',
      ].sort()
    );
  });

  it('never contains a player id, even when one is typed into the nickname', () => {
    const s = buildSubmission(inputs({ nickname: 'me EI1234567890123456 here' }));
    expect(JSON.stringify(s)).not.toMatch(/EI\d{16}/);
    expect(s.nickname).toBe('me EI[redacted] here');
  });

  it('omits the nickname entirely rather than sending an empty one', () => {
    expect(buildSubmission(inputs({ nickname: '   ' })).nickname).toBeUndefined();
    expect('nickname' in buildSubmission(inputs())).toBe(false);
  });

  it('caps a nickname rather than relaying whatever was pasted', () => {
    const s = buildSubmission(inputs({ nickname: 'x'.repeat(400) }));
    expect(s.nickname!.length).toBe(40);
  });

  it('reports local wall-clock, not absolute instants', () => {
    // A unix timestamp plus a duration pins a player harder than a date does, and a leaderboard
    // gains nothing from it.
    const s = buildSubmission(inputs());
    expect(s.startLocal).toBe('2026-09-09 19:04');
    expect(s.endLocal).toMatch(/^2028-09-18 /);
    expect(JSON.stringify(s)).not.toContain(String(PLAN_START));
  });

  it('says waiting time is unknown rather than zero when no legs were kept', () => {
    // A chain replayed from a checkpoint keeps no legs. Publishing 0 would be a measurement
    // nobody made, and on a leaderboard it would look like the kindest schedule in the list.
    expect(buildSubmission(inputs({ legs: [] })).waitingHours).toBeNull();
    expect(buildSubmission(inputs()).waitingHours).toBe(15.4);
  });

  it('rounds rather than shipping float noise', () => {
    const s = buildSubmission(inputs());
    expect(s.durationDays).toBe(739.4764);
    expect(s.legs[0].peakDeliveryQph).toBe(5);
  });
});

describe('keepVirtueArtifacts', () => {
  it('keeps only what a virtue ascension can equip', () => {
    // The brooch is the example the request named: 104 of them tell nobody anything about a
    // delivery rate, and shipping the full inventory is a sharper fingerprint than shipping the
    // eight families that matter.
    const kept = keepVirtueArtifacts([
      { label: 'T1C Aurelian brooch', count: 104, familyId: 'aurelian-brooch' },
      { label: 'T2C Beak of Midas', count: 904, familyId: 'beak-of-midas' },
      { label: 'T4L Quantum metronome', count: 1, familyId: 'quantum-metronome' },
      { label: 'T4L Puzzle cube', count: 1, familyId: 'puzzle-cube' },
      { label: 'T4L The chalice', count: 3, familyId: 'the-chalice' },
      { label: 'T1C Gusset', count: 4, familyId: 'ornate-gusset' },
    ]);
    expect(kept.map(a => a.label)).toEqual([
      'T4L Quantum metronome',
      'T4L Puzzle cube',
      'T4L The chalice',
      'T1C Gusset',
    ]);
  });

  it('falls back to the label when an older inventory carries no family', () => {
    // Dropping everything would look like an empty inventory rather than a missing field.
    const kept = keepVirtueArtifacts([
      { label: 'T4L Tungsten ankh', count: 1 },
      { label: 'T3C Phoenix feather', count: 29 },
    ]);
    expect(kept.map(a => a.label)).toEqual(['T4L Tungsten ankh']);
  });

  it('is applied by buildSubmission', () => {
    const s = buildSubmission(
      inputs({
        artifacts: [
          { label: 'T1C Aurelian brooch', count: 104, familyId: 'aurelian-brooch' },
          { label: 'T4L Lunar totem', count: 1, familyId: 'lunar-totem' },
        ],
      })
    );
    expect(s.artifacts.map(a => a.label)).toEqual(['T4L Lunar totem']);
    // Stones stay wholesale: they slot into every family that is kept.
    expect(s.stones).toHaveLength(1);
  });
});

describe('scrubIdentifiers', () => {
  it('redacts every id in a block of text', () => {
    const out = scrubIdentifiers('a EI1111111111111111 b EI2222222222222222');
    expect(out).toBe('a EI[redacted] b EI[redacted]');
  });

  it('leaves things that merely look similar alone', () => {
    expect(scrubIdentifiers('EI123 and EGG1234567890123456')).toBe('EI123 and EGG1234567890123456');
  });
});

describe('validateSubmission', () => {
  const ok = () => JSON.parse(JSON.stringify(buildSubmission(inputs())));

  it('accepts what buildSubmission produces', () => {
    expect(validateSubmission(ok())).toEqual([]);
  });

  it('rejects a foreign or future schema rather than guessing', () => {
    expect(validateSubmission({ ...ok(), schema: SUBMISSION_SCHEMA + 1 })[0]).toMatch(/unknown schema/);
  });

  it('rejects a chain that does not strictly increase', () => {
    expect(validateSubmission({ ...ok(), chain: [195, 195, 490] })).toContain('chain must strictly increase');
  });

  it('rejects nonsense durations and oversized payloads', () => {
    expect(validateSubmission({ ...ok(), durationDays: 0 })).toContain('durationDays must be positive');
    const huge = { ...ok(), artifacts: Array.from({ length: 20000 }, () => ({ label: 'x'.repeat(20), count: 1 })) };
    expect(validateSubmission(huge)).toContain('submission is implausibly large');
  });

  it('rejects junk without throwing', () => {
    for (const junk of [null, 'nope', 42, []]) expect(validateSubmission(junk).length).toBeGreaterThan(0);
  });
});

describe('submissionFilename', () => {
  it('is dated so two submissions do not collide', () => {
    expect(submissionFilename(buildSubmission(inputs()))).toBe('chain-submission-490te-2026-09-13-12-00.json');
  });
});
