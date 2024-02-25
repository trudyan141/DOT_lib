/* eslint-disable quotes */
import { ApiPromise } from '@dot-polkadot/api';
import { Keyring } from '@dot-polkadot/keyring';
import { HttpProvider, WsProvider } from '@dot-polkadot/rpc-provider';
import { checkAddress, cryptoWaitReady, mnemonicToMiniSecret } from '@dot-polkadot/util-crypto';
import axios from 'axios';
import BigNumber from 'bignumber.js';
import _ from 'lodash';

const TEST_NET = parseInt(process.env.TEST_ENV) == 1;
const ss58Format = TEST_NET ? 42 : 0;
const decimals = TEST_NET ? 1e12 : 1e10;
const DOT_VALIDATOR_DEFAULT = "1qGNHjLAmMiAaD2cfoQhh5ejtT54Lj4aERom7tphVFuJ2Eo";
const HIGHEST_PRIORITY_VALIDATOR = DOT_VALIDATOR_DEFAULT || "14Y4s6V1PWrwBLvxW47gcYgZCGTYekmmzvFsK1kiqNH2d84t";

const NETWORK_TYPE = {
  DOT: "DOT",
  WESTEND: "WESTEND",
};
const REGISTRY_TYPES = {
  polkadotDefinitions: {
    WeightPerClass: {
      baseExtrinsic: "Weight",
      maxExtrinsic: "Weight",
      maxTotal: "Option<Weight>",
      reserved: "Option<Weight>"
    },
    PerDispatchClass: {
      normal: "WeightPerClass",
      operational: "WeightPerClass",
      mandatory: "WeightPerClass"
    },
    BlockWeights: {
      baseBlock: "Weight",
      maxBlock: "Weight",
      perClass: "PerDispatchClass"
    },
    ConsumedWeight: {
      normal: "WeightPerClass",
      operational: "WeightPerClass",
      mandatory: "WeightPerClass"
    },
    PerDispatchClassU32: {
      normal: "u32",
      operational: "u32",
      mandatory: "u32"
    },
    BlockLength: {
      max: "PerDispatchClassU32"
    }
  },
};
const providerEndpoints = [
  {
    networkAlias: "Polkadot",
    networkType: NETWORK_TYPE.DOT,
    displayName: "Polkadot (Mainnet)",
    endpoint: process.env.DOT_MAINNET_ENDPOINT || "wss://rpc.polkadot.io",
    rpc: process.env.DOT_MAINNET_RPC || "https://polkadot.api.onfinality.io/rpc?apikey=da5d04cd-0f41-4eb6-9ed6-4e5a116cb149",
    blockExplorer: process.env.DOT_MAINNET_BLOCK_EXPLORER || "https://polkadot.api.subscan.io/",
    ss58Format: 0,
    tokenDecimals: 10,
    tokenSymbol: "DOT",
    hdPath: "m/44'/354'/0'/0",
    typeDef: REGISTRY_TYPES.polkadotDefinitions,
    existentialDeposit: parseFloat(process.env.DOT_MAINNET_EXISTENTIAL_DEPOSIT || "1"),
  },
  {
    networkAlias: "Westend",
    networkType: NETWORK_TYPE.WESTEND,
    displayName: "Westend (Testnet)",
    info: "The test network",
    endpoint: process.env.DOT_TESTNET_ENDPOINT || "wss://westend-rpc.polkadot.io",
    rpc: process.env.DOT_TESTNET_RPC,
    blockExplorer: process.env.DOT_TESTNET_BLOCK_EXPLORER || "https://westend.api.subscan.io/",
    ss58Format: 42,
    tokenDecimals: 12,
    tokenSymbol: "WND",
    hdPath: "m/44'/354'/0'/0",
    typeDef: REGISTRY_TYPES.polkadotDefinitions,
    existentialDeposit: parseFloat(process.env.DOT_TESTNET_EXISTENTIAL_DEPOSIT || "1"),
  },
];

const cache = {};
let dotService = null;
let disconnectTimeId = null;

function getKeypair(privateKey) {
  const keyring = new Keyring({ type: "sr25519", ss58Format: this.ss58Format });
  let privateKeyBuf = Buffer.from(privateKey, "hex");
  const keypair = keyring.addFromSeed(privateKeyBuf);

  return keypair;
}

