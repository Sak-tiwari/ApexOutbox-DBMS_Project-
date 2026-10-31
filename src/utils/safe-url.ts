import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);

  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const a = p[0]!;
  const b = p[1]!;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export async function isSafeUrl(value: string): Promise<boolean> {
  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;

    const host = url.hostname.toLowerCase();

    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    ) return false;

    if (isIP(host) === 4) return !isPrivateIPv4(host);

    if (isIP(host) === 6) {
      return !(
        host === "::1" ||
        host.startsWith("fc") ||
        host.startsWith("fd") ||
        host.startsWith("fe80:")
      );
    }

    const addresses = await lookup(host, { all: true });

    return (
      addresses.length > 0 &&
      addresses.every((item) =>
        item.family === 4
          ? !isPrivateIPv4(item.address)
          : !(
              item.address === "::1" ||
              item.address.startsWith("fc") ||
              item.address.startsWith("fd") ||
              item.address.startsWith("fe80:")
            )
      )
    );
  } catch {
    return false;
  }
}