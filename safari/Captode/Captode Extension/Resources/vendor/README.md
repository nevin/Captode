# Third-party codecs

Compiled to WebAssembly, unmodified, from the [jSquash](https://github.com/jamsinclair/jSquash)
packages (which package the codecs from Google's [Squoosh](https://github.com/GoogleChromeLabs/squoosh)).

| Folder | Codec | Package | Licences |
|---|---|---|---|
| `oxipng/` | [oxipng](https://github.com/shssoichiro/oxipng): lossless PNG optimiser | `@jsquash/oxipng@2.3.0` (single-threaded build) | Apache-2.0 (`LICENSE`), codec: MIT (`LICENSE.codec.md`) |
| `mozjpeg/` | [MozJPEG](https://github.com/mozilla/mozjpeg) encoder | `@jsquash/jpeg@1.6.0` | Apache-2.0 (`LICENSE`), codec: IJG / BSD (`LICENSE.codec.md`) |

Captode loads them through `src/lib/wasm.js`, only inside encoding workers, and falls back to
its own encoders if they can't load.

This software is based in part on the work of the Independent JPEG Group.
