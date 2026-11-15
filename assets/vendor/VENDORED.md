Vendored third-party libraries

marked.min.js     v18.2.0  MIT     (c) MarkedJS, Christopher Jeffrey   https://github.com/markedjs/marked
purify.min.js    v3.4.18  Apache-2.0 / MPL-2.0  (c) Cure53   https://github.com/cure53/DOMPurify

These files are unmodified upstream builds, served from this origin so the
app works offline on first load and depends on no third party at runtime.
Full licence text is in LICENSE.marked.md and LICENSE.dompurify.txt.

Provenance and integrity (the sha384 values are the ones in index.html):

marked.min.js   lib/marked.umd.js from the npm package marked@18.2.0 (tarball
                checked against the registry's sha512 integrity value;
                identical to the cdn.jsdelivr.net copy). marked no longer
                ships a file called marked.min.js; the UMD build is the
                minified browser build, kept here under the old name. Its
                last line points at a source map that is not vendored, so
                browser developer tools may log a harmless 404 for it.
                sha384-DDYDxilZ1LlqPSbaRHlrwh12h+3fUewuQj7HjscrZIWt5bGyQ+n0DHtIoZE3i3zU

purify.min.js   dist/purify.min.js from the npm package dompurify@3.4.18
                (tarball checked against the registry's sha512 integrity
                value; identical to the cdn.jsdelivr.net copy).
                sha384-lkArbWjiZKuE+bzKbj1vOEF7DKYBDNvgwZMCt5OH8bdRB92zpzyNska9Q/XKPHQD

To update one: replace the file, recompute the hash with
`openssl dgst -sha384 -binary <file> | base64`, update the integrity attribute
in index.html and the entries here and in README.md, and bump VERSION in
sw.js so installed copies drop the old precache.
