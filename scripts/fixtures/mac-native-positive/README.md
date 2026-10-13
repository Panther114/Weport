This is synthetic SQLCipher 4 data, containing one `qa_contact` session and two English test messages. It contains no real WeChat account, key, or conversation.

It intentionally has no `message_fts.db`. It verifies message reads, exports,
app-built indexing, and Reader fallback, not native FTS search support.

The public test passphrase is 32 ASCII `a` characters. Weport receives its hex representation from `manifest.json`. The encrypted databases were generated with SQLCipher 4 and independently read through the packaged Linux native engine before reuse here. File hashes and exact message identities are recorded in the manifest.

Files use `.sqlcipher` extensions in the repository. The Mac acceptance script verifies their hashes and copies them into a private temporary fixture directory with the database filenames expected by the engine. It never opens the repository copies through WCDB.
