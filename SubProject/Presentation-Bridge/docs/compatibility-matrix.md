# Compatibility Matrix

No target feature is marked supported solely because a source fixture exists. Target cells remain evidence-driven.

| Feature | PPTX preflight | Google native | Keynote native | Evidence fixture | Current state |
|---|---|---|---|---|---|
| Text / shapes | implemented | live gate required | live gate required | 01 | source verified |
| Images | implemented | live gate required | live gate required | 02 | source verified |
| Master/layout/theme | inventoried | live gate required | live gate required | 03 | source verified |
| Tables | implemented | target structural count | live gate required | 04 | source verified |
| Charts | implemented | target Sheets-chart count | live gate required | 05 | source verified |
| SVG/media | inventoried | live gate required | live gate required | 06/11 | source verified |
| Transparency | source objects retained by importer | live visual gate required | live visual gate required | 07 | target TBD |
| Rotation/groups | rotation source retained; groups inventoried if present | target TBD | target TBD | 08 | target TBD |
| Hyperlinks/notes | inventoried | target inspection partial | target live gate | 09 | source verified |
| Transition/animation | inventoried | target mapping unknown | target mapping unknown | 10 | source verified |
| Mixed real-world deck | implemented | live acceptance required | live acceptance required | 12 | source verified |

“Target TBD” is deliberate. Unknown must remain unknown until a reproducible live conversion proves otherwise.
