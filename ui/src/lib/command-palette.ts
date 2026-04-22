const OPEN_COMMAND_PALETTE_EVENT = "friday:open-command-palette";

export function requestCommandPaletteOpen(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
}

export function onCommandPaletteOpenRequest(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handle = () => listener();
  window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handle as EventListener);
  return () => {
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handle as EventListener);
  };
}
