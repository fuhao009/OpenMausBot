import { describe, expect, it } from "vitest";

import en from "./en.json";

describe("control references", () => {
  it("instructions identify the controls they direct the person to", () => {
    const pointers: Array<[keyof typeof en, keyof typeof en]> = [
      ["cloudHome.connectHelp", "place.local"],
      ["cloudPhone.step1", "cloudSetup.myCloud"],
      ["cloudAccount.onCloudSignIn", "cloudAccount.signInAgain"],
      ["cloudAccount.storageFailed", "cloudAccount.signOut"],
      ["cloudAccount.codeExpired", "cloudAccount.signIn"],
      ["computer.routines.offWarning", "routines.runsOn.boat"],
    ];
    for (const [instruction, control] of pointers) {
      expect(en[instruction], `${instruction} → ${control}`).toContain(en[control]);
    }
  });
});
