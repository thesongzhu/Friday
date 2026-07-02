import { FridayDomainError } from "#errors";
import { FRIDAY_MEMORY_ERROR_CODES } from "../friday-memory.constants.js";

export function assertTsDurableMemoryWriteEnabled(enabled: boolean, operation: string): void {
  if (enabled) return;
  throw new FridayDomainError(
    FRIDAY_MEMORY_ERROR_CODES.TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED,
    "TypeScript durable memory writes are retired for this runtime; use the Rust-owned memory confirmation spine.",
    {
      httpStatus: 503,
      details: {
        operation,
        replacement: "rust_owned_memory_confirmation_spine",
      },
    },
  );
}
