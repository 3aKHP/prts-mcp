globalThis.fetch = (() => new Promise(() => {
  // Intentionally never resolves: startup tests use this to prove that
  // server listen is not blocked by GitHub sync.
})) as typeof fetch;
