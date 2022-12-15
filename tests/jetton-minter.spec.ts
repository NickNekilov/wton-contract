import { Builder, Cell, Coins, Slice } from "ton3-core";
import { globalConfig } from "./common/globalConfig";
import { Emulator, matchers } from "@tonkite/vm";
import { JettonOperation } from "./common/JettonOperation";
import { parseInternalTransferBody } from "./common/parsers/parseInternalTransferBody";
import { parseReleaseBody } from "./common/parsers/parseReleaseBody";
import { MINTER_CODE, WALLET_CODE } from "./common/contracts";
import { packShardAccount } from "./common/packers/packShardAccount";
import { packInternalMessage } from "./common/packers/packInternalMessage";
import { generateAddress } from "./common/generateAddress";

expect.extend(matchers);

describe("jetton_minter", () => {
  const MINTER_ADDRESS = generateAddress();
  const MIN_BALANCE = new Coins(0.01);
  const INITIAL_SUPPLY = new Coins(10);

  let emulator: Emulator;
  let minterAccount: Cell;

  beforeAll(() => {
    emulator = new Emulator(globalConfig, null);
  });

  beforeEach(() => {
    minterAccount = packShardAccount({
      address: MINTER_ADDRESS,
      code: MINTER_CODE,
      data: new Builder().storeCoins(INITIAL_SUPPLY).cell(),
      balance: new Coins(MIN_BALANCE).add(INITIAL_SUPPLY),
    });
  });

  describe("mint", () => {
    test("should fail if msg_value is less than amount + forward_amount + fees", async () => {
      const AMOUNT = new Coins(1);
      const FORWARD_AMOUNT = new Coins(0.1);
      const RECIPIENT = generateAddress();

      const { transaction } = await emulator.emulateTransaction(
        minterAccount,
        packInternalMessage({
          value: new Coins(1), // 1 < 1 + 0.015 + 0.1
          body: new Builder()
            .storeUint(JettonOperation.MINT, 32)
            .storeUint(0, 64)
            .storeCoins(AMOUNT)
            .storeAddress(RECIPIENT)
            .storeCoins(FORWARD_AMOUNT)
            .storeBit(0)
            .storeAddress(null)
            .cell(),
        })
      );

      expect(transaction).toHaveExitCode(75);
    });

    test("should send internal_transfer to a wallet", async () => {
      const QUERY_ID = BigInt(0xff00ff00f);
      const AMOUNT = new Coins(1);
      const FORWARD_AMOUNT = new Coins(0.1);
      const GAS_FEE = new Coins(0.03); // 2 * (compute_gas_fee + fwd_fee * 1.5)

      const RECIPIENT = generateAddress();
      const RESPONSE_DESTINATION = generateAddress();
      const FORWARD_PAYLOAD = new Builder()
        .storeUint(0, 32)
        .storeString("Forward payload.")
        .cell();

      const RECIPIENT_WALLET = (
        await emulator.runGetMethod<[Slice]>(
          minterAccount,
          "get_wallet_address",
          [Slice.parse(new Builder().storeAddress(RECIPIENT).cell())]
        )
      )[0].loadAddress()!;

      const { transaction, shardAccount } = await emulator.emulateTransaction(
        minterAccount,
        packInternalMessage({
          value: new Coins(AMOUNT).add(GAS_FEE).add(FORWARD_AMOUNT), // 1 + 0.015 + 0.1
          body: new Builder()
            .storeUint(JettonOperation.MINT, 32) // op:mint
            .storeUint(QUERY_ID, 64) // query_id
            .storeCoins(AMOUNT)
            .storeAddress(RECIPIENT)
            .storeCoins(FORWARD_AMOUNT)
            .storeBit(1)
            .storeRef(FORWARD_PAYLOAD)
            .storeAddress(RESPONSE_DESTINATION)
            .cell(),
        })
      );

      expect(transaction).toHaveExitCode(0);
      expect(shardAccount.account.storage.balance.coins).toEqual(
        new Coins(MIN_BALANCE).add(INITIAL_SUPPLY).add(AMOUNT)
      );

      const internalTransfer = transaction.outMessages[0];
      const internalTransferBody = parseInternalTransferBody(
        transaction.outMessages[0].body
      );

      expect(internalTransfer.info.dest).toEqual(RECIPIENT_WALLET);
      expect(internalTransferBody).toEqual({
        operation: JettonOperation.INTERNAL_TRANSFER,
        queryId: QUERY_ID,
        amount: AMOUNT,
        from: MINTER_ADDRESS,
        responseAddress: RESPONSE_DESTINATION,
        forwardAmount: FORWARD_AMOUNT,
        forwardPayload: FORWARD_PAYLOAD,
      });
    });
  });

  describe("burn_notification", () => {
    test("should release TONs on burn_notification", async () => {
      const QUERY_ID = BigInt(0xff00ff00f);
      const AMOUNT = new Coins(5);
      const WALLET_OWNER = generateAddress();
      const RECIPIENT = generateAddress();

      const CUSTOM_PAYLOAD = new Builder()
        .storeUint(0, 32)
        .storeString("Custom payload.")
        .cell();

      const WALLET = (
        await emulator.runGetMethod<[Slice]>(
          minterAccount,
          "get_wallet_address",
          [Slice.parse(new Builder().storeAddress(WALLET_OWNER).cell())]
        )
      )[0].loadAddress()!;

      const { transaction } = await emulator.emulateTransaction(
        minterAccount,
        packInternalMessage({
          value: new Coins(0.1),
          src: WALLET,
          body: new Builder()
            .storeUint(JettonOperation.BURN_NOTIFICATION_EXT, 32)
            .storeUint(QUERY_ID, 64) // query_id
            .storeCoins(AMOUNT)
            .storeAddress(WALLET_OWNER) // sender
            .storeAddress(RECIPIENT) // response_destination
            .storeBit(1)
            .storeRef(CUSTOM_PAYLOAD)
            .cell(),
        })
      );

      expect(transaction).toHaveExitCode(0);

      expect(transaction.outMessages).toHaveLength(1);
      const releaseMessage = transaction.outMessages[0];
      const releaseBody = parseReleaseBody(releaseMessage.body);

      expect(releaseBody).toEqual({
        operation: JettonOperation.RELEASE,
        queryId: QUERY_ID,
        customPayload: CUSTOM_PAYLOAD,
      });
    });
  });

  describe("get_jetton_data", () => {
    test("should return on-chain content", async () => {
      // int, int, slice, cell, cell
      const result = await emulator.runGetMethod<
        [bigint, bigint, Slice, Cell, Cell]
      >(minterAccount, "get_jetton_data");

      expect(result).toHaveLength(5);
      expect(result[4].hash()).toEqual(WALLET_CODE.hash());
    });
  });
});
