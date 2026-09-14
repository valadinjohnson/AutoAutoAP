/**
 * Measured data behind the Chain Search explainer's figures.
 *
 * Every number here is simulator output from exhaustive sweeps — no model, no fit, no smoothing.
 * Regenerating means re-running the sweeps and pasting the result; nothing computes these at
 * runtime, because the point of the figures is that they are evidence rather than illustration.
 *
 * Both corpora are from one account (start TE 170 / 173) and are stated as such wherever they are
 * rendered. They are not a claim about anybody else's account.
 */

/** A 21-wide sweep of the LAST checkpoint with the rest of the chain pinned: `195 226 277 X 490`.
 *  This is the sawtooth itself — descending runs a few TE wide, separated by one missed sale. */
export const SAWTOOTH = {
  prefix: '195 226 277',
  target: 490,
  x: [310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330],
  days: [
    761.5, 760.5, 759.375, 762.667, 761.542, 760.583, 759.417, 758.917, 761.542, 760.458, 759.417, 762.625, 761.5,
    760.375, 759.292, 762.5, 761.375, 760.208, 759.375, 762.333, 761.167,
  ],
};

/** The same sweep opened out to 86 consecutive values: `195 231 X 490`. Shows that the teeth sit
 *  on a bowl, that the left side falls in ledges rather than a slope, and that the function is
 *  not unimodal. */
export const WIDE_SWEEP = {
  prefix: '195 231',
  target: 490,
  x: [
    255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277,
    278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300,
    301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323,
    324, 325, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340,
  ],
  days: [
    893.0, 891.625, 890.667, 878.667, 877.667, 876.833, 869.5, 868.458, 867.5, 866.667, 865.667, 868.875, 868.042,
    817.458, 816.75, 865.375, 819.375, 820.333, 809.833, 814.5, 803.167, 789.083, 779.458, 793.208, 787.375, 769.5,
    781.333, 780.167, 768.375, 767.625, 770.292, 769.5, 768.667, 768.958, 768.625, 767.542, 771.167, 770.458, 769.625,
    771.583, 770.792, 770.333, 771.875, 773.208, 772.458, 771.708, 771.042, 774.583, 773.792, 773.0, 776.708, 775.875,
    775.042, 774.5, 777.958, 777.25, 776.75, 779.958, 779.25, 779.0, 781.958, 781.25, 784.75, 783.958, 783.208, 786.708,
    785.917, 785.375, 788.667, 787.875, 791.375, 790.583, 789.792, 793.292, 792.458, 796.0, 795.167, 794.458, 797.833,
    797.0, 800.542, 799.667, 799.208, 802.292, 801.458, 804.917,
  ],
};

/** Every chain in the exhaustive box `195 X2 X3 X4 490` (X2 220-235, X3 265-295, X4 310-330),
 *  binned by duration. 10,413 of the box's 10,416 chains priced, so its winner is a PROVEN
 *  optimum of the box rather than a search result. */
export const DISTRIBUTION = {
  counts: [
    2, 19, 15, 16, 10, 36, 62, 39, 149, 102, 132, 140, 193, 238, 303, 252, 329, 252, 320, 281, 417, 377, 403, 295, 378,
    350, 462, 436, 452, 322, 270, 339, 289, 404, 327, 341, 174, 179, 116, 244, 179, 114, 85, 82, 72, 68, 82, 68, 36, 14,
    20, 34, 23, 13, 13, 10, 19, 6, 4, 6,
  ],
  edges: [
    758.917, 759.187, 759.457, 759.727, 759.997, 760.267, 760.537, 760.808, 761.078, 761.348, 761.618, 761.888, 762.158,
    762.428, 762.699, 762.969, 763.239, 763.509, 763.779, 764.049, 764.319, 764.59, 764.86, 765.13, 765.4, 765.67,
    765.94, 766.21, 766.481, 766.751, 767.021, 767.291, 767.561, 767.831, 768.101, 768.372, 768.642, 768.912, 769.182,
    769.452, 769.722, 769.992, 770.263, 770.533, 770.803, 771.073, 771.343, 771.613, 771.883, 772.153, 772.424, 772.694,
    772.964, 773.234, 773.504, 773.774, 774.044, 774.315, 774.585, 774.855, 775.125,
  ],
  n: 10413,
  best: 758.9167,
  bestChain: '195 226 277 317 490',
  median: 766.0,
  worst: 775.125,
  within1: 52,
  top100Span: 1.625,
};

/** Best chain reachable from each starting FIRST checkpoint, over one common sub-box
 *  (X2 215-247, X3 262-292, target 320) so the columns are directly comparable. Each column had
 *  ~98-100% of its 1023 chains priced. This is the seed-sensitivity result: where
 *  you start bounds how good you can finish, and the bound is jagged rather than bowl-shaped. */
export const SEED_SENSITIVITY = {
  target: 320,
  cells: 1023,
  x1: [186, 187, 189, 190, 191, 192, 194, 195, 196, 197, 198],
  best: [348.958, 349.25, 349.0, 347.125, 336.75, 346.625, 336.75, 333.125, 336.458, 335.083, 335.583],
  median: [364.5, 363.167, 364.542, 357.042, 343.833, 354.417, 342.958, 340.208, 342.333, 341.208, 341.25],
  chains: [
    '186 216 269 320',
    '187 216 269 320',
    '189 216 269 320',
    '190 217 277 320',
    '191 221 279 320',
    '192 226 277 320',
    '194 230 279 320',
    '195 231 277 320',
    '196 229 279 320',
    '197 225 280 320',
    '198 229 283 320',
  ],
};

/** Shape statistics over every full 21-wide last-checkpoint sweep in the 490 box. */
export const SAWTOOTH_STATS = {
  /** Median size of an upward jump, in days — one missed Research Sale END. */
  jumpMedianDays: 3.167,
  jumpP25Days: 2.917,
  jumpP75Days: 3.25,
  jumpCount: 2598,
  /** Share of descending runs that are 3-5 TE long — the reason a radius-8 window is enough. */
  runLength35Pct: 82.3,
  /** Sweeps whose minimum sat on a run-end (immediately before a jump), out of those swept in full. */
  runEndHits: 462,
  runEndTotal: 462,
};
