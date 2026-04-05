/**
 * trade-knowledge-ingest — 交易知识导入引擎
 *
 * 读取 Trade Agent OG 的 ai_export CSV 文件（预处理数据），
 * 将内容分块存入 Friday 记忆系统，按主题/系列/类型标签化。
 * 支持增量导入（基于内容哈希去重）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// --- CSV Parser (lightweight, no deps) ---
function* parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      lines.push(current);
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (current.length > 0 || lines.length > 0) {
        lines.push(current);
        current = '';
      }
      if (lines.length > 0) {
        yield lines.splice(0);
      }
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      current += ch;
    }
  }
  if (current.length > 0 || lines.length > 0) {
    lines.push(current);
    yield lines.splice(0);
  }
}

function* csvRows(text) {
  const gen = parseCSV(text);
  const headerRow = gen.next().value;
  if (!headerRow) return;
  const headers = headerRow.map(h => h.replace(/^\uFEFF/, '').trim());
  for (const row of gen) {
    if (row.length === 0) continue;
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = (row[i] || '').trim();
    }
    yield obj;
  }
}

// --- Topic tag normalization ---
function parseTopics(topicStr) {
  if (!topicStr) return [];
  return topicStr
    .split(';')
    .map(t => t.trim())
    .filter(t => t.length > 0 && t !== 'undefined');
}

function normalizeSeries(seriesStr) {
  if (!seriesStr) return null;
  const s = seriesStr.trim();
  if (s.length === 0) return null;
  return s;
}

// --- Content hash for deduplication ---
function contentHash(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

// --- Memory chunk builder ---
function buildMemoryChunk(record, namespace) {
  const content = record.content_text || record.text_preview || '';
  if (content.length < 10) return null;

  const hash = contentHash(content);
  const topics = parseTopics(record.topic_tags_en);
  const series = normalizeSeries(record.series_en);
  const category = record.category_en || 'general_document';

  const tags = [category, ...topics];
  if (series) tags.push(series);

  // Determine memory type based on category
  let memoryType = 'fact';
  if (['trading_strategy_note', 'course_material'].includes(category)) {
    memoryType = 'procedure';
  } else if (['daily_market_review', 'q_and_a_note'].includes(category)) {
    memoryType = 'episode';
  }

  return {
    id: `${namespace}:${record.file_id || 'unknown'}-${record.chunk_index || '0'}`,
    namespace,
    content,
    metadata: {
      fileId: record.file_id,
      fileName: record.file_name || record.relative_path,
      title: record.title_original,
      chunkIndex: parseInt(record.chunk_index || '0', 10),
      category,
      series: series || undefined,
      topics,
      language: record.source_language_guess || 'zh',
      memoryType,
      contentHash: hash,
      source: 'trade-agent-og',
    },
    tags,
  };
}

// --- Main execution ---
export default async function execute(input) {
  const { contentDir, namespace = 'trade-kb', forceReindex = false, aiExportDir } = input;

  const exportDir = aiExportDir || (contentDir ? join(contentDir, 'ai_export') : null);
  if (!exportDir || !existsSync(exportDir)) {
    return {
      chunksIngested: 0,
      categoryCounts: {},
      topicCounts: {},
      errors: [`ai_export directory not found: ${exportDir}`],
    };
  }

  const masterFile = join(exportDir, 'ai_master_dataset.csv');
  const contentChunksFile = join(exportDir, 'ai_content_chunks.csv');

  // Prefer master dataset, fall back to content chunks
  const csvFile = existsSync(masterFile) ? masterFile : contentChunksFile;
  if (!existsSync(csvFile)) {
    return {
      chunksIngested: 0,
      categoryCounts: {},
      topicCounts: {},
      errors: [`No CSV data file found in ${exportDir}`],
    };
  }

  const csvText = readFileSync(csvFile, 'utf-8');
  const chunks = [];
  const categoryCounts = {};
  const topicCounts = {};
  const errors = [];
  const seenHashes = new Set();

  for (const row of csvRows(csvText)) {
    // Skip file_only rows (no content)
    if (row.row_type === 'file_only' && !row.content_text) continue;

    const chunk = buildMemoryChunk(row, namespace);
    if (!chunk) continue;

    // Dedup by content hash
    const hash = chunk.metadata.contentHash;
    if (!forceReindex && seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    chunks.push(chunk);

    // Count categories
    const cat = chunk.metadata.category;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;

    // Count topics
    for (const topic of chunk.metadata.topics) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
  }

  // Output the chunks as structured JSON for the Friday runtime to store
  const result = {
    chunksIngested: chunks.length,
    categoryCounts,
    topicCounts,
    errors,
    chunks, // The runtime bridge will handle memory storage
  };

  return result;
}

// CLI entry point
const args = process.argv[2];
if (args) {
  try {
    const input = JSON.parse(args);
    const result = await execute(input);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.log(JSON.stringify({
      chunksIngested: 0,
      categoryCounts: {},
      topicCounts: {},
      errors: [err.message],
    }));
  }
}
