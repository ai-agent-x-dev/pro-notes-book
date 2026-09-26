# Vendored font

## Inter

| | |
| --- | --- |
| Family | Inter |
| Version | v20 (as served by Google Fonts) |
| File | `inter-latin-var.woff2` |
| Size | 48,256 bytes (47 KB) |
| Format | WOFF2, variable |
| Axes | `wght` 100–900, default 400 |
| Subset | Latin |
| Upstream | <https://github.com/rsms/inter> |
| License | SIL Open Font License 1.1 — see `LICENSE.inter.txt` |
| Copyright | Copyright (c) 2016 The Inter Project Authors |

Obtained from the Google Fonts CDN endpoint that the app previously linked
directly, then stored locally and left **unmodified**:

```
https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2
```

## Why one file, not five

The Google CSS for `Inter:wght@300;400;500;600;700` emits five `@font-face`
rules — one per weight — and all five point at **the same URL**. Inter latin is
distributed as a variable font, so the CDN was already sending one file and
letting the browser instantiate the requested weight.

`fonts.css` therefore declares a single rule with `font-weight: 100 900`
instead of five rules that would all download the same bytes. The range is
wider than the app uses on purpose: the file genuinely covers it, and a future
heavier or lighter weight needs no new download.

Verified with `fontTools`:

```python
>>> TTFont('inter-latin-var.woff2')['fvar'].axes[0].axisTag
'wght'
>>> TTFont('inter-latin-var.woff2')['fvar'].axes[0].minValue   # 100
>>> TTFont('inter-latin-var.woff2')['fvar'].axes[0].maxValue   # 900
```

## Licensing

Inter is licensed under the SIL Open Font License 1.1, which requires the
copyright notice and licence to be bundled with the font — `LICENSE.inter.txt`
does that, and OFL condition 2 (bundling) is satisfied by shipping both files
together.

The file is byte-identical to the upstream release, so the **Reserved Font
Name** provisions do not restrict anything here: OFL condition 3 only bars
*modified* versions from using the reserved name. If the font is ever edited,
it must be renamed.

## Verifying a future update

```bash
# 1. confirm the downloaded file is a valid woff2 of the expected size
python3 -c "d=open('inter-latin-var.woff2','rb').read(); print(d[:4], len(d))"
# expect: b'wOF2' 48256

# 2. confirm it is still variable and still covers the range we declare
python3 -c "
from fontTools.ttLib import TTFont
a=TTFont('inter-latin-var.woff2')['fvar'].axes[0]
print(a.axisTag, a.minValue, a.maxValue)"
# expect: wght 100.0 900.0
```
