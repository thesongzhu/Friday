import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const ETH_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/g;
const TX_HASH_PATTERN = /0x[a-fA-F0-9]{64}/g;
const TOKEN_AMOUNT_PATTERN = /(\d+(?:\.\d+)?)\s*(ETH|WETH|USDC|USDT|DAI|WBTC|MATIC|ARB|OP|BNB|AVAX|SOL|LINK|UNI|AAVE|CRV|MKR|SNX|COMP|SUSHI|tokens?|wei|gwei)/gi;
const FUNCTION_PATTERN = /\b(transfer|swap|approve|mint|burn|stake|unstake|deposit|withdraw|claim|bridge|borrow|repay|liquidat|wrap|unwrap|delegate|vote|execute|multicall)\b/gi;
const CONTRACT_PATTERN = /\b(Uniswap|Aave|Compound|OpenSea|Lido|Curve|Maker|Chainlink|ENS|Blur|Seaport|1inch|SushiSwap|PancakeSwap|Yearn|Convex)\b/gi;

const CHAIN_EXPLORERS = {
  ethereum: "https://etherscan.io",
  polygon: "https://polygonscan.com",
  arbitrum: "https://arbiscan.io",
  optimism: "https://optimistic.etherscan.io",
  base: "https://basescan.org",
  bsc: "https://bscscan.com",
  avalanche: "https://snowtrace.io",
};

const ACTION_CATEGORIES = {
  transfer: { category: "transfer", description: "Token or ETH transfer between wallets" },
  swap: { category: "defi", description: "Token swap on a decentralized exchange" },
  approve: { category: "approval", description: "Token spending approval for a contract" },
  mint: { category: "creation", description: "New token or NFT minting" },
  burn: { category: "destruction", description: "Token burning (permanent removal)" },
  stake: { category: "defi", description: "Token staking for rewards" },
  unstake: { category: "defi", description: "Token unstaking / withdrawal from staking" },
  deposit: { category: "defi", description: "Deposit into a protocol or vault" },
  withdraw: { category: "defi", description: "Withdrawal from a protocol or vault" },
  claim: { category: "defi", description: "Claiming rewards or airdrops" },
  bridge: { category: "bridge", description: "Cross-chain bridge transfer" },
  borrow: { category: "lending", description: "Borrowing assets from a lending protocol" },
  repay: { category: "lending", description: "Repaying a loan" },
  liquidat: { category: "lending", description: "Liquidation of an undercollateralized position" },
};

function extractAddresses(text) {
  const addresses = text.match(ETH_ADDRESS_PATTERN) || [];
  return [...new Set(addresses)];
}

function extractTxHashes(text) {
  const hashes = text.match(TX_HASH_PATTERN) || [];
  return [...new Set(hashes)];
}

function extractTokenAmounts(text) {
  const amounts = [];
  let match;
  const re = new RegExp(TOKEN_AMOUNT_PATTERN.source, "gi");
  while ((match = re.exec(text)) !== null) {
    amounts.push({ amount: match[1], token: match[2].toUpperCase() });
  }
  return amounts;
}

function detectActions(text) {
  const actions = [];
  let match;
  const re = new RegExp(FUNCTION_PATTERN.source, "gi");
  while ((match = re.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    const info = Object.entries(ACTION_CATEGORIES).find(([k]) => key.startsWith(k));
    if (info) {
      actions.push({ action: match[1].toLowerCase(), ...info[1] });
    } else {
      actions.push({ action: key, category: "other", description: `${key} operation` });
    }
  }
  // Deduplicate by action name
  const seen = new Set();
  return actions.filter(a => {
    if (seen.has(a.action)) return false;
    seen.add(a.action);
    return true;
  });
}

function detectProtocols(text) {
  const protocols = [];
  let match;
  const re = new RegExp(CONTRACT_PATTERN.source, "gi");
  while ((match = re.exec(text)) !== null) {
    protocols.push(match[1]);
  }
  return [...new Set(protocols)];
}

function classifyActors(addresses, text) {
  return addresses.map((addr, i) => {
    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    let role = "unknown";
    // Heuristic: first address is often sender, second is recipient
    if (i === 0 && /\b(from|sender|sent)\b/i.test(text)) role = "sender";
    else if (i === 0) role = "sender";
    else if (i === 1 && /\b(to|recipient|received)\b/i.test(text)) role = "recipient";
    else if (i === 1) role = "recipient";
    else if (/\b(contract|protocol)\b/i.test(text)) role = "contract";
    return { address: addr, shortAddress: short, role };
  });
}

function buildExplanation(actions, actors, tokenAmounts, protocols, chain) {
  const steps = [];

  if (actors.length > 0) {
    const sender = actors.find(a => a.role === "sender");
    const recipient = actors.find(a => a.role === "recipient");
    if (sender) steps.push(`Wallet ${sender.shortAddress} initiated the transaction.`);
    if (recipient) steps.push(`Destination: ${recipient.shortAddress}.`);
  }

  for (const action of actions) {
    steps.push(`Action: ${action.action} - ${action.description}.`);
  }

  if (tokenAmounts.length > 0) {
    const amounts = tokenAmounts.map(t => `${t.amount} ${t.token}`).join(", ");
    steps.push(`Token amounts involved: ${amounts}.`);
  }

  if (protocols.length > 0) {
    steps.push(`Protocol(s) involved: ${protocols.join(", ")}.`);
  }

  steps.push(`Network: ${chain}.`);

  return steps;
}

export async function execute(input = {}) {
  const transaction = asString(input.transaction ?? input.content ?? input.text);
  if (!transaction) {
    throw new Error("onchain-transaction-analyzer requires a transaction input.");
  }

  const chain = asString(input.chain, "ethereum").toLowerCase();
  const explorer = CHAIN_EXPLORERS[chain] || CHAIN_EXPLORERS.ethereum;

  const addresses = extractAddresses(transaction);
  const txHashes = extractTxHashes(transaction);
  const tokenAmounts = extractTokenAmounts(transaction);
  const actions = detectActions(transaction);
  const protocols = detectProtocols(transaction);
  const actors = classifyActors(addresses, transaction);

  const explanation = buildExplanation(actions, actors, tokenAmounts, protocols, chain);

  const txType = actions.length > 0 ? actions[0].category : "unknown";
  const explorerLinks = txHashes.map(h => `${explorer}/tx/${h}`);

  return {
    summary: `Transaction analysis on ${chain}: ${actions.length} action(s), ${actors.length} actor(s), ${tokenAmounts.length} token movement(s) detected.`,
    nextStep: txHashes.length > 0
      ? `View full transaction details at ${explorerLinks[0]}`
      : "Provide a transaction hash for deeper on-chain analysis.",
    details: {
      chain,
      transactionType: txType,
      actors,
      actions,
      tokenAmounts,
      protocols,
      transactionHashes: txHashes,
      explorerLinks,
      explanation,
      explorerBaseUrl: explorer,
      suggestedSkillId: "deep-research-synthesizer",
    },
  };
}
