# Noise test vectors

Published test vectors of two independent implementations of the [Noise Protocol Framework](https://noiseprotocol.org/).
The protocol tests run every vector through smurg's Noise state machine (`packages/protocol/src/noise/`); the files are
test data only and are not part of the smurg executable or the web app.

Both files are unmodified copies of the upstream files (downloaded 2026-09-27, compared again byte for byte on
2026-10-02).

| File | Vectors | Upstream | Upstream path and commit | sha256 | Upstream license |
|---|---|---|---|---|---|
| `cacophony.txt` | 944 | <https://github.com/haskell-cryptography/cacophony> | `vectors/cacophony.txt` at `18b7348c54fd61fcd0c220298883de0d09c8364d` (2018-12-16) | `3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae` | [The Unlicense](https://github.com/haskell-cryptography/cacophony/blob/master/LICENSE) (public domain) |
| `snow.txt` | 408 | <https://github.com/mcginty/snow> | `tests/vectors/snow.txt` at `d00b360cc61a7fe519ce7539974dca4f36c4654a` (2025-03-04) | `69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3` | Apache-2.0 OR MIT ([LICENSE-APACHE](https://github.com/mcginty/snow/blob/main/LICENSE-APACHE), [LICENSE-MIT](https://github.com/mcginty/snow/blob/main/LICENSE-MIT)); used here under MIT |

## snow.txt: MIT license notice

```
MIT License

Copyright (c) 2021 Jake McGinty

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Updating

Replace a file only with the upstream file as it is, then update the commit and sha256 above
(`shasum -a 256 packages/protocol/test-vectors/*.txt`) and check that the upstream license has not changed.
