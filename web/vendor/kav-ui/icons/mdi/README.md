# Material Design Icons — SVG subset

128 icons from Material Design Icons 7.4.47, by Pictogrammers and contributors.

Source: https://github.com/Templarian/MaterialDesign-SVG/tree/v7.4.47/svg
Upstream license: https://github.com/Templarian/MaterialDesign-SVG/blob/v7.4.47/LICENSE

The upstream LICENSE and the Apache 2.0 license text are included in this folder.
Keep these notices with redistributed assets.

The path data is unchanged. SVG wrapper attributes were adapted: duplicate-prone
IDs were removed; explicit dimensions, currentColor, aria-hidden and focusable
were added for decorative inline use. For meaningful standalone images, remove
aria-hidden and supply an accessible name (for example, role="img" and aria-label).

Paste the complete SVG into HTML. No imports, icon fonts, external sprite,
JavaScript, CDN or network request are required to render the pasted SVG.

The catalog and searchable copy controls are in components/mdi-icons.html.

With the shared ui.css and ui.js loaded, `<span icon="mdi-home"></span>`
also renders an inline SVG. All 128 paths are embedded in ui.js for offline and
file:// use. If updating these assets, update the mdiPaths table in ui.js too.
The generated SVG is decorative; put accessible labels on its host/button.
