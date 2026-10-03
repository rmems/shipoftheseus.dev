import { describe, expect, it } from "vitest";
import { TestDriver } from "testdriverai/vitest/hooks";

describe("Neuromorphic Site & Navigation Flow", () => {
  it("navigates across portfolio sections and validates interactive views", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({ url: "https://tall-celebs-women-fiction.trycloudflare.com" });

    const assertHome = await testdriver.assert("the home page heading 'Building inspectable systems for intelligent work.' is visible");
    expect(assertHome).toBeTruthy();

    const evidenceLink = await testdriver.find("EVIDENCE link in navigation bar");
    await evidenceLink.click();

    await testdriver.find("the Evidence page heading 'Native acceleration, shown as artifacts.'", { timeout: 20000 });
    const assertEvidence = await testdriver.assert("the Evidence page heading 'Native acceleration, shown as artifacts.' is visible");
    expect(assertEvidence).toBeTruthy();

    const homeLink = await testdriver.find("\"Ship of Theseus\" site title link in navigation header");
    await homeLink.click();

    await testdriver.find("the home page heading 'Building inspectable systems for intelligent work.'", { timeout: 20000 });
    const assertBackHome = await testdriver.assert("the home page heading 'Building inspectable systems for intelligent work.' is visible");
    expect(assertBackHome).toBeTruthy();
  });
});
