import { describe, it, expect } from 'vitest';
import { defaultSeedChain, seedChainIssue, usableCheckpoints, fitSeedToLimits, MAX_LAST_GAP } from './seedChain';

describe('defaultSeedChain', () => {
  it('produces a chain inside the configured prestige range, not a 2-ascension one', () => {
    // The reported case: current TE 159, target 490, limits 5-8. The old default reached the
    // search as `<something> 490`, which descent can never grow into a 5-ascension answer.
    const chain = defaultSeedChain({ currentTE: 159, finalTE: 490, minPrestiges: 5, maxPrestiges: 8 });
    expect(chain.length).toBeGreaterThanOrEqual(5);
    expect(chain.length).toBeLessThanOrEqual(8);
    expect(chain[chain.length - 1]).toBe(490);
  });

  it('is strictly increasing and stays above current TE', () => {
    const chain = defaultSeedChain({ currentTE: 159, finalTE: 490, minPrestiges: 5, maxPrestiges: 8 });
    for (let i = 1; i < chain.length; i++) expect(chain[i]).toBeGreaterThan(chain[i - 1]);
    expect(chain[0]).toBeGreaterThan(159);
  });

  it('keeps every checkpoint under the maxLast cap when the target leaves room for it', () => {
    const chain = defaultSeedChain({ currentTE: 159, finalTE: 490, minPrestiges: 5, maxPrestiges: 8 });
    for (const checkpoint of chain.slice(0, -1)) expect(checkpoint).toBeLessThanOrEqual(490 - MAX_LAST_GAP);
  });

  it('honours a range that excludes the preferred six', () => {
    expect(defaultSeedChain({ currentTE: 100, finalTE: 490, minPrestiges: 3, maxPrestiges: 4 })).toHaveLength(4);
    expect(defaultSeedChain({ currentTE: 100, finalTE: 490, minPrestiges: 7, maxPrestiges: 9 })).toHaveLength(7);
  });

  it('widens its gaps rather than spacing evenly', () => {
    // Measured optima open with small gaps and widen (195 226 277 317 490). An evenly spaced seed
    // starts in the wrong basin at the cheap end of the chain, where legs are shortest.
    const chain = defaultSeedChain({ currentTE: 159, finalTE: 490, minPrestiges: 6, maxPrestiges: 6 });
    const checkpoints = chain.slice(0, -1);
    const firstGap = checkpoints[1] - checkpoints[0];
    const lastGap = checkpoints[checkpoints.length - 1] - checkpoints[checkpoints.length - 2];
    expect(lastGap).toBeGreaterThan(firstGap);
  });

  it('still produces a chain on a short target, where the maxLast cap leaves no room', () => {
    // current 173 to a 320 target puts `final - 150` at 170, below the chain's own start. A
    // measured optimum for this pair is `195 231 277 320`, so returning nothing would be wrong.
    const chain = defaultSeedChain({ currentTE: 173, finalTE: 320, minPrestiges: 5, maxPrestiges: 8 });
    expect(chain.length).toBeGreaterThanOrEqual(5);
    expect(chain[chain.length - 1]).toBe(320);
    for (let i = 1; i < chain.length; i++) expect(chain[i]).toBeGreaterThan(chain[i - 1]);
  });

  it('gives up cleanly only when there is genuinely no room left', () => {
    // current 310 against final 320: even the fallback cap of `final - 20` is below the start.
    expect(defaultSeedChain({ currentTE: 310, finalTE: 320, minPrestiges: 5, maxPrestiges: 8 })).toEqual([320]);
  });

  it('never emits a checkpoint equal to the final target', () => {
    const chain = defaultSeedChain({ currentTE: 50, finalTE: 200, minPrestiges: 5, maxPrestiges: 8 });
    expect(chain.filter(v => v === 200)).toHaveLength(1);
  });
});

