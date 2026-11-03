/** Minimal, conservative robots.txt (RFC 9309) evaluation. */

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
  crawlDelay?: number;
}

export interface Robots {
  isAllowed(path: string): boolean;
  /** Seconds the site asks us to wait between requests, if stated. */
  crawlDelay: number | undefined;
}

export const ALLOW_ALL: Robots = { isAllowed: () => true, crawlDelay: undefined };
export const DENY_ALL: Robots = { isAllowed: () => false, crawlDelay: undefined };

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string, agent: string): Robots {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.slice(0, 500_000).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value !== "") current.rules.push({ allow: key === "allow", path: value });
      // An empty Disallow means "allow everything" and adds no rule.
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }

  const name = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const crawlDelay = chosen.map((g) => g.crawlDelay).find((d) => d !== undefined);
  const compiled = rules.map((r) => ({ allow: r.allow, re: patternToRegex(r.path), len: r.path.length }));

  return {
    crawlDelay,
    isAllowed(path: string) {
      let best: { allow: boolean; len: number } | undefined;
      for (const r of compiled) {
        if (!r.re.test(path)) continue;
        // Longest match wins; on a tie Allow beats Disallow.
        if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = { allow: r.allow, len: r.len };
      }
      return best ? best.allow : true;
    },
  };
}
