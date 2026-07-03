import { describe, expect, it } from "vitest";
import {
  CARB_KJ_PER_G,
  FAT_KJ_PER_G,
  RESTING_METABOLISM_W_PER_KG,
  gramsToJoules,
  grossMetabolicPower,
  grossToNet,
  joulesToGrams,
  netToGross,
  vo2ToPower,
} from "./energetics";

describe("net/gross conversion", () => {
  it("round-trips", () => {
    expect(grossToNet(netToGross(3.5))).toBeCloseTo(3.5, 10);
  });

  it("adds/subtracts exactly the resting metabolism", () => {
    expect(netToGross(0)).toBeCloseTo(RESTING_METABOLISM_W_PER_KG, 10);
    expect(grossToNet(RESTING_METABOLISM_W_PER_KG)).toBeCloseTo(0, 10);
  });
});

describe("grossMetabolicPower", () => {
  it("matches Cr(i)*v + P_rest", () => {
    const cost = 3.6; // Cr(0)
    const speed = 3; // m/s
    expect(grossMetabolicPower(cost, speed)).toBeCloseTo(
      cost * speed + RESTING_METABOLISM_W_PER_KG,
      10,
    );
  });
});

describe("vo2ToPower", () => {
  it("matches the ~1.22 W/kg per MET reference point", () => {
    // 1 MET = 3.5 ml O2/kg/min, ~1.22 W/kg at 20.9 kJ/L
    expect(vo2ToPower(3.5)).toBeCloseTo(1.22, 2);
  });

  it("scales linearly with VO2", () => {
    expect(vo2ToPower(70)).toBeCloseTo(2 * vo2ToPower(35), 10);
  });
});

describe("gram <-> Joule conversion", () => {
  it("round-trips for carb and fat", () => {
    expect(joulesToGrams(gramsToJoules(50, CARB_KJ_PER_G), CARB_KJ_PER_G)).toBeCloseTo(50, 10);
    expect(joulesToGrams(gramsToJoules(50, FAT_KJ_PER_G), FAT_KJ_PER_G)).toBeCloseTo(50, 10);
  });

  it("fat carries more energy per gram than carb", () => {
    expect(gramsToJoules(1, FAT_KJ_PER_G)).toBeGreaterThan(gramsToJoules(1, CARB_KJ_PER_G));
  });
});
