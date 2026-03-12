/**
 * Media Providers — Provider chain runner with bounded concurrency.
 *
 * @module media-understanding/friday-media-providers
 */

import type {
  FridayMediaAttachment,
  FridayMediaUnderstandingOutput,
  FridayMediaUnderstandingProvider,
} from "./friday-media-understanding.types.js";

/**
 * Resolves the best provider for a given attachment from the provider chain.
 */
export function resolveProvider(
  attachment: FridayMediaAttachment,
  providers: readonly FridayMediaUnderstandingProvider[],
): FridayMediaUnderstandingProvider | undefined {
  return providers.find((p) =>
    p.supportedMediaTypes.includes(attachment.mediaType),
  );
}

/**
 * Runs providers for multiple attachments with bounded concurrency.
 */
export async function runProviderChain(
  attachments: readonly FridayMediaAttachment[],
  providers: readonly FridayMediaUnderstandingProvider[],
  fetchContent: (attachment: FridayMediaAttachment) => Promise<Buffer>,
  maxConcurrency: number,
  timeoutMs: number,
): Promise<Map<string, FridayMediaUnderstandingOutput | Error>> {
  const results = new Map<string, FridayMediaUnderstandingOutput | Error>();

  // Process in chunks for bounded concurrency
  const chunks = chunkArray(attachments, Math.max(1, maxConcurrency));

  for (const chunk of chunks) {
    const promises = chunk.map(async (attachment) => {
      const provider = resolveProvider(attachment, providers);
      if (!provider) {
        results.set(
          attachment.id,
          new Error(`No provider found for media type "${attachment.mediaType}"`),
        );
        return;
      }

      try {
        const output = await withTimeout(
          provider.process(attachment, () => fetchContent(attachment)),
          timeoutMs,
        );
        results.set(attachment.id, output);
      } catch (err) {
        results.set(
          attachment.id,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });

    await Promise.all(promises);
  }

  return results;
}

// ─── Helpers ───

function chunkArray<T>(array: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Provider timed out after ${ms}ms`)),
      ms,
    );
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
