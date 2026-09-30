// TEST ONLY (vitest setupFiles of @smurg/cli): nothing a CLI test runs may open the owner's real browser. The CLI's
// only opener (cli/io.ts openInBrowser) refuses when SMURG_NO_BROWSER is set; processes the tests spawn inherit it
// (isolatedEnv() sets it too). test/browser-policy.test.ts fails if this is ever missing.
process.env['SMURG_NO_BROWSER'] = '1';
