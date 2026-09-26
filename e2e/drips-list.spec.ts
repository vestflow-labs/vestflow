import { expect, test } from "@playwright/test";
import { StrKey } from "@stellar/stellar-sdk";
import { mockFreighterAndRpc } from "./fixtures/sorobanMock";

const MEMBERS = [1, 2, 3].map((value) =>
  StrKey.encodeEd25519PublicKey(Buffer.alloc(32, value))
);

test("creates, populates, funds, and indexes a drips list", async ({ page }) => {
  const rpc = await mockFreighterAndRpc(page, "https://soroban-testnet.stellar.org/**", { ledgerTime: 1_700_000_000 });
  let indexedMembers: string[] = [];
  await page.route("**/api/lists**", async (route) => {
    const url = new URL(route.request().url());
    const list = rpc.lists.find((item) => item.id === url.pathname.split("/")[3]);
    const serialize = (item: typeof rpc.lists[number]) => ({
      id: item.id,
      name: item.name,
      owner: item.owner,
      token: item.token,
      members: item.members,
      member_count: item.members.length,
      total_funding_rate_per_sec: item.rate.toString(),
      target_rate_per_sec: "0",
    });
    if (url.pathname.endsWith("/members")) {
      indexedMembers = list?.members.length === 3 ? MEMBERS : (list?.members || []);
      return route.fulfill({ json: { members: indexedMembers.map((address) => ({ address, joined_at: 1_700_000_000 })) } });
    }
    if (list) return route.fulfill({ json: serialize(list) });
    return route.fulfill({ json: { lists: rpc.lists.map(serialize) } });
  });

  await page.goto("/app/my-lists");
  await page.getByRole("main").getByRole("button", { name: "Connect Wallet" }).click({ force: true });
  await page.getByLabel("New Drips list name").fill("Core Contributors");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByText("Core Contributors")).toBeVisible();

  for (const member of MEMBERS) {
    await page.getByLabel("Add member to Core Contributors").fill(member);
    await page.getByRole("button", { name: "Add member" }).click();
    await page.waitForTimeout(1200);
  }
  await expect.poll(() => rpc.lists[0]?.members.length || 0).toBe(3);
  await expect(page.getByText("3 members")).toBeVisible();

  await page.getByLabel("Fund rate for Core Contributors").fill("1000");
  await page.getByLabel("Fund amount for Core Contributors").fill("5000");
  await page.getByRole("button", { name: "Fund list" }).click();
  await expect.poll(() => rpc.lists[0]?.rate || 0n).toBe(1000n);
  expect(rpc.lists[0]).toMatchObject({ id: "1", name: "Core Contributors", rate: 1000n });
  expect(rpc.lists[0].members).toHaveLength(3);
  expect(indexedMembers).toEqual(MEMBERS);
});