describe('seedChainIssue', () => {
  const PROBE = { countProbe: true };
  const NO_PROBE = { countProbe: false };

  it('passes a chain inside the limits', () => {
    expect(seedChainIssue([180, 220, 270, 320, 490], 5, 8, PROBE)).toBeNull();
    expect(seedChainIssue([180, 220, 270, 320, 490], 5, 8, NO_PROBE)).toBeNull();
  });

  it('flags a 5-ascension seed under a maximum of 4 when no probe will run', () => {
    // The reported case, on Balanced: `199 222 252 291 490` with "most ascensions" set to 4.
    // Stages 4-6 all run on the seed at its own length, and Balanced has no prestige-count probe,
    // so nothing in the whole run would have brought it back to 4.
    expect(seedChainIssue([199, 222, 252, 291, 490], 2, 4, NO_PROBE)).toEqual({
      kind: 'too-long',
      ascensions: 5,
      maxPrestiges: 4,
      probeCanFix: false,
    });
  });

  it('marks the same seed as probe-fixable on a tier that runs the probe', () => {
    expect(seedChainIssue([199, 222, 252, 291, 490], 2, 4, PROBE)).toEqual({
      kind: 'too-long',
      ascensions: 5,
      maxPrestiges: 4,
      probeCanFix: true,
    });
  });

  it('never calls a two-step gap probe-fixable', () => {
    expect(seedChainIssue([170, 195, 220, 250, 280, 320, 490], 2, 4, PROBE)).toEqual({
      kind: 'too-long',
      ascensions: 7,
      maxPrestiges: 4,
      probeCanFix: false,
    });
  });

  it('flags a chain the search cannot grow into range', () => {
    expect(seedChainIssue([135, 490], 5, 8, NO_PROBE)).toEqual({
      kind: 'too-short',
      ascensions: 2,
      minPrestiges: 5,
      probeCanFix: false,
    });
  });
});

describe('fitSeedToLimits', () => {
  it('trims a 5-ascension chain to the configured maximum of 4', () => {
    const fitted = fitSeedToLimits([199, 222, 252, 291, 490], 2, 4);
    expect(fitted).toHaveLength(4);
    expect(fitted[0]).toBe(199);
    expect(fitted[fitted.length - 1]).toBe(490);
  });

  it('keeps the chain strictly increasing while trimming', () => {
    const fitted = fitSeedToLimits([199, 222, 252, 291, 320, 360, 490], 2, 4);
    expect(fitted).toHaveLength(4);
    for (let i = 1; i < fitted.length; i++) expect(fitted[i]).toBeGreaterThan(fitted[i - 1]);
  });

  it('pads a short chain up to the configured minimum', () => {
    const fitted = fitSeedToLimits([250, 490], 5, 8);
    expect(fitted).toHaveLength(5);
    for (let i = 1; i < fitted.length; i++) expect(fitted[i]).toBeGreaterThan(fitted[i - 1]);
    expect(fitted[fitted.length - 1]).toBe(490);
  });

  it('leaves a chain already inside the limits untouched', () => {
    const chain = [195, 226, 277, 317, 490];
    expect(fitSeedToLimits(chain, 5, 8)).toEqual(chain);
  });
});

describe('usableCheckpoints', () => {
  it('drops a checkpoint at or below current TE', () => {
    // The reported state: a seed box holding 135 on a 159 TE account. Passing that through is what
    // reached the simulator and came back as a bare "Chain search worker error".
    expect(usableCheckpoints([135, 250, 340], 159, 490)).toEqual([250, 340]);
    expect(usableCheckpoints([159], 159, 490)).toEqual([]);
  });

  it('drops a checkpoint at or above the final target, which is appended separately', () => {
    expect(usableCheckpoints([250, 490, 600], 159, 490)).toEqual([250]);
  });

  it('keeps a chain that is entirely usable', () => {
    expect(usableCheckpoints([195, 226, 277, 317], 170, 490)).toEqual([195, 226, 277, 317]);
  });

  it('returns nothing when every checkpoint is unusable, so the caller can generate one', () => {
    expect(usableCheckpoints([135], 159, 490)).toEqual([]);
  });
});