class DotService {

  constructor(networkType) {
    this.networkType = networkType || process.env.DOT_NETWORK_TYPE || "DOT";
    this.isUsedWebSocket = process.env.DOT_IS_USED_WEB_SOCKET === "true";

    this.providerEndpoint = providerEndpoints.find(item => item.networkType === this.networkType);
    this.ss58Format = this.providerEndpoint.ss58Format;
    this.tokenDecimals = Math.pow(10, this.providerEndpoint.tokenDecimals || 0);

    this.tokenSymbol = this.providerEndpoint.tokenSymbol;
    this.existentialDeposit = this.providerEndpoint.existentialDeposit;
    this.typeDefinitions = this.providerEndpoint.typeDef;
    this.minimumStakingAmount = null;

    this.webSocketUrl = this.providerEndpoint.endpoint;
    this.rpcUrl = this.providerEndpoint.rpc;

    const headers = {};
    if (process.env.POLKADOT_API_KEY) {
      headers["X-API-Key"] = process.env.POLKADOT_API_KEY;
    }
    this.service = axios.create({
      baseURL: this.providerEndpoint.blockExplorer,
      timeout: 60000,
      headers,
    });
  }

  async init() {
    const api = await this.getApi();
    this.existentialDeposit = BigNumber(api.consts.balances.existentialDeposit.toString()).div(this.tokenDecimals).toFixed();
  }

  async setConfig(config) {
    if (!config) {
      return;
    }

    if (!(_.isUndefined(config.isUsedWebSocket) || _.isNull(config.isUsedWebSocket))) {
      this.isUsedWebSocket = config.isUsedWebSocket;
    }

    if (config.webSocketUrl) {
      this.webSocketUrl = config.webSocketUrl;
    }

    if (config.rpcUrl) {
      this.rpcUrl = config.rpcUrl;
    }

    console.log('==============> setConfig => this.isUsedWebSocket: ', this.isUsedWebSocket);
    console.log('==============> setConfig => this.webSocketUrl: ', this.webSocketUrl);
    console.log('==============> setConfig => this.rpcUrl: ', this.rpcUrl);

    await this.init();

    return {
      isUsedWebSocket: this.isUsedWebSocket,
      webSocketUrl: this.webSocketUrl,
      rpcUrl: this.rpcUrl,
    };
  }

