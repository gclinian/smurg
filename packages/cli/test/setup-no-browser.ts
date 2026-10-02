// TEST ONLY (vitest setupFiles of @smurg/cli): nothing a CLI test runs may open the owner's real browser. The CLI's
// only opener (cli/io.ts openInBrowser) refuses when SMURG_NO_BROWSER is set; processes the tests spawn inherit it
// (isolatedEnv() sets it too). test/browser-policy.test.ts fails if this is ever missing.
process.env['SMURG_NO_BROWSER'] = '1';
// … and no CLI a test starts with process.env asks downloads.smurg.ai for a newer version (update/notice.ts): the tests
// of the notice inject their own io and a local server.
process.env['SMURG_NO_UPDATE_CHECK'] = '1';
// … and every CLI a test runs speaks English, whatever the developer's own locale is (SMURG_LANG beats LC_ALL,
// LC_MESSAGES, LANG and the system language). The zh-TW suite (test/zh-tw.test.ts) sets it itself.
process.env['SMURG_LANG'] = 'en';
