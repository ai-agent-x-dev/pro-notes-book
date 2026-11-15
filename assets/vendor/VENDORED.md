Vendored third-party libraries

marked.min.js     v15.0.7  MIT     (c) Christopher Jeffrey   https://github.com/markedjs/marked
purify.min.js    v3.4.18  Apache-2.0 / MPL-2.0  (c) Cure53   https://github.com/cure53/DOMPurify

These files are unmodified upstream builds, served from this origin so the
app works offline on first load and depends on no third party at runtime.
Full licence text is in LICENSE.marked.md and LICENSE.dompurify.txt.

Provenance and integrity (the sha384 values are the ones in index.html):

marked.min.js   byte-identical to the file previously loaded from
                cdn.jsdelivr.net, verified against its subresource-integrity
                hash.
                sha384-H+hy9ULve6xfxRkWIh/YOtvDdpXgV2fmAGQkIDTxIgZwNoaoBal14Di2YTMR6MzR

purify.min.js   dist/purify.min.js from the npm package dompurify@3.4.18
                (tarball checked against the registry's sha512 integrity
                value; identical to the cdn.jsdelivr.net copy).
                sha384-lkArbWjiZKuE+bzKbj1vOEF7DKYBDNvgwZMCt5OH8bdRB92zpzyNska9Q/XKPHQD

To update one: replace the file, recompute the hash with
`openssl dgst -sha384 -binary <file> | base64`, update the integrity attribute
in index.html and the entries here and in README.md, and bump VERSION in
sw.js so installed copies drop the old precache.
