import { platform } from "node:os";
import { FridayDomainError } from "#errors";

export function buildOpenBrowserUrlCommand(
  rawUrl: string,
  os: NodeJS.Platform = platform(),
): { command: string; args: string[] } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FridayDomainError("VALIDATION_ERROR", "Browser URL is invalid", { httpStatus: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FridayDomainError("VALIDATION_ERROR", "Browser URL must use http or https", { httpStatus: 400 });
  }

  if (os === "darwin") {
    return { command: "open", args: [url.toString()] };
  }
  if (os === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url.toString()] };
  }
  return { command: "xdg-open", args: [url.toString()] };
}