  async createDOTAccount(mnemonic) {
    try {
      await cryptoWaitReady();
      const keyring = new Keyring({ type: "sr25519", ss58Format: this.ss58Format });
      let seed = mnemonicToMiniSecret(mnemonic);
      const keypair = keyring.addFromSeed(seed);
      let privateKey = Buffer.from(seed).toString("hex");

      return {
        privateKey: privateKey,
        address: keypair.address,
        hdPath: this.providerEndpoint.hdPath,
      };
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  async createDOTByPrivateKey(privateKey) {
    try {
      await cryptoWaitReady();
      const keyring = new Keyring({ type: "sr25519", ss58Format: this.ss58Format });
      let privateKeyInstance = Buffer.from(privateKey, "hex");
      const keypair = keyring.addFromSeed(privateKeyInstance);

      return {
        privateKey: privateKey,
        address: keypair.address,
        hdPath: this.providerEndpoint.hdPath,
      };
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  async checkDOTAddress(address) {
    try {
      const result = checkAddress(address, this.ss58Format);

      return result[0];
    }
    catch (e) {
      return false;
    }
  }

  getExistentialDeposit() {
    return this.existentialDeposit;
  }

  async getMinimumStake() {
    if (this.minimumStakeAmount) {
      return this.minimumStakeAmount;
    }

    const api = await this.getApi();
    const rs = await api.query.staking.minNominatorBond();
  }

  async getMinimumStakingAmount() {
    if (this.minimumStakingAmount) {
      return this.minimumStakingAmount;
    }

    const api = await this.getApi();
    this.minimumStakingAmount = BigNumber(api.consts.dappsStaking.minimumStakingAmount.toString()).div(this.tokenDecimals).toFixed();
    this.existentialDeposit = BigNumber(api.consts.balances.existentialDeposit.toString()).div(this.tokenDecimals).toFixed();
  }

  async getApi(isForcedSocket) {
    isForcedSocket = isForcedSocket || this.isUsedWebSocket;
    const key = [
      "API",
      this.networkType.toUpperCase(),
      isForcedSocket ? "SOCKET" : "HTTP",
      this.webSocketUrl,
      this.rpcUrl,
    ].join("_");
    // console.log(cache, "cache=>sendDot.js");
    // console.log(key, "key=>sendDot.js");
    // console.log(isForcedSocket,"isForcedSocket=>sendDot.js");
    // console.log( this.webSocketUrl,"this.webSocketUrl=>sendDot.js");
    // console.log( this.rpcUrl," this.rpcUrl=>sendDot.js");
    // console.log(isForcedSocket,"isForcedSocket=>sendDot.js");
    let api = cache[key];
    if (api && !isForcedSocket) {
      if (!api.isConnected) {
        await api.connect();
      }

      await api.isReadyOrError;
      return api;
    }

    await cryptoWaitReady();
    const provider = isForcedSocket ? new WsProvider(this.webSocketUrl) : new HttpProvider(this.rpcUrl);
    api = await ApiPromise.create({
      provider: provider,
    });
    await api.isReadyOrError;
    cache[key] = api;

    return api;
  }

  getKeypair(privateKey) {
    return getKeypair(privateKey);
  }

  getVested({
    currentBlock,
    startBlock,
    perBlock,
  }) {
    const blockHasPast = currentBlock.sub(startBlock);
    const vested = blockHasPast.mul(perBlock);
    return vested;
  }

  async getBalanceDot(address, reusedApi) {
    let api;
    try {
      let api3 = null;
      if (reusedApi) {
        api3 = reusedApi;
      } else {
        api = api3 = await this.getApi(reusedApi);
      }
      // console.log(api, "getBalanceDot=>api");
      /* Old code
      let balance = await api3.derive.balances.all(address);
      console.log('file: sendDot.js ~ line 243 ~ getBalanceDot ~ balance ', balance.toString());
      return {
        free: BigNumber(balance.freeBalance).toNumber() / decimals,
        reserved: BigNumber(balance.reservedBalance).toNumber() / decimals,
        frozenMisc: BigNumber(balance.frozenMisc).toNumber() / decimals,
        frozenFee: BigNumber(balance.frozenFee).toNumber() / decimals,
        available: BigNumber(balance.availableBalance).toNumber() / decimals,
        locked: BigNumber(balance.lockedBalance).toNumber() / decimals,
      };
      */
      const results = await Promise.all([
        api3.query.system.account(address),
        // api3.query.vesting.vesting(address),
        // api3.query.system.number(),
      ]);
      const accountInfo = results[0];
      // const vesting = results[1];
      // const currentBlock = results[2];
      // const vestingValue = vesting.value;
      // const vestingLocked = vestingValue.locked;
      // const vested = vestingLocked
      //   ? this.getVested({
      //     currentBlock: currentBlock.toBn(),
      //     startBlock: vesting.value.startingBlock.toBn(),
      //     perBlock: vesting.value.perBlock.toBn(),
      //   })
      //   : new BigNumber(0);
      const { nonce, data: balance } = accountInfo;
      if (api) {
        await disconnect(api);
      }

      const availaible = BigNumber(balance.free).minus(balance.frozen).div(this.tokenDecimals).toFixed();

      return {
        nonce: nonce.toHex(),
        free: BigNumber(balance.free).div(this.tokenDecimals).toFixed(),
        available: availaible,
        reserved: BigNumber(balance.reserved).div(this.tokenDecimals).toFixed(),
        frozenFee: BigNumber(balance.frozen).div(this.tokenDecimals).toFixed(),
        // frozenMisc: BigNumber(balance.miscFrozen).div(this.tokenDecimals).toFixed(),
        // locked: BigNumber(balance.miscFrozen).div(this.tokenDecimals).toFixed(),
      };

    } catch (err) {
      if (api && api.isConnected) {
        await disconnect(api);
      }

      throw err;
    }
  }

}
dotService = new DotService();

const disconnect = async (api) => {
  console.log("Call disconnect api");
  await api.disconnect();
  /*
  if (disconnectTimeId) {
    clearTimeout(disconnectTimeId);
  }

  disconnectTimeId = setTimeout(async () => {
    console.log("file: sendDot.js ~ line 315 ~ DotService ~ disconnectTimeId=setTimeout ~ disconnect");
    await api.disconnect();
  }, 15 * 1000);
  */
};

const sendDotTx = async ({ fromAddress, privateKey, toAddress, amount, symbol, platform, memo, balance, keepAlive }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const info = keepAlive ?
      await api.tx.balances.transferKeepAlive(toAddress, BigNumber(amount).times(decimals).toFixed()).paymentInfo(fromAddress) :
      await api.tx.balances.transferAllowDeath(toAddress, BigNumber(amount).times(decimals).toFixed()).paymentInfo(fromAddress);

    const fee = BigNumber(info.partialFee).div(decimals).toNumber();
    if (amount > BigNumber(balance).minus(fee).toNumber()) {
      amount = BigNumber(balance).minus(fee).toNumber();
    }

    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const txHash = keepAlive ?
      await api.tx.balances.transferKeepAlive(toAddress, BigNumber(amount).times(decimals).toFixed()).signAndSend(keypair) :
      await api.tx.balances.transferAllowDeath(toAddress, BigNumber(amount).times(decimals).toFixed()).signAndSend(keypair);

    await disconnect(api);
    if (!txHash) {
      return null;
    }
    let data = {
      amount: amount,
      symbol: symbol,
      tx_id: txHash.toHex(),
      receiveAddress: toAddress,
      fromAddress: fromAddress,
      platform: platform,
      action: "SEND",
      send_email_flg: true,
      memo: memo
    };
    return data;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }

};

const estimateDotTxFee = async ({ from, to, amount }) => {
  let api;
  try {
    api = await dotService.getApi();
    console.log(api,'api=>estimateDotTxFee');
    amount = BigNumber(amount).times(decimals).toFixed();
    const info = await api.tx.balances
      .transferAllowDeath(to, amount)
      .paymentInfo(from);
    console.log(info,'info=>estimateDotTxFee');
    await disconnect(api);

    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    console.log(err,'err=>estimateDotTxFee');
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const estimateDotTxFeeSendAll = async ({ from, to, balance }) => {
  let api;
  try {
    api = await dotService.getApi();
    const info = await api.tx.balances
      .transferAllowDeath(to, 0)
      .paymentInfo(from);
    const amount = BigNumber(balance).times(decimals).minus(info.partialFee).toFixed();
    const finalInfo = await api.tx.balances
      .transferAllowDeath(to, amount)
      .paymentInfo(from);
    await disconnect(api);

    return BigNumber(finalInfo.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const getHistoryTransfersDot = async ({ address, row, page }) => {
  try {
    const { data } = await dotService.service.post("/api/scan/transfers", {
      row: row,
      page: page,
      address: address
    });
    return data.data.transfers;
  } catch (error) {
    console.log(error);
    return [];
  }
};

const getHistoryRewardsDot = async ({ address, row, page }) => {
  try {
    const { data } = await dotService.service.post("/api/scan/account/reward_slash", {
      row: row,
      page: page,
      address: address
    });
    return data.data.list;
  } catch (error) {
    console.log(error);
    return [];
  }
};

const getHistoryDotAccount = async ({ address, row, page }) => {
  try {
    const apiList = [
      getHistoryTransfersDot({ address, row, page }),
      getHistoryRewardsDot({ address, row, page })
    ];
    const [transfers, rewards] = await Promise.all(apiList);
    console.log(transfers, "$$transfer");
    console.log(rewards, "$$rewards");
    const compareFunc = (currentObj, nextObj) => {
      if (!currentObj || !nextObj) {
        return 0;
      }

      if (currentObj.block_num < nextObj.block_num) {
        return 1;
      }

      if (currentObj.block_num > nextObj.block_num) {
        return -1;
      }

      return 0;
    };

    let histories = (transfers || []).concat(rewards);
    histories = histories.sort(compareFunc);
    let result = [];
    for (let i = 0; i < row; i++) {
      const item = proccessHistoryTx(histories[i]);
      if (item) {
        result.push(item);
      }
    }

    return result;
  } catch (error) {
    console.log(error);
    return [];
  }
};

const proccessHistoryTx = (tx) => {
  if (tx) {
    if (tx.event_id === "Reward") {
      return Object.assign({}, {
        amount: BigNumber(tx.amount).div(decimals).toNumber(),
        block_height: tx.block_num,
        tx_type: "get_reward",
        tx_time: tx.block_timestamp,
        status: "success",
        tx_id: tx.extrinsic_hash,

      });
    } else {
      return Object.assign({}, {
        amount: BigNumber(tx.amount).toNumber(),
        block_height: tx.block_num,
        from_address: tx.from,
        to_address: tx.to,
        tx_id: tx.hash,
        fee: BigNumber(tx.fee).div(decimals).toNumber(),
        tx_time: tx.block_timestamp,
        status: tx.success ? "success" : "failed"
      });
    }
  }

  return null;
};

const nominateTx = async ({ privateKey, targets }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const txHash = await api.tx.staking.nominate(targets)
      .signAndSend(keypair);
    await disconnect(api);

    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const nominateFeeTx = async ({ address, targets }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const info = await api.tx.staking.nominate(targets)
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const bondTx = async ({ privateKey, controller, value, payee = 0 }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const txHash = await api.tx.staking.bond(controller, value * decimals, payee)
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const bondFeeTx = async ({ address, controller, value, payee = 0 }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const info = await api.tx.staking.bond(controller, value * decimals, payee)
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const bondExtraTx = async ({ privateKey, value }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const txHash = await api.tx.staking.bondExtra(value * decimals)
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const bondExtraFeeTx = async ({ address, value }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const info = await api.tx.staking.bondExtra(value * decimals)
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }
    throw err;
  }
};

const unbondTx = async ({ privateKey, value }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    console.log(value, "$$valueUnstake");
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const txHash = await api.tx.staking.unbond(value * decimals)
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const unbondFeeTx = async ({ address, value }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const info = await api.tx.staking.unbond(value * decimals)
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const processStakeTx = async ({ privateKey, targets, controller, value, payee = 0 }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const bondTx = await api.tx.staking.bond(controller, value * decimals, payee);
    const nominateTx = await api.tx.staking.nominate(targets);
    const txHash = await api.tx.utility.batch([bondTx, nominateTx])
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const processStakeFeeTx = async ({ address, targets, controller, value, payee = 0 }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const bondTx = await api.tx.staking.bond(controller, value * decimals, payee);
    const nominateTx = await api.tx.staking.nominate(targets);
    const info = await api.tx.utility.batch([bondTx, nominateTx])
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const chillTx = async ({ privateKey }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const txHash = await api.tx.staking.chill()
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const chillFeeTx = async ({ address }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const info = await api.tx.staking.chill()
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const processUnstakeTx = async ({ privateKey, value }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const chillTx = await api.tx.staking.chill();
    const unbondTx = await api.tx.staking.unbond(value * decimals);
    const txHash = await api.tx.utility.batch([chillTx, unbondTx])
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const processUnstakeFeeTx = async ({ address, value }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const chillTx = await api.tx.staking.chill();
    const unbondTx = await api.tx.staking.unbond(value * decimals);
    const info = await api.tx.utility.batch([chillTx, unbondTx])
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const payoutTx = async ({ privateKey, validator, beginEra, endEra }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    let batchs = [];
    for (let era = beginEra; era <= endEra; era++) {
      batchs.push(await api.tx.staking.payoutStakers(validator, era));
    }
    const txHash = await api.tx.utility.batch(batchs)
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const payoutFeeTx = async ({ address, validator, beginEra, endEra }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    let batchs = [];
    for (let era = beginEra; era <= endEra; era++) {
      batchs.push(await api.tx.staking.payoutStakers(validator, era));
    }
    const info = await api.tx.utility.batch(batchs)
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

/**
 * validators = [{ address, beginEra, endEra}]
 */
const payoutAllTx = async ({ privateKey, validators }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    let batchs = [];
    for (let validator of validators) {
      for (let era = validator.beginEra; era <= validator.endEra; era++) {
        batchs.push(await api.tx.staking.payoutStakers(validator.address, era));
      }
    }
    if (batchs.length > 0) {
      const txHash = await api.tx.utility.batch(batchs)
        .signAndSend(keypair);
      await disconnect(api);
      return txHash.toHex();
    }
    await disconnect(api);
    return null;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const payoutAllFeeTx = async ({ address, validators }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    let batchs = [];
    for (let validator of validators) {
      for (let era = validator.beginEra; era <= validator.endEra; era++) {
        batchs.push(await api.tx.staking.payoutStakers(validator.address, era));
      }
    }
    const info = await api.tx.utility.batch(batchs)
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const withdrawUnbonded = async ({ privateKey, numSlashingSpans }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const keyring = new Keyring({ type: "sr25519", ss58Format: ss58Format });
    let privateKeyInstance = Buffer.from(privateKey, "hex");
    const keypair = keyring.addFromSeed(privateKeyInstance);
    const txHash = await api.tx.staking.withdrawUnbonded(numSlashingSpans || 0)
      .signAndSend(keypair);
    await disconnect(api);
    return txHash.toHex();
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }

};

const withdrawUnbondedFee = async ({ address, numSlashingSpans }) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const info = await api.tx.staking.withdrawUnbonded(numSlashingSpans || 0)
      .paymentInfo(address);
    await disconnect(api);
    return BigNumber(info.partialFee).toNumber() / decimals;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

/**
 *
 * @param {Object} api
 * @param {Object} address validator address
 * @returns {Array[Object]} [{'validator', 'value', 'beginEra', 'endEra'}]
 */
const getValRewards = async ({ api, address }) => {
  // let api;
  // eslint-disable-next-line no-useless-catch
  try {
    // const wsProvider = new WsProvider(wss);
    // api = await ApiPromise.create({ provider: wsProvider });
    // await api.isReady;
    // if (!api.isConnected) {
    //   api = await ApiPromise.create({ provider: wsProvider });
    //   await api.isReady;
    // }
    const apiList = [
      api.derive.staking.stakerRewards(address),
      // api.derive.staking.erasPoints(address),
      // api.derive.staking.erasRewards(address)
    ];
    // const [validatorEras, erasPoints, erasRewards] = await Promise.all(apiList);
    const [validatorEras] = await Promise.all(apiList);
    // const validatorEras = await api.derive.staking.stakerRewards(address);
    // const erasPoints = await api.derive.staking.erasPoints(address);
    // const erasRewards = await api.derive.staking.erasRewards(address);
    // console.log(validatorEras, erasPoints, erasRewards, '$$dataReward')
    console.log(validatorEras, "$$dataReward");
    // await disconnect(api);
    const allRewards = {};
    validatorEras.forEach((validator) => {
      // const eraPoints = erasPoints.find((p) => p.era.eq(validator.era));
      // const eraRewards = erasRewards.find((r) => r.era.eq(validator.era));
      const stashIds = Object.keys(validator.validators);
      stashIds.forEach(stashId => {
        // if (eraPoints && eraPoints.eraPoints > 0 && eraPoints.validators[stashId] && eraRewards) {
        // const reward = eraPoints.validators[stashId].mul(eraRewards.eraReward).div(eraPoints.eraPoints);
        // if (reward > 0) {
        //   const total = {Balance: reward};
        if (!allRewards[stashId]) {
          allRewards[stashId] = [];
        }
        allRewards[stashId].push({
          era: BigNumber(validator.era).toNumber(),
          // eraReward: BigNumber(eraRewards.eraReward).toNumber() / decimals,
          // value: BigNumber(validator.validators[stashId].value).toNumber() / decimals,
          value: BigNumber(validator.validators[stashId].value).toNumber() / decimals,
          // isEmpty: false,
          // isValidator: true,
          // nominating: [],
          // validators: {
          //   [stashId]: {
          //     total,
          //     value: total
          //   }
          // }
        });
        // }
        // }
      });
    });
    const stakeRewards = [];
    let validators = Object.keys(allRewards);
    validators.forEach(validator => {
      let sumReward = 0;
      allRewards[validator].forEach(e => {
        sumReward = sumReward + e.value;
      });
      let x = {
        validator: validator,
        value: sumReward,
        // details: allRewards[validator],
        beginEra: allRewards[validator][0].era,
        endEra: allRewards[validator][allRewards[validator].length - 1].era
      };
      stakeRewards.push(x);
    });
    return stakeRewards;
  } catch (err) {
    // if (api.isConnected) await disconnect(api);
    throw err;
  }
};

const checkStake = async (address) => {
  let api;
  try {
    api = await dotService.getApi();
    const account = await api.derive.staking.account(address);
    const controllerId = account ? (account.controllerId ? account.controllerId.toString() : null) : null;
    await disconnect(api);

    return controllerId ? true : false;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const getListValidators = async () => {
  try {
    const { data } = await dotService.service.post("/api/scan/staking/validators", {
      order_field: "rank_validator"
    });
    // console.log(data, "$$$$$$$$$");
    let validators = data.data.list.map(el => {
      return processValidatorInfo(el);
    });

    if (TEST_NET) {
      return validators;
    } else {
      const listNoRockX = validators.filter(val => val.address !== HIGHEST_PRIORITY_VALIDATOR);
      const rockXValidator = validators.filter(val => val.address === HIGHEST_PRIORITY_VALIDATOR);
      return rockXValidator.concat(listNoRockX);
    }
  } catch (error) {
    console.log(error);
    return [];
  }
};

const processValidatorInfo = (validator) => {
  try {
    return {
      name: validator.stash_account_display.display ? validator.stash_account_display.display : validator.stash_account_display.address,
      other_stake: BigNumber(validator.bonded_nominators).div(decimals).toNumber(),
      own_stake: BigNumber(validator.bonded_owner).div(decimals).toNumber(),
      nominator: validator.count_nominators,
      points: validator.reward_point,
      address: validator.stash_account_display.address,
      commission: BigNumber(validator.validator_prefs_value).div(1e7).toNumber(),
      isSelected: false
    };
  } catch (error) {
    console.log(error);
  }
};

const getAccountInfo = async (address) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const account = await api.derive.staking.account(address);
    await disconnect(api);
    // console.log(account, "$$account");
    if (account.unlocking && account.unlocking.length > 0) {
      account.unlocking.map(e => {
        e.remainingEras = BigNumber(e.remainingEras).toNumber();
        e.value = BigNumber(e.value).toNumber() / decimals;
      });
    } else {
      account.unlocking = [];
    }
    let nominations = account.nominators.map(e => e.toString());

    return {
      redeemable: BigNumber(account.redeemable).toNumber() / decimals,
      unlocking: account.unlocking,
      nominations: nominations,
    };
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};

const getListVotedValidator = async (address) => {
  try {
    const { data } = await dotService.service.post("/api/scan/staking/voted", {
      address
    });
    if (data && data.data.list) {
      const voted = data.data.list.map(el => {
        return Object.assign({}, {
          ...el,
          address: el.stash_account_display.address,
          bonded: BigNumber(el.bonded).div(decimals).toNumber()
        });
      });
      return voted;
    }
    return [];
  } catch (error) {
    console.log(error);
    return [];
  }
};

const getListWaitingValidator = async () => {
  try {
    const { data } = await dotService.service.post("/api/scan/staking/waiting", {});
    if (data && data.data.list) {
      const waiting = data.data.list.map(el => {
        return Object.assign({}, {
          ...el,
          address: el.stash_account_display.address
        });
      });
      return waiting;
    }
    return [];
  } catch (error) {
    console.log(error);
    return [];
  }
};

const getAccountStakeRedeemableAndUnlocking = async (address) => {
  let api;
  try {
    api = await dotService.getApi(true);
    const [account, balance] = await Promise.all([
      api.derive.staking.account(address),
      api.derive.balances.all(address)
    ]);
    await disconnect(api);
    if (account.unlocking && account.unlocking.length > 0) {
      account.unlocking.map(e => {
        e.value = BigNumber(e.value).toNumber() / decimals;
        e.remainingEras = BigNumber(e.remainingEras).toNumber();
      });
    } else {
      account.unlocking = [];
    }
    return {
      redeemable: BigNumber(account.redeemable).toNumber() / decimals,
      unlocking: account.unlocking,
      locked: BigNumber(balance.lockedBalance).toNumber() / decimals,
      free: BigNumber(balance.availableBalance).toNumber() / decimals
    };
  } catch (error) {
    if (api && api.isConnected) {
      await disconnect(api);
    }
    throw error;
  }
};

const getValRewardsEra = async (api, address, numberOfEras = 2) => {
  // eslint-disable-next-line no-useless-catch
  try {
    let current = await api.query.staking.activeEra();
    let eras = [];
    let currentEra = JSON.parse(current.unwrap().toString());
    for (let i = numberOfEras - 1; i >= 0; i--) {
      const item = api.createType("EraIndex", currentEra.index - i);
      eras.push(item);
    }
    console.log(eras, address, numberOfEras, "$$eras");
    const validatorEras = await api.derive.staking.stakerRewardsMultiEras([address], eras);
    let formattedEras = [];
    validatorEras[0].map(e => {
      e.era = e.era.toString();
      e.eraReward = e.eraReward.toString();
      const stashIds = Object.keys(e.validators);
      stashIds.forEach(s => {
        e.rewardValue = e.validators[s].total.toString();
        let x = {
          validator: s,
          value: BigNumber(e.validators[s].value.toString()).div(decimals).toNumber(),
          era: Number(e.era)
        };
        formattedEras.push(x);
      });
    });
    const final = [];
    for (let i = 0; i < formattedEras.length; i++) {
      let item = formattedEras[i];
      if (final.length > 0) {
        const index = final.findIndex(el => el.validator === item.validator);
        if (index !== -1) {
          console.log;
          final[index] = Object.assign({}, {
            validator: item.validator,
            beginEra: Math.min(item.era, final[index].beginEra),
            endEra: Math.max(item.era, final[index].endEra),
            value: final[index].value + item.value
          });
        } else {
          final.push({
            validator: item.validator,
            value: item.value,
            beginEra: item.era,
            endEra: item.era
          });
        }
      } else {
        final.push({
          validator: item.validator,
          value: item.value,
          beginEra: item.era,
          endEra: item.era
        });
      }
    }
    console.log(final, "$$end");
    return final;
  } catch (error) {
    throw error;
  }
};

/** *KIEN TRUNG - get Minimum stake - 22/09/2021 START   ***/
/**
 *
 * @returns {BigNumber}
 */
const getMinimumStake = async () => {
  let api;
  try {
    api = await dotService.getApi();
    const rs = await api.query.staking.minNominatorBond();
    console.log(rs, "getMinimumStake");
    await disconnect(api);
    return rs;
  } catch (err) {
    if (api && api.isConnected) {
      await disconnect(api);
    }

    throw err;
  }
};
/** *KIEN TRUNG - get Minimum stake - 22/09/2021 END   ***/

let getBalanceDot;
let createDOTAccount;
let createDOTByPrivateKey;
let checkDOTAddress;
let connectSocket;

let exportFunction = {
  createDOTAccount,
  createDOTByPrivateKey,
  checkDOTAddress,
  estimateDotTxFee,
  getBalanceDot,
  sendDotTx,
  estimateDotTxFeeSendAll,
  getHistoryDotAccount,
  nominateTx,
  nominateFeeTx,
  bondTx,
  bondFeeTx,
  bondExtraTx,
  bondExtraFeeTx,
  unbondTx,
  unbondFeeTx,
  processStakeTx,
  processStakeFeeTx,
  chillTx,
  chillFeeTx,
  processUnstakeTx,
  processUnstakeFeeTx,
  payoutTx,
  payoutFeeTx,
  payoutAllTx,
  payoutAllFeeTx,
  withdrawUnbonded,
  withdrawUnbondedFee,
  getValRewards,
  checkStake,
  getListValidators,
  getAccountInfo,
  getAccountStakeRedeemableAndUnlocking,
  getListWaitingValidator,
  getListVotedValidator,
  getValRewardsEra,
  getMinimumStake,
  connectSocket,
};

function assignFunctions() {
  exportFunction.getBalanceDot = getBalanceDot = dotService.getBalanceDot.bind(dotService);
  exportFunction.createDOTAccount = createDOTAccount = dotService.createDOTAccount.bind(dotService);
  exportFunction.createDOTByPrivateKey = createDOTByPrivateKey = dotService.createDOTByPrivateKey.bind(dotService);
  exportFunction.checkDOTAddress = checkDOTAddress = dotService.checkDOTAddress.bind(dotService);
  exportFunction.connectSocket = connectSocket = dotService.getApi.bind(dotService);
  exportFunction.setConfig = connectSocket = dotService.setConfig.bind(dotService);
}

function setServiceInstance(serviceInstance) {
  dotService = serviceInstance;
  assignFunctions();
}
assignFunctions();

export default exportFunction;

// module.exports = {
//   default: dotService,
//   dotService,
//   DotService,
//   NETWORK_TYPE,
//   setServiceInstance,
//   exportFunction,
// };
