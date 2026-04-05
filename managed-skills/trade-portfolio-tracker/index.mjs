#!/usr/bin/env node

/**
 * 持仓跟踪器 — Portfolio Tracker
 *
 * Tracks actual holdings, entry prices, current P&L, and position sizing.
 * Persists portfolio state to portfolio-data.json in the skill directory.
 *
 * Actions:
 *   - view: Show all positions with current P&L
 *   - add_position: Add new position with symbol, shares, price, date
 *   - close_position: Close position, record P&L, move to history
 *   - update_price: Update current prices for P&L calculation
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, 'portfolio-data.json');

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

const input = JSON.parse(readFileSync(0, 'utf-8').trim() || '{}');

const action = input.action || 'view';
const symbol = input.symbol || null;
const shares = input.shares != null ? Number(input.shares) : null;
const price = input.price != null ? Number(input.price) : null;
const side = input.side || 'buy';
const date = input.date || new Date().toISOString().slice(0, 10);
const notes = input.notes || '';

// ---------------------------------------------------------------------------
// Data persistence
// ---------------------------------------------------------------------------

const DEFAULT_DATA = {
  positions: [],
  tradeHistory: [],
  cashBalance: 1000000, // Default 100万 starting cash
  initialCapital: 1000000
};

function loadData() {
  if (!existsSync(DATA_FILE)) return { ...DEFAULT_DATA, positions: [], tradeHistory: [] };
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { ...DEFAULT_DATA, positions: [], tradeHistory: [] };
  }
}

function saveData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function addPosition(data) {
  if (!symbol) {
    return { error: 'symbol is required for add_position' };
  }
  if (shares == null || shares <= 0) {
    return { error: 'shares must be a positive number for add_position' };
  }
  if (price == null || price <= 0) {
    return { error: 'price must be a positive number for add_position' };
  }

  const cost = shares * price;
  if (cost > data.cashBalance) {
    return { error: `Insufficient cash. Need ${cost}, available ${data.cashBalance}` };
  }

  // Check if position already exists for this symbol
  const existing = data.positions.find(p => p.symbol === symbol);
  if (existing) {
    // Average up/down
    const totalShares = existing.shares + shares;
    const totalCost = existing.shares * existing.avgPrice + shares * price;
    existing.avgPrice = Math.round((totalCost / totalShares) * 1000) / 1000;
    existing.shares = totalShares;
    existing.lastUpdated = date;
    if (notes) existing.notes = notes;
  } else {
    data.positions.push({
      symbol,
      shares,
      avgPrice: price,
      currentPrice: price,
      entryDate: date,
      lastUpdated: date,
      side: side || 'buy',
      notes: notes || ''
    });
  }

  data.cashBalance -= cost;

  // Record in trade history
  data.tradeHistory.push({
    symbol,
    action: 'buy',
    shares,
    price,
    cost,
    date,
    notes
  });

  saveData(data);
  return { success: true, message: `Added ${shares} shares of ${symbol} @ ${price}` };
}

function closePosition(data) {
  if (!symbol) {
    return { error: 'symbol is required for close_position' };
  }

  const posIdx = data.positions.findIndex(p => p.symbol === symbol);
  if (posIdx === -1) {
    return { error: `No open position found for ${symbol}` };
  }

  const pos = data.positions[posIdx];
  const closingShares = shares != null && shares > 0 ? Math.min(shares, pos.shares) : pos.shares;
  const exitPrice = price != null && price > 0 ? price : pos.currentPrice;
  const proceeds = closingShares * exitPrice;
  const costBasis = closingShares * pos.avgPrice;
  const realizedPnL = Math.round((proceeds - costBasis) * 100) / 100;
  const pnlPct = Math.round((realizedPnL / costBasis) * 10000) / 100;

  data.cashBalance += proceeds;

  // Record in trade history
  data.tradeHistory.push({
    symbol,
    action: 'sell',
    shares: closingShares,
    price: exitPrice,
    proceeds,
    realizedPnL,
    pnlPct,
    entryPrice: pos.avgPrice,
    entryDate: pos.entryDate,
    exitDate: date,
    holdingDays: daysBetween(pos.entryDate, date),
    notes
  });

  // Remove or reduce position
  if (closingShares >= pos.shares) {
    data.positions.splice(posIdx, 1);
  } else {
    pos.shares -= closingShares;
    pos.lastUpdated = date;
  }

  saveData(data);
  return {
    success: true,
    message: `Closed ${closingShares} shares of ${symbol} @ ${exitPrice}`,
    realizedPnL,
    pnlPct
  };
}

function updatePrice(data) {
  if (!symbol) {
    return { error: 'symbol is required for update_price' };
  }
  if (price == null || price <= 0) {
    return { error: 'price must be a positive number for update_price' };
  }

  const pos = data.positions.find(p => p.symbol === symbol);
  if (!pos) {
    return { error: `No open position found for ${symbol}` };
  }

  pos.currentPrice = price;
  pos.lastUpdated = date;

  saveData(data);
  return { success: true, message: `Updated ${symbol} current price to ${price}` };
}

function viewPortfolio(data) {
  // Calculate per-position details
  const positionBreakdown = data.positions.map(pos => {
    const marketValue = pos.shares * pos.currentPrice;
    const costBasis = pos.shares * pos.avgPrice;
    const unrealizedPnL = Math.round((marketValue - costBasis) * 100) / 100;
    const pnlPct = costBasis > 0
      ? Math.round((unrealizedPnL / costBasis) * 10000) / 100
      : 0;
    const holdingDays = daysBetween(pos.entryDate, new Date().toISOString().slice(0, 10));

    return {
      symbol: pos.symbol,
      shares: pos.shares,
      avgPrice: pos.avgPrice,
      currentPrice: pos.currentPrice,
      marketValue,
      costBasis,
      unrealizedPnL,
      pnlPct,
      entryDate: pos.entryDate,
      holdingDays,
      side: pos.side,
      notes: pos.notes
    };
  });

  // Portfolio totals
  const totalMarketValue = positionBreakdown.reduce((s, p) => s + p.marketValue, 0);
  const totalCostBasis = positionBreakdown.reduce((s, p) => s + p.costBasis, 0);
  const totalUnrealizedPnL = Math.round((totalMarketValue - totalCostBasis) * 100) / 100;
  const totalValue = data.cashBalance + totalMarketValue;
  const exposurePct = totalValue > 0
    ? Math.round((totalMarketValue / totalValue) * 10000) / 100
    : 0;

  // Recent trade history (last 20)
  const recentHistory = data.tradeHistory.slice(-20).reverse();

  return {
    portfolio: {
      totalValue,
      totalMarketValue,
      totalCostBasis,
      totalUnrealizedPnL,
      totalUnrealizedPnLPct: totalCostBasis > 0
        ? Math.round((totalUnrealizedPnL / totalCostBasis) * 10000) / 100
        : 0,
      positionCount: data.positions.length,
      initialCapital: data.initialCapital
    },
    cashAvailable: data.cashBalance,
    exposurePct,
    positionBreakdown,
    tradeHistory: recentHistory
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.max(0, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

const data = loadData();
let result;

switch (action) {
  case 'add_position':
    result = addPosition(data);
    if (result.success) {
      // After adding, also return the portfolio view
      const view = viewPortfolio(loadData());
      result = { ...result, ...view };
    }
    break;

  case 'close_position':
    result = closePosition(data);
    if (result.success) {
      const view = viewPortfolio(loadData());
      result = { ...result, ...view };
    }
    break;

  case 'update_price':
    result = updatePrice(data);
    if (result.success) {
      const view = viewPortfolio(loadData());
      result = { ...result, ...view };
    }
    break;

  case 'view':
  default:
    result = viewPortfolio(data);
    break;
}

console.log(JSON.stringify(result, null, 2));
