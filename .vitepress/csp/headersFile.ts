// Reads the Netlify `_headers` format: an unindented line starts a block for that
// path, and the indented `Name: value` lines under it are its headers. Comments
// and blank lines are skipped. Shared by the build (which appends to the file)
// and the e2e server (which serves what the file says), so both agree on what
// the file means.
const COMMENT_PREFIX = "#";
const INDENTED_LINE_PATTERN = /^\s/;
const HEADER_LINE_PATTERN = /^\s+([\w-]+):[ \t]*(\S.*?)\s*$/;
const HEADERS_FILE_NAME = "_headers";

export type HeadersFileHeader = { name: string; value: string };
export type HeadersFileBlock = { path: string; headers: HeadersFileHeader[] };

// An indented line that is not a `Name: value` pair (or has no block above it)
// throws instead of being mistaken for a path, which would silently drop the
// headers around it.
export function parseHeadersFile(headersFile: string): HeadersFileBlock[] {
  const blocks: HeadersFileBlock[] = [];
  for (const line of headersFile.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(COMMENT_PREFIX)) {
      continue;
    }
    if (!INDENTED_LINE_PATTERN.test(line)) {
      blocks.push({ path: trimmed, headers: [] });
      continue;
    }
    const header = HEADER_LINE_PATTERN.exec(line);
    const currentBlock = blocks.at(-1);
    if (!header || !currentBlock) {
      throw new Error(
        `${HEADERS_FILE_NAME}: not a valid header line: ${JSON.stringify(line)}`,
      );
    }
    currentBlock.headers.push({ name: header[1], value: header[2] });
  }
  return blocks;
}
