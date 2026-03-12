import { describe, it, expect } from "vitest";
import { extractMarkdownCommands } from "#skills/converter";

describe("extractMarkdownCommands", () => {
  it("extracts a single bash block with heading label", () => {
    const md = `# Weather

## Get weather

\`\`\`bash
curl -s "wttr.in/London?format=3"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      label: "Get weather",
      command: 'curl -s "wttr.in/London?format=3"',
      lang: "bash",
    });
  });

  it("extracts multiple bash blocks under different headings", () => {
    const md = `# GitHub

## Pull Requests

Check CI status on a PR:

\`\`\`bash
gh pr checks 55 --repo owner/repo
\`\`\`

List recent workflow runs:

\`\`\`bash
gh run list --repo owner/repo --limit 10
\`\`\`

## API

Get PR info:

\`\`\`bash
gh api repos/owner/repo/pulls/55
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(3);
    expect(commands[0]!.label).toBe("Check CI status on a PR");
    expect(commands[0]!.command).toBe("gh pr checks 55 --repo owner/repo");
    expect(commands[1]!.label).toBe("List recent workflow runs");
    expect(commands[1]!.command).toBe("gh run list --repo owner/repo --limit 10");
    expect(commands[2]!.label).toBe("Get PR info");
    expect(commands[2]!.command).toBe("gh api repos/owner/repo/pulls/55");
  });

  it("extracts sh and shell tagged blocks", () => {
    const md = `# Test

## Shell

\`\`\`sh
echo "hello sh"
\`\`\`

## Shell2

\`\`\`shell
echo "hello shell"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.lang).toBe("sh");
    expect(commands[0]!.command).toBe('echo "hello sh"');
    expect(commands[1]!.lang).toBe("shell");
    expect(commands[1]!.command).toBe('echo "hello shell"');
  });

  it("extracts untagged code blocks", () => {
    const md = `# Test

Run this:

\`\`\`
echo "untagged"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.lang).toBe("");
    expect(commands[0]!.command).toBe('echo "untagged"');
  });

  it("ignores non-shell language tags", () => {
    const md = `# Test

\`\`\`python
print("hello")
\`\`\`

\`\`\`javascript
console.log("hello")
\`\`\`

\`\`\`json
{ "key": "value" }
\`\`\`

\`\`\`bash
echo "this one is bash"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('echo "this one is bash"');
    expect(commands[0]!.lang).toBe("bash");
  });

  it("handles multi-line commands", () => {
    const md = `# Deploy

## Build and deploy

\`\`\`bash
npm run build
npm run test
npm run deploy
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe("npm run build\nnpm run test\nnpm run deploy");
    expect(commands[0]!.label).toBe("Build and deploy");
  });

  it("uses preceding text line as label when no heading is directly above", () => {
    const md = `# Weather

Quick one-liner:

\`\`\`bash
curl -s "wttr.in/?format=3"
\`\`\`

Full forecast:

\`\`\`bash
curl -s "wttr.in/?T"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.label).toBe("Quick one-liner");
    expect(commands[1]!.label).toBe("Full forecast");
  });

  it("strips trailing colons from labels", () => {
    const md = `Compact format:

\`\`\`bash
curl -s "wttr.in/London?format=%l"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.label).toBe("Compact format");
  });

  it("skips empty code blocks", () => {
    const md = `# Test

\`\`\`bash
\`\`\`

\`\`\`bash
echo "not empty"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('echo "not empty"');
  });

  it("returns empty array for markdown with no code blocks", () => {
    const md = `# Just a heading

Some text without code blocks.

- bullet 1
- bullet 2
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(0);
  });

  it("falls back to heading context when no inline text precedes", () => {
    const md = `# Main

## Section A

\`\`\`bash
echo "in section A"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.label).toBe("Section A");
  });

  it("handles commands with comments", () => {
    const md = `# Test

## Run with comments

\`\`\`bash
# This is a comment
echo "hello"
# Another comment
echo "world"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe(
      '# This is a comment\necho "hello"\n# Another comment\necho "world"',
    );
  });

  it("parses a realistic weather SKILL.md", () => {
    const md = `# Weather

Two free services, no API keys needed.

## wttr.in (primary)

Quick one-liner:

\`\`\`bash
curl -s "wttr.in/London?format=3"
\`\`\`

Compact format:

\`\`\`bash
curl -s "wttr.in/London?format=%l:+%c+%t+%h+%w"
\`\`\`

Full forecast:

\`\`\`bash
curl -s "wttr.in/London?T"
\`\`\`

## Open-Meteo (fallback, JSON)

\`\`\`bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(4);
    expect(commands[0]!.label).toBe("Quick one-liner");
    expect(commands[1]!.label).toBe("Compact format");
    expect(commands[2]!.label).toBe("Full forecast");
    expect(commands[3]!.label).toBe("Open-Meteo (fallback, JSON)");
  });

  it("generates fallback labels when nothing precedes", () => {
    const md = `\`\`\`bash
echo "orphan command"
\`\`\`
`;
    const commands = extractMarkdownCommands(md);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.label).toBe("command-0");
  });
});
