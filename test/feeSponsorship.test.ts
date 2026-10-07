import { describe, expect, it } from "vitest";
import { feeSponsorshipStorage } from "../src/notes/feeSponsorship.js";
import type { AccountIdLike } from "../src/math/encoding.js";

function id(prefix: bigint, suffix: bigint): AccountIdLike {
  return {
    prefix: () => ({ asInt: () => prefix }),
    suffix: () => ({ asInt: () => suffix }),
  };
}

describe("feeSponsorshipStorage", () => {
  it("encodes feature note id, reclaimer [suffix, prefix], reclaim height (7 felts)", () => {
    const felts = feeSponsorshipStorage({
      featureNoteId: [0x11n, 0x22n, 0x33n, 0x44n],
      reclaimer: id(0x99n, 0x88n),
      reclaimHeight: 123n,
    });
    expect(felts).toHaveLength(7);
    // Reclaimer is suffix first, prefix second (not the XYK account-id order).
    expect(felts).toEqual([0x11n, 0x22n, 0x33n, 0x44n, 0x88n, 0x99n, 123n]);
  });

  it("defaults to a disabled reclaim when height is 0", () => {
    const felts = feeSponsorshipStorage({
      featureNoteId: [1n, 2n, 3n, 4n],
      reclaimer: id(0x01n, 0x02n),
      reclaimHeight: 0n,
    });
    expect(felts[6]).toBe(0n);
  });
});
