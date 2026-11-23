/**
 * Shared POSIX shell quoting for remote commands.
 * Every value that is not a literal must go through shellQuote (or shellJoin) so that
 * ; $( ) ` & | newlines and quotes reach the remote command as plain text.
 */
function shellQuote(value) {
  return `'${String(value == null ? "" : value).replace(/'/g, `'"'"'`)}'`;
}

/** Quote each argument and join with spaces. */
function shellJoin(args) {
  return (Array.isArray(args) ? args : []).map(shellQuote).join(" ");
}

/** Contents for use INSIDE an existing single-quoted string (no surrounding quotes). */
function escapeForSingleQuotes(value) {
  return String(value == null ? "" : value).replace(/'/g, `'"'"'`);
}

/** Bare token (user, container, path segment) that is safe unquoted; throws otherwise. */
function assertShellToken(value, label = "value") {
  const s = String(value == null ? "" : value).trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(s)) {
    throw new Error(`Unsupported characters in ${label}.`);
  }
  return s;
}

module.exports = { shellQuote, shellJoin, escapeForSingleQuotes, assertShellToken };